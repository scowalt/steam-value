import { createHash } from "node:crypto";
import { byteLength } from "./access";
import { TransferError } from "./transfer-error";
import { quote, recordRow, scalar, tableSummary } from "./transfer-native";
import type { SchemaTable, SnapshotRow, TableInventory, TransferSource } from "./transfer";

export const FIXED_D1_VERIFICATION_LIMITS = Object.freeze({ paidInvocationQueries: 1000, admittedQueries: 960, reservedQueries: 64, pageRows: 256, pageBytes: 2097152 });

type Reader = Pick<TransferSource, "query">;

function pageRows(bytes: number, columns: number) {
  const bound = bytes * 6 + columns * 128 + 512;
  if (!Number.isSafeInteger(bound) || bound > FIXED_D1_VERIFICATION_LIMITS.pageBytes) throw new TransferError("UNSUPPORTED_DATA");
  return Math.min(FIXED_D1_VERIFICATION_LIMITS.pageRows, Math.floor(FIXED_D1_VERIFICATION_LIMITS.pageBytes / bound));
}

function queryEstimate(plans: { count: number; pageRows: number }[]) {
  const queries = FIXED_D1_VERIFICATION_LIMITS.reservedQueries + plans.reduce((sum, plan) => sum + 3 + Math.floor(plan.count / plan.pageRows), 0);
  if (!Number.isSafeInteger(queries) || queries > FIXED_D1_VERIFICATION_LIMITS.admittedQueries) throw new TransferError("UNSUPPORTED_DATA");
  return queries;
}

export function estimateFixedD1Verification(tables: readonly TableInventory[]) {
  return queryEstimate(tables.map((table) => {
    if (!Number.isSafeInteger(table.rowCount) || table.rowCount < 0 || !Number.isSafeInteger(table.maxRowBytes) || table.maxRowBytes < 0 || !Array.isArray(table.columns) || !table.columns.length) throw new TransferError("ARTIFACT_INVALID");
    return { count: table.rowCount, pageRows: pageRows(table.maxRowBytes, table.columns.length) };
  }));
}

function sizeExpression(table: SchemaTable) {
  return table.columns.map((column) => `coalesce(length(CAST(${quote(String(column.name))} AS BLOB)),0)`).join("+");
}

async function bounds(source: Reader, table: SchemaTable) {
  const rows = await source.query(`SELECT COUNT(*) AS count, coalesce(MAX(${sizeExpression(table)}),0) AS bytes FROM ${quote(table.name)}`);
  const value = rows[0];
  if (rows.length !== 1 || !value || typeof value.count !== "number" || !Number.isSafeInteger(value.count) || value.count < 0 || typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 0) throw new TransferError("UNSUPPORTED_DATA");
  return { count: value.count, bytes: value.bytes, pageRows: pageRows(value.bytes, table.columns.length) };
}

async function page(source: Reader, table: SchemaTable, plan: Awaited<ReturnType<typeof bounds>>, cursor: number | undefined): Promise<SnapshotRow[]> {
  const projection = table.columns.flatMap((column, index) => {
    const name = quote(String(column.name));
    return [`${name} AS c${index}`, `typeof(${name}) AS t${index}`, `length(CAST(${name} AS BLOB)) AS b${index}`];
  }).join(",");
  const rows = await source.query(`SELECT CASE WHEN ${sizeExpression(table)} <= ? THEN rowid ELSE json('!') END AS transfer_rowid,${projection} FROM ${quote(table.name)}${cursor === undefined ? "" : " WHERE rowid > ?"} ORDER BY rowid LIMIT ?`, cursor === undefined ? [plan.bytes, plan.pageRows] : [plan.bytes, cursor, plan.pageRows]);
  if (rows.length > plan.pageRows || byteLength(JSON.stringify(rows)) > FIXED_D1_VERIFICATION_LIMITS.pageBytes) throw new TransferError("UNSUPPORTED_DATA");
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
  const plans = [];
  for (const table of schema.tables) plans.push(await bounds(source, table));
  queryEstimate(plans);
  const tables: TableInventory[] = [];
  for (const [index, table] of schema.tables.entries()) {
    const plan = plans[index]!;
    const summary = tableSummary(table);
    const hash = createHash("sha256");
    let cursor: number | undefined;
    const maxPages = Math.floor(plan.count / plan.pageRows) + 1;
    let complete = false;
    for (let index = 0; index < maxPages; index++) {
      const rows = await page(source, table, plan, cursor);
      for (const row of rows) {
        if (summary.rowCount >= plan.count) throw new TransferError("FREEZE_REQUIRED");
        hash.update(recordRow(summary, row));
        cursor = row.rowid;
      }
      if (rows.length < plan.pageRows) { complete = true; break; }
    }
    const after = await bounds(source, table);
    if (!complete || summary.rowCount !== plan.count || after.count !== plan.count || after.bytes !== plan.bytes) throw new TransferError("FREEZE_REQUIRED");
    summary.contentDigest = hash.digest("hex");
    tables.push(summary);
  }
  return tables;
}
