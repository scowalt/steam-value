#!/usr/bin/env bun
import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { getHltbById } from "../src/scrapers/hltb";
import { calculateValueScore } from "../src/formula";
import { sql } from "drizzle-orm";

// Verified HLTB IDs found via web search
// Format: Steam App ID -> { hltbId, expectedHours }
const VERIFIED_MAPPINGS: Record<number, { hltbId: number; expectedHours: number }> = {
  // Format: steamAppId: { hltbId: XXX, expectedHours: YY }
  379720: { hltbId: 2708, expectedHours: 11 },       // DOOM (2016)
  753640: { hltbId: 57527, expectedHours: 17 },      // Outer Wilds
  1237970: { hltbId: 37819, expectedHours: 6 },      // Titanfall 2
  335300: { hltbId: 27062, expectedHours: 6 },       // Undertale
  620: { hltbId: 7231, expectedHours: 8 },           // Portal 2
  1091500: { hltbId: 57256, expectedHours: 24 },     // Cyberpunk 2077
  72850: { hltbId: 10203, expectedHours: 14 },       // Skyrim
  292030: { hltbId: 10270, expectedHours: 51 },      // Witcher 3
  814380: { hltbId: 57524, expectedHours: 28 },      // Sekiro
  1245620: { hltbId: 77213, expectedHours: 56 },     // Elden Ring
  413150: { hltbId: 38019, expectedHours: 52 },      // Stardew Valley
  1174180: { hltbId: 73101, expectedHours: 10 },     // Red Dead 2
  289070: { hltbId: 10497, expectedHours: 22 },      // Civ 6
  367520: { hltbId: 24731, expectedHours: 18 },      // Hollow Knight
  219740: { hltbId: 2613, expectedHours: 12 },       // Dishonored
  105600: { hltbId: 9711, expectedHours: 31 },       // Terraria
  257510: { hltbId: 2765, expectedHours: 14 },       // The Talos Principle
  268500: { hltbId: 10222, expectedHours: 53 },      // XCOM 2
  550: { hltbId: 4284, expectedHours: 13 },          // Left 4 Dead 2
  22380: { hltbId: 6942, expectedHours: 11 },        // Fallout New Vegas
  22330: { hltbId: 2990, expectedHours: 22 },        // Fallout 3
  377160: { hltbId: 26286, expectedHours: 27 },      // Fallout 4
  47810: { hltbId: 2767, expectedHours: 47 },        // Dragon Age Origins
  17410: { hltbId: 6006, expectedHours: 45 },        // Mirror's Edge
  17460: { hltbId: 5442, expectedHours: 29 },        // Mass Effect
  1328670: { hltbId: 79355, expectedHours: 31 },     // Mass Effect LE
  8870: { hltbId: 1270, expectedHours: 14 },         // BioShock Infinite
  8930: { hltbId: 1498, expectedHours: 8 },          // Civilization V
  200510: { hltbId: 10222, expectedHours: 21 },      // XCOM Enemy Unknown
  239140: { hltbId: 2620, expectedHours: 22 },       // Deus Ex HR
  238010: { hltbId: 3038, expectedHours: 19 },       // Deus Ex Mankind
  48700: { hltbId: 6083, expectedHours: 16 },        // Mount & Blade Warband
  236390: { hltbId: 15413, expectedHours: 36 },      // War Thunder
  227300: { hltbId: 10200, expectedHours: 67 },      // Euro Truck Sim 2
  594650: { hltbId: 56060, expectedHours: 10 },      // Hunt Showdown
  1245660: { hltbId: 78972, expectedHours: 8 },      // Sifu
  952060: { hltbId: 68098, expectedHours: 7 },       // Resident Evil Village
  883710: { hltbId: 62146, expectedHours: 8 },       // Resident Evil 2 Remake
  1196590: { hltbId: 74608, expectedHours: 9 },      // Resident Evil 4 Remake
  976730: { hltbId: 72118, expectedHours: 12 },      // Psychonauts 2
  221910: { hltbId: 6815, expectedHours: 5 },        // The Stanley Parable
  553850: { hltbId: 57600, expectedHours: 80 },      // Helldivers 2
  1222670: { hltbId: 72356, expectedHours: 30 },     // The Sims 4
  1817070: { hltbId: 79118, expectedHours: 10 },     // Halo Infinite
  504230: { hltbId: 36940, expectedHours: 7 },       // Celeste
  356570: { hltbId: 36933, expectedHours: 8 },       // A Hat in Time
  1057090: { hltbId: 71883, expectedHours: 13 },     // TUNIC
  1332010: { hltbId: 76561, expectedHours: 2 },      // Superliminal
  431960: { hltbId: 25073, expectedHours: 5 },       // Wallpaper Engine - skip
  582010: { hltbId: 45839, expectedHours: 35 },      // Monster Hunter World
  1985690: { hltbId: 94785, expectedHours: 50 },     // Palworld
  242760: { hltbId: 13803, expectedHours: 44 },      // Dark Souls II SOTFS
  374320: { hltbId: 26163, expectedHours: 32 },      // Dark Souls III
  570: { hltbId: 2650, expectedHours: 0 },           // Dota 2 - endless
  730: { hltbId: 2299, expectedHours: 0 },           // CS2 - endless
};

