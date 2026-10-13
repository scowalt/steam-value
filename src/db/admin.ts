import { Miniflare } from "miniflare";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applyMigrations, loadMigrations, migrationChecksum, MigrationError } from "./migrations";
import { DbError, toDbError, type DbClient, type DbStatement } from "./access";

export const applicationTables = ["games", "sync_state", "catalog_refresh_state", "catalog_refresh_failures", "itad_game_map", "game_deal_cache", "deal_refresh_state"] as const;
export type ApplicationTable = typeof applicationTables[number];
const tableOrders: Record<ApplicationTable, string> = {
  games: "id", sync_state: "key", catalog_refresh_state: "key", catalog_refresh_failures: "steam_app_id",
  itad_game_map: "steam_app_id", game_deal_cache: "steam_app_id, country, kind", deal_refresh_state: "country",
};
export interface InspectionOptions { table?: ApplicationTable; limit?: number; offset?: number }

export async function inspectDatabase(client: DbClient, options: InspectionOptions = {}) {
  const { table, limit = 50, offset = 0 } = options;
  if ((table !== undefined && !applicationTables.includes(table)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0) throw new DbError("INVALID_REQUEST", "not-applied");
  const statements: DbStatement[] = ["SELECT type, name, tbl_name AS table_name, sql FROM sqlite_schema WHERE name NOT GLOB '_cf_*' ORDER BY type, name",
    ...applicationTables.map((name) => `SELECT COUNT(*) AS row_count FROM ${name}`)];
  if (table) statements.push({ sql: `SELECT * FROM ${table} ORDER BY ${tableOrders[table]} LIMIT ? OFFSET ?`, args: [limit, offset] });
  try {
    const results = await client.batch(statements, "read");
    const tables = applicationTables.map((name, index) => {
      const rowCount = results[index + 1]?.rows[0]?.row_count;
      if (typeof rowCount !== "number" || !Number.isSafeInteger(rowCount) || rowCount < 0) throw new DbError("PROTOCOL_ERROR", "not-applied");
      return { name, rowCount };
    });
    return { schemaObjects: results[0]!.rows, tables, ...(table ? { sample: { table, limit, offset, rows: results.at(-1)!.rows } } : {}) };
  } catch (error) { throw toDbError(error); }
}

export function openLocalD1(persistTo?: string) {
  return new Miniflare({
    modules: true, script: "export default { fetch() { return new Response(null, { status: 404 }); } }",
    d1Databases: ["DB"], d1Persist: persistTo ? join(resolve(persistTo), "v3", "d1") : false,
    cf: false, host: "127.0.0.1", port: 0,
  });
}

export async function generateMigration(name: string, sql: string, directory = resolve("migrations")) {
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name) || !sql.trim()) {
    throw new MigrationError("INVALID_MIGRATION", "Provide a snake-case name and nonempty reviewed SQL");
  }
  const historyUrl = pathToFileURL(`${resolve(directory)}/`);
  const history = await loadMigrations(historyUrl);
  const number = Number(history.at(-1)?.id.slice(0, 4) ?? 0) + 1;
  if (history.length === 0 || number > 9999) throw new MigrationError("INVALID_MIGRATION", "Generation requires a complete existing migration history");
  const migrationId = `${String(number).padStart(4, "0")}_${name}.sql`;
  const candidate = { id: migrationId, sql, checksum: await migrationChecksum(sql) };
  const runtime = openLocalD1();
  let schemaFingerprint: string;
  try {
    const report = await applyMigrations(await runtime.getD1Database("DB"), [...history, candidate]);
    schemaFingerprint = report.schemaFingerprint;
  } finally {
    await runtime.dispose();
  }
  const current = await loadMigrations(historyUrl);
  if (JSON.stringify(current) !== JSON.stringify(history)) throw new MigrationError("MIGRATION_CHANGED", "Migration history changed during generation; review before resuming");
  const path = join(resolve(directory), migrationId);
  const output = await open(path, "wx", 0o644);
  try { await output.writeFile(sql); } finally { await output.close(); }
  return { scope: "disposable-validation", migrationId, checksum: candidate.checksum, schemaFingerprint, path };
}
