#!/usr/bin/env bun
import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { eq, isNull } from "drizzle-orm";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface SteamSpyResponse {
  tags?: Record<string, number>;
}

async function fetchSteamSpyTags(appId: number): Promise<string[] | null> {
  const url = `https://steamspy.com/api.php?request=appdetails&appid=${appId}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`SteamSpy returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as SteamSpyResponse;

  if (!data.tags || typeof data.tags !== "object") {
    return null;
  }

  const sorted = Object.entries(data.tags)
    .sort(([, a], [, b]) => b - a)
    .map(([name]) => name);

  return sorted.length > 0 ? sorted : null;
}

async function main() {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : undefined;

  let query = db.query.games.findMany({
    where: isNull(games.tags),
    ...(limit ? { limit } : {}),
  });

  const gamesToHydrate = await query;
  console.log(`Found ${gamesToHydrate.length} games without tags.`);

  let updated = 0;
  let failed = 0;
  let processed = 0;

  for (const game of gamesToHydrate) {
    processed++;

    if (processed > 1) {
      await sleep(1000);
    }

    try {
      const tags = await fetchSteamSpyTags(game.steamAppId);

      if (tags && tags.length > 0) {
        await db
          .update(games)
          .set({ tags: JSON.stringify(tags) })
          .where(eq(games.id, game.id));
        updated++;
        console.log(`  ${game.name}: ${tags.join(", ")}`);
      } else {
        console.log(`  ${game.name}: no tags found`);
      }
    } catch (error: unknown) {
      failed++;
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  ${game.name}: ERROR - ${msg}`);
    }

    if (processed % 50 === 0) {
      console.log(`Progress: ${processed}/${gamesToHydrate.length}`);
    }
  }

  console.log(`\nDone!`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Skipped (no tags): ${processed - updated - failed}`);
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
