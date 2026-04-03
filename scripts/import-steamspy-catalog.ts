#!/usr/bin/env bun
/**
 * Bulk import games from SteamSpy's all-games endpoint.
 * Fetches all pages (1000 entries each), filters for games with 100+ total
 * reviews (positive + negative), and inserts new games with steamAppId, name,
 * and steamReviewScore.
 *
 * Hydration order (run separately after import):
 *   1. hydrate-tags.ts        - SteamSpy community tags (1 req/sec)
 *   2. hydrate-game-info-fast.ts - Steam API: controller support, game modes, early access, release date
 *   3. hydrate-hltb.ts        - HowLongToBeat data (Playwright, slow)
 *   4. recalculate.ts         - Recalculate value scores
 */
import { db } from "../src/db/client";
import { games } from "../src/db/schema";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface SteamSpyAllEntry {
  appid: number;
  name: string;
  positive: number;
  negative: number;
}

async function fetchAllPages(): Promise<SteamSpyAllEntry[]> {
  const allEntries = new Map<number, SteamSpyAllEntry>();
  let page = 0;

  while (true) {
    console.log(`  Fetching page ${page}...`);
    const response = await fetch(
      `https://steamspy.com/api.php?request=all&page=${page}`
    );

    if (!response.ok) {
      throw new Error(`SteamSpy returned HTTP ${response.status} on page ${page}`);
    }

    const data = (await response.json()) as Record<string, SteamSpyAllEntry>;
    const entries = Object.values(data);

    if (entries.length === 0) {
      break;
    }

    let newCount = 0;
    for (const entry of entries) {
      if (!allEntries.has(entry.appid)) {
        allEntries.set(entry.appid, entry);
        newCount++;
      }
    }

    console.log(`    Got ${entries.length} entries (${newCount} new)`);

    // If we got fewer than 1000, we've reached the last page
    if (entries.length < 1000) {
      break;
    }

    page++;
    // Rate limit: be nice to SteamSpy
    await sleep(1500);
  }

  return Array.from(allEntries.values());
}

async function main() {
  console.log("Fetching SteamSpy all-games catalog (all pages)...");
  const allEntries = await fetchAllPages();
  console.log(`Total unique entries from SteamSpy: ${allEntries.length}`);

  // Filter for games with 100+ total reviews
  const minReviews = 100;
  const candidates = allEntries.filter(
    (entry) => entry.positive + entry.negative >= minReviews
  );
  console.log(`Games with ${minReviews}+ reviews: ${candidates.length}`);

  // Load existing steamAppIds to skip duplicates
  const existingGames = await db.query.games.findMany({
    columns: { steamAppId: true },
  });
  const existingIds = new Set(existingGames.map((g) => g.steamAppId));
  console.log(`Already in DB: ${existingIds.size}`);

  const toInsert = candidates.filter((entry) => !existingIds.has(entry.appid));
  console.log(`New games to import: ${toInsert.length}`);

  if (toInsert.length === 0) {
    console.log("Nothing to import.");
    return;
  }

  // Insert in batches
  const batchSize = 100;
  let inserted = 0;

  for (let i = 0; i < toInsert.length; i += batchSize) {
    const batch = toInsert.slice(i, i + batchSize);
    const values = batch.map((entry) => {
      const total = entry.positive + entry.negative;
      const reviewScore =
        total > 0 ? Math.round((entry.positive / total) * 100) : null;
      return {
        steamAppId: entry.appid,
        name: entry.name,
        steamReviewScore: reviewScore,
        steamReviewCount: total,
      };
    });

    await db.insert(games).values(values);
    inserted += batch.length;

    if (inserted % 1000 === 0 || inserted === toInsert.length) {
      console.log(`  Inserted ${inserted}/${toInsert.length}`);
    }
  }

  console.log(`\nDone! Imported ${inserted} games.`);
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
