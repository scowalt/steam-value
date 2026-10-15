import type { D1Database } from "@cloudflare/workers-types";
import { createHash } from "node:crypto";
import { byteLength, DB_LIMITS, isDbValue, isRecord, type DbValue } from "./access";
import { TransferError } from "./transfer-error";
import type { SchemaObject, SchemaTable, SnapshotRow, TableInventory, TransferSource, TypedValue } from "./transfer";

export const TRANSFER_LIMITS = Object.freeze({ pageRows: 64, maxRowBytes: 2_000_000, batchStatements: 64, maxManifestBytes: 1_000_000 });

export function quote(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
export function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function safeRecord(row: Record<string, unknown>): Record<string, DbValue> {
  if (!Object.values(row).every(isDbValue)) throw new TransferError("SCHEMA_DRIFT");
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value as DbValue]));
}

type TransferReader = Pick<TransferSource, "query">;

export function createNativeTransferReader(binding: D1Database): TransferReader {
  return {
    async query(sql, args = []) {
      if (byteLength(sql) > DB_LIMITS.maxSqlBytes || args.length > DB_LIMITS.maxParams || byteLength(JSON.stringify({ sql, args })) > DB_LIMITS.maxRequestBytes) throw new TransferError("UNSUPPORTED_DATA");
      try {
        const result = await binding.prepare(sql).bind(...args).raw<DbValue[]>({ columnNames: true });
        const columns = result.shift();
        if (!columns || !columns.every((column) => typeof column === "string") || new Set(columns).size !== columns.length || result.length > DB_LIMITS.maxRowsPerResult || byteLength(JSON.stringify(result)) > DB_LIMITS.maxResponseBytes) throw new TransferError("UNSUPPORTED_DATA");
        return result.map((row) => {
          if (row.length !== columns.length || !row.every(isDbValue)) throw new TransferError("UNSUPPORTED_DATA");
          return Object.fromEntries(columns.map((column, index) => [String(column), row[index]]));
        });
      } catch (error) { throw error instanceof TransferError ? error : new TransferError("TRANSFER_FAILED"); }
    },
  };
}

export async function readSchema(source: TransferReader) {
  const raw = await source.query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name");
  const objects: SchemaObject[] = raw.map((row) => {
    if (typeof row.type !== "string" || typeof row.name !== "string" || typeof row.tbl_name !== "string" || !(row.sql === null || typeof row.sql === "string")) throw new TransferError("SCHEMA_DRIFT");
    return { type: row.type, name: row.name, tbl_name: row.tbl_name, sql: row.sql };
  });
  return objects;
}

const tableDescriptionSql = `SELECT table_names.value AS transfer_table,
  (SELECT json_group_array(json_object('cid',cid,'name',name,'type',type,'notnull',\"notnull\",'dflt_value',dflt_value,'pk',pk,'hidden',hidden))
    FROM (SELECT * FROM pragma_table_xinfo(table_names.value) ORDER BY cid)) AS columns_json,
  (SELECT json_group_array(json_object('definition',json_object('name',name,'unique',\"unique\",'origin',origin,'partial',partial),
    'columns',json((SELECT json_group_array(json_object('seqno',seqno,'cid',cid,'name',name,'desc',\"desc\",'coll',coll,'key',key))
      FROM (SELECT * FROM pragma_index_xinfo(indexes.name) ORDER BY seqno)))))
    FROM (SELECT * FROM pragma_index_list(table_names.value) ORDER BY name) AS indexes) AS indexes_json,
  (SELECT json_group_array(json_object('id',id,'seq',seq,'table',\"table\",'from',\"from\",'to',\"to\",'on_update',on_update,'on_delete',on_delete,'match',match))
    FROM (SELECT * FROM pragma_foreign_key_list(table_names.value) ORDER BY id,seq)) AS foreign_keys_json,
  (SELECT json_object('type',type,'ncol',ncol,'wr',wr,'strict',strict)
    FROM pragma_table_list WHERE schema='main' AND name=table_names.value) AS flags_json
  FROM json_each(?) AS table_names`;

