import type { D1Database } from "@cloudflare/workers-types";
import type { Client as LibsqlClient } from "@libsql/client";
import { Miniflare } from "miniflare";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createD1Client } from "./d1";
import { DB_LIMITS, exactKeys, isDbValue, isRecord, type DbValue } from "./access";
import { applyMigrations, loadMigrations, migrationChecksum } from "./migrations";

export class TransferError extends Error {
  constructor(readonly code: "SCHEMA_DRIFT" | "UNSUPPORTED_DATA" | "FREEZE_REQUIRED" | "ARTIFACT_INVALID" | "ARTIFACT_UNSAFE" | "TARGET_NOT_EMPTY" | "INCOMPLETE_IMPORT" | "CONTENT_MISMATCH" | "BEHAVIOR_REQUIRED" | "TRANSFER_FAILED") {
    super({
      SCHEMA_DRIFT: "Unresolved schema or metadata drift; stop for reviewed inventory",
      UNSUPPORTED_DATA: "Source data exceeds supported types or bounds; preserve it and stop",
      FREEZE_REQUIRED: "Matching explicit writer freeze and drain evidence is required",
      ARTIFACT_INVALID: "Snapshot is incomplete, malformed or fails integrity checks",
      ARTIFACT_UNSAFE: "Artifacts must be private owned files outside Git without symlinks",
      TARGET_NOT_EMPTY: "Import requires a deliberately selected pristine empty or staging target",
      INCOMPLETE_IMPORT: "Import is incomplete or uncertain; inspect protected receipts and restart explicitly",
      CONTENT_MISMATCH: "Full schema, typed content or sequence validation failed",
      BEHAVIOR_REQUIRED: "Representative viewer and job verification is required before validation completes",
      TRANSFER_FAILED: "Transfer failed; inspect protected incomplete receipts without retrying writes",
    }[code]);
    this.name = "TransferError";
  }
}

export interface FreezeRecord {
  mode: "frozen-writers";
  sourceId: string;
  recordId: string;
  frozenAt: number;
  evidence: string;
  writersPaused: readonly string[];
  writersDrained: readonly string[];
  manualWritersDrained: true;
  holdsUntilRelease: true;
}

export interface TransferSource {
  readonly id: string;
  readonly scope: "isolated-local" | "approved-operator";
  readonly freezeRecord: FreezeRecord;
  query(sql: string, args?: readonly DbValue[]): Promise<Record<string, unknown>[]>;
}

interface SourceOptions {
  id: string;
  freezeRecord: FreezeRecord;
}

export function createD1TransferSource(binding: D1Database, options: SourceOptions & { scope?: TransferSource["scope"] }): TransferSource {
  return {
    ...options, scope: options.scope ?? "isolated-local",
    async query(sql, args = []) {
      try { return (await binding.prepare(sql).bind(...args).all<Record<string, unknown>>()).results; }
      catch { throw new TransferError("TRANSFER_FAILED"); }
    },
  };
}

export function createLegacyTransferSource(client: Pick<LibsqlClient, "execute">, options: SourceOptions): TransferSource {
  return {
    ...options, scope: "approved-operator",
    async query(sql, args = []) {
      try {
        const result = await client.execute({ sql, args: [...args] });
        return result.rows.map((row) => Object.fromEntries(result.columns.map((column) => [column, row[column]])));
      } catch { throw new TransferError("TRANSFER_FAILED"); }
    },
  };
}

export interface SchemaObject { type: string; name: string; tbl_name: string; sql: string | null }
export interface SchemaTable {
  name: string;
  columns: Record<string, DbValue>[];
  indexes: { definition: Record<string, DbValue>; columns: Record<string, DbValue>[] }[];
  foreignKeys: Record<string, DbValue>[];
  flags: Record<string, DbValue>;
}
export interface ReviewedSchema { objects: SchemaObject[]; tables: SchemaTable[]; sequenceObject: SchemaObject }
export interface SourceInventory {
  version: 1;
  source: { id: string; scope: TransferSource["scope"] };
  schemaStatus: "provisional-source-schema";
  schema: ReviewedSchema;
  schemaFingerprint: string;
  migrationFingerprint: string;
  migrationHistory: { id: string; checksum: string }[];
  sourceMigrationHistory: { id: string; checksum: string }[] | null;
  excludedMetadata: SchemaObject[];
  tables: TableInventory[];
  sequence: { name: string; seq: number }[];
}

export type StorageType = "null" | "integer" | "real" | "text";
export type TypedValue = [StorageType, DbValue];
export interface SnapshotRow { rowid: number; values: TypedValue[] }
export interface TableInventory {
  name: string;
  file: string;
  rowCount: number;
  contentDigest: string;
  bytes: number;
  maxRowBytes: number;
  maxScalarBytes: number;
  storageTypes: Partial<Record<StorageType, number>>[];
}
export interface SnapshotManifest extends SourceInventory {
  snapshotId: string;
  createdAt: number;
  freezeRecord: FreezeRecord;
}
export interface Snapshot { directory: string; manifest: SnapshotManifest }

