#!/usr/bin/env bun
import { db } from "../src/db/client";
import { readAllGames, reportManualError, updateGame } from "../src/db/manual";
import { games } from "../src/db/schema";
import { steam } from "../src/lib/steam-client";
import { eq } from "drizzle-orm";

async function main() {
  const allGames = await readAllGames(db);
  console.log(`Checking ${allGames.length} games for Early Access status...`);

  let earlyAccessCount = 0;
  let processed = 0;

  for (const game of allGames) {
    processed++;
    const isEA = await steam.isEarlyAccess(game.steamAppId);

    if (isEA !== game.isEarlyAccess) {
      await updateGame(db, eq(games.id, game.id), { isEarlyAccess: isEA });

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

main().catch(reportManualError);
