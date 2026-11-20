#!/usr/bin/env bun
import { openLocalD1 } from "../src/db/admin";
import { formatCoverage, readCoverage } from "../src/db/coverage";
import { createD1Client } from "../src/db/d1";
import { createExternalClient } from "../src/db/http";
import { reportManualError } from "../src/db/manual";

const usage = "Usage: bun scripts/db-coverage.ts (--local --persist-to <isolated-directory> | --application) [--json]";

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--help") {
    console.log(`${usage}\nRead-only Game Catalog data coverage: one aggregate count of Catalog Facts, Steam Status, Value Score blockers and the largest pending buckets. Application access requires the four application/Access keys, never account API credentials.`);
    return;
  }
  let local = false;
  let application = false;
  let json = false;
  let persistTo: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (key === "--local" && !local) local = true;
    else if (key === "--application" && !application) application = true;
    else if (key === "--json" && !json) json = true;
    else {
      const value = args[++index];
      if (key !== "--persist-to" || !value || value.startsWith("--") || persistTo !== undefined) throw new Error(usage);
      persistTo = value;
    }
  }
  if (local === application || (local && !persistTo) || (application && persistTo)) throw new Error(usage);
  const print = (scope: string, report: Awaited<ReturnType<typeof readCoverage>>) => {
    console.log(json ? JSON.stringify({ scope, ...report }) : `${formatCoverage(report)}\n\nScope: ${scope}`);
  };
  if (application) {
    print("application", await readCoverage(createExternalClient(process.env)));
    return;
  }
  const runtime = await openLocalD1(persistTo);
  try {
    print("isolated-local", await readCoverage(createD1Client(runtime.binding)));
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