export const TRANSFER_LIMITS = Object.freeze({ pageRows: 64, maxRowBytes: 2_000_000, batchStatements: 64, maxManifestBytes: 1_000_000 });

function quote(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function safeRecord(row: Record<string, unknown>): Record<string, DbValue> {
  if (!Object.values(row).every(isDbValue)) throw new TransferError("SCHEMA_DRIFT");
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value as DbValue]));
}

function assertFreeze(source: TransferSource, record = source.freezeRecord) {
  if (typeof source.id !== "string" || !source.id || !["isolated-local", "approved-operator"].includes(source.scope) ||
    !record || record.mode !== "frozen-writers" || record.sourceId !== source.id || typeof record.recordId !== "string" || !record.recordId || typeof record.evidence !== "string" || !record.evidence ||
    !Number.isSafeInteger(record.frozenAt) || record.frozenAt <= 0 || record.frozenAt > Math.floor(Date.now() / 1000) ||
    record.manualWritersDrained !== true || record.holdsUntilRelease !== true ||
    !Array.isArray(record.writersPaused) || record.writersPaused.length === 0 || !Array.isArray(record.writersDrained) ||
    !record.writersDrained.every((writer) => typeof writer === "string" && writer.length > 0) ||
    !record.writersPaused.every((writer) => typeof writer === "string" && writer.length > 0 && record.writersDrained?.includes(writer)) ||
    !same(record, source.freezeRecord)) throw new TransferError("FREEZE_REQUIRED");
}

async function readSchema(source: TransferSource) {
  const raw = await source.query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name");
  const objects: SchemaObject[] = raw.map((row) => {
    if (typeof row.type !== "string" || typeof row.name !== "string" || typeof row.tbl_name !== "string" || !(row.sql === null || typeof row.sql === "string")) throw new TransferError("SCHEMA_DRIFT");
    return { type: row.type, name: row.name, tbl_name: row.tbl_name, sql: row.sql };
  });
  return objects;
}

async function describeTables(source: TransferSource, objects: SchemaObject[]): Promise<SchemaTable[]> {
  const tables: SchemaTable[] = [];
  for (const object of objects.filter((entry) => entry.type === "table")) {
    const columns = (await source.query(`SELECT * FROM pragma_table_xinfo(?) ORDER BY cid`, [object.name])).map(safeRecord);
    const indexes = [];
    for (const row of await source.query("SELECT * FROM pragma_index_list(?) ORDER BY name", [object.name])) {
      if (typeof row.name !== "string") throw new TransferError("SCHEMA_DRIFT");
      const definition = safeRecord(row);
      delete definition.seq;
      indexes.push({ definition, columns: (await source.query("SELECT * FROM pragma_index_xinfo(?) ORDER BY seqno", [row.name])).map(safeRecord) });
    }
    const flags = (await source.query("SELECT type, ncol, wr, strict FROM pragma_table_list WHERE schema = 'main' AND name = ?", [object.name])).map(safeRecord)[0];
    if (!flags) throw new TransferError("SCHEMA_DRIFT");
    tables.push({ name: object.name, columns, indexes, foreignKeys: (await source.query("SELECT * FROM pragma_foreign_key_list(?) ORDER BY id, seq", [object.name])).map(safeRecord), flags });
  }
  return tables;
}

let reviewed: Promise<{ schema: ReviewedSchema; excluded: SchemaObject[]; history: { id: string; checksum: string }[]; ledger: Record<string, unknown>[] }> | undefined;
async function reviewedSchema() {
  return reviewed ??= (async () => {
    const runtime = new Miniflare({ modules: true, script: "export default {fetch(){return new Response(null)}}", d1Databases: ["DB"], d1Persist: false, cf: false, host: "127.0.0.1", port: 0 });
    try {
      const binding = await runtime.getD1Database("DB");
      const migrations = await loadMigrations();
      await applyMigrations(binding, migrations);
      const source = createD1TransferSource(binding, { id: "reviewed-local-schema", freezeRecord: undefined! });
      const objects = await readSchema(source);
      const excluded = objects.filter((object) => ["_cf_METADATA", "steam_value_migrations", "sqlite_autoindex_steam_value_migrations_1"].includes(object.name));
      const application = objects.filter((object) => !excluded.includes(object) && object.name !== "sqlite_sequence");
      const sequenceObject = objects.find((object) => object.name === "sqlite_sequence")!;
      return {
        schema: { objects: application, tables: await describeTables(source, application), sequenceObject }, excluded,
        history: migrations.map(({ id, checksum }) => ({ id, checksum })),
        ledger: await source.query("SELECT id, checksum, schema_json FROM steam_value_migrations ORDER BY id"),
      };
    } finally { await runtime.dispose(); }
  })();
}

async function saveSchemaDrift(source: TransferSource, directory: string) {
  const objects = await readSchema(source);
  const tables: SchemaTable[] = [];
  const unavailableTables: string[] = [];
  for (const object of objects.filter((entry) => entry.type === "table")) {
    try { tables.push(...await describeTables(source, [object])); }
    catch { unavailableTables.push(object.name); }
  }
  await writeJson(join(directory, "schema-drift.json"), {
    version: 1, status: "unresolved-drift", source: { id: source.id, scope: source.scope },
    objects, tables, unavailableTables, reviewedSchema: (await reviewedSchema()).schema,
  }, true);
}

