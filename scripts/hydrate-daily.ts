#!/usr/bin/env bun
import { createClient } from "@libsql/client";
import { syncSteamStatus } from "../src/services/steam-status-sync";

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

console.log(`[Steam Status] Starting at ${new Date().toISOString()}`);

const result = await syncSteamStatus(client, {
  STEAM_API_KEY: process.env.STEAM_API_KEY,
  STEAM_ID: process.env.STEAM_ID,
  STEAM_LOGIN_SECURE: process.env.STEAM_LOGIN_SECURE,
});

if (!result.success) {
  console.error(`[Steam Status] Failed: ${result.error}`);
  process.exit(result.skipped ? 0 : 1);
}

console.log(
  `[Steam Status] Complete: ${result.gamesUpdated} updates, ${result.ownedCount} owned, ${result.wishlistCount} wishlisted, ${result.ignoredCount} ignored`
);
