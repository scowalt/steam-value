#!/usr/bin/env bun
import { db } from "../src/db/client";
import { readAllGames, reportManualError, updateGame } from "../src/db/manual";
import { games } from "../src/db/schema";
import { steam } from "../src/lib/steam-client";
import { eq } from "drizzle-orm";

async function main() {
  const allGames = await readAllGames(db);
  console.log(`Hydrating ${allGames.length} games...`);

  let earlyAccessCount = 0;
  let fullControllerCount = 0;
  let partialControllerCount = 0;
  let processed = 0;

  for (const game of allGames) {
    processed++;

    const [isEA, controller] = await Promise.all([
      steam.isEarlyAccess(game.steamAppId),
      steam.getControllerSupport(game.steamAppId),
    ]);

    const needsUpdate =
      isEA !== game.isEarlyAccess || controller !== game.controllerSupport;

    if (needsUpdate) {
      await updateGame(db, eq(games.id, game.id), { isEarlyAccess: isEA, controllerSupport: controller });

      const changes = [];
      if (isEA !== game.isEarlyAccess && isEA) changes.push("EA");
      if (controller !== game.controllerSupport && controller)
        changes.push(`Controller: ${controller}`);

      if (changes.length > 0) {
        console.log(`  ${game.name}: ${changes.join(", ")}`);
      }
    }

    if (isEA) earlyAccessCount++;
    if (controller === "full") fullControllerCount++;
    if (controller === "partial") partialControllerCount++;

    if (processed % 50 === 0) {
      console.log(`Progress: ${processed}/${allGames.length}`);
    }
  }

  console.log(`\nDone!`);
  console.log(`  Early Access: ${earlyAccessCount}`);
  console.log(`  Full Controller: ${fullControllerCount}`);
  console.log(`  Partial Controller: ${partialControllerCount}`);
}

main().catch(reportManualError);
