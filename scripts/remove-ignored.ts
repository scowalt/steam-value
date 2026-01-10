#!/usr/bin/env bun
/**
 * Remove games that are on the user's Steam "Not Interested" list.
 *
 * Requires STEAM_LOGIN_SECURE cookie in .env file.
 * Run: bun scripts/remove-ignored.ts
 */

import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { inArray } from "drizzle-orm";
import { fetchIgnoredApps } from "../src/services/steam-ignored";

async function main() {
  // Fetch ignored apps from Steam
  const ignored = await fetchIgnoredApps();

  if (ignored.size === 0) {
    console.log("No ignored apps found. Check your STEAM_LOGIN_SECURE cookie.");
    return;
  }

  console.log(`Found ${ignored.size} ignored games on Steam\n`);

  // Get all games from database
  const allGames = await db
    .select({
      id: games.id,
      steamAppId: games.steamAppId,
      name: games.name,
    })
    .from(games);

  // Find games in DB that are ignored
  const toRemove = allGames.filter((g) => ignored.has(g.steamAppId));

  if (toRemove.length === 0) {
    console.log("No ignored games found in database. Nothing to remove.");
    return;
  }

  console.log(`${toRemove.length} ignored games found in database:\n`);
  toRemove.forEach((g) => console.log(`  - ${g.name} (${g.steamAppId})`));

  // Delete them
  const ids = toRemove.map((g) => g.id);
  await db.delete(games).where(inArray(games.id, ids));

  console.log(`\nRemoved ${toRemove.length} games from database.`);
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
