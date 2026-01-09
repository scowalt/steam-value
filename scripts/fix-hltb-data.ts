#!/usr/bin/env bun
import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { getHltbById } from "../src/scrapers/hltb";
import { calculateValueScore } from "../src/formula";
import { sql } from "drizzle-orm";

// Verified correct HLTB IDs (tested or from official URLs)
const FIXES: { pattern: string; hltbId: number; expectedHours: number }[] = [
  // Verified working
  { pattern: "DOOM", hltbId: 2708, expectedHours: 11 },           // DOOM 2016
  { pattern: "Outer Wilds", hltbId: 57527, expectedHours: 17 },
  { pattern: "Titanfall", hltbId: 37819, expectedHours: 6 },      // Titanfall 2
  { pattern: "Dark Souls II", hltbId: 13803, expectedHours: 44 }, // DS2 SOTFS
  { pattern: "Wasteland 3", hltbId: 56041, expectedHours: 32 },
  { pattern: "Psychonauts 2", hltbId: 72118, expectedHours: 12 },
  { pattern: "Thief Gold", hltbId: 10089, expectedHours: 15 },    // Might be correct already
  { pattern: "Undertale", hltbId: 27062, expectedHours: 6 },
  { pattern: "Dragon Age: Origins", hltbId: 2740, expectedHours: 40 },
  { pattern: "Persona 4 Golden", hltbId: 7095, expectedHours: 69 },
  { pattern: "Portal 2", hltbId: 7119, expectedHours: 8 },
  { pattern: "Halo Infinite", hltbId: 79118, expectedHours: 10 },
  { pattern: "Dishonored", hltbId: 2613, expectedHours: 12 },
  { pattern: "Antichamber", hltbId: 790, expectedHours: 7 },
  { pattern: "Deus Ex: Human Revolution", hltbId: 2620, expectedHours: 22 },
  { pattern: "Hat in Time", hltbId: 36933, expectedHours: 8 },
  { pattern: "TUNIC", hltbId: 71883, expectedHours: 13 },
  { pattern: "Superliminal", hltbId: 76561, expectedHours: 2 },   // Actually short game
];

const batchNum = parseInt(process.argv[2] ?? "0");

async function fixGame(pattern: string, hltbId: number, expectedHours: number) {
  const allGames = await db.query.games.findMany();
  const game = allGames.find(g => g.name.includes(pattern));

  if (!game) {
    console.log(`  Not found: ${pattern}`);
    return false;
  }

  // Check if already correct
  if (game.hltbMain && Math.abs(game.hltbMain - expectedHours) < 5) {
    console.log(`  Already OK: ${game.name} (${game.hltbMain?.toFixed(1)}h)`);
    return false;
  }

  try {
    const hltb = await getHltbById(hltbId);
    if (!hltb || !hltb.main) {
      console.log(`  HLTB failed for ${pattern} (id: ${hltbId})`);
      return false;
    }

    // Verify it's approximately correct
    if (Math.abs(hltb.main - expectedHours) > 10) {
      console.log(`  Wrong ID? ${pattern}: got ${hltb.name} (${hltb.main?.toFixed(1)}h), expected ~${expectedHours}h`);
      return false;
    }

    const score = calculateValueScore({
      steamReviewScore: game.steamReviewScore,
      steamReviewCount: game.steamReviewCount,
      hltbMain: hltb.main,
      hltbMainExtra: hltb.mainExtra,
      hltbCompletionist: hltb.completionist,
      isEndless: game.isEndless,
    });

    await db.run(sql`
      UPDATE games
      SET hltb_id = ${hltbId},
          hltb_main = ${hltb.main},
          hltb_main_extra = ${hltb.mainExtra},
          hltb_completionist = ${hltb.completionist},
          value_score = ${score}
      WHERE id = ${game.id}
    `);

    console.log(`  Fixed: ${game.name} | ${hltb.main?.toFixed(1)}h | Value: ${score?.toFixed(2)}`);
    return true;
  } catch (e: any) {
    console.log(`  Error: ${pattern} - ${e.message?.slice(0, 40)}`);
    return false;
  }
}

async function main() {
  console.log("Fixing HLTB data...\n");

  let fixed = 0;
  const start = batchNum > 0 ? (batchNum - 1) * 5 : 0;
  const end = batchNum > 0 ? Math.min(start + 5, FIXES.length) : FIXES.length;

  for (let i = start; i < end; i++) {
    const fix = FIXES[i];
    const success = await fixGame(fix.pattern, fix.hltbId, fix.expectedHours);
    if (success) fixed++;
    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`\nFixed ${fixed} games`);
}

main().catch(console.error);
