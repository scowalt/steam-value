#!/usr/bin/env bun
import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { fetchSteamData } from "../src/scrapers/steam";
import { fetchHltbData } from "../src/scrapers/hltb";
import { lookupHltbForSteam } from "../src/scrapers/hltb-lookup";
import { calculateValueScore } from "../src/formula";
import { eq } from "drizzle-orm";

function parseArgs() {
  const args = process.argv.slice(2);
  let steamAppId: number | null = null;
  let hltbId: number | null = null;
  let isEndless = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--hltb-id" && args[i + 1]) {
      hltbId = parseInt(args[i + 1], 10);
      i++; // Skip the next argument
    } else if (arg === "--endless") {
      isEndless = true;
    } else if (!arg.startsWith("--") && steamAppId === null) {
      steamAppId = parseInt(arg, 10);
    }
  }

  return { steamAppId, hltbId, isEndless };
}

async function main() {
  const { steamAppId, hltbId, isEndless } = parseArgs();

  if (!steamAppId || isNaN(steamAppId)) {
    console.error("Usage: bun scripts/add-game.ts <steam_app_id> [options]");
    console.error("Example: bun scripts/add-game.ts 1245620 --hltb-id 68151");
    console.error("\nOptions:");
    console.error("  --hltb-id <id>  Specify the HowLongToBeat game ID");
    console.error("  --endless       Mark as endless/multiplayer game (no value score)");
    console.error("\nTo find the HLTB ID:");
    console.error("  1. Search for the game on howlongtobeat.com");
    console.error("  2. Look at the URL: howlongtobeat.com/game/XXXXX");
    console.error("  3. XXXXX is the HLTB ID");
    process.exit(1);
  }

  console.log(`Fetching data for Steam App ID: ${steamAppId}...`);
  if (hltbId) {
    console.log(`Using HLTB ID: ${hltbId}`);
  }
  if (isEndless) {
    console.log(`Game type: Endless/Multiplayer (no value score)`);
  }

  // Check if game already exists
  const existing = await db.query.games.findFirst({
    where: eq(games.steamAppId, steamAppId),
  });

  if (existing) {
    console.log(`Game "${existing.name}" already exists (id: ${existing.id})`);
    console.log("Use the update script to refresh data.");
    process.exit(0);
  }

  // Fetch Steam data
  console.log("\nFetching Steam data...");
  const steamData = await fetchSteamData(steamAppId);
  console.log(`  Name: ${steamData.name}`);
  console.log(`  Review Score: ${steamData.reviewScore}%`);
  console.log(`  Review Count: ${steamData.reviewCount.toLocaleString()}`);

  // Fetch HLTB data
  console.log(`\nFetching HLTB data for "${steamData.name}"...`);

  let hltbData = null;

  // If HLTB ID provided, use it directly
  if (hltbId) {
    hltbData = await fetchHltbData(steamData.name, hltbId);
  } else {
    // Try auto-lookup first (checks manual overrides)
    const lookup = await lookupHltbForSteam(steamAppId, steamData.name);
    if (lookup) {
      console.log(`  Auto-matched via ${lookup.source} (confidence: ${lookup.confidence})`);
      hltbData = {
        hltbId: lookup.hltbId,
        name: lookup.name,
        main: lookup.main,
        mainExtra: lookup.mainExtra,
        completionist: lookup.completionist,
      };
    }
  }

  if (hltbData) {
    console.log(`  Found: ${hltbData.name}`);
    console.log(`  Main Story: ${hltbData.main?.toFixed(1) ?? "N/A"} hours`);
    console.log(`  Main + Extras: ${hltbData.mainExtra?.toFixed(1) ?? "N/A"} hours`);
    console.log(`  Completionist: ${hltbData.completionist?.toFixed(1) ?? "N/A"} hours`);
  } else {
    console.log("  No HLTB data found");
    console.log("  Tip: Use --hltb-id <id> to specify the HLTB game ID");
  }

  // Calculate value score
  const valueScore = calculateValueScore({
    steamReviewScore: steamData.reviewScore,
    steamReviewCount: steamData.reviewCount,
    hltbMain: hltbData?.main ?? null,
    hltbMainExtra: hltbData?.mainExtra ?? null,
    hltbCompletionist: hltbData?.completionist ?? null,
    isEndless,
  });

  console.log(`\nValue Score: ${valueScore?.toFixed(2) ?? "N/A"}${isEndless ? " (endless game)" : ""}`);

  // Insert into database
  const result = await db
    .insert(games)
    .values({
      steamAppId,
      name: steamData.name,
      steamReviewScore: steamData.reviewScore,
      steamReviewCount: steamData.reviewCount,
      hltbId: hltbData?.hltbId ?? null,
      hltbMain: hltbData?.main ?? null,
      hltbMainExtra: hltbData?.mainExtra ?? null,
      hltbCompletionist: hltbData?.completionist ?? null,
      valueScore,
      isEndless,
    })
    .returning();

  const inserted = result[0];
  console.log(`\nGame saved to database (id: ${inserted?.id ?? "unknown"})`);
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
