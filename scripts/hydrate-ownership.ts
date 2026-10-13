#!/usr/bin/env bun
import { db } from "../src/db/client";
import { readAllGames, reportManualError, updateGame } from "../src/db/manual";
import { games } from "../src/db/schema";
import { getOwnedGamesWithPlaytime } from "../src/services/steam-played";
import { eq } from "drizzle-orm";

async function main() {
  const ownedGames = await getOwnedGamesWithPlaytime();
  console.log(`Found ${ownedGames.size} owned games in Steam library\n`);

  const allGames = await readAllGames(db);
  console.log(`Updating ${allGames.length} games in database...\n`);

  let ownedCount = 0;
  let playedCount = 0;
  let updated = 0;

  for (const game of allGames) {
    const playtime = ownedGames.get(game.steamAppId);
    const isOwned = playtime !== undefined;
    const playtimeMinutes = playtime ?? null;

    if (game.isOwned !== isOwned || game.playtimeMinutes !== playtimeMinutes) {
      await updateGame(db, eq(games.id, game.id), { isOwned, playtimeMinutes });
      updated++;

      if (isOwned) {
        const hours = playtimeMinutes ? (playtimeMinutes / 60).toFixed(1) : "0";
        console.log(`  ${game.name}: Owned, ${hours}h played`);
      }
    }

    if (isOwned) ownedCount++;
    if (playtimeMinutes && playtimeMinutes > 0) playedCount++;
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total games: ${allGames.length}`);
  console.log(`Owned: ${ownedCount}`);
  console.log(`Played (>0 minutes): ${playedCount}`);
  console.log(`Updated: ${updated}`);
}

main().catch(reportManualError);
