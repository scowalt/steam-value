#!/usr/bin/env bun
import { db } from "../src/db/client";
import { readAllGames, reportManualError, updateGame } from "../src/db/manual";
import { games } from "../src/db/schema";
import { steam } from "../src/lib/steam-client";
import { eq } from "drizzle-orm";

async function main() {
  const allGames = await readAllGames(db);
  console.log(`Hydrating release dates for ${allGames.length} games...`);

  let updated = 0;
  let notFound = 0;
  let processed = 0;

  for (const game of allGames) {
    processed++;

    if (game.releaseDate) {
      if (processed % 50 === 0) {
        console.log(`Progress: ${processed}/${allGames.length}`);
      }
      continue;
    }

    const releaseDate = await steam.getReleaseDate(game.steamAppId);

    if (releaseDate) {
      await updateGame(db, eq(games.id, game.id), { releaseDate });
      console.log(`  ${game.name}: ${releaseDate}`);
      updated++;
    } else {
      notFound++;
    }

    if (processed % 50 === 0) {
      console.log(`Progress: ${processed}/${allGames.length}`);
    }
  }

  console.log(`\nDone!`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Not found: ${notFound}`);
}

main().catch(reportManualError);
