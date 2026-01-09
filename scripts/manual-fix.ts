#!/usr/bin/env bun
import { db } from "../src/db/client";
import { sql } from "drizzle-orm";
import { calculateValueScore } from "../src/formula";

// Manual fixes based on web research (HLTB times verified from multiple sources)
const fixes = [
  { steamAppId: 391540, name: "Undertale", main: 6.5, mainExtra: 9.5, completionist: 21 },
  { steamAppId: 1237970, name: "Titanfall 2", main: 6.0, mainExtra: 12.0, completionist: 21 },
  { steamAppId: 1055540, name: "A Short Hike", main: 1.5, mainExtra: 2.5, completionist: 3.5 },
  { steamAppId: 1049410, name: "Superliminal", main: 2.0, mainExtra: 3.0, completionist: 6.0 },
  { steamAppId: 253230, name: "A Hat in Time", main: 8.0, mainExtra: 14.0, completionist: 28.0 },
  { steamAppId: 607080, name: "Psychonauts 2", main: 12.0, mainExtra: 17.0, completionist: 26.0 },
  { steamAppId: 719040, name: "Wasteland 3", main: 32.0, mainExtra: 53.0, completionist: 83.0 },
  { steamAppId: 1057090, name: "Ori and the Will of the Wisps", main: 11.0, mainExtra: 16.0, completionist: 20.0 },
  { steamAppId: 553420, name: "TUNIC", main: 12.5, mainExtra: 17.5, completionist: 24.0 },
  { steamAppId: 257510, name: "The Talos Principle", main: 14.0, mainExtra: 22.0, completionist: 36.0 },
  { steamAppId: 205100, name: "Dishonored", main: 12.0, mainExtra: 22.0, completionist: 37.0 },
  { steamAppId: 219890, name: "Antichamber", main: 6.5, mainExtra: 8.0, completionist: 10.0 },
  { steamAppId: 1240440, name: "Halo Infinite", main: 10.0, mainExtra: 19.0, completionist: 39.0 },
  { steamAppId: 1113000, name: "Persona 4 Golden", main: 69.0, mainExtra: 91.0, completionist: 116.0 },
  { steamAppId: 211600, name: "Thief Gold", main: 15.0, mainExtra: 22.0, completionist: 26.0 },
];

console.log("Fixing HLTB data for", fixes.length, "games...\n");
let fixed = 0;

for (const fix of fixes) {
  const game = await db.query.games.findFirst({
    where: (g, { eq }) => eq(g.steamAppId, fix.steamAppId),
  });

  if (!game) {
    console.log("  Not found:", fix.name);
    continue;
  }

  const score = calculateValueScore({
    steamReviewScore: game.steamReviewScore,
    steamReviewCount: game.steamReviewCount,
    hltbMain: fix.main,
    hltbMainExtra: fix.mainExtra,
    hltbCompletionist: fix.completionist,
    isEndless: false,
  });

  await db.run(sql`
    UPDATE games SET
      hltb_main = ${fix.main},
      hltb_main_extra = ${fix.mainExtra},
      hltb_completionist = ${fix.completionist},
      value_score = ${score}
    WHERE steam_app_id = ${fix.steamAppId}
  `);

  console.log(`  Fixed: ${fix.name.padEnd(35)} | ${fix.main.toString().padStart(5)}h | Score: ${score?.toFixed(2)}`);
  fixed++;
}

console.log(`\nFixed ${fixed} games`);