async function inspectSource(source: TransferSource, onRow?: (table: string, line: string) => Promise<void>): Promise<SourceInventory> {
  assertFreeze(source);
  const expected = await reviewedSchema();
  const objects = await readSchema(source);
  const excludedMetadata = objects.filter((object) => expected.excluded.some((entry) => same(entry, object)));
  const application = objects.filter((object) => !excludedMetadata.includes(object) && object.name !== "sqlite_sequence");
  const sequenceObject = objects.find((object) => object.name === "sqlite_sequence");
  if (!same(application, expected.schema.objects) || !same(sequenceObject, expected.schema.sequenceObject)) throw new TransferError("SCHEMA_DRIFT");
  const schema: ReviewedSchema = { objects: application, tables: await describeTables(source, application), sequenceObject: sequenceObject! };
  if (!same(schema, expected.schema)) throw new TransferError("SCHEMA_DRIFT");
  const hasHistory = excludedMetadata.some((object) => object.name === "steam_value_migrations");
  const ledger = hasHistory ? await source.query("SELECT id, checksum, schema_json FROM steam_value_migrations ORDER BY id") : null;
  if (ledger !== null && !same(ledger, expected.ledger)) throw new TransferError("SCHEMA_DRIFT");
  const sourceMigrationHistory = ledger === null ? null : ledger.map((row) => {
    if (typeof row.id !== "string" || typeof row.checksum !== "string") throw new TransferError("SCHEMA_DRIFT");
    return { id: row.id, checksum: row.checksum };
  });
  if (sourceMigrationHistory !== null && !same(sourceMigrationHistory, expected.history)) throw new TransferError("SCHEMA_DRIFT");
  const tables = await scanTables(source, schema, onRow);
  const sequence = await readSequence(source);
  if (tables.find((table) => table.name === "games")!.rowCount > 0 && sequence.length === 0) throw new TransferError("UNSUPPORTED_DATA");
  return {
    version: 1, source: { id: source.id, scope: source.scope }, schemaStatus: "provisional-source-schema",
    schema, schemaFingerprint: await migrationChecksum(JSON.stringify(schema)),
    migrationFingerprint: await migrationChecksum(JSON.stringify(expected.history)), migrationHistory: expected.history,
    sourceMigrationHistory, excludedMetadata,
    tables, sequence,
  };
}

export async function inventorySource(source: TransferSource, destination?: string): Promise<SourceInventory> {
  if (destination === undefined) return inspectSource(source);
  const directory = await privateDirectory(destination, true);
  const receiptPath = join(directory, "inventory-receipt.json");
  await writeJson(receiptPath, { version: 1, status: "incomplete", kind: "inventory" }, true);
  try {
    const inventory = await inspectSource(source);
    await writeJson(join(directory, "inventory.json"), inventory, true);
    await writeJson(receiptPath, { version: 1, status: "complete", kind: "inventory" });
    return inventory;
  } catch (error) {
    if (error instanceof TransferError && error.code === "SCHEMA_DRIFT") await saveSchemaDrift(source, directory).catch(() => {});
    await writeJson(receiptPath, { version: 1, status: "incomplete", kind: "inventory", errorCode: error instanceof TransferError ? error.code : "TRANSFER_FAILED" }).catch(() => {});
    throw error instanceof TransferError ? error : new TransferError("TRANSFER_FAILED");
  }
}

async function readSequence(source: TransferSource) {
  const rows = await source.query("SELECT name, seq, typeof(seq) AS storage FROM sqlite_sequence ORDER BY name");
  if (rows.length > 1) throw new TransferError("UNSUPPORTED_DATA");
  return rows.map((row) => {
    if (row.name !== "games" || row.storage !== "integer" || typeof row.seq !== "number" || !Number.isSafeInteger(row.seq) || row.seq < 0) throw new TransferError("UNSUPPORTED_DATA");
    return { name: row.name, seq: row.seq };
  });
}

function scalar(type: unknown, value: unknown): TypedValue {
  if (type === "null" && value === null) return ["null", null];
  if (type === "text" && typeof value === "string" && Buffer.byteLength(value) <= DB_LIMITS.maxStringBytes) return ["text", value];
  if ((type === "integer" || type === "real") && typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0) &&
    (type !== "integer" || Number.isSafeInteger(value)) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return [type, value];
  throw new TransferError("UNSUPPORTED_DATA");
}

function tableSummary(table: SchemaTable): TableInventory {
  return { name: table.name, file: `${table.name}.jsonl`, rowCount: 0, contentDigest: "", bytes: 0, maxRowBytes: 0, maxScalarBytes: 0, storageTypes: table.columns.map(() => ({})) };
}

