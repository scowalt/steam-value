import type { D1Database } from "@cloudflare/workers-types";
import { byteLength, DbError, DB_LIMITS, exactKeys, isJsonMediaType, isRecord, isRequestId, nativeSqlFailure, readBoundedJson, validateStatement, type DbValue } from "./access";
import { migrationChecksum, prepareMigrationGroup, schemaJsonQuery, validateMigrationHistory, type DbMigration } from "./migrations-native";
import { createNativeTransferReader, describeTables, packTransferRows, quote, readSchema, readSequence, readTransferPage, recordRow, scalar, tableSummary, transferReadBounds, TRANSFER_LIMITS } from "./transfer-native";
import { TransferError } from "./transfer-error";
import { estimateFixedD1Verification, scanFixedD1Tables } from "./fixed-job-native";
import type { ReviewedSchema, SnapshotRow, SourceInventory } from "./transfer";

export interface FixedD1Group {
  index: number;
  table: string;
  rows: SnapshotRow[];
}

export interface FixedD1Job {
  version: 1;
  runId: string;
  expiresAt: number;
  target: { id: string; binding: "DB"; intent: "empty" | "staging" };
  capabilityDigest: string;
  snapshotId: string;
  snapshotDigest: string;
  sourceSchemaFingerprint: string;
  sourceProfile: "prepared-d1-v2" | "observed-legacy-v1";
  targetSchemaFingerprint: string;
  schemaObjectsDigest: string;
  excludedMetadataDigest: string;
  ledgerDigest: string;
  migrationFingerprint: string;
  migrations: { id: string; checksum: string }[];
  tables: SourceInventory["tables"];
  sequence: SourceInventory["sequence"];
  groups: { index: number; table: string; rowCount: number; lastRowid: number; digest: string }[];
}

const tableNames = ["__drizzle_migrations", "catalog_refresh_failures", "catalog_refresh_state", "deal_refresh_state", "game_deal_cache", "games", "itad_game_map", "sync_state"];
const history = [
  { id: "0001_complete_schema.sql", checksum: "bcb5a3738c65336b9af697be9816d3039edffd9da0ef627cc50da5ecf5d0a83a" },
  { id: "0002_retain_legacy_metadata.sql", checksum: "c2bda4e5782d3c7f51e0a035d41abf02c8e36ea70645ee8fba043400d81d0d8e" },
];
const digest = (value: unknown) => migrationChecksum(JSON.stringify(value));
const hashPattern = /^[a-f0-9]{64}$/;

