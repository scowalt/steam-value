import { fileURLToPath } from "node:url";
import { migrationChecksum, type DbMigration } from "./migrations-native";
export { applyMigrations, MigrationError, migrationChecksum, type DbMigration, type MigrationReport } from "./migrations-native";

export async function loadMigrations(directory = new URL("../../migrations/", import.meta.url)): Promise<DbMigration[]> {
  const files = await Array.fromAsync(new Bun.Glob("*.sql").scan({ cwd: fileURLToPath(directory) }));
  return Promise.all(files.sort().map(async (id) => {
    const sql = await Bun.file(new URL(id, directory)).text();
    return { id, sql, checksum: await migrationChecksum(sql) };
  }));
}
