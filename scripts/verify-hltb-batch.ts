#!/usr/bin/env bun

import { db } from "../src/db/client";
import { readAllGames, recoverableManualError, reportManualError, updateGame } from "../src/db/manual";
import { games } from "../src/db/schema";
import { verifyHltbMapping, type VerificationStatus } from "../src/services/hltb-mapping";
import { eq, isNull, and } from "drizzle-orm";

interface VerificationStats {
  total: number;
  verified: number;
  wrongMapping: number;
  needsReview: number;
  noCandidate: number;
  alreadyHasHltb: number;
  errors: number;
}

const RATE_LIMIT_MS = 1000;  
const CHECKPOINT_INTERVAL = 10;  

function parseArgs() {
  const args = process.argv.slice(2);
  let limit: number | null = null;
  let dryRun = false;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--limit" && args[i + 1]) {
      limit = parseInt(args[i + 1]!, 10);
      i++;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    }
  }

  return { limit, dryRun, verbose };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { limit, dryRun, verbose } = parseArgs();

  console.log("=== HLTB Batch Verification ===\n");

  if (dryRun) {
    console.log("DRY RUN MODE - No changes will be made\n");
  }

  const gamesToVerify = await readAllGames(db, {
    where: and(
      isNull(games.hltbId),
      eq(games.isEndless, false)
    ),
  });

  const totalGames = limit ? Math.min(gamesToVerify.length, limit) : gamesToVerify.length;
  console.log(`Found ${gamesToVerify.length} games without HLTB data`);
  console.log(`Will process: ${totalGames} games`);
  console.log(`Rate limit: 1 request per second`);
  console.log(`Estimated time: ${Math.ceil(totalGames / 60)} minutes\n`);

  const stats: VerificationStats = {
    total: 0,
    verified: 0,
    wrongMapping: 0,
    needsReview: 0,
    noCandidate: 0,
    alreadyHasHltb: 0,
    errors: 0,
  };

  const statusCounts: Record<VerificationStatus, Array<{ steamAppId: number; name: string }>> = {
    verified: [],
    wrong_mapping: [],
    needs_review: [],
    no_candidate: [],
  };

  for (let i = 0; i < totalGames; i++) {
    const game = gamesToVerify[i]!;
    stats.total++;

    const progress = `[${i + 1}/${totalGames}]`;
    process.stdout.write(`${progress} ${game.name}... `);

    try {
      const result = await verifyHltbMapping(game.steamAppId, game.name);

      statusCounts[result.status].push({ steamAppId: game.steamAppId, name: game.name });

      switch (result.status) {
        case "verified":
          stats.verified++;
          if (result.hltbData && !dryRun) {
            await updateGame(db, eq(games.steamAppId, game.steamAppId), {
                hltbId: result.hltbData.hltbId,
                hltbMain: result.hltbData.main,
                hltbMainExtra: result.hltbData.mainExtra,
                hltbCompletionist: result.hltbData.completionist,
              });
          }
          console.log(`\u2713 VERIFIED (${result.hltbData?.main?.toFixed(1) ?? "N/A"}h)`);
          break;

        case "wrong_mapping":
          stats.wrongMapping++;
          console.log(`\u2717 WRONG MAPPING`);
          if (verbose) {
            console.log(`    ${result.message}`);
          }
          break;

        case "needs_review":
          stats.needsReview++;
          console.log(`? NEEDS REVIEW`);
          if (verbose) {
            console.log(`    ${result.message}`);
          }
          break;

        case "no_candidate":
          stats.noCandidate++;
          console.log(`- NO CANDIDATE`);
          break;
      }
    } catch (error) {
      const failure = recoverableManualError(error);
      stats.errors++;
      console.log(`ERROR: ${failure.message}`);
    }

    if (i < totalGames - 1) {
      await sleep(RATE_LIMIT_MS);
    }

    if ((i + 1) % CHECKPOINT_INTERVAL === 0) {
      console.log(`\n--- Checkpoint: ${i + 1}/${totalGames} processed ---`);
      console.log(`  Verified: ${stats.verified}`);
      console.log(`  Wrong: ${stats.wrongMapping}`);
      console.log(`  Review: ${stats.needsReview}`);
      console.log(`  No candidate: ${stats.noCandidate}`);
      console.log("");
    }
  }

  console.log("\n=== VERIFICATION COMPLETE ===\n");
  console.log(`Total processed: ${stats.total}`);
  console.log(`  \u2713 Verified:      ${stats.verified} (${((stats.verified / stats.total) * 100).toFixed(1)}%)`);
  console.log(`  \u2717 Wrong mapping: ${stats.wrongMapping}`);
  console.log(`  ? Needs review:  ${stats.needsReview}`);
  console.log(`  - No candidate:  ${stats.noCandidate}`);
  console.log(`  ! Errors:        ${stats.errors}`);

  if (statusCounts.wrong_mapping.length > 0) {
    console.log("\n--- Games with WRONG MAPPING (need manual HLTB ID) ---");
    statusCounts.wrong_mapping.forEach((g) => {
      console.log(`  Steam ${g.steamAppId}: ${g.name}`);
    });
  }

  if (statusCounts.needs_review.length > 0 && verbose) {
    console.log("\n--- Games NEEDING REVIEW ---");
    statusCounts.needs_review.forEach((g) => {
      console.log(`  Steam ${g.steamAppId}: ${g.name}`);
    });
  }

  if (dryRun) {
    console.log("\nDRY RUN - No changes were made to the database.");
  }
}

main().catch(reportManualError);