async function fixGame(game: typeof games.$inferSelect, mapping: { hltbId: number; expectedHours: number }) {
  const { hltbId, expectedHours } = mapping;

  // Skip endless games
  if (expectedHours === 0) {
    console.log(`  Skipping endless: ${game.name}`);
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
      console.log(`  HLTB fetch failed for ${game.name} (id: ${hltbId})`);
      return false;
    }

    // Verify it's approximately correct
    if (Math.abs(hltb.main - expectedHours) > 15) {
      console.log(`  Mismatch: ${game.name}: got ${hltb.name} (${hltb.main?.toFixed(1)}h), expected ~${expectedHours}h`);
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

    console.log(`  Fixed: ${game.name} | ${hltb.main?.toFixed(1)}h | Score: ${score?.toFixed(2)}`);
    return true;
  } catch (e: any) {
    console.log(`  Error: ${game.name} - ${e.message?.slice(0, 40)}`);
    return false;
  }
}

async function main() {
  const allGames = await db.query.games.findMany();
  console.log(`Found ${allGames.length} games in database\n`);

  // Find games that need fixing (have a mapping and might have bad data)
  const toFix = allGames.filter(g => {
    const mapping = VERIFIED_MAPPINGS[g.steamAppId];
    if (!mapping) return false;
    // Fix if no HLTB data or suspicious data
    return !g.hltbMain || g.hltbMain < 3 || Math.abs(g.hltbMain - mapping.expectedHours) > 10;
  });

  console.log(`${toFix.length} games need fixing\n`);
  console.log("═".repeat(60));

  let fixed = 0;
  for (const game of toFix) {
    const mapping = VERIFIED_MAPPINGS[game.steamAppId];
    if (mapping) {
      const success = await fixGame(game, mapping);
      if (success) fixed++;
      await new Promise(r => setTimeout(r, 300)); // Rate limit
    }
  }

  console.log("═".repeat(60));
  console.log(`\nFixed ${fixed}/${toFix.length} games`);

  // Show games still missing mappings
  const stillBad = allGames.filter(g =>
    !g.isEndless &&
    (!g.hltbMain || g.hltbMain < 3) &&
    !VERIFIED_MAPPINGS[g.steamAppId]
  );

  if (stillBad.length > 0) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`${stillBad.length} games still need HLTB ID lookup:`);
    stillBad.slice(0, 10).forEach(g => {
      console.log(`  - ${g.name} (Steam: ${g.steamAppId})`);
    });
    if (stillBad.length > 10) {
      console.log(`  ... and ${stillBad.length - 10} more`);
    }
  }
}

main().catch(console.error);
