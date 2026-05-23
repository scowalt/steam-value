#!/usr/bin/env bun
import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { calculateGameValueScore } from "../src/formula";
import { eq, sql } from "drizzle-orm";
import { formulaConfig } from "../src/formula/config";
import { createClient } from "@libsql/client";

const BATCH_SIZE = 200;

async function main() {
  console.log("Recalculating value scores...");
  console.log(`Formula config: timeMetric=${formulaConfig.timeMetric}, exponent=${formulaConfig.hoursPenaltyExponent}`);
  console.log("-".repeat(60));

  const allGames = await db.query.games.findMany();

  if (allGames.length === 0) {
    console.log("No games found in database.");
    process.exit(0);
  }

  // Compute all scores in memory first
  const updates: { id: number; name: string; oldScore: number | null; newScore: number | null }[] = [];
  let unchanged = 0;

  for (const game of allGames) {
    const newScore = calculateGameValueScore(game);
    if (newScore === game.valueScore) {
      unchanged++;
    } else {
      updates.push({ id: game.id, name: game.name, oldScore: game.valueScore, newScore });
    }
  }

  console.log(`Computed scores: ${updates.length} to update, ${unchanged} unchanged`);

  // Batch update using raw client for transaction batching
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  let updated = 0;
  let failed = 0;

  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);
    try {
      await client.batch(
        batch.map((u) => ({
          sql: "UPDATE games SET value_score = ?, updated_at = unixepoch() WHERE id = ?",
          args: [u.newScore, u.id],
        })),
        "write"
      );
      updated += batch.length;
      console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: updated ${batch.length} games (${updated}/${updates.length})`);
    } catch (error) {
      console.error(`  Batch ${Math.floor(i / BATCH_SIZE) + 1} failed:`, error);
      failed += batch.length;
    }
  }

  // Log some examples
  const examples = updates.slice(0, 10);
  for (const u of examples) {
    const changeStr = u.oldScore !== null && u.newScore !== null
      ? `${u.oldScore.toFixed(2)} → ${u.newScore.toFixed(2)}`
      : u.newScore !== null
        ? `N/A → ${u.newScore.toFixed(2)}`
        : `${u.oldScore?.toFixed(2)} → N/A`;
    console.log(`  ${u.name}: ${changeStr}`);
  }

  console.log("-".repeat(60));
  console.log(`Done! Updated: ${updated}, Unchanged: ${unchanged}, Failed: ${failed}`);
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
