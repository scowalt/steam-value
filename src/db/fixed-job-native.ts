import { createHash } from "node:crypto";
import { byteLength, DB_LIMITS } from "./access";
import { TransferError } from "./transfer-error";
import { quote, recordRow, scalar, tableSummary } from "./transfer-native";
import type { SchemaTable, SnapshotRow, TableInventory, TransferSource } from "./transfer";

export const FIXED_D1_VERIFICATION_LIMITS = Object.freeze({ paidInvocationQueries: 1000, admittedQueries: 960, reservedQueries: 64, pageRows: 256, pageBytes: 2097152 });

type Reader = Pick<TransferSource, "query">;
interface Plan { count: number; bytes: number; totalBytes: number; maxPages: number }
const pageBudget = FIXED_D1_VERIFICATION_LIMITS.pageBytes - 2;

function overhead(columns: number) {
  return 64 + Array.from({ length: columns }, (_, index) => 66 + 3 * String(index).length).reduce((sum, size) => sum + size, 0);
}

function plan(count: number, bytes: number, totalBytes: number): Plan {
  if (![count, bytes, totalBytes].every((value) => Number.isSafeInteger(value) && value >= 0) || bytes > pageBudget ||
    (count === 0 ? bytes !== 0 || totalBytes !== 0 : bytes === 0 || totalBytes < bytes || totalBytes / count > bytes)) throw new TransferError("UNSUPPORTED_DATA");
  const maxPages = count === 0 ? 1 : Math.min(count + 1, bytes === pageBudget ? count + 1 : Math.floor(count / FIXED_D1_VERIFICATION_LIMITS.pageRows) + Math.floor(totalBytes / (pageBudget - bytes)) + 2);
  if (!Number.isSafeInteger(maxPages)) throw new TransferError("UNSUPPORTED_DATA");
  return { count, bytes, totalBytes, maxPages };
}

function queryEstimate(plans: Plan[]) {
  const queries = FIXED_D1_VERIFICATION_LIMITS.reservedQueries + plans.reduce((sum, plan) => sum + 2 + plan.maxPages, 0);
  if (!Number.isSafeInteger(queries) || queries > FIXED_D1_VERIFICATION_LIMITS.admittedQueries) throw new TransferError("UNSUPPORTED_DATA");
  return queries;
}

export function estimateFixedD1Verification(tables: readonly TableInventory[]) {
  return queryEstimate(tables.map((table) => {
    if (![table.rowCount, table.maxRowBytes].every((value) => Number.isSafeInteger(value) && value >= 0) || !Array.isArray(table.columns) || !table.columns.length) throw new TransferError("ARTIFACT_INVALID");
    if (table.rowCount === 0) return plan(0, 0, 0);
    const fixed = overhead(table.columns.length);
    const maximum = table.maxRowBytes * 6 + fixed;
    const complete = Number.isSafeInteger(table.bytes) && table.bytes >= table.maxRowBytes && table.maxRowBytes > 0 && table.bytes / table.rowCount <= table.maxRowBytes;
    return plan(table.rowCount, maximum, complete ? table.bytes * 6 + table.rowCount * fixed : table.rowCount * maximum);
  }));
}

function sizeExpression(table: SchemaTable) {
  return `6*(${table.columns.map((column) => {
    const name = quote(String(column.name));
    return `CASE WHEN typeof(${name}) IN ('text','blob') THEN coalesce(length(CAST(${name} AS BLOB)),0) ELSE 0 END`;
  }).join("+")})+${overhead(table.columns.length)}`;
}

async function bounds(source: Reader, table: SchemaTable) {
  const size = sizeExpression(table);
  const rows = await source.query(`SELECT COUNT(*) AS count, coalesce(MAX(${size}),0) AS bytes, coalesce(SUM(${size}),0) AS totalBytes FROM ${quote(table.name)}`);
  const value = rows[0];
  if (rows.length !== 1 || !value || typeof value.count !== "number" || typeof value.bytes !== "number" || typeof value.totalBytes !== "number") throw new TransferError("UNSUPPORTED_DATA");
  return plan(value.count, value.bytes, value.totalBytes);
}