function recordRow(summary: TableInventory, row: SnapshotRow) {
  const line = JSON.stringify(row) + "\n";
  const bytes = Buffer.byteLength(line);
  if (bytes > TRANSFER_LIMITS.maxRowBytes) throw new TransferError("UNSUPPORTED_DATA");
  summary.rowCount++;
  summary.bytes += bytes;
  summary.maxRowBytes = Math.max(summary.maxRowBytes, bytes);
  row.values.forEach(([type, value], index) => {
    const types = summary.storageTypes[index]!;
    types[type] = (types[type] ?? 0) + 1;
    summary.maxScalarBytes = Math.max(summary.maxScalarBytes, typeof value === "string" ? Buffer.byteLength(value) : 8);
  });
  return line;
}

async function* sourceRows(source: TransferSource, table: SchemaTable): AsyncGenerator<SnapshotRow> {
  const columns = table.columns.map((column) => quote(String(column.name)));
  const sizeSql = columns.map((column) => `coalesce(length(CAST(${column} AS BLOB)),0)`).join("+");
  const sizes = await source.query(`SELECT COUNT(*) AS count, coalesce(MAX(${sizeSql}),0) AS bytes FROM ${quote(table.name)}`);
  const size = sizes[0];
  if (!size || typeof size.count !== "number" || !Number.isSafeInteger(size.count) || typeof size.bytes !== "number" || size.bytes > TRANSFER_LIMITS.maxRowBytes) throw new TransferError("UNSUPPORTED_DATA");
  const pageSize = Math.max(1, Math.min(TRANSFER_LIMITS.pageRows, Math.floor(DB_LIMITS.maxResponseBytes / (Math.max(1, size.bytes) * 8 + 4096))));
  const projection = columns.flatMap((column, index) => [`${column} AS c${index}`, `typeof(${column}) AS t${index}`, `length(CAST(${column} AS BLOB)) AS b${index}`]).join(",");
  let cursor: number | undefined;
  let count = 0;
  for (;;) {
    const rows = await source.query(`SELECT rowid AS transfer_rowid,${projection} FROM ${quote(table.name)}${cursor === undefined ? "" : " WHERE rowid > ?"} ORDER BY rowid LIMIT ?`, cursor === undefined ? [pageSize] : [cursor, pageSize]);
    if (rows.length > pageSize) throw new TransferError("UNSUPPORTED_DATA");
    for (const raw of rows) {
      if (typeof raw.transfer_rowid !== "number" || !Number.isSafeInteger(raw.transfer_rowid) || (cursor !== undefined && raw.transfer_rowid <= cursor)) throw new TransferError("UNSUPPORTED_DATA");
      cursor = raw.transfer_rowid;
      const values = columns.map((_, index) => {
        const value = scalar(raw[`t${index}`], raw[`c${index}`]);
        if (value[0] === "text" && Buffer.byteLength(String(value[1])) !== raw[`b${index}`]) throw new TransferError("UNSUPPORTED_DATA");
        return value;
      });
      count++;
      yield { rowid: cursor, values };
    }
    if (rows.length < pageSize) break;
  }
  if (count !== size.count) throw new TransferError("FREEZE_REQUIRED");
}

async function scanTables(source: TransferSource, schema: ReviewedSchema, onRow?: (table: string, line: string) => Promise<void>) {
  const tables = [];
  for (const table of schema.tables) {
    const summary = tableSummary(table);
    const hash = new Bun.CryptoHasher("sha256");
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

async function outsideGit(path: string) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (info?.isSymbolicLink()) throw new TransferError("ARTIFACT_UNSAFE");
    if (await lstat(join(current, ".git")).catch(() => undefined)) throw new TransferError("ARTIFACT_UNSAFE");
  }
  return absolute;
}

function owned(info: { mode: number; uid: number }, mode: number) {
  return (info.mode & 0o777) === mode && (process.getuid === undefined || info.uid === process.getuid());
}

async function privateDirectory(path: string, create = false) {
  try {
    const absolute = await outsideGit(path);
    if (create) await mkdir(absolute, { mode: 0o700 });
    const info = await lstat(absolute);
    if (!info.isDirectory() || !owned(info, 0o700) || await realpath(absolute) !== absolute) throw new TransferError("ARTIFACT_UNSAFE");
    return absolute;
  } catch { throw new TransferError("ARTIFACT_UNSAFE"); }
}

async function privateFile(path: string, create = false): Promise<FileHandle> {
  const absolute = await outsideGit(path);
  await privateDirectory(dirname(absolute));
  const handle = await open(absolute, create ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW : constants.O_RDONLY | constants.O_NOFOLLOW, 0o600).catch(() => { throw new TransferError("ARTIFACT_UNSAFE"); });
  const info = await handle.stat();
  if (!info.isFile() || !owned(info, 0o600) || info.nlink !== 1) {
    await handle.close();
    throw new TransferError("ARTIFACT_UNSAFE");
  }
  return handle;
}

