#!/usr/bin/env bun
// Add games from steamdb-raw.json that have HLTB data
// Uses verified HLTB mapping system

import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { fetchSteamData, isGame } from "../src/scrapers/steam";
import { verifyHltbMapping } from "../src/services/hltb-mapping";
import { hasEnglishSupport } from "../src/services/language-lookup";
import { calculateValueScore } from "../src/formula";
import { eq, inArray } from "drizzle-orm";

interface SteamDbEntry {
  sid: number;
  name: string;
  hltb_url?: string;
  store_uscore?: number;
}

async function main() {
  const limit = parseInt(process.argv[2] || "100");

  // Load steamdb data
  const file = Bun.file("./src/data/steamdb-raw.json");
  const steamdbData: SteamDbEntry[] = await file.json();

  // Get existing game IDs
  const existing = await db.select({ steamAppId: games.steamAppId }).from(games);
  const existingIds = new Set(existing.map(g => g.steamAppId));

  // Filter to games with HLTB URLs that aren't in DB, sorted by review score
  const candidates = steamdbData
    .filter(g => g.hltb_url && !existingIds.has(g.sid))
    .sort((a, b) => (b.store_uscore ?? 0) - (a.store_uscore ?? 0))
    .slice(0, limit * 2); // Get extra in case some fail

  console.log(`Found ${candidates.length} candidates, processing up to ${limit}...\n`);

  let added = 0;
  let skipped = 0;
  let failed = 0;

  for (const candidate of candidates) {
    if (added >= limit) break;

    process.stdout.write(`[${added + 1}/${limit}] ${candidate.name.slice(0, 35).padEnd(35)} `);

    try {
      // Check if it's actually a game (not video, dlc, etc.)
      const isActualGame = await isGame(candidate.sid);
      if (!isActualGame) {
        console.log("⊘ Not a game");
        skipped++;
        continue;
      }

      // Check English support
      const hasEnglish = await hasEnglishSupport(candidate.sid);
      if (hasEnglish === false) {
        console.log("⊘ No English");
        skipped++;
        continue;
      }

      // Fetch Steam data
      const steamData = await fetchSteamData(candidate.sid);

      // Verify HLTB mapping
      const verification = await verifyHltbMapping(candidate.sid, steamData.name);

      if (verification.status !== "verified" || !verification.hltbData) {
        console.log(`⊘ ${verification.status}`);
        skipped++;
        continue;
      }

      // Calculate value score
      const valueScore = calculateValueScore({
        steamReviewScore: steamData.reviewScore,
        steamReviewCount: steamData.reviewCount,
        hltbMain: verification.hltbData.main,
        hltbMainExtra: verification.hltbData.mainExtra,
        hltbCompletionist: verification.hltbData.completionist,
        isEndless: false,
      });

      // Insert
      await db.insert(games).values({
        steamAppId: candidate.sid,
        name: steamData.name,
        steamReviewScore: steamData.reviewScore,
        steamReviewCount: steamData.reviewCount,
        hltbId: verification.hltbData.hltbId,
        hltbMain: verification.hltbData.main,
        hltbMainExtra: verification.hltbData.mainExtra,
        hltbCompletionist: verification.hltbData.completionist,
        valueScore,
        isEndless: false,
      });

      const hours = verification.hltbData.main?.toFixed(0) ?? "?";
      console.log(`✓ ${steamData.reviewScore}% | ${hours}h | ${valueScore?.toFixed(0) ?? "N/A"}`);
      added++;

    } catch (e: any) {
      console.log(`✗ ${e.message?.slice(0, 30) ?? "Error"}`);
      failed++;
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 1100));
  }

  console.log(`\n=== Summary ===`);
  console.log(`Added: ${added}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed: ${failed}`);
}

main().catch(console.error);