function schemaJson(value: unknown): unknown {
  if (typeof value !== "string") throw new TransferError("SCHEMA_DRIFT");
  try { return JSON.parse(value); } catch { throw new TransferError("SCHEMA_DRIFT"); }
}

function schemaRecords(value: unknown): Record<string, DbValue>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new TransferError("SCHEMA_DRIFT");
  return value.map(safeRecord);
}

export async function describeTables(source: TransferReader, objects: SchemaObject[]): Promise<SchemaTable[]> {
  const tables: SchemaTable[] = [];
  const selected = objects.filter((entry) => entry.type === "table");
  const descriptions = new Map<string, Record<string, unknown>>();
  const groupSize = 20;
  for (let offset = 0; offset < selected.length; offset += groupSize) {
    const group = selected.slice(offset, offset + groupSize);
    const sql = tableDescriptionSql;
    const args = [JSON.stringify(group.map((object) => object.name))];
    if (byteLength(sql) > DB_LIMITS.maxSqlBytes || byteLength(JSON.stringify({ sql, args })) > DB_LIMITS.maxRequestBytes) throw new TransferError("SCHEMA_DRIFT");
    const rows = await source.query(sql, args);
    if (rows.length !== group.length) throw new TransferError("SCHEMA_DRIFT");
    for (const row of rows) {
      if (typeof row.transfer_table !== "string" || !group.some((object) => object.name === row.transfer_table) || descriptions.has(row.transfer_table)) throw new TransferError("SCHEMA_DRIFT");
      descriptions.set(row.transfer_table, row);
    }
  }
  for (const object of selected) {
    const row = descriptions.get(object.name);
    if (!row) throw new TransferError("SCHEMA_DRIFT");
    const columns = schemaRecords(schemaJson(row.columns_json));
    const rawIndexes = schemaJson(row.indexes_json);
    if (!Array.isArray(rawIndexes)) throw new TransferError("SCHEMA_DRIFT");
    const indexes = rawIndexes.map((index: unknown) => {
      if (!isRecord(index) || !isRecord(index.definition)) throw new TransferError("SCHEMA_DRIFT");
      return { definition: safeRecord(index.definition), columns: schemaRecords(index.columns) };
    });
    const flags = schemaJson(row.flags_json);
    if (!isRecord(flags)) throw new TransferError("SCHEMA_DRIFT");
    tables.push({ name: object.name, columns, indexes, foreignKeys: schemaRecords(schemaJson(row.foreign_keys_json)), flags: safeRecord(flags) });
  }
  return tables;
}

export async function readSequence(source: TransferReader) {
  const rows = await source.query("SELECT name, seq, typeof(seq) AS storage FROM sqlite_sequence ORDER BY name");
  if (rows.length > 1) throw new TransferError("UNSUPPORTED_DATA");
  return rows.map((row) => {
    if (row.name !== "games" || row.storage !== "integer" || typeof row.seq !== "number" || !Number.isSafeInteger(row.seq) || row.seq < 0) throw new TransferError("UNSUPPORTED_DATA");
    return { name: row.name, seq: row.seq };
  });
}

export function scalar(type: unknown, value: unknown): TypedValue {
  if (type === "null" && value === null) return ["null", null];
  if (type === "text" && typeof value === "string" && byteLength(value) <= DB_LIMITS.maxStringBytes) return ["text", value];
  if ((type === "integer" || type === "real") && typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0) &&
    (type !== "integer" || Number.isSafeInteger(value)) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return [type, value];
  throw new TransferError("UNSUPPORTED_DATA");
}

export function tableSummary(table: SchemaTable): TableInventory {
  return { name: table.name, columns: table.columns.map((column) => String(column.name)), file: `${table.name}.jsonl`, rowCount: 0, contentDigest: "", bytes: 0, maxRowBytes: 0, maxScalarBytes: 0, storageTypes: table.columns.map(() => ({})) };
}