export async function validateFixedD1Job(job: FixedD1Job, migrations: readonly DbMigration[]) {
  const fields = ["version", "runId", "expiresAt", "target", "capabilityDigest", "snapshotId", "snapshotDigest", "sourceSchemaFingerprint", "sourceProfile", "targetSchemaFingerprint", "schemaObjectsDigest", "excludedMetadataDigest", "ledgerDigest", "migrationFingerprint", "migrations", "tables", "sequence", "groups"];
  if (!isRecord(job) || !exactKeys(job, fields) || Object.keys(job).length !== fields.length || !isRecord(job.target) || !exactKeys(job.target, ["id", "binding", "intent"]) || Object.keys(job.target).length !== 3) throw new TransferError("ARTIFACT_INVALID");
  if (job.version !== 1 || !isRequestId(job.runId) || !isRequestId(job.snapshotId) || !Number.isSafeInteger(job.expiresAt) ||
    job.target?.binding !== "DB" || !/^[a-zA-Z0-9_-]{1,80}$/.test(job.target.id) || !["empty", "staging"].includes(job.target.intent) ||
    !["prepared-d1-v2", "observed-legacy-v1"].includes(job.sourceProfile) ||
    ![job.capabilityDigest, job.snapshotDigest, job.sourceSchemaFingerprint, job.targetSchemaFingerprint, job.schemaObjectsDigest, job.excludedMetadataDigest, job.ledgerDigest, job.migrationFingerprint].every((value) => typeof value === "string" && hashPattern.test(value)) ||
    JSON.stringify(job.migrations) !== JSON.stringify(history) || job.migrationFingerprint !== await digest(history) ||
    JSON.stringify(migrations.map(({ id, checksum }) => ({ id, checksum }))) !== JSON.stringify(history) ||
    !Array.isArray(job.tables) || JSON.stringify(job.tables.map((table) => table.name)) !== JSON.stringify(tableNames) ||
    !Array.isArray(job.groups) || !Array.isArray(job.sequence) || job.sequence.length > 1 ||
    job.sequence.some((entry) => !isRecord(entry) || !exactKeys(entry, ["name", "seq"]) || Object.keys(entry).length !== 2 || entry.name !== "games" || !Number.isSafeInteger(entry.seq) || entry.seq < 0) ||
    byteLength(JSON.stringify(job)) > TRANSFER_LIMITS.maxManifestBytes) throw new TransferError("ARTIFACT_INVALID");
  await validateMigrationHistory(migrations);
  const totals: Record<string, number> = Object.fromEntries(tableNames.map((name) => [name, 0]));
  let previous = -1;
  for (const [index, group] of job.groups.entries()) {
    const tableIndex = tableNames.indexOf(group.table);
    if (!isRecord(group) || !exactKeys(group, ["index", "table", "rowCount", "lastRowid", "digest"]) || Object.keys(group).length !== 5 || group.index !== index || tableIndex < previous || tableIndex < 0 || !Number.isSafeInteger(group.rowCount) || group.rowCount <= 0 || group.rowCount > 6400 || !Number.isSafeInteger(group.lastRowid) || !hashPattern.test(group.digest)) throw new TransferError("ARTIFACT_INVALID");
    previous = tableIndex;
    totals[group.table]! += group.rowCount;
  }
  if (job.tables.some((table) => table.rowCount !== totals[table.name])) throw new TransferError("ARTIFACT_INVALID");
  estimateFixedD1Verification(job.tables);
}

async function fixedSchema(binding: D1Database, job: FixedD1Job): Promise<ReviewedSchema> {
  const source = createNativeTransferReader(binding);
  const raw = await readSchema(source);
  const excluded = raw.filter((object) => ["_cf_METADATA", "steam_value_migrations", "sqlite_autoindex_steam_value_migrations_1"].includes(object.name));
  const objects = raw.filter((object) => !excluded.includes(object) && object.name !== "sqlite_sequence");
  if (await digest(excluded) !== job.excludedMetadataDigest || await digest(objects) !== job.schemaObjectsDigest) throw new TransferError("SCHEMA_DRIFT");
  const sequenceObject = raw.find((object) => object.name === "sqlite_sequence");
  if (!sequenceObject) throw new TransferError("SCHEMA_DRIFT");
  const schema: ReviewedSchema = { objects, tables: await describeTables(source, objects), sequenceObject };
  if (await digest(schema) !== job.targetSchemaFingerprint || await digest(await source.query("SELECT id, checksum, schema_json FROM steam_value_migrations ORDER BY id")) !== job.ledgerDigest ||
    schema.tables.some((table, index) => JSON.stringify(table.columns.map((column) => column.name)) !== JSON.stringify(job.tables[index]?.columns))) throw new TransferError("SCHEMA_DRIFT");
  return schema;
}

async function uninitialized(binding: D1Database) {
  const objects = await readSchema(createNativeTransferReader(binding));
  if (objects.some((object) => object.name !== "_cf_METADATA")) return false;
  const object = objects[0];
  if (objects.length > 1 || (object && (object.type !== "table" || object.tbl_name !== "_cf_METADATA" || typeof object.sql !== "string" || await migrationChecksum(object.sql) !== "f197d62ec9699924d941575fe9a9fbb42ef9fde5416b7693f51ebe970c5ff160"))) throw new TransferError("SCHEMA_DRIFT");
  return true;
}

