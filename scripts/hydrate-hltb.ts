#!/usr/bin/env bun
// Quick script to hydrate verified HLTB data for all games
// Run: bun scripts/hydrate-hltb.ts

import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { verifyHltbMapping } from "../src/services/hltb-mapping";
import { eq, isNull, and } from "drizzle-orm";

async function main() {
  const toVerify = await db.query.games.findMany({
    where: and(isNull(games.hltbId), eq(games.isEndless, false)),
  });

  console.log(`Found ${toVerify.length} games without HLTB data\n`);

  let verified = 0;
  let reviewed = 0;
  let noCandidate = 0;

  for (let i = 0; i < toVerify.length; i++) {
    const game = toVerify[i];
    process.stdout.write(`[${i + 1}/${toVerify.length}] ${game.name}... `);

    try {
      const result = await verifyHltbMapping(game.steamAppId, game.name);

      if (result.status === "verified" && result.hltbData) {
        await db
          .update(games)
          .set({
            hltbId: result.hltbData.hltbId,
            hltbMain: result.hltbData.main,
            hltbMainExtra: result.hltbData.mainExtra,
            hltbCompletionist: result.hltbData.completionist,
          })
          .where(eq(games.steamAppId, game.steamAppId));
        console.log(`✓ ${result.hltbData.main?.toFixed(1) || "N/A"}h`);
        verified++;
      } else if (result.status === "no_candidate") {
        console.log("- no candidate");
        noCandidate++;
      } else {
        console.log(`? ${result.status}`);
        reviewed++;
      }
    } catch (e) {
      console.log(`ERROR: ${e instanceof Error ? e.message : e}`);
    }

    // Rate limit: 1 request per second
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`\n=== Summary ===`);
  console.log(`Verified: ${verified}`);
  console.log(`Needs review: ${reviewed}`);
  console.log(`No candidate: ${noCandidate}`);
}

main();
