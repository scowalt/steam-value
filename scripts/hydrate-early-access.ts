#!/usr/bin/env bun
/**
 * Hydrate Early Access status for all games in the database.
 */
import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { steam } from "../src/lib/steam-client";
import { eq } from "drizzle-orm";

async function main() {
  const allGames = await db.query.games.findMany();
  console.log(`Checking ${allGames.length} games for Early Access status...`);

  let earlyAccessCount = 0;
  let processed = 0;

  for (const game of allGames) {
    processed++;
    const isEA = await steam.isEarlyAccess(game.steamAppId);

    if (isEA !== game.isEarlyAccess) {
      await db
        .update(games)
        .set({ isEarlyAccess: isEA })
        .where(eq(games.id, game.id));

      if (isEA) {
        earlyAccessCount++;
        console.log(`  [EA] ${game.name}`);
      }
    } else if (isEA) {
      earlyAccessCount++;
    }

    if (processed % 50 === 0) {
      console.log(`Progress: ${processed}/${allGames.length}`);
    }
  }

  console.log(`\nDone! Found ${earlyAccessCount} Early Access games.`);
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