function checkedGroup(value: unknown, job: FixedD1Job): FixedD1Group {
  if (!isRecord(value) || !exactKeys(value, ["index", "table", "rows"]) || Object.keys(value).length !== 3 || typeof value.index !== "number" || !Number.isSafeInteger(value.index) || value.index < 0) throw new TransferError("ARTIFACT_INVALID");
  const fixed = job.groups[value.index];
  const table = job.tables.find((entry) => entry.name === value.table);
  if (!fixed || !table || value.table !== fixed.table || !Array.isArray(value.rows) || value.rows.length !== fixed.rowCount) throw new TransferError("ARTIFACT_INVALID");
  let cursor = job.groups.slice(0, value.index).findLast((entry) => entry.table === value.table)?.lastRowid;
  const rows = value.rows.map((row: unknown): SnapshotRow => {
    if (!isRecord(row) || !exactKeys(row, ["rowid", "values"]) || Object.keys(row).length !== 2 || typeof row.rowid !== "number" || !Number.isSafeInteger(row.rowid) || Object.is(row.rowid, -0) ||
      (cursor !== undefined && row.rowid <= cursor) || !Array.isArray(row.values) || row.values.length !== table.columns.length) throw new TransferError("ARTIFACT_INVALID");
    const values = row.values.map((entry: unknown) => {
      if (!Array.isArray(entry) || entry.length !== 2) throw new TransferError("ARTIFACT_INVALID");
      return scalar(entry[0], entry[1]);
    });
    cursor = row.rowid;
    const checked = { rowid: row.rowid, values };
    if (byteLength(JSON.stringify(checked) + "\n") > TRANSFER_LIMITS.maxRowBytes) throw new TransferError("UNSUPPORTED_DATA");
    return checked;
  });
  if (cursor !== fixed.lastRowid) throw new TransferError("ARTIFACT_INVALID");
  return { index: value.index, table: fixed.table, rows };
}

function progressGuard(job: FixedD1Job, index: number) {
  const before = job.groups.slice(0, index);
  const counts = Object.fromEntries(tableNames.map((name) => [name, before.filter((group) => group.table === name).reduce((total, group) => total + group.rowCount, 0)]));
  const games = before.filter((group) => group.table === "games");
  const sequence = games.length ? Math.max(0, ...games.map((group) => group.lastRowid)) : undefined;
  const conditions = ["unixepoch() < ?", ...tableNames.map((table) => `(SELECT COUNT(*) FROM ${quote(table)}) = ${counts[table]}`),
    `(SELECT COUNT(*) FROM sqlite_sequence) = ${sequence === undefined ? 0 : 1}`,
    ...(sequence === undefined ? [] : [`EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='games' AND typeof(seq)='integer' AND seq=${sequence})`]),
    `(SELECT schema_json FROM steam_value_migrations ORDER BY id DESC LIMIT 1) = (${schemaJsonQuery})`];
  return { sql: `SELECT json(CASE WHEN ${conditions.join(" AND ")} THEN 'true' ELSE '!' END) AS admitted`, args: [job.expiresAt] };
}

function preparedWriteGroup(binding: D1Database, statements: { sql: string; args: DbValue[] }[]) {
  const checked = statements.map(({ sql, args }) => validateStatement({ sql, args }));
  if (checked.length > TRANSFER_LIMITS.batchStatements || byteLength(JSON.stringify(checked.map(({ sql, args }) => ({ sql, args })))) > DB_LIMITS.maxRequestBytes) throw new TransferError("UNSUPPORTED_DATA");
  return checked.map(({ sql, args }) => binding.prepare(sql).bind(...args));
}

function json(value: unknown, status = 200) {
  const text = JSON.stringify(value);
  if (byteLength(text) > DB_LIMITS.maxResponseBytes) throw new TransferError("UNSUPPORTED_DATA");
  return new Response(text, { status, headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } });
}

export async function authenticateFixedD1Capability(expected: string, capability: string) {
  if (!hashPattern.test(expected)) return false;
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(capability)));
  let difference = /^\S+$/.test(capability) ? 0 : 1;
  for (let index = 0; index < 32; index++) difference |= bytes[index]! ^ Number.parseInt(expected.slice(index * 2, index * 2 + 2), 16);
  return difference === 0;
}