export function recordRow(summary: TableInventory, row: SnapshotRow) {
  const line = JSON.stringify(row) + "\n";
  const bytes = byteLength(line);
  if (bytes > TRANSFER_LIMITS.maxRowBytes) throw new TransferError("UNSUPPORTED_DATA");
  summary.rowCount++;
  summary.bytes += bytes;
  summary.maxRowBytes = Math.max(summary.maxRowBytes, bytes);
  row.values.forEach(([type, value], index) => {
    const types = summary.storageTypes[index]!;
    types[type] = (types[type] ?? 0) + 1;
    summary.maxScalarBytes = Math.max(summary.maxScalarBytes, typeof value === "string" ? byteLength(value) : 8);
  });
  return line;
}

export async function transferReadBounds(source: TransferReader, table: SchemaTable) {
  const columns = table.columns.map((column) => quote(String(column.name)));
  const sizeSql = columns.map((column) => `coalesce(length(CAST(${column} AS BLOB)),0)`).join("+");
  const sizes = await source.query(`SELECT COUNT(*) AS count, coalesce(MAX(${sizeSql}),0) AS bytes FROM ${quote(table.name)}`);
  const size = sizes[0];
  if (!size || typeof size.count !== "number" || !Number.isSafeInteger(size.count) || typeof size.bytes !== "number" || size.bytes > TRANSFER_LIMITS.maxRowBytes) throw new TransferError("UNSUPPORTED_DATA");
  const pageSize = Math.max(1, Math.min(TRANSFER_LIMITS.pageRows, Math.floor(DB_LIMITS.maxResponseBytes / (Math.max(1, size.bytes) * 8 + 4096))));
  return { count: size.count, pageSize };
}

export async function readTransferPage(source: TransferReader, table: SchemaTable, cursor: number | undefined, pageSize: number): Promise<SnapshotRow[]> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > TRANSFER_LIMITS.pageRows || (cursor !== undefined && !Number.isSafeInteger(cursor))) throw new TransferError("UNSUPPORTED_DATA");
  const columns = table.columns.map((column) => quote(String(column.name)));
  const projection = columns.flatMap((column, index) => [`${column} AS c${index}`, `typeof(${column}) AS t${index}`, `length(CAST(${column} AS BLOB)) AS b${index}`]).join(",");
  const rows = await source.query(`SELECT rowid AS transfer_rowid,${projection} FROM ${quote(table.name)}${cursor === undefined ? "" : " WHERE rowid > ?"} ORDER BY rowid LIMIT ?`, cursor === undefined ? [pageSize] : [cursor, pageSize]);
  if (rows.length > pageSize) throw new TransferError("UNSUPPORTED_DATA");
  return rows.map((raw) => {
    if (typeof raw.transfer_rowid !== "number" || !Number.isSafeInteger(raw.transfer_rowid) || (cursor !== undefined && raw.transfer_rowid <= cursor)) throw new TransferError("UNSUPPORTED_DATA");
    cursor = raw.transfer_rowid;
    const values = columns.map((_, index) => {
      const value = scalar(raw[`t${index}`], raw[`c${index}`]);
      if (value[0] === "text" && byteLength(String(value[1])) !== raw[`b${index}`]) throw new TransferError("UNSUPPORTED_DATA");
      return value;
    });
    return { rowid: cursor, values };
  });
}

export async function* sourceRows(source: TransferReader, table: SchemaTable): AsyncGenerator<SnapshotRow> {
  const { count: expectedCount, pageSize } = await transferReadBounds(source, table);
  let cursor: number | undefined;
  let count = 0;
  for (;;) {
    const rows = await readTransferPage(source, table, cursor, pageSize);
    for (const row of rows) {
      cursor = row.rowid;
      count++;
      yield row;
    }
    if (rows.length < pageSize) break;
  }
  if (count !== expectedCount) throw new TransferError("FREEZE_REQUIRED");
}