async function writeJson(path: string, value: unknown, create = false) {
  if (!create) {
    const existing = await privateFile(path);
    await existing.close();
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const file = await privateFile(temporary, true);
  try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); }
  finally { await file.close(); }
  if (create) {
    const destination = await privateFile(path, true);
    await destination.close();
  }
  await rename(temporary, path).catch(() => { throw new TransferError("ARTIFACT_UNSAFE"); });
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function readJson(path: string): Promise<unknown> {
  const file = await privateFile(path);
  try {
    if ((await file.stat()).size > TRANSFER_LIMITS.maxManifestBytes) throw new TransferError("ARTIFACT_INVALID");
    return JSON.parse(await file.readFile("utf8"));
  } catch (error) { throw error instanceof TransferError ? error : new TransferError("ARTIFACT_INVALID"); }
  finally { await file.close(); }
}

export async function exportSnapshot(source: TransferSource, destination: string, freezeRecord: FreezeRecord): Promise<Snapshot> {
  assertFreeze(source, freezeRecord);
  const directory = await privateDirectory(destination, true);
  const snapshotId = crypto.randomUUID();
  const receiptPath = join(directory, "export-receipt.json");
  const receipt = { version: 1, kind: "export", snapshotId, status: "incomplete", sourceId: source.id };
  await writeJson(receiptPath, receipt, true);
  const files = new Map<string, FileHandle>();
  try {
    const expected = await reviewedSchema();
    for (const table of expected.schema.tables) files.set(table.name, await privateFile(join(directory, `${table.name}.jsonl`), true));
    const inventory = await inspectSource(source, async (table, line) => { await files.get(table)!.writeFile(line); });
    for (const file of files.values()) await file.sync();
    if (!same(inventory, await inspectSource(source))) throw new TransferError("FREEZE_REQUIRED");
    const manifest: SnapshotManifest = { ...inventory, snapshotId, createdAt: Math.floor(Date.now() / 1000), freezeRecord };
    await writeJson(join(directory, "manifest.json"), manifest, true);
    await writeJson(receiptPath, { ...receipt, status: "complete", manifestDigest: await migrationChecksum(JSON.stringify(manifest)) });
    return { directory, manifest };
  } catch (error) {
    if (error instanceof TransferError && error.code === "SCHEMA_DRIFT") await saveSchemaDrift(source, directory).catch(() => {});
    await writeJson(receiptPath, { ...receipt, status: "incomplete", errorCode: error instanceof TransferError ? error.code : "TRANSFER_FAILED" }).catch(() => {});
    throw error instanceof TransferError ? error : new TransferError("TRANSFER_FAILED");
  } finally {
    await Promise.all([...files.values()].map((file) => file.close()));
  }
}

export interface TransferTarget extends TransferSource {
  readonly binding: D1Database;
  readonly intent: "empty" | "staging";
  readonly receiptPath: string;
  readonly signal?: AbortSignal;
  readonly verifyBehavior?: () => Promise<{ passed: string[] }>;
}

export function createD1TransferTarget(binding: D1Database, options: SourceOptions & {
  intent: TransferTarget["intent"]; receiptPath: string; signal?: AbortSignal; scope?: TransferSource["scope"];
  verifyBehavior?: TransferTarget["verifyBehavior"];
}): TransferTarget {
  return { ...options, ...createD1TransferSource(binding, options), binding };
}

export interface ImportReceipt {
  version: 1;
  kind: "import";
  targetId: string;
  snapshotId: string | null;
  manifestDigest: string | null;
  status: "incomplete" | "imported" | "validated";
  phase: "preflight" | "rows" | "sequence" | "complete" | "failed";
  confirmedRows: Record<string, number>;
  writeOutcome: "not-started" | "partial-or-unknown" | "imported";
  errorCode?: string;
  validation?: { status: "incomplete" | "failed" | "passed"; errorCode?: string; behaviorChecks?: string[] };
}

async function openSnapshot(input: Snapshot | string): Promise<Snapshot> {
  const directory = await privateDirectory(typeof input === "string" ? input : input.directory);
  const value = await readJson(join(directory, "manifest.json"));
  const receipt = await readJson(join(directory, "export-receipt.json"));
  const expected = await reviewedSchema();
  const keys = ["version", "source", "schemaStatus", "schema", "schemaFingerprint", "migrationFingerprint", "migrationHistory", "sourceMigrationHistory", "excludedMetadata", "tables", "sequence", "snapshotId", "createdAt", "freezeRecord"];
  if (!isRecord(value) || !exactKeys(value, keys) || Object.keys(value).length !== keys.length || value.version !== 1 ||
    typeof value.snapshotId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.snapshotId) ||
    typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0 ||
    !isRecord(value.source) || typeof value.source.id !== "string" || !["isolated-local", "approved-operator"].includes(String(value.source.scope)) ||
    value.schemaStatus !== "provisional-source-schema" || !same(value.schema, expected.schema) ||
    value.schemaFingerprint !== await migrationChecksum(JSON.stringify(expected.schema)) ||
    !same(value.migrationHistory, expected.history) || value.migrationFingerprint !== await migrationChecksum(JSON.stringify(expected.history)) ||
    !(value.sourceMigrationHistory === null || same(value.sourceMigrationHistory, expected.history)) ||
    !Array.isArray(value.excludedMetadata) || !value.excludedMetadata.every((object) => expected.excluded.some((entry) => same(entry, object))) ||
    !Array.isArray(value.tables) || value.tables.length !== expected.schema.tables.length ||
    !Array.isArray(value.sequence) || value.sequence.length > 1 || value.sequence.some((entry) => !isRecord(entry) || entry.name !== "games" || typeof entry.seq !== "number" || !Number.isSafeInteger(entry.seq) || entry.seq < 0) ||
    !isRecord(receipt) || receipt.status !== "complete" || receipt.snapshotId !== value.snapshotId || receipt.manifestDigest !== await migrationChecksum(JSON.stringify(value))) throw new TransferError("ARTIFACT_INVALID");
  const manifest = value as unknown as SnapshotManifest;
  assertFreeze({ ...manifest.source, freezeRecord: manifest.freezeRecord, query: async () => [] });
  for (const [index, table] of manifest.tables.entries()) {
    if (table.name !== expected.schema.tables[index]!.name || table.file !== `${table.name}.jsonl` ||
      !Number.isSafeInteger(table.rowCount) || table.rowCount < 0 || !Number.isSafeInteger(table.bytes) || table.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(table.contentDigest) || !Array.isArray(table.storageTypes) || table.storageTypes.length !== expected.schema.tables[index]!.columns.length) throw new TransferError("ARTIFACT_INVALID");
  }
  return { directory, manifest };
}

