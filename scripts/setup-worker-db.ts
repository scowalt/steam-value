#!/usr/bin/env bun
/**
 * Prepare Turso for the Cloudflare Worker runtime.
 * Safe to run repeatedly.
 */
import { createClient } from "@libsql/client";
import { ensureSyncStateTable } from "../src/services/steam-status-sync";
import { ensureDealTables } from "../src/services/game-deals";

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

await ensureSyncStateTable(client);
await ensureDealTables(client);

await client.batch(
  [
    "CREATE INDEX IF NOT EXISTS idx_games_browse_default ON games(value_score DESC) WHERE value_score IS NOT NULL AND is_endless = 0 AND is_ignored = 0",
    "CREATE INDEX IF NOT EXISTS idx_games_browse_owned_playtime ON games(playtime_minutes, value_score DESC) WHERE value_score IS NOT NULL AND is_endless = 0",
    "CREATE INDEX IF NOT EXISTS idx_games_steam_app_id ON games(steam_app_id)",
  ],
  "write"
);

console.log("Worker database tables and indexes are ready");