export async function scanTables(source: TransferReader, schema: { tables: SchemaTable[] }, onRow?: (table: string, line: string) => Promise<void>) {
  const tables = [];
  for (const table of schema.tables) {
    const summary = tableSummary(table);
    const hash = createHash("sha256");
    for await (const row of sourceRows(source, table)) {
      const line = recordRow(summary, row);
      hash.update(line);
      await onRow?.(table.name, line);
    }
    summary.contentDigest = hash.digest("hex");
    tables.push(summary);
  }
  return tables;
}

export interface ImportStatement { sql: string; args: DbValue[]; rows: number }
export interface TransferGroup { statements: ImportStatement[]; rows: SnapshotRow[] }

export async function* packTransferRows(table: SchemaTable, rows: AsyncIterable<SnapshotRow>, fixedJob = false): AsyncGenerator<TransferGroup> {
  let batch: ImportStatement[] = [];
  let groupRows: SnapshotRow[] = [];
  let pending: ImportStatement | undefined;
  let pendingRows: SnapshotRow[] = [];
  let bytes = 0;
  let rowBytes = 0;
  const prefix = `INSERT INTO ${quote(table.name)} (rowid,${table.columns.map((column) => quote(String(column.name))).join(",")}) VALUES `;
  const statementBytes = (statement: ImportStatement) => byteLength(JSON.stringify({ sql: statement.sql, args: statement.args }));
  const enqueue = (): TransferGroup | undefined => {
    if (!pending) return;
    const size = statementBytes(pending);
    const sizeRows = fixedJob ? pendingRows.reduce((total, row) => total + byteLength(JSON.stringify(row)) + 1, 0) : 0;
    if (fixedJob && sizeRows > DB_LIMITS.maxRequestBytes - 4096) throw new TransferError("UNSUPPORTED_DATA");
    let full: TransferGroup | undefined;
    if (batch.length >= TRANSFER_LIMITS.batchStatements - (fixedJob ? 1 : 0) || bytes + size > DB_LIMITS.maxRequestBytes - 4096 || (fixedJob && rowBytes + sizeRows > DB_LIMITS.maxRequestBytes - 4096)) {
      full = { statements: batch, rows: groupRows };
      batch = []; groupRows = []; bytes = 0; rowBytes = 0;
    }
    batch.push(pending); groupRows.push(...pendingRows); bytes += size; rowBytes += sizeRows;
    pending = undefined; pendingRows = [];
    return full;
  };
  for await (const row of rows) {
    const args: DbValue[] = [row.rowid, ...row.values.map((entry) => entry[1])];
    const binds = ["CAST(? AS INTEGER)", ...row.values.map(([type]) => type === "integer" ? "CAST(? AS INTEGER)" : type === "real" ? "CAST(? AS REAL)" : "?")];
    const values = `(${binds.join(",")})`;
    const single: ImportStatement = { sql: prefix + values, args, rows: 1 };
    if (args.length > DB_LIMITS.maxParams || byteLength(single.sql) > DB_LIMITS.maxSqlBytes || statementBytes(single) > DB_LIMITS.maxRequestBytes - 4096) throw new TransferError("UNSUPPORTED_DATA");
    let combined = pending ? { sql: `${pending.sql},${values}`, args: [...pending.args, ...args], rows: pending.rows + 1 } : single;
    if (combined.args.length > DB_LIMITS.maxParams || byteLength(combined.sql) > DB_LIMITS.maxSqlBytes || statementBytes(combined) > DB_LIMITS.maxRequestBytes - 4096) {
      const full = enqueue();
      if (full) yield full;
      combined = single;
    }
    pending = combined;
    pendingRows.push(row);
  }
  const full = enqueue();
  if (full) yield full;
  if (batch.length) yield { statements: batch, rows: groupRows };
}
