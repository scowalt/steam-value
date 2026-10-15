import type { D1Database } from "@cloudflare/workers-types";
import type { Client as LibsqlClient } from "@libsql/client";
import { createLocalD1 } from "./local-d1";
import { createGuardedImportReceiptPublication, privateDirectory, privateFile, readJson, writeJson } from "./transfer-artifacts";
import type { FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createD1Client } from "./d1";
import { DB_LIMITS, exactKeys, isRecord, type DbValue } from "./access";
import { TransferError } from "./transfer-error";
import { describeTables, packTransferRows, quote, readSchema, readSequence, recordRow, same, scalar, scanTables, tableSummary, TRANSFER_LIMITS } from "./transfer-native";
export { TransferError } from "./transfer-error";
export { TRANSFER_LIMITS } from "./transfer-native";
import { applyMigrations, loadMigrations, migrationChecksum } from "./migrations";
import { legacySchemaStatements, OBSERVED_LEGACY_OBJECTS_FINGERPRINT } from "./schema-profile";

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
      try {
        const prepared = binding.prepare(sql);
        return (await (args.length ? prepared.bind(...args) : prepared).all<Record<string, unknown>>()).results;
      } catch { throw new TransferError("TRANSFER_FAILED"); }
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
export interface SchemaCompatibility {
  profile: "prepared-d1-v2" | "observed-legacy-v1";
  targetSchemaFingerprint: string;
  rawDdlIdentical: boolean;
}
export interface SourceInventory {
  version: 1;
  source: { id: string; scope: TransferSource["scope"] };
  schemaStatus: "provisional-source-schema";
  schema: ReviewedSchema;
  schemaFingerprint: string;
  schemaCompatibility: SchemaCompatibility;
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
  columns: string[];
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

interface SchemaReview {
  schema: ReviewedSchema;
  legacySchema: ReviewedSchema;
  excluded: SchemaObject[];
  history: { id: string; checksum: string }[];
  ledger: Record<string, unknown>[];
}

let reviewed: Promise<SchemaReview> | undefined;
export async function reviewedSchema() {
  return reviewed ??= (async () => {
    const runtime = await createLocalD1({ databaseNames: ["LEGACY_PROFILE"] });
    try {
      const binding = runtime.binding;
      const migrations = await loadMigrations();
      await applyMigrations(binding, migrations);
      const source = createD1TransferSource(binding, { id: "reviewed-local-schema", freezeRecord: undefined! });
      const objects = await readSchema(source);
      const excluded = objects.filter((object) => ["_cf_METADATA", "steam_value_migrations", "sqlite_autoindex_steam_value_migrations_1"].includes(object.name));
      const application = objects.filter((object) => !excluded.includes(object) && object.name !== "sqlite_sequence");
      const sequenceObject = objects.find((object) => object.name === "sqlite_sequence")!;
      const legacyBinding = await runtime.getBinding("LEGACY_PROFILE");
      await legacyBinding.batch((await legacySchemaStatements()).map((sql) => legacyBinding.prepare(sql)));
      const legacy = createD1TransferSource(legacyBinding, { id: "reviewed-legacy-schema", freezeRecord: undefined! });
      const legacyObjects = (await readSchema(legacy)).filter((object) => !excluded.some((entry) => same(entry, object)) && object.name !== "sqlite_sequence");
      return {
        schema: { objects: application, tables: await describeTables(source, application), sequenceObject },
        legacySchema: { objects: legacyObjects, tables: await describeTables(legacy, legacyObjects), sequenceObject }, excluded,
        history: migrations.map(({ id, checksum }) => ({ id, checksum })),
        ledger: await source.query("SELECT id, checksum, schema_json FROM steam_value_migrations ORDER BY id"),
      };
    } finally { await runtime.dispose(); }
  })();
}

async function reviewedObjects(objects: SchemaObject[], expected: SchemaReview): Promise<boolean> {
  return same(objects, expected.schema.objects) || same(objects, expected.legacySchema.objects) ||
    await migrationChecksum(JSON.stringify(objects)) === OBSERVED_LEGACY_OBJECTS_FINGERPRINT;
}

async function schemaCompatibility(schema: ReviewedSchema, expected: SchemaReview): Promise<SchemaCompatibility> {
  if (!isRecord(schema) || !exactKeys(schema, ["objects", "tables", "sequenceObject"]) || Object.keys(schema).length !== 3) throw new TransferError("SCHEMA_DRIFT");
  const targetSchemaFingerprint = await migrationChecksum(JSON.stringify(expected.schema));
  if (same(schema, expected.schema)) return { profile: "prepared-d1-v2", targetSchemaFingerprint, rawDdlIdentical: true };
  if (same(schema.tables, expected.legacySchema.tables) && same(schema.sequenceObject, expected.legacySchema.sequenceObject)) {
    const fingerprint = await migrationChecksum(JSON.stringify(schema.objects));
    if (fingerprint === OBSERVED_LEGACY_OBJECTS_FINGERPRINT || same(schema.objects, expected.legacySchema.objects)) {
      return { profile: "observed-legacy-v1", targetSchemaFingerprint, rawDdlIdentical: false };
    }
  }
  throw new TransferError("SCHEMA_DRIFT");
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
  if (!same(sequenceObject, expected.schema.sequenceObject) || !await reviewedObjects(application, expected)) throw new TransferError("SCHEMA_DRIFT");
  const schema: ReviewedSchema = { objects: application, tables: await describeTables(source, application), sequenceObject: sequenceObject! };
  const compatibility = await schemaCompatibility(schema, expected);
  const hasHistory = excludedMetadata.some((object) => object.name === "steam_value_migrations");
  const hasHistoryIndex = excludedMetadata.some((object) => object.name === "sqlite_autoindex_steam_value_migrations_1");
  if (hasHistory !== hasHistoryIndex || (hasHistory && compatibility.profile !== "prepared-d1-v2")) throw new TransferError("SCHEMA_DRIFT");
  const ledger = hasHistory ? await source.query("SELECT id, checksum, schema_json FROM steam_value_migrations ORDER BY id") : null;
  if (ledger !== null && !same(ledger, expected.ledger)) throw new TransferError("SCHEMA_DRIFT");
  const sourceMigrationHistory = ledger === null ? null : ledger.map((row) => {
    if (typeof row.id !== "string" || typeof row.checksum !== "string") throw new TransferError("SCHEMA_DRIFT");
    return { id: row.id, checksum: row.checksum };
  });
  if (sourceMigrationHistory !== null && !same(sourceMigrationHistory, expected.history)) throw new TransferError("SCHEMA_DRIFT");
  const tables = await scanTables(source, expected.schema, onRow);
  const sequence = await readSequence(source);
  if (tables.find((table) => table.name === "games")!.rowCount > 0 && sequence.length === 0) throw new TransferError("UNSUPPORTED_DATA");
  return {
    version: 1, source: { id: source.id, scope: source.scope }, schemaStatus: "provisional-source-schema",
    schema, schemaFingerprint: await migrationChecksum(JSON.stringify(schema)), schemaCompatibility: compatibility,
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
  readonly receiptPublisher: ImportReceiptPublisher;
  readonly signal?: AbortSignal;
  readonly verifyBehavior?: () => Promise<{ passed: string[] }>;
}

export function createD1TransferTarget(binding: D1Database, options: SourceOptions & {
  intent: TransferTarget["intent"]; receiptPath: string; signal?: AbortSignal; scope?: TransferSource["scope"];
  verifyBehavior?: TransferTarget["verifyBehavior"]; receiptPublisher?: ImportReceiptPublisher;
}): TransferTarget {
  return { ...options, ...createD1TransferSource(binding, options), binding,
    receiptPublisher: options.receiptPublisher ?? createProtectedImportReceiptPublisher(options.receiptPath),
  };
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

export interface ImportReceiptPublisher {
  publish(receipt: ImportReceipt, create: boolean): Promise<void>;
}

export function createProtectedImportReceiptPublisher(receiptPath: string): ImportReceiptPublisher {
  return { publish: (receipt, create) => writeJson(receiptPath, receipt, create) };
}

async function openSnapshot(input: Snapshot | string): Promise<Snapshot> {
  const directory = await privateDirectory(typeof input === "string" ? input : input.directory);
  const value = await readJson(join(directory, "manifest.json"));
  const receipt = await readJson(join(directory, "export-receipt.json"));
  const expected = await reviewedSchema();
  const keys = ["version", "source", "schemaStatus", "schema", "schemaFingerprint", "schemaCompatibility", "migrationFingerprint", "migrationHistory", "sourceMigrationHistory", "excludedMetadata", "tables", "sequence", "snapshotId", "createdAt", "freezeRecord"];
  if (!isRecord(value) || !exactKeys(value, keys) || Object.keys(value).length !== keys.length || value.version !== 1 ||
    typeof value.snapshotId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.snapshotId) ||
    typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0 ||
    !isRecord(value.source) || typeof value.source.id !== "string" || !["isolated-local", "approved-operator"].includes(String(value.source.scope)) ||
    value.schemaStatus !== "provisional-source-schema" ||
    value.schemaFingerprint !== await migrationChecksum(JSON.stringify(value.schema)) ||
    !same(value.migrationHistory, expected.history) || value.migrationFingerprint !== await migrationChecksum(JSON.stringify(expected.history)) ||
    !(value.sourceMigrationHistory === null || same(value.sourceMigrationHistory, expected.history)) ||
    !Array.isArray(value.excludedMetadata) || !value.excludedMetadata.every((object) => expected.excluded.some((entry) => same(entry, object))) ||
    !Array.isArray(value.tables) || value.tables.length !== expected.schema.tables.length ||
    !Array.isArray(value.sequence) || value.sequence.length > 1 || value.sequence.some((entry) => !isRecord(entry) || entry.name !== "games" || typeof entry.seq !== "number" || !Number.isSafeInteger(entry.seq) || entry.seq < 0) ||
    !isRecord(receipt) || receipt.status !== "complete" || receipt.snapshotId !== value.snapshotId || receipt.manifestDigest !== await migrationChecksum(JSON.stringify(value))) throw new TransferError("ARTIFACT_INVALID");
  const manifest = value as unknown as SnapshotManifest;
  let compatibility: SchemaCompatibility;
  try { compatibility = await schemaCompatibility(manifest.schema, expected); }
  catch { throw new TransferError("ARTIFACT_INVALID"); }
  const hasHistory = manifest.excludedMetadata.some((object) => object.name === "steam_value_migrations");
  const hasHistoryIndex = manifest.excludedMetadata.some((object) => object.name === "sqlite_autoindex_steam_value_migrations_1");
  if (!same(compatibility, manifest.schemaCompatibility) || hasHistory !== hasHistoryIndex ||
    hasHistory !== (manifest.sourceMigrationHistory !== null) || (hasHistory && compatibility.profile !== "prepared-d1-v2") ||
    new Set(manifest.excludedMetadata.map((object) => object.name)).size !== manifest.excludedMetadata.length) throw new TransferError("ARTIFACT_INVALID");
  assertFreeze({ ...manifest.source, freezeRecord: manifest.freezeRecord, query: async () => [] });
  for (const [index, table] of manifest.tables.entries()) {
    if (table.name !== expected.schema.tables[index]!.name || table.file !== `${table.name}.jsonl` ||
      !same(table.columns, expected.schema.tables[index]!.columns.map((column) => column.name)) ||
      !Number.isSafeInteger(table.rowCount) || table.rowCount < 0 || !Number.isSafeInteger(table.bytes) || table.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(table.contentDigest) || !Array.isArray(table.storageTypes) || table.storageTypes.length !== expected.schema.tables[index]!.columns.length) throw new TransferError("ARTIFACT_INVALID");
  }
  return { directory, manifest };
}

export async function* artifactRows(snapshot: Snapshot, table: SchemaTable): AsyncGenerator<SnapshotRow> {
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

export async function verifyArtifact(input: Snapshot | string) {
  const snapshot = await openSnapshot(input);
  for (const table of (await reviewedSchema()).schema.tables) for await (const _row of artifactRows(snapshot, table)) {}
  return snapshot;
}

export async function importSnapshot(target: TransferTarget, input: Snapshot | string): Promise<ImportReceipt> {
  const receipt: ImportReceipt = {
    version: 1, kind: "import", targetId: target.id, snapshotId: null, manifestDigest: null,
    status: "incomplete", phase: "preflight", confirmedRows: {}, writeOutcome: "not-started",
  };
  const publish = createGuardedImportReceiptPublication(target.receiptPath, target.receiptPublisher);
  await publish(receipt, true);
  const save = () => publish(receipt);
  try {
    if (!["empty", "staging"].includes(target.intent)) throw new TransferError("TARGET_NOT_EMPTY");
    const snapshot = await verifyArtifact(input);
    receipt.snapshotId = snapshot.manifest.snapshotId;
    receipt.manifestDigest = await migrationChecksum(JSON.stringify(snapshot.manifest));
    const before = await inventorySource(target);
    if (before.sourceMigrationHistory === null || before.schemaCompatibility.profile !== "prepared-d1-v2") throw new TransferError("SCHEMA_DRIFT");
    if (before.tables.some((table) => table.rowCount !== 0) || before.sequence.length) throw new TransferError("TARGET_NOT_EMPTY");
    const tables = (await reviewedSchema()).schema.tables;
    receipt.confirmedRows = Object.fromEntries(tables.map((table) => [table.name, 0]));
    await save();
    for (const table of tables) {
      receipt.phase = "rows";
      for await (const group of packTransferRows(table, artifactRows(snapshot, table))) {
        if (target.signal?.aborted) throw new TransferError("INCOMPLETE_IMPORT");
        receipt.writeOutcome = "partial-or-unknown";
        await save();
        const statements = group.statements.map((statement) => target.binding.prepare(statement.sql).bind(...statement.args));
        if (target.signal?.aborted) throw new TransferError("INCOMPLETE_IMPORT");
        await target.binding.batch(statements);
        receipt.confirmedRows[table.name]! += group.statements.reduce((count, statement) => count + statement.rows, 0);
        if (target.signal?.aborted) throw new TransferError("INCOMPLETE_IMPORT");
        await save();
        if (target.signal?.aborted) throw new TransferError("INCOMPLETE_IMPORT");
      }
    }
    if (target.signal?.aborted) throw new TransferError("INCOMPLETE_IMPORT");
    receipt.phase = "sequence";
    await save();
    if (target.signal?.aborted) throw new TransferError("INCOMPLETE_IMPORT");
    const sequence = snapshot.manifest.sequence[0];
    const generated = await readSequence(target);
    if (target.signal?.aborted) throw new TransferError("INCOMPLETE_IMPORT");
    if (sequence) {
      receipt.writeOutcome = "partial-or-unknown";
      await save();
      const statements = [generated.length
        ? target.binding.prepare("UPDATE sqlite_sequence SET seq = CAST(? AS INTEGER) WHERE name = 'games'").bind(sequence.seq)
        : target.binding.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('games', CAST(? AS INTEGER))").bind(sequence.seq)];
      if (target.signal?.aborted) throw new TransferError("INCOMPLETE_IMPORT");
      await target.binding.batch(statements);
      if (target.signal?.aborted) throw new TransferError("INCOMPLETE_IMPORT");
    } else if (generated.length) throw new TransferError("ARTIFACT_INVALID");
    const imported = await inventorySource(target);
    if (target.signal?.aborted) throw new TransferError("INCOMPLETE_IMPORT");
    if (!same(imported.tables, snapshot.manifest.tables) || !same(imported.sequence, snapshot.manifest.sequence)) throw new TransferError("CONTENT_MISMATCH");
    const complete: ImportReceipt = { ...receipt, status: "imported", phase: "complete", writeOutcome: "imported" };
    await publish(complete);
    if (target.signal?.aborted) throw new TransferError("INCOMPLETE_IMPORT");
    return complete;
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
  sourceSchemaFingerprint: string;
  schemaCompatibility: SchemaCompatibility;
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
      if (inventory.schemaCompatibility.profile !== "prepared-d1-v2" || inventory.schemaFingerprint !== snapshot.manifest.schemaCompatibility.targetSchemaFingerprint ||
        !same(inventory.tables, snapshot.manifest.tables) || !same(inventory.sequence, snapshot.manifest.sequence) || inventory.sourceMigrationHistory === null) throw new TransferError("CONTENT_MISMATCH");
    };
    await compare();
    if (!target.verifyBehavior) throw new TransferError("BEHAVIOR_REQUIRED");
    const behavior = await target.verifyBehavior();
    const checks = ["viewer", "steam-status", "catalog-facts", "offers"];
    if (!isRecord(behavior) || !same(behavior.passed, checks)) throw new TransferError("BEHAVIOR_REQUIRED");
    await compare();
    receipt.status = "validated"; receipt.validation = { status: "passed", behaviorChecks: checks };
    await writeJson(target.receiptPath, receipt);
    return { status: "validated", snapshotId: snapshot.manifest.snapshotId, tableCount: snapshot.manifest.tables.length,
      schemaFingerprint: snapshot.manifest.schemaCompatibility.targetSchemaFingerprint, sourceSchemaFingerprint: snapshot.manifest.schemaFingerprint,
      schemaCompatibility: snapshot.manifest.schemaCompatibility, behaviorChecks: checks };
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
    for (const table of (await reviewedSchema()).schema.tables) {
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
  try {
    const owner = await createLocalD1({ persistTo: directory });
    return { binding: owner.binding, dispose: owner.dispose };
  } catch { throw new TransferError("TRANSFER_FAILED"); }
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
