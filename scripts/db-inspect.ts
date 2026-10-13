#!/usr/bin/env bun
import { applicationTables, inspectDatabase, openLocalD1, type ApplicationTable } from "../src/db/admin";
import { createD1Client } from "../src/db/d1";
import { createExternalClient } from "../src/db/http";
import { reportManualError } from "../src/db/manual";

const usage = "Usage: bun scripts/db-inspect.ts (--local --persist-to <isolated-directory> | --application) [--table <application-table>] [--limit <1..1000>] [--offset <rows>]";

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--help") {
    console.log(`${usage}\nRead-only schema/index/count inspection and explicitly bounded samples. No initialization or SQL console. Application access requires the four application/Access keys, never account API credentials.`);
    return;
  }
  const options = new Map<string, string>();
  let local = false;
  let application = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (key === "--local" && !local) local = true;
    else if (key === "--application" && !application) application = true;
    else {
      const value = args[++index];
      if (!["--persist-to", "--table", "--limit", "--offset"].includes(key) || !value || value.startsWith("--") || options.has(key)) throw new Error(usage);
      options.set(key, value);
    }
  }
  const persistTo = options.get("--persist-to");
  const table = options.get("--table");
  const limitArg = options.get("--limit");
  const offsetArg = options.get("--offset");
  if (local === application || (local && !persistTo) || (application && persistTo) || (table !== undefined && !applicationTables.some((name) => name === table)) || (limitArg !== undefined && !/^\d+$/.test(limitArg)) || (offsetArg !== undefined && !/^\d+$/.test(offsetArg))) throw new Error(usage);
  const limit = limitArg === undefined ? 50 : Number(limitArg);
  const offset = offsetArg === undefined ? 0 : Number(offsetArg);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset)) throw new Error(usage);
  const selected = applicationTables.find((name): name is ApplicationTable => name === table);
  const inspection = { table: selected, limit, offset };
  if (application) {
    console.log(JSON.stringify({ scope: "application", ...await inspectDatabase(createExternalClient(process.env), inspection) }));
    return;
  }
  const runtime = await openLocalD1(persistTo);
  try {
    console.log(JSON.stringify({ scope: "isolated-local", ...await inspectDatabase(createD1Client(runtime.binding), inspection) }));
  } finally { await runtime.dispose(); }
}

if (import.meta.main) {
  try { await main(Bun.argv.slice(2)); } catch (error) {
    if (error instanceof Error && error.message === usage) {
      console.error(usage);
      process.exitCode = 1;
    } else reportManualError(error);
  }
}
