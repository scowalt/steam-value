#!/usr/bin/env bun
import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { fetchSteamData, isGame } from "../src/scrapers/steam";
import { verifyHltbMapping, verifyManualHltbId } from "../src/services/hltb-mapping";
import { hasEnglishSupport, getLanguages } from "../src/services/language-lookup";
import { isIgnored } from "../src/services/steam-ignored";
import { hasPlayed } from "../src/services/steam-played";
import { calculateValueScore } from "../src/formula";
import { eq } from "drizzle-orm";

function parseArgs() {
  const args = process.argv.slice(2);
  let steamAppId: number | null = null;
  let hltbId: number | null = null;
  let isEndless = false;
  let forceUnverified = false;
  let skipEnglishCheck = false;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--hltb-id" && args[i + 1]) {
      hltbId = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--endless") {
      isEndless = true;
    } else if (arg === "--force-unverified") {
      forceUnverified = true;
    } else if (arg === "--skip-english-check") {
      skipEnglishCheck = true;
    } else if (arg === "--force") {
      force = true;
    } else if (!arg.startsWith("--") && steamAppId === null) {
      steamAppId = parseInt(arg, 10);
    }
  }

  return { steamAppId, hltbId, isEndless, forceUnverified, skipEnglishCheck, force };
}

async function main() {
  const { steamAppId, hltbId, isEndless, forceUnverified, skipEnglishCheck, force } = parseArgs();

  if (!steamAppId || isNaN(steamAppId)) {
    console.error("Usage: bun scripts/add-game.ts <steam_app_id> [options]");
    console.error("Example: bun scripts/add-game.ts 1245620 --hltb-id 68151");
    console.error("\nOptions:");
    console.error("  --hltb-id <id>       Specify the HowLongToBeat game ID");
    console.error("  --endless            Mark as endless/multiplayer game (no value score)");
    console.error("  --force-unverified   Use HLTB data even if unverified (not recommended)");
    console.error("  --skip-english-check Allow adding games without English support");
    console.error("  --force              Add even if game is on your Steam ignored list");
    console.error("\nTo find the HLTB ID:");
    console.error("  1. Search for the game on howlongtobeat.com");
    console.error("  2. Look at the URL: howlongtobeat.com/game/XXXXX");
    console.error("  3. XXXXX is the HLTB ID");
    process.exit(1);
  }

  console.log(`Fetching data for Steam App ID: ${steamAppId}...`);

  const existing = await db.query.games.findFirst({
    where: eq(games.steamAppId, steamAppId),
  });

  if (existing) {
    console.log(`Game "${existing.name}" already exists (id: ${existing.id})`);
    console.log("Use the update script to refresh data.");
    process.exit(0);
  }

  if (!force && (await isIgnored(steamAppId))) {
    console.log("\nThis game is on your Steam 'Not Interested' list.");
    console.log("Use --force to add anyway.");
    process.exit(0);
  }

  if (!force && (await hasPlayed(steamAppId))) {
    console.log("\nYou've already played this game.");
    console.log("Use --force to add anyway.");
    process.exit(0);
  }

  console.log("\nChecking Steam app type...");
  const isActualGame = await isGame(steamAppId);
  if (!isActualGame) {
    console.error("This is not a game (may be video, DLC, or software).");
    process.exit(1);
  }

  console.log("\nFetching Steam data...");
  const steamData = await fetchSteamData(steamAppId);
  console.log(`  Name: ${steamData.name}`);
  console.log(`  Review Score: ${steamData.reviewScore}%`);
  console.log(`  Review Count: ${steamData.reviewCount.toLocaleString()}`);

  if (!skipEnglishCheck) {
    const englishSupport = await hasEnglishSupport(steamAppId);
    if (englishSupport === false) {
      const languages = await getLanguages(steamAppId);
      console.error(`\nGame does not support English.`);
      console.error(`  Languages: ${languages?.join(", ") || "unknown"}`);
      console.error(`\nUse --skip-english-check to add anyway.`);
      process.exit(1);
    }
  }

  console.log(`\nLooking up HLTB data for "${steamData.name}"...`);

  const verification = hltbId
    ? await verifyManualHltbId(steamAppId, hltbId)
    : await verifyHltbMapping(steamAppId, steamData.name);

  console.log(`  Status: ${verification.status.toUpperCase()}`);
  if (verification.hltbId) {
    console.log(`  HLTB ID: ${verification.hltbId}`);
  }
  if (verification.hltbName) {
    console.log(`  HLTB Name: ${verification.hltbName}`);
  }
  console.log(`  ${verification.message}`);

  let hltbData = verification.hltbData;

  if (verification.status === "verified") {
    console.log("\n  \u2713 VERIFIED - Using HLTB data");
  } else if (verification.status === "wrong_mapping") {
    console.log("\n  \u2717 WRONG MAPPING - HLTB data will NOT be used");
    console.log("    The steamdb candidate maps to a different Steam game.");
    console.log("    Use --hltb-id to specify the correct HLTB ID.");
    hltbData = null;
  } else if (verification.status === "needs_review") {
    if (forceUnverified && hltbId) {
      console.log("\n  ! UNVERIFIED - Using HLTB data (--force-unverified)");
    } else {
      console.log("\n  ? NEEDS REVIEW - HLTB data will NOT be used");
      console.log("    HLTB page has no Steam link to verify the mapping.");
      if (hltbId) {
        console.log("    Use --force-unverified to use this data anyway.");
      } else {
        console.log("    Try --hltb-id with --force-unverified if you're confident.");
      }
      hltbData = null;
    }
  } else {
    console.log("\n  - NO CANDIDATE - No HLTB data available");
    console.log("    This game is not in the steamdb dataset.");
    console.log("    Use --hltb-id to manually specify an HLTB ID.");
  }

  if (hltbData) {
    console.log(`\n  Main Story: ${hltbData.main?.toFixed(1) ?? "N/A"} hours`);
    console.log(`  Main + Extras: ${hltbData.mainExtra?.toFixed(1) ?? "N/A"} hours`);
    console.log(`  Completionist: ${hltbData.completionist?.toFixed(1) ?? "N/A"} hours`);
  }

  const valueScore = calculateValueScore({
    steamReviewScore: steamData.reviewScore,
    steamReviewCount: steamData.reviewCount,
    hltbMain: hltbData?.main ?? null,
    hltbMainExtra: hltbData?.mainExtra ?? null,
    hltbCompletionist: hltbData?.completionist ?? null,
    isEndless,
  });

  console.log(`\nValue Score: ${valueScore?.toFixed(2) ?? "N/A"}${isEndless ? " (endless game)" : ""}`);

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

  if (verification.status !== "verified" && !isEndless) {
    console.log("\n--- HLTB Status ---");
    if (verification.status === "no_candidate") {
      console.log("This game needs manual HLTB lookup.");
      console.log("Find it on howlongtobeat.com and re-add with --hltb-id");
    } else if (verification.status === "wrong_mapping") {
      console.log("The steamdb mapping was incorrect.");
      console.log("Find the correct HLTB page and re-add with --hltb-id");
    } else if (verification.status === "needs_review") {
      console.log("HLTB mapping could not be verified.");
      console.log("Verify manually on howlongtobeat.com");
    }
  }
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
