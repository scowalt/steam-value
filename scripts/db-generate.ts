#!/usr/bin/env bun
import { resolve } from "node:path";
import { generateMigration } from "../src/db/admin";
import { MigrationError } from "../src/db/migrations";

const usage = "Usage: bun scripts/db-generate.ts --name <snake_name> --sql-file <reviewed-sql> [--migrations-dir <history-directory>]";

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--help") {
    console.log(`${usage}\nValidates complete history plus candidate on disposable native D1, then appends without overwriting. Never applies to a persistent or remote database.`);
    return;
  }
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1];
    if (!["--name", "--sql-file", "--migrations-dir"].includes(key) || !value || value.startsWith("--") || options.has(key)) throw new Error(usage);
    options.set(key, value);
  }
  const name = options.get("--name");
  const sqlFile = options.get("--sql-file");
  if (!name || !sqlFile) throw new Error(usage);
  const sql = await Bun.file(resolve(sqlFile)).text();
  console.log(JSON.stringify(await generateMigration(name, sql, options.get("--migrations-dir"))));
}

if (import.meta.main) {
  try { await main(Bun.argv.slice(2)); } catch (error) {
    console.error(error instanceof MigrationError ? `${error.code}: ${error.message}`
      : error instanceof Error && error.message === usage ? usage
      : "GENERATION_FAILED: Could not read, validate or append the migration; inspect history before resuming");
    process.exitCode = 1;
  }
}
