#!/usr/bin/env bun
/**
 * Fast hydration of EA + Controller Support
 * Fetches appdetails once per game (2x faster than separate calls)
 */
import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { eq } from "drizzle-orm";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface AppDetails {
  success: boolean;
  data?: {
    genres?: Array<{ id: string; description: string }>;
    categories?: Array<{ id: number; description: string }>;
  };
}

async function fetchAppDetails(appId: number): Promise<AppDetails | null> {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appId}`;
  try {
    const res = await fetch(url);
    if (res.status === 429) return null; // Rate limited
    const data = await res.json();
    return data[appId.toString()] || null;
  } catch {
    return null;
  }
}

async function main() {
  const allGames = await db.query.games.findMany();
  console.log(`Hydrating ${allGames.length} games (fast mode)...`);

  let earlyAccessCount = 0;
  let fullControllerCount = 0;
  let partialControllerCount = 0;
  let processed = 0;
  let rateLimited = 0;

  for (const game of allGames) {
    processed++;

    let appDetails: AppDetails | null = null;
    let retries = 0;

    // Fetch with retry
    while (retries < 3) {
      appDetails = await fetchAppDetails(game.steamAppId);
      if (appDetails !== null) break;
      rateLimited++;
      const backoff = 2000 * Math.pow(2, retries);
      console.log(`  Rate limited on ${game.name}, waiting ${backoff}ms...`);
      await sleep(backoff);
      retries++;
    }

    if (!appDetails?.success || !appDetails.data) {
      if (processed % 50 === 0) {
        console.log(`Progress: ${processed}/${allGames.length}`);
      }
      await sleep(1500); // Rate limit
      continue;
    }

    // Extract EA from genres (ID 70)
    const isEA = appDetails.data.genres?.some((g) => g.id === "70") ?? false;

    // Extract controller support from categories (28=full, 18=partial)
    let controller: "full" | "partial" | null = null;
    if (appDetails.data.categories?.some((c) => c.id === 28)) {
      controller = "full";
    } else if (appDetails.data.categories?.some((c) => c.id === 18)) {
      controller = "partial";
    }

    const needsUpdate =
      isEA !== game.isEarlyAccess || controller !== game.controllerSupport;

    if (needsUpdate) {
      try {
        await db
          .update(games)
          .set({ isEarlyAccess: isEA, controllerSupport: controller })
          .where(eq(games.id, game.id));

        const changes = [];
        if (isEA !== game.isEarlyAccess && isEA) changes.push("EA");
        if (controller !== game.controllerSupport && controller)
          changes.push(`Controller: ${controller}`);

        if (changes.length > 0) {
          console.log(`  ${game.name}: ${changes.join(", ")}`);
        }
      } catch (err: any) {
        console.error(`  Error updating ${game.name}: ${err.message}`);
      }
    }

    if (isEA) earlyAccessCount++;
    if (controller === "full") fullControllerCount++;
    if (controller === "partial") partialControllerCount++;

    if (processed % 50 === 0) {
      console.log(`Progress: ${processed}/${allGames.length}`);
    }

    await sleep(1500); // Rate limit between games
  }

  console.log(`\nDone!`);
  console.log(`  Early Access: ${earlyAccessCount}`);
  console.log(`  Full Controller: ${fullControllerCount}`);
  console.log(`  Partial Controller: ${partialControllerCount}`);
  if (rateLimited > 0) {
    console.log(`  Rate limited events: ${rateLimited}`);
  }
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