async function page(source: Reader, table: SchemaTable, plan: Plan, cursor: number | undefined): Promise<SnapshotRow[]> {
  const projection = table.columns.flatMap((column, index) => {
    const name = quote(String(column.name));
    return [`${name} AS c${index}`, `typeof(${name}) AS t${index}`, `length(CAST(${name} AS BLOB)) AS b${index}`];
  }).join(",");
  const selected = ["transfer_rowid", ...table.columns.flatMap((_, index) => [`c${index}`, `t${index}`, `b${index}`])].join(",");
  const rows = await source.query(`WITH candidate AS (SELECT rowid AS transfer_rowid,${projection},${sizeExpression(table)} AS transfer_bytes FROM ${quote(table.name)}${cursor === undefined ? "" : " WHERE rowid > ?"} ORDER BY rowid LIMIT ${FIXED_D1_VERIFICATION_LIMITS.pageRows}), sized AS (SELECT *,SUM(transfer_bytes) OVER (ORDER BY transfer_rowid ROWS UNBOUNDED PRECEDING) AS transfer_total FROM candidate) SELECT ${selected} FROM sized WHERE CASE WHEN transfer_bytes > ? THEN json('!') ELSE transfer_total <= ? END ORDER BY transfer_rowid`, cursor === undefined ? [plan.bytes, pageBudget] : [cursor, plan.bytes, pageBudget]);
  if (rows.length > FIXED_D1_VERIFICATION_LIMITS.pageRows || byteLength(JSON.stringify(rows)) > FIXED_D1_VERIFICATION_LIMITS.pageBytes) throw new TransferError("UNSUPPORTED_DATA");
  return rows.map((raw) => {
    if (typeof raw.transfer_rowid !== "number" || !Number.isSafeInteger(raw.transfer_rowid) || (cursor !== undefined && raw.transfer_rowid <= cursor)) throw new TransferError("UNSUPPORTED_DATA");
    cursor = raw.transfer_rowid;
    const values = table.columns.map((_, index) => {
      const value = scalar(raw[`t${index}`], raw[`c${index}`]);
      if (value[0] === "text" && byteLength(String(value[1])) !== raw[`b${index}`]) throw new TransferError("UNSUPPORTED_DATA");
      return value;
    });
    return { rowid: cursor, values };
  });
}

export async function scanFixedD1Tables(source: Reader, schema: { tables: SchemaTable[] }) {
  let queries = 0;
  let limit = FIXED_D1_VERIFICATION_LIMITS.admittedQueries - FIXED_D1_VERIFICATION_LIMITS.reservedQueries;
  const started = Date.now();
  const reader: Reader = { async query(sql, args) {
    if (++queries > limit || Date.now() - started > DB_LIMITS.timeoutMs) throw new TransferError("UNSUPPORTED_DATA");
    const rows = await source.query(sql, args);
    if (Date.now() - started > DB_LIMITS.timeoutMs) throw new TransferError("UNSUPPORTED_DATA");
    return rows;
  } };
  const plans = [];
  for (const table of schema.tables) plans.push(await bounds(reader, table));
  limit = queryEstimate(plans) - FIXED_D1_VERIFICATION_LIMITS.reservedQueries;
  const tables: TableInventory[] = [];
  for (const [index, table] of schema.tables.entries()) {
    const plan = plans[index]!;
    const summary = tableSummary(table);
    const fixed = overhead(table.columns.length);
    const hash = createHash("sha256");
    let cursor: number | undefined;
    let complete = false;
    let bytes = 0;
    for (let index = 0; index < plan.maxPages; index++) {
      const rows = await page(reader, table, plan, cursor);
      for (const row of rows) {
        const size = fixed + row.values.reduce((sum, [type, value]) => sum + (type === "text" ? byteLength(String(value)) * 6 : 0), 0);
        bytes += size;
        if (summary.rowCount >= plan.count || size > plan.bytes || bytes > plan.totalBytes) throw new TransferError("FREEZE_REQUIRED");
        hash.update(recordRow(summary, row));
        cursor = row.rowid;
      }
      if (!rows.length) { complete = true; break; }
    }
    const after = await bounds(reader, table);
    if (!complete || summary.rowCount !== plan.count || bytes !== plan.totalBytes || after.count !== plan.count || after.bytes !== plan.bytes || after.totalBytes !== plan.totalBytes) throw new TransferError("FREEZE_REQUIRED");
    summary.contentDigest = hash.digest("hex");
    tables.push(summary);
  }
  return tables;
}
