#!/usr/bin/env bun
import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { calculateGameValueScore } from "../src/formula";
import { eq } from "drizzle-orm";
import { formulaConfig } from "../src/formula/config";

async function main() {
  console.log("Recalculating value scores...");
  console.log(`Formula config: timeMetric=${formulaConfig.timeMetric}, exponent=${formulaConfig.hoursPenaltyExponent}`);
  console.log("-".repeat(60));

  const allGames = await db.query.games.findMany();

  if (allGames.length === 0) {
    console.log("No games found in database.");
    process.exit(0);
  }

  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const game of allGames) {
    const newScore = calculateGameValueScore(game);
    const oldScore = game.valueScore;

    if (newScore === oldScore) {
      unchanged++;
      continue;
    }

    try {
      await db
        .update(games)
        .set({ valueScore: newScore })
        .where(eq(games.id, game.id));

      const changeStr = oldScore !== null && newScore !== null
        ? `${oldScore.toFixed(2)} → ${newScore.toFixed(2)}`
        : newScore !== null
          ? `N/A → ${newScore.toFixed(2)}`
          : `${oldScore?.toFixed(2)} → N/A`;

      console.log(`  ${game.name}: ${changeStr}`);
      updated++;
    } catch (error) {
      console.error(`  Failed to update ${game.name}:`, error);
      failed++;
    }
  }

  console.log("-".repeat(60));
  console.log(`Done! Updated: ${updated}, Unchanged: ${unchanged}, Failed: ${failed}`);
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
