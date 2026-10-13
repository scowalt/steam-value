#!/usr/bin/env bun

import { db } from "../src/db/client";
import { readAllGames, recoverableManualError, reportManualError, updateGame } from "../src/db/manual";
import { games } from "../src/db/schema";
import { verifyHltbMapping } from "../src/services/hltb-mapping";
import { eq, isNull, and } from "drizzle-orm";

async function main() {
  const toVerify = await readAllGames(db, {
    where: and(isNull(games.hltbId), eq(games.isEndless, false)),
  });

  console.log(`Found ${toVerify.length} games without HLTB data\n`);

  let verified = 0;
  let reviewed = 0;
  let noCandidate = 0;

  for (let i = 0; i < toVerify.length; i++) {
    const game = toVerify[i]!;
    process.stdout.write(`[${i + 1}/${toVerify.length}] ${game.name}... `);

    try {
      const result = await verifyHltbMapping(game.steamAppId, game.name);

      if (result.status === "verified" && result.hltbData) {
        await updateGame(db, eq(games.steamAppId, game.steamAppId), {
            hltbId: result.hltbData.hltbId,
            hltbMain: result.hltbData.main,
            hltbMainExtra: result.hltbData.mainExtra,
            hltbCompletionist: result.hltbData.completionist,
          });
        console.log(`✓ ${result.hltbData.main?.toFixed(1) || "N/A"}h`);
        verified++;
      } else if (result.status === "no_candidate") {
        console.log("- no candidate");
        noCandidate++;
      } else {
        console.log(`? ${result.status}`);
        reviewed++;
      }
    } catch (error) {
      console.log(`ERROR: ${recoverableManualError(error).message}`);
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`\n=== Summary ===`);
  console.log(`Verified: ${verified}`);
  console.log(`Needs review: ${reviewed}`);
  console.log(`No candidate: ${noCandidate}`);
}

main().catch(reportManualError);
