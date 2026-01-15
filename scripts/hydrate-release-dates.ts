#!/usr/bin/env bun
/**
 * Hydrate release dates for all games from Steam API.
 */
import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { steam } from "../src/lib/steam-client";
import { eq } from "drizzle-orm";

async function main() {
  const allGames = await db.query.games.findMany();
  console.log(`Hydrating release dates for ${allGames.length} games...`);

  let updated = 0;
  let notFound = 0;
  let processed = 0;

  for (const game of allGames) {
    processed++;

    // Skip if already has release date
    if (game.releaseDate) {
      if (processed % 50 === 0) {
        console.log(`Progress: ${processed}/${allGames.length}`);
      }
      continue;
    }

    const releaseDate = await steam.getReleaseDate(game.steamAppId);

    if (releaseDate) {
      await db
        .update(games)
        .set({ releaseDate })
        .where(eq(games.id, game.id));
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

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
