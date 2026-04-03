#!/usr/bin/env bun
/**
 * Hydrate tags (genres + categories) for all games missing them.
 * Usage: bun scripts/hydrate-tags.ts [--limit N]
 */
import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { steam } from "../src/lib/steam-client";
import { eq, isNull } from "drizzle-orm";

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

    try {
      const tags = await steam.getTags(game.steamAppId);

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
