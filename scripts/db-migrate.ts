#!/usr/bin/env bun
import { Miniflare } from "miniflare";
import { join, resolve } from "node:path";
import { applyMigrations, loadMigrations, MigrationError } from "../src/db/migrations";

const usage = "Usage: bun scripts/db-migrate.ts --local --persist-to <isolated-directory>";

async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--help") {
    console.log(`${usage}\nLocal-only explicit bootstrap. Source schema is provisional; no credentials or remote D1 access.`);
    return;
  }
  const persistIndex = args.indexOf("--persist-to");
  if (args.length !== 3 || !args.includes("--local") || persistIndex < 0 || !args[persistIndex + 1] || args[persistIndex + 1]!.startsWith("--")) {
    throw new Error(usage);
  }
  const persistTo = resolve(args[persistIndex + 1]!);
  const runtime = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 404 }); } }",
    d1Databases: ["DB"],
    d1Persist: join(persistTo, "v3", "d1"),
    cf: false,
    host: "127.0.0.1",
    port: 0,
  });
  try {
    const report = await applyMigrations(await runtime.getD1Database("DB"), await loadMigrations());
    console.log(JSON.stringify({ scope: "isolated-local", schemaStatus: "provisional-source-schema", ...report }));
  } finally {
    await runtime.dispose();
  }
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof MigrationError ? `${error.code}: ${error.message}`
      : error instanceof Error && error.message === usage ? usage
      : "LOCAL_D1_UNAVAILABLE: Isolated local D1 could not be opened or disposed");
    process.exitCode = 1;
  }
}
