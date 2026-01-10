#!/usr/bin/env bun
/**
 * Remove games that the user has already played (has playtime on Steam).
 *
 * Requires STEAM_API_KEY and STEAM_ID in .env file.
 * Run: bun scripts/remove-played.ts
 */

import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { inArray } from "drizzle-orm";
import { fetchPlayedApps } from "../src/services/steam-played";

async function main() {
  // Fetch played apps from Steam
  const played = await fetchPlayedApps();

  if (played.size === 0) {
    console.log("No played apps found. Check your STEAM_API_KEY and STEAM_ID.");
    return;
  }

  console.log(`\nFound ${played.size} games with playtime on Steam\n`);

  // Get all games from database
  const allGames = await db
    .select({
      id: games.id,
      steamAppId: games.steamAppId,
      name: games.name,
    })
    .from(games);

  // Find games in DB that have been played
  const toRemove = allGames.filter((g) => played.has(g.steamAppId));

  if (toRemove.length === 0) {
    console.log("No played games found in database. Nothing to remove.");
    return;
  }

  console.log(`${toRemove.length} played games found in database:\n`);
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