async function* artifactRows(snapshot: Snapshot, table: SchemaTable): AsyncGenerator<SnapshotRow> {
  const summary = snapshot.manifest.tables.find((entry) => entry.name === table.name)!;
  const file = await privateFile(join(snapshot.directory, summary.file));
  const observed = tableSummary(table);
  const hash = new Bun.CryptoHasher("sha256");
  let cursor: number | undefined;
  try {
    if ((await file.stat()).size !== summary.bytes) throw new TransferError("ARTIFACT_INVALID");
    const buffer = Buffer.alloc(65536);
    let pending = Buffer.alloc(0);
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
      for (;;) {
        const newline = pending.indexOf(10);
        if (newline < 0) break;
        if (newline + 1 > TRANSFER_LIMITS.maxRowBytes) throw new TransferError("ARTIFACT_INVALID");
        const line = pending.subarray(0, newline + 1).toString("utf8");
        pending = pending.subarray(newline + 1);
        const row: unknown = JSON.parse(line);
        if (!isRecord(row) || !exactKeys(row, ["rowid", "values"]) || typeof row.rowid !== "number" || !Number.isSafeInteger(row.rowid) ||
          (cursor !== undefined && row.rowid <= cursor) || !Array.isArray(row.values) || row.values.length !== table.columns.length) throw new TransferError("ARTIFACT_INVALID");
        const values = row.values.map((entry: unknown) => {
          if (!Array.isArray(entry) || entry.length !== 2) throw new TransferError("ARTIFACT_INVALID");
          return scalar(entry[0], entry[1]);
        });
        cursor = row.rowid;
        const typed = { rowid: cursor, values };
        if (recordRow(observed, typed) !== line) throw new TransferError("ARTIFACT_INVALID");
        hash.update(line);
        yield typed;
      }
      if (pending.length > TRANSFER_LIMITS.maxRowBytes) throw new TransferError("ARTIFACT_INVALID");
    }
    observed.contentDigest = hash.digest("hex");
    if (pending.length || !same(observed, summary)) throw new TransferError("ARTIFACT_INVALID");
  } catch (error) { throw error instanceof TransferError ? error : new TransferError("ARTIFACT_INVALID"); }
  finally { await file.close(); }
}

async function verifyArtifact(input: Snapshot | string) {
  const snapshot = await openSnapshot(input);
  for (const table of snapshot.manifest.schema.tables) for await (const _row of artifactRows(snapshot, table)) {}
  return snapshot;
}

