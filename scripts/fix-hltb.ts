#!/usr/bin/env bun
import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { getHltbById } from "../src/scrapers/hltb";
import { calculateValueScore } from "../src/formula";
import { eq } from "drizzle-orm";

// Correct HLTB IDs (verified from howlongtobeat.com URLs)
const CORRECT_HLTB_IDS: Record<string, number> = {
  "Sekiro": 57415,           // Not 57386
  "Celeste": 42818,          // Not 49970
  "Undertale": 21336,        // Not 26523
  "DOOM": 2028,              // DOOM 2016 - Not 38058
  "Titanfall": 10019,        // Not 10348
  "Shovel Knight": 20456,    // Not 22050
  "Half-Life 2": 4260,       // Not 4210
  "Crusader Kings III": 79468, // Not 75126
  "Horizon Zero Dawn": 36936, // Not 41618
  "The Witness": 26833,       // Not 15091
  "Portal 2": 7119,           // Not 8016
  "Portal": 7112,             // Not 8017
  "Outer Wilds": 44504,       // Not 62668
  "Hollow Knight": 26286,     // Verify this one
  "Hades": 64351,             // Not 69955
  "Dead Cells": 45812,        // Not 50614
};

async function fixGame(namePattern: string, correctHltbId: number) {
  const allGames = await db.query.games.findMany();
  const game = allGames.find(g => g.name.includes(namePattern));

  if (!game) {
    console.log(`  Not found: ${namePattern}`);
    return;
  }

  // Fetch correct HLTB data
  const hltbData = await getHltbById(correctHltbId);
  if (!hltbData) {
    console.log(`  Failed HLTB fetch for ${namePattern}`);
    return;
  }

  // Recalculate value score
  const valueScore = calculateValueScore({
    steamReviewScore: game.steamReviewScore,
    steamReviewCount: game.steamReviewCount,
    hltbMain: hltbData.main,
    hltbMainExtra: hltbData.mainExtra,
    hltbCompletionist: hltbData.completionist,
    isEndless: game.isEndless,
  });

  // Update in database
  await db.update(games)
    .set({
      hltbId: correctHltbId,
      hltbMain: hltbData.main,
      hltbMainExtra: hltbData.mainExtra,
      hltbCompletionist: hltbData.completionist,
      valueScore,
    })
    .where(eq(games.id, game.id));

  console.log(`  Fixed: ${game.name} | ${hltbData.main?.toFixed(1)}h main | Value: ${valueScore?.toFixed(2) ?? 'N/A'}`);
}

async function main() {
  console.log("Fixing HLTB data with correct IDs...\n");

  for (const [namePattern, hltbId] of Object.entries(CORRECT_HLTB_IDS)) {
    await fixGame(namePattern, hltbId);
    await new Promise(r => setTimeout(r, 400)); // Rate limit
  }

  console.log("\nDone!");
}

main().catch(console.error);
