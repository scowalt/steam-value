#!/usr/bin/env bun
import { createExternalClient } from "../src/db/http.ts";
import { toDbError, type DbClient } from "../src/db/access.ts";
import { ItadClient } from "../src/services/itad-client";
import { OfferRefreshError, refreshGameDeals } from "../src/services/deal-refresh";

const args = process.argv.slice(2);
let limit: number | undefined;
if (args.length) {
  if (args.length !== 2 || args[0] !== "--limit" || !Number.isSafeInteger(Number(args[1])) || Number(args[1]) < 1) {
    throw new Error("Usage: bun scripts/refresh-deals.ts [--limit <positive integer>]");
  }
  limit = Number(args[1]);
}
let client: DbClient | undefined;
try {
  const apiKey = process.env.ITAD_API_KEY;
  if (!apiKey) throw new OfferRefreshError("Missing ITAD_API_KEY");
  client = createExternalClient(process.env);
  const result = await refreshGameDeals(client, new ItadClient(apiKey), {
    limit, onProgress: (message) => console.log(`[Offers] ${message}`),
  });
  console.log(`[Offers] ${result.skipped ? "Already running" : "Complete"}: ${JSON.stringify(result)}`);
} catch (error) {
  console.error(`[Offers] ${error instanceof OfferRefreshError ? error.message : toDbError(error).message}`);
  process.exitCode = 1;
} finally {
  client?.close();
}