export async function importSnapshot(target: TransferTarget, input: Snapshot | string): Promise<ImportReceipt> {
  const receipt: ImportReceipt = {
    version: 1, kind: "import", targetId: target.id, snapshotId: null, manifestDigest: null,
    status: "incomplete", phase: "preflight", confirmedRows: {}, writeOutcome: "not-started",
  };
  await writeJson(target.receiptPath, receipt, true);
  const save = () => writeJson(target.receiptPath, receipt);
  try {
    if (!["empty", "staging"].includes(target.intent)) throw new TransferError("TARGET_NOT_EMPTY");
    const snapshot = await verifyArtifact(input);
    receipt.snapshotId = snapshot.manifest.snapshotId;
    receipt.manifestDigest = await migrationChecksum(JSON.stringify(snapshot.manifest));
    const before = await inventorySource(target);
    if (before.sourceMigrationHistory === null) throw new TransferError("SCHEMA_DRIFT");
    if (before.tables.some((table) => table.rowCount !== 0) || before.sequence.length) throw new TransferError("TARGET_NOT_EMPTY");
    await save();
    for (const table of snapshot.manifest.schema.tables) {
      receipt.phase = "rows";
      receipt.confirmedRows[table.name] = 0;
      let batch: { sql: string; args: DbValue[] }[] = [];
      let bytes = 0;
      const flush = async () => {
        if (!batch.length) return;
        if (target.signal?.aborted) throw new TransferError("INCOMPLETE_IMPORT");
        receipt.writeOutcome = "partial-or-unknown";
        await save();
        await target.binding.batch(batch.map((statement) => target.binding.prepare(statement.sql).bind(...statement.args)));
        receipt.confirmedRows[table.name]! += batch.length;
        batch = []; bytes = 0;
        await save();
      };
      for await (const row of artifactRows(snapshot, table)) {
        const args: DbValue[] = [row.rowid, ...row.values.map((entry) => entry[1])];
        const binds = ["CAST(? AS INTEGER)", ...row.values.map(([type]) => type === "integer" ? "CAST(? AS INTEGER)" : type === "real" ? "CAST(? AS REAL)" : "?")];
        const sql = `INSERT INTO ${quote(table.name)} (rowid,${table.columns.map((column) => quote(String(column.name))).join(",")}) VALUES (${binds.join(",")})`;
        const size = Buffer.byteLength(JSON.stringify({ sql, args }));
        if (args.length > DB_LIMITS.maxParams || Buffer.byteLength(sql) > DB_LIMITS.maxSqlBytes || size > DB_LIMITS.maxRequestBytes) throw new TransferError("UNSUPPORTED_DATA");
        if (batch.length >= TRANSFER_LIMITS.batchStatements || bytes + size > DB_LIMITS.maxRequestBytes - 4096) await flush();
        batch.push({ sql, args }); bytes += size;
      }
      await flush();
    }
    if (target.signal?.aborted) throw new TransferError("INCOMPLETE_IMPORT");
    receipt.phase = "sequence";
    await save();
    const sequence = snapshot.manifest.sequence[0];
    const generated = await readSequence(target);
    if (sequence) {
      await target.binding.batch([generated.length
        ? target.binding.prepare("UPDATE sqlite_sequence SET seq = CAST(? AS INTEGER) WHERE name = 'games'").bind(sequence.seq)
        : target.binding.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('games', CAST(? AS INTEGER))").bind(sequence.seq)]);
    } else if (generated.length) throw new TransferError("ARTIFACT_INVALID");
    const imported = await inventorySource(target);
    if (!same(imported.tables, snapshot.manifest.tables) || !same(imported.sequence, snapshot.manifest.sequence)) throw new TransferError("CONTENT_MISMATCH");
    receipt.status = "imported"; receipt.phase = "complete"; receipt.writeOutcome = "imported";
    await save();
    return receipt;
  } catch (error) {
    receipt.status = "incomplete"; receipt.phase = "failed";
    receipt.errorCode = error instanceof TransferError ? error.code : "TRANSFER_FAILED";
    await save().catch(() => {});
    throw error instanceof TransferError ? error : new TransferError("TRANSFER_FAILED");
  }
}

export interface ValidationReport {
  status: "validated";
  snapshotId: string;
  tableCount: number;
  schemaFingerprint: string;
  behaviorChecks: string[];
}

export async function validateSnapshot(target: TransferTarget, input: Snapshot | string): Promise<ValidationReport> {
  const snapshot = await verifyArtifact(input);
  const value = await readJson(target.receiptPath);
  if (!isRecord(value) || value.version !== 1 || value.kind !== "import" || value.targetId !== target.id ||
    value.snapshotId !== snapshot.manifest.snapshotId || value.manifestDigest !== await migrationChecksum(JSON.stringify(snapshot.manifest)) ||
    !["imported", "validated"].includes(String(value.status)) || value.phase !== "complete" || value.writeOutcome !== "imported") throw new TransferError("INCOMPLETE_IMPORT");
  const receipt = value as unknown as ImportReceipt;
  receipt.status = "imported"; receipt.validation = { status: "incomplete" };
  await writeJson(target.receiptPath, receipt);
  try {
    const compare = async () => {
      const inventory = await inventorySource(target);
      if (!same(inventory.schema, snapshot.manifest.schema) || !same(inventory.tables, snapshot.manifest.tables) ||
        !same(inventory.sequence, snapshot.manifest.sequence) || inventory.sourceMigrationHistory === null) throw new TransferError("CONTENT_MISMATCH");
    };
    await compare();
    if (!target.verifyBehavior) throw new TransferError("BEHAVIOR_REQUIRED");
    const behavior = await target.verifyBehavior();
    const checks = ["viewer", "steam-status", "catalog-facts", "offers"];
    if (!isRecord(behavior) || !same(behavior.passed, checks)) throw new TransferError("BEHAVIOR_REQUIRED");
    await compare();
    receipt.status = "validated"; receipt.validation = { status: "passed", behaviorChecks: checks };
    await writeJson(target.receiptPath, receipt);
    return { status: "validated", snapshotId: snapshot.manifest.snapshotId, tableCount: snapshot.manifest.tables.length, schemaFingerprint: snapshot.manifest.schemaFingerprint, behaviorChecks: checks };
  } catch (error) {
    receipt.status = "imported"; receipt.validation = { status: "failed", errorCode: error instanceof TransferError ? error.code : "TRANSFER_FAILED" };
    await writeJson(target.receiptPath, receipt).catch(() => {});
    throw error instanceof TransferError ? error : new TransferError("TRANSFER_FAILED");
  }
}

export interface RollbackReceipt {
  version: 1;
  kind: "rollback-preparation";
  status: "incomplete" | "reconciliation-required";
  baselineSnapshotId: string;
  postCutoverSnapshotId: string;
  baselineManifestDigest: string;
  postCutoverManifestDigest: string;
  automaticReversion: false;
  sequenceChanged: boolean;
  delta: Record<string, { added: number; deleted: number; changed: number }>;
  reconciliationDigest?: string;
  errorCode?: string;
}

export async function prepareRollback(target: TransferSource, baselineSnapshot: Snapshot | string, destination: string): Promise<RollbackReceipt> {
  const baseline = await verifyArtifact(baselineSnapshot);
  const current = await exportSnapshot(target, destination, target.freezeRecord);
  const receipt: RollbackReceipt = {
    version: 1, kind: "rollback-preparation", status: "incomplete",
    baselineSnapshotId: baseline.manifest.snapshotId, postCutoverSnapshotId: current.manifest.snapshotId,
    baselineManifestDigest: await migrationChecksum(JSON.stringify(baseline.manifest)), postCutoverManifestDigest: await migrationChecksum(JSON.stringify(current.manifest)),
    automaticReversion: false, sequenceChanged: !same(baseline.manifest.sequence, current.manifest.sequence), delta: {},
  };
  const receiptPath = join(current.directory, "rollback-receipt.json");
  await writeJson(receiptPath, receipt, true);
  const deltaFile = await privateFile(join(current.directory, "reconciliation.jsonl"), true);
  const hash = new Bun.CryptoHasher("sha256");
  try {
    for (const table of baseline.manifest.schema.tables) {
      const counts = receipt.delta[table.name] = { added: 0, deleted: 0, changed: 0 };
      const previousRows = artifactRows(baseline, table);
      const currentRows = artifactRows(current, table);
      try {
        let previous = await previousRows.next();
        let next = await currentRows.next();
        while (!previous.done || !next.done) {
          const before = previous.done ? undefined : previous.value;
          const after = next.done ? undefined : next.value;
          let change: { table: string; rowid: number; before: SnapshotRow | null; after: SnapshotRow | null } | undefined;
          if (before && (!after || before.rowid < after.rowid)) {
            counts.deleted++;
            change = { table: table.name, rowid: before.rowid, before, after: null };
            previous = await previousRows.next();
          } else if (after && (!before || after.rowid < before.rowid)) {
            counts.added++;
            change = { table: table.name, rowid: after.rowid, before: null, after };
            next = await currentRows.next();
          } else if (before && after) {
            if (!same(before, after)) {
              counts.changed++;
              change = { table: table.name, rowid: before.rowid, before, after };
            }
            previous = await previousRows.next(); next = await currentRows.next();
          }
          if (change) {
            const line = JSON.stringify(change) + "\n";
            hash.update(line);
            await deltaFile.writeFile(line);
          }
        }
      } finally { await previousRows.return(undefined); await currentRows.return(undefined); }
    }
    await deltaFile.sync();
    receipt.reconciliationDigest = hash.digest("hex");
    receipt.status = "reconciliation-required";
    await writeJson(receiptPath, receipt);
    return receipt;
  } catch (error) {
    receipt.status = "incomplete"; receipt.errorCode = error instanceof TransferError ? error.code : "TRANSFER_FAILED";
    await writeJson(receiptPath, receipt).catch(() => {});
    throw error instanceof TransferError ? error : new TransferError("TRANSFER_FAILED");
  } finally { await deltaFile.close(); }
}

export async function readFreezeRecord(path: string): Promise<FreezeRecord> {
  const value = await readJson(path);
  if (!isRecord(value) || typeof value.sourceId !== "string") throw new TransferError("FREEZE_REQUIRED");
  const record = value as unknown as FreezeRecord;
  assertFreeze({ id: record.sourceId, scope: "isolated-local", freezeRecord: record, query: async () => [] });
  return record;
}

export async function openLocalTransferHandle(persistTo: string) {
  const directory = await privateDirectory(persistTo);
  const runtime = new Miniflare({
    modules: true, script: "export default {fetch(){return new Response(null)}}", d1Databases: ["DB"],
    d1Persist: join(directory, "v3", "d1"), cf: false, host: "127.0.0.1", port: 0,
  });
  try {
    return { binding: await runtime.getD1Database("DB"), dispose: () => runtime.dispose() };
  } catch { await runtime.dispose(); throw new TransferError("TRANSFER_FAILED"); }
}

export async function localBehaviorVerifier(binding: D1Database, modulePath: string): Promise<NonNullable<TransferTarget["verifyBehavior"]>> {
  const path = resolve(modulePath);
  const file = await privateFile(path);
  await file.close();
  const module = await import(pathToFileURL(path).href);
  if (typeof module.default !== "function") throw new TransferError("BEHAVIOR_REQUIRED");
  const client = createD1Client(binding);
  return async () => module.default(client);
}
