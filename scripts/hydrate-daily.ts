#!/usr/bin/env bun
import { createExternalClient } from "../src/db/http.ts";
import { toDbError, type DbClient } from "../src/db/access.ts";
import { syncSteamStatus } from "../src/services/steam-status-sync.ts";

let client: DbClient | undefined;
try {
  client = createExternalClient(process.env);
  console.log(`[Steam Status] Starting at ${new Date().toISOString()}`);
  const result = await syncSteamStatus(client, {
    STEAM_API_KEY: process.env.STEAM_API_KEY,
    STEAM_ID: process.env.STEAM_ID,
    STEAM_LOGIN_SECURE: process.env.STEAM_LOGIN_SECURE,
  });
  if (!result.success) {
    console.error(`[Steam Status] Failed: ${result.error}`);
    process.exitCode = result.skipped ? 0 : 1;
  } else {
    console.log(
      `[Steam Status] Complete: ${result.gamesUpdated} updates, ${result.ownedCount} owned, ${result.wishlistCount} wishlisted, ${result.ignoredCount} ignored`
    );
  }
} catch (error) {
  console.error(`[Steam Status] Failed: ${toDbError(error).message}`);
  process.exitCode = 1;
} finally {
  client?.close();
}