export function createFixedD1JobWorker(job: FixedD1Job, migrations: readonly DbMigration[]) {
  return {
    async fetch(request: Request, env: { DB?: D1Database }): Promise<Response> {
      const failure = (code: string, status: number, outcome = "not-applied") => json({ ok: false, code, outcome }, status);
      if (!hashPattern.test(job.capabilityDigest)) return failure("NOT_CONFIGURED", 503);
      const capability = request.headers.get("Authorization")?.match(/^Bearer (\S+)$/i)?.[1] ?? "";
      if (!await authenticateFixedD1Capability(job.capabilityDigest, capability)) return failure("UNAUTHORIZED", 401);
      let dispatched = false;
      try {
        await validateFixedD1Job(job, migrations);
        if (Math.floor(Date.now() / 1000) >= job.expiresAt) return failure("EXPIRED", 410);
        if (!env.DB) return failure("NOT_CONFIGURED", 503);
        const url = new URL(request.url);
        if (url.pathname !== "/job" || url.search || request.method !== "POST" || !isJsonMediaType(request.headers.get("Content-Type")) || ![null, "identity"].includes(request.headers.get("Content-Encoding"))) return failure("ARTIFACT_INVALID", 400);
        const body = await readBoundedJson(request.body, DB_LIMITS.maxRequestBytes, "LIMIT_EXCEEDED", "INVALID_REQUEST");
        const extra = isRecord(body) && body.op === "rows" ? ["group"] : isRecord(body) && body.op === "page" ? ["table", "cursor"] : [];
        if (!isRecord(body) || !exactKeys(body, ["version", "op", "runId", "targetId", "intent", "snapshotDigest", ...extra]) || Object.keys(body).length !== 6 + extra.length ||
          body.version !== 1 || body.runId !== job.runId || body.targetId !== job.target.id || body.intent !== job.target.intent || body.snapshotDigest !== job.snapshotDigest || !["bootstrap", "inventory", "rows", "page", "sequence", "validate"].includes(String(body.op))) return failure("ARTIFACT_INVALID", 400);
        if (body.op === "bootstrap") {
          if (!await uninitialized(env.DB)) return failure("TARGET_NOT_EMPTY", 409);
          const batch = [env.DB.prepare("SELECT json(CASE WHEN unixepoch() < ? AND NOT EXISTS (SELECT 1 FROM sqlite_schema WHERE name <> '_cf_METADATA') THEN 'true' ELSE '!' END) AS admitted").bind(job.expiresAt),
            ...migrations.flatMap((migration, index) => prepareMigrationGroup(env.DB!, migration, index === 0))];
          if (batch.length > TRANSFER_LIMITS.batchStatements) throw new TransferError("UNSUPPORTED_DATA");
          dispatched = true;
          const result = await env.DB.batch(batch);
          if (result.length !== batch.length || result.some((item) => !item.success)) return failure("OUTCOME_UNKNOWN", 503, "unknown");
          await fixedSchema(env.DB, job);
          return json({ ok: true, state: "prepared", schemaFingerprint: job.targetSchemaFingerprint });
        }
        if (body.op === "rows") {
          const group = checkedGroup(body.group, job);
          const fixed = job.groups[group.index]!;
          if (await digest(group) !== fixed.digest || JSON.stringify(group) !== JSON.stringify(body.group)) return failure("ARTIFACT_INVALID", 400);
          const schema = await fixedSchema(env.DB, job);
          const table = schema.tables.find((entry) => entry.name === group.table)!;
          const statements: { sql: string; args: DbValue[] }[] = [progressGuard(job, group.index)];
          for await (const packed of packTransferRows(table, (async function* () { yield* group.rows; })())) statements.push(...packed.statements);
          const batch = preparedWriteGroup(env.DB, statements);
          dispatched = true;
          const result = await env.DB.batch(batch);
          if (result.length !== batch.length || result.some((item) => !item.success)) return failure("OUTCOME_UNKNOWN", 503, "unknown");
          return json({ ok: true, index: group.index, rows: group.rows.length, digest: fixed.digest });
        }
        if (body.op === "page" && (!tableNames.includes(String(body.table)) || !(body.cursor === null || (typeof body.cursor === "number" && Number.isSafeInteger(body.cursor))))) return failure("ARTIFACT_INVALID", 400);
        if (body.op === "inventory" && await uninitialized(env.DB)) return json({ ok: true, state: "uninitialized" });
        const schema = await fixedSchema(env.DB, job);
        const source = createNativeTransferReader(env.DB);
        if (body.op === "page") {
          const table = schema.tables.find((entry) => entry.name === body.table)!;
          const bounds = await transferReadBounds(source, table);
          const rows = await readTransferPage(source, table, typeof body.cursor === "number" ? body.cursor : undefined, bounds.pageSize);
          const summary = tableSummary(table);
          for (const row of rows) recordRow(summary, row);
          return json({ ok: true, columns: ["rowid", ...table.columns.map((column) => column.name)], rows, cursor: rows.at(-1)?.rowid ?? body.cursor, complete: rows.length < bounds.pageSize });
        }
        const tables = await scanFixedD1Tables(source, schema);
        const sequence = await readSequence(source);
        if (body.op === "sequence") {
          if (JSON.stringify(tables) !== JSON.stringify(job.tables)) return failure("ORDER_REFUSED", 409);
          const requested = job.sequence[0];
          const games = job.groups.filter((group) => group.table === "games");
          const generated = games.length ? Math.max(0, ...games.map((group) => group.lastRowid)) : undefined;
          const expectedGenerated = generated === undefined ? [] : [{ name: "games", seq: generated }];
          if (JSON.stringify(expectedGenerated) === JSON.stringify(job.sequence)) {
            if (JSON.stringify(sequence) !== JSON.stringify(job.sequence)) return failure("ORDER_REFUSED", 409);
            return json({ ok: true, phase: "sequence", changed: false });
          }
          if (!requested) throw new TransferError("ARTIFACT_INVALID");
          const batch = preparedWriteGroup(env.DB, [progressGuard(job, job.groups.length), generated === undefined
            ? { sql: "INSERT INTO sqlite_sequence (name, seq) VALUES ('games', CAST(? AS INTEGER))", args: [requested.seq] }
            : { sql: "UPDATE sqlite_sequence SET seq = CAST(? AS INTEGER) WHERE name = 'games'", args: [requested.seq] }]);
          dispatched = true;
          const result = await env.DB.batch(batch);
          if (result.length !== batch.length || result.some((item) => !item.success) || JSON.stringify(await readSequence(source)) !== JSON.stringify(job.sequence)) return failure("OUTCOME_UNKNOWN", 503, "unknown");
          return json({ ok: true, phase: "sequence", changed: true });
        }
        if (body.op === "validate") {
          if (JSON.stringify(tables) !== JSON.stringify(job.tables) || JSON.stringify(sequence) !== JSON.stringify(job.sequence)) return failure("CONTENT_MISMATCH", 409);
          return json({ ok: true, status: "data-verified", schemaFingerprint: job.targetSchemaFingerprint, tables, sequence });
        }
        return json({ ok: true, state: "prepared", schemaFingerprint: job.targetSchemaFingerprint, schema, tables, sequence });
      } catch (error) {
        if (dispatched && error instanceof Error && /^D1_ERROR:.*malformed JSON.*SQLITE_ERROR/s.test(error.message)) return failure("ORDER_REFUSED", 409, "rolled-back");
        if (dispatched && nativeSqlFailure(error)) return failure("GROUP_ROLLED_BACK", 422, "rolled-back");
        if (dispatched) return failure("OUTCOME_UNKNOWN", 503, "unknown");
        if (error instanceof DbError && error.code === "LIMIT_EXCEEDED") return failure("LIMIT_EXCEEDED", 413);
        return failure(error instanceof TransferError ? error.code : "ARTIFACT_INVALID", error instanceof TransferError && error.code === "SCHEMA_DRIFT" ? 409 : 400);
      }
    },
  };
}
