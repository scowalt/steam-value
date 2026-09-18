#!/usr/bin/env bun
import { createClient } from "@libsql/client";
import { ItadClient } from "../src/services/itad-client";
import { refreshGameDeals } from "../src/services/deal-refresh";

// --limit is for a bounded initial verification; normal scheduled runs cover all rankings.
const args = process.argv.slice(2);
let limit: number | undefined;
if (args.length) {
  if (args.length !== 2 || args[0] !== "--limit" || !Number.isSafeInteger(Number(args[1])) || Number(args[1]) < 1) {
    throw new Error("Usage: bun scripts/refresh-deals.ts [--limit <positive integer>]");
  }
  limit = Number(args[1]);
}
const apiKey = process.env.ITAD_API_KEY;
const url = process.env.TURSO_DATABASE_URL;
if (!apiKey || !url) throw new Error("Missing ITAD_API_KEY or TURSO_DATABASE_URL");
const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
try {
  const result = await refreshGameDeals(client, new ItadClient(apiKey), {
    limit, onProgress: (message) => console.log(`[Offers] ${message}`),
  });
  console.log(`[Offers] ${result.skipped ? "Already running" : "Complete"}: ${JSON.stringify(result)}`);
} catch (error) {
  console.error(`[Offers] ${error instanceof Error ? error.message : "Refresh failed"}`);
  process.exitCode = 1;
} finally {
  client.close();
}
