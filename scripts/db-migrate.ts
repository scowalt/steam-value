#!/usr/bin/env bun
import { createLocalD1 } from "../src/db/local-d1";
import { resolve } from "node:path";
import { applyMigrations, loadMigrations, MigrationError } from "../src/db/migrations";

const usage = "Usage: bun scripts/db-migrate.ts --local --persist-to <isolated-directory>";

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--help") {
    console.log(`${usage}\nLocal-only explicit bootstrap. Source schema is provisional; no credentials or remote D1 access.`);
    return;
  }
  const persistIndex = args.indexOf("--persist-to");
  if (args.length !== 3 || !args.includes("--local") || persistIndex < 0 || !args[persistIndex + 1] || args[persistIndex + 1]!.startsWith("--")) {
    throw new Error(usage);
  }
  const persistTo = resolve(args[persistIndex + 1]!);
  const runtime = await createLocalD1({ persistTo });
  try {
    const report = await applyMigrations(runtime.binding, await loadMigrations());
    console.log(JSON.stringify({ scope: "isolated-local", schemaStatus: "provisional-source-schema", ...report }));
  } finally {
    await runtime.dispose();
  }
}

export function reportMigrationError(error: unknown) {
  console.error(error instanceof MigrationError ? `${error.code}: ${error.message}`
    : error instanceof Error && error.message === usage ? usage
    : "LOCAL_D1_UNAVAILABLE: Isolated local D1 could not be opened or disposed");
  process.exitCode = 1;
}

if (import.meta.main) await main(Bun.argv.slice(2)).catch(reportMigrationError);
