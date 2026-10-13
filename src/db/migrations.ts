import type { D1Database } from "@cloudflare/workers-types";
import { fileURLToPath } from "node:url";

export interface DbMigration {
  readonly id: string;
  readonly sql: string;
  readonly checksum: string;
}

export async function loadMigrations(directory = new URL("../../migrations/", import.meta.url)): Promise<DbMigration[]> {
  const files = await Array.fromAsync(new Bun.Glob("*.sql").scan({ cwd: fileURLToPath(directory) }));
  return Promise.all(files.sort().map(async (id) => {
    const sql = await Bun.file(new URL(id, directory)).text();
    return { id, sql, checksum: await migrationChecksum(sql) };
  }));
}

export async function migrationChecksum(sql: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sql));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface MigrationReport {
  applied: string[];
  alreadyApplied: string[];
  schemaFingerprint: string;
}

export class MigrationError extends Error {
  constructor(readonly code: "MIGRATION_CHANGED" | "SCHEMA_DRIFT" | "INVALID_MIGRATION" | "MIGRATION_FAILED", message: string, readonly migrationId?: string) {
    super(message);
    this.name = "MigrationError";
  }
}

const metadataTable = "steam_value_migrations";
const metadataCreateSql = `CREATE TABLE ${metadataTable} (
  id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, schema_json TEXT NOT NULL,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch())
)`;
const schemaJsonQuery = `SELECT json_group_array(json_object('type', type, 'name', name, 'table', tbl_name, 'sql', sql)) AS schema_json
  FROM (SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE name <> '_cf_METADATA'
      AND tbl_name NOT IN ('${metadataTable}', 'sqlite_sequence')
    ORDER BY type, name)`;

export async function applyMigrations(binding: D1Database, migrations: readonly DbMigration[]): Promise<MigrationReport> {
  if (migrations.length === 0) throw new MigrationError("INVALID_MIGRATION", "Explicit migration history cannot be empty");
  for (const [index, migration] of migrations.entries()) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(migration.id) || (index > 0 && migrations[index - 1]!.id.slice(0, 4) >= migration.id.slice(0, 4))) {
      throw new MigrationError("INVALID_MIGRATION", "Migration identifiers must be ordered, unique SQL filenames");
    }
    if (!migration.sql.trim() || await migrationChecksum(migration.sql) !== migration.checksum) {
      throw new MigrationError("INVALID_MIGRATION", "Migration checksum must describe nonempty SQL", migration.id);
    }
    if (splitMigrationSql(migration.sql).length === 0) {
      throw new MigrationError("INVALID_MIGRATION", "Migration SQL must contain a statement", migration.id);
    }
  }
  const readSchemaText = async () => {
    try {
      const value = await binding.prepare(schemaJsonQuery).first<unknown>("schema_json");
      if (typeof value !== "string") throw new Error("Incompatible metadata value");
      return value;
    } catch {
      throw new MigrationError("SCHEMA_DRIFT", "Schema inventory is unavailable or incompatible; stop for reviewed inspection");
    }
  };
  let metadata: { type: string; name: string; tbl_name: string; sql: string }[];
  try {
    metadata = (await binding.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN ('_cf_METADATA','sqlite_sequence',?) ORDER BY name").bind(metadataTable).all<{ type: string; name: string; tbl_name: string; sql: string }>()).results;
    if (metadata.some((object) => object.type !== "table" || object.tbl_name !== object.name || typeof object.sql !== "string")) throw new Error("Incompatible metadata object");
  } catch {
    throw new MigrationError("SCHEMA_DRIFT", "Schema inventory is unavailable or incompatible; stop for reviewed inspection");
  }
  const internalSql = metadata.find((object) => object.name === "_cf_METADATA")?.sql ?? null;
  if (internalSql !== null && await migrationChecksum(internalSql) !== "f197d62ec9699924d941575fe9a9fbb42ef9fde5416b7693f51ebe970c5ff160") {
    throw new MigrationError("SCHEMA_DRIFT", "Native D1 metadata has an incompatible schema");
  }
  const sequenceSql = metadata.find((object) => object.name === "sqlite_sequence")?.sql ?? null;
  if (sequenceSql !== null && sequenceSql !== "CREATE TABLE sqlite_sequence(name,seq)") {
    throw new MigrationError("SCHEMA_DRIFT", "Sequence metadata has an incompatible schema");
  }
  const metadataSql = metadata.find((object) => object.name === metadataTable)?.sql ?? null;
  const hasMetadata = metadataSql !== null;
  if (hasMetadata && metadataSql !== metadataCreateSql) {
    throw new MigrationError("SCHEMA_DRIFT", "Migration metadata has an incompatible schema");
  }
  let history: { id: string; checksum: string; schema_json: string }[];
  try {
    history = hasMetadata
      ? (await binding.prepare(`SELECT id, checksum, schema_json FROM ${metadataTable} ORDER BY id`).all<{ id: string; checksum: string; schema_json: string }>()).results
      : [];
  } catch {
    throw new MigrationError("SCHEMA_DRIFT", "Migration metadata has an incompatible schema");
  }
  const currentSchema = await readSchemaText();
  if (currentSchema !== (history.at(-1)?.schema_json ?? "[]")) {
    throw new MigrationError("SCHEMA_DRIFT", "Database schema does not match the explicit migration history; authorized drift inventory is required");
  }
  for (const [index, applied] of history.entries()) {
    const supplied = migrations[index];
    if (!supplied || supplied.id !== applied.id || supplied.checksum !== applied.checksum) {
      throw new MigrationError("MIGRATION_CHANGED", "Applied migration history does not match the supplied immutable history", applied.id);
    }
  }
  const report = { applied: [] as string[], alreadyApplied: history.map((row) => row.id), schemaFingerprint: "" };
  for (const migration of migrations) {
    if (report.alreadyApplied.includes(migration.id)) continue;
    const statements = splitMigrationSql(migration.sql);
    const batch = statements.map((sql) => binding.prepare(sql));
    if (!hasMetadata && report.applied.length === 0) {
      batch.unshift(binding.prepare(metadataCreateSql));
    }
    batch.push(binding.prepare(`INSERT INTO ${metadataTable} (id, checksum, schema_json) VALUES (?, ?, (${schemaJsonQuery}))`).bind(migration.id, migration.checksum));
    try {
      await binding.batch(batch);
    } catch {
      throw new MigrationError("MIGRATION_FAILED", "Migration could not be applied; inspect the schema and receipt before explicitly resuming", migration.id);
    }
    report.applied.push(migration.id);
  }
  const schemaJson = await readSchemaText();
  report.schemaFingerprint = await migrationChecksum(schemaJson ?? "[]");
  return report;
}

function splitMigrationSql(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: string | undefined;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!;
    if (quote) {
      if (char === quote) {
        if (quote !== "]" && sql[index + 1] === quote) index++;
        else quote = undefined;
      }
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "[") {
      quote = "]";
    } else if (char === ";") {
      const statement = sql.slice(start, index).trim();
      if (statement) statements.push(statement);
      start = index + 1;
    }
  }
  if (quote) throw new MigrationError("INVALID_MIGRATION", "Migration SQL contains an unterminated quoted value or identifier");
  const final = sql.slice(start).trim();
  if (final) statements.push(final);
  return statements;
}
