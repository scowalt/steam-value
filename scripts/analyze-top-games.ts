#!/usr/bin/env bun
import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { fetchSteamData } from "../src/scrapers/steam";
import { getHltbById } from "../src/scrapers/hltb";
import { calculateValueScore } from "../src/formula";
import { eq } from "drizzle-orm";

const TOP_GAMES: { steamId: number; hltbId: number; name: string }[] = [
  { steamId: 1086940, hltbId: 68033, name: "Baldur's Gate 3" },
  { steamId: 1245620, hltbId: 68151, name: "ELDEN RING" },
  { steamId: 1091500, hltbId: 2127, name: "Cyberpunk 2077" },
  { steamId: 489830, hltbId: 38557, name: "Skyrim Special Edition" },

  { steamId: 271590, hltbId: 4063, name: "Grand Theft Auto V" },
  { steamId: 1174180, hltbId: 61912, name: "Red Dead Redemption 2" },

  { steamId: 289070, hltbId: 36705, name: "Civilization VI" },
  { steamId: 394360, hltbId: 33233, name: "Hearts of Iron IV" },
  { steamId: 1142710, hltbId: 55463, name: "Total War: WARHAMMER III" },
  { steamId: 261550, hltbId: 42489, name: "Mount & Blade II: Bannerlord" },

  { steamId: 105600, hltbId: 10056, name: "Terraria" },
  { steamId: 108600, hltbId: 8525, name: "Project Zomboid" },
  { steamId: 413150, hltbId: 41753, name: "Stardew Valley" },
  { steamId: 251570, hltbId: 5233, name: "7 Days to Die" },
  { steamId: 252490, hltbId: 20265, name: "Rust" },
  { steamId: 221100, hltbId: 4112, name: "DayZ" },
  { steamId: 227300, hltbId: 5003, name: "Euro Truck Simulator 2" },

  { steamId: 2300320, hltbId: 125553, name: "Farming Simulator 25" },

  { steamId: 381210, hltbId: 28631, name: "Dead by Daylight" },
  { steamId: 359550, hltbId: 32573, name: "Rainbow Six Siege" },

  { steamId: 322170, hltbId: 16369, name: "Geometry Dash" },
  { steamId: 4000, hltbId: 4212, name: "Garry's Mod" },

  { steamId: 1623730, hltbId: 114063, name: "Palworld" },
];

async function addGame(steamId: number, hltbId: number, expectedName: string) {
  const existing = await db.query.games.findFirst({
    where: eq(games.steamAppId, steamId),
  });

  if (existing) {
    return { status: "exists", game: existing };
  }

  try {
    const steamData = await fetchSteamData(steamId);

    let hltbData = null;
    try {
      hltbData = await getHltbById(hltbId);
    } catch {
    }

    const valueScore = calculateValueScore({
      steamReviewScore: steamData.reviewScore,
      steamReviewCount: steamData.reviewCount,
      hltbMain: hltbData?.main ?? null,
      hltbMainExtra: hltbData?.mainExtra ?? null,
      hltbCompletionist: hltbData?.completionist ?? null,
    });

    const result = await db
      .insert(games)
      .values({
        steamAppId: steamId,
        name: steamData.name,
        steamReviewScore: steamData.reviewScore,
        steamReviewCount: steamData.reviewCount,
        hltbId: hltbData?.hltbId ?? null,
        hltbMain: hltbData?.main ?? null,
        hltbMainExtra: hltbData?.mainExtra ?? null,
        hltbCompletionist: hltbData?.completionist ?? null,
        valueScore,
      })
      .returning();

    return { status: "added", game: result[0], hltbData };
  } catch (error) {
    return { status: "error", error: (error as Error).message };
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════════════════╗");
  console.log("║               STEAM TOP GAMES ANALYSIS                                       ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════════╝\n");

  const results = { added: 0, exists: 0, errors: 0 };

  for (const game of TOP_GAMES) {
    process.stdout.write(`  ${game.name.padEnd(35)} `);

    const result = await addGame(game.steamId, game.hltbId, game.name);

    if (result.status === "added") {
      const score = result.game?.valueScore?.toFixed(2) ?? "N/A";
      const hours = result.hltbData?.main?.toFixed(0) ?? "?";
      console.log(`✓ Added | Value: ${score.padStart(6)} | ${hours}h`);
      results.added++;
    } else if (result.status === "exists") {
      console.log(`○ Exists`);
      results.exists++;
    } else {
      console.log(`✗ ${result.error?.slice(0, 40)}`);
      results.errors++;
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n${"─".repeat(78)}`);
  console.log(`  Summary: ${results.added} added, ${results.exists} existing, ${results.errors} errors`);
  console.log(`${"─".repeat(78)}\n`);

  const allGames = await db.query.games.findMany();
  const gamesWithScore = allGames.filter((g) => g.valueScore !== null);

  const byValue = [...gamesWithScore].sort((a, b) => (b.valueScore ?? 0) - (a.valueScore ?? 0));
  const byLength = [...allGames].filter(g => g.hltbMain).sort((a, b) => (b.hltbMain ?? 0) - (a.hltbMain ?? 0));
  const byReviewScore = [...allGames].sort((a, b) => (b.steamReviewScore ?? 0) - (a.steamReviewScore ?? 0));
  const byReviewCount = [...allGames].sort((a, b) => (b.steamReviewCount ?? 0) - (a.steamReviewCount ?? 0));

  console.log("╔══════════════════════════════════════════════════════════════════════════════╗");
  console.log("║  🏆 TOP GAMES BY VALUE SCORE (Quality ÷ √Length)                             ║");
  console.log("╠══════════════════════════════════════════════════════════════════════════════╣");
  console.log("║  Rank   Value   Rating   Hours   Name                                        ║");
  console.log("╠──────────────────────────────────────────────────────────────────────────────╣");

  byValue.slice(0, 15).forEach((game, i) => {
    const rank = `#${i + 1}`.padStart(4);
    const value = (game.valueScore?.toFixed(2) ?? "N/A").padStart(7);
    const rating = `${game.steamReviewScore}%`.padStart(5);
    const hours = `${game.hltbMain?.toFixed(0) ?? "?"}h`.padStart(6);
    const name = game.name.slice(0, 40).padEnd(40);
    console.log(`║  ${rank}  ${value}   ${rating}  ${hours}   ${name} ║`);
  });
  console.log("╚══════════════════════════════════════════════════════════════════════════════╝\n");

  console.log("╔══════════════════════════════════════════════════════════════════════════════╗");
  console.log("║  📊 ANALYSIS HIGHLIGHTS                                                      ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════════╝\n");

  if (byValue[0]) {
    const g = byValue[0];
    console.log(`  🥇 BEST VALUE: ${g.name}`);
    console.log(`     Value Score: ${g.valueScore?.toFixed(2)} | ${g.steamReviewScore}% positive | ${g.hltbMain?.toFixed(0)}h main story`);
    console.log(`     High quality relative to time investment\n`);
  }

  console.log(`  📏 LONGEST GAMES (Most Content):`);
  byLength.slice(0, 5).forEach((g, i) => {
    const extras = g.hltbMainExtra ? ` (${g.hltbMainExtra.toFixed(0)}h with extras)` : "";
    console.log(`     ${i + 1}. ${g.name} - ${g.hltbMain?.toFixed(0)}h${extras}`);
  });

  const shortQuality = [...allGames]
    .filter(g => g.hltbMain && g.hltbMain < 30 && g.steamReviewScore && g.steamReviewScore >= 90)
    .sort((a, b) => (b.valueScore ?? 0) - (a.valueScore ?? 0));

  if (shortQuality.length > 0) {
    console.log(`\n  ⚡ BEST SHORT GAMES (<30h, >90% rating):`);
    shortQuality.slice(0, 5).forEach((g, i) => {
      console.log(`     ${i + 1}. ${g.name} - ${g.hltbMain?.toFixed(0)}h (${g.steamReviewScore}% rating)`);
    });
  }

  console.log(`\n  ⭐ HIGHEST RATED:`);
  byReviewScore.slice(0, 5).forEach((g, i) => {
    console.log(`     ${i + 1}. ${g.name} - ${g.steamReviewScore}% (${g.steamReviewCount?.toLocaleString()} reviews)`);
  });

  console.log(`\n  🔥 MOST REVIEWED (Most Popular):`);
  byReviewCount.slice(0, 5).forEach((g, i) => {
    console.log(`     ${i + 1}. ${g.name} - ${g.steamReviewCount?.toLocaleString()} reviews`);
  });

  const avgHours = allGames.filter(g => g.hltbMain).reduce((sum, g) => sum + (g.hltbMain ?? 0), 0) /
                   allGames.filter(g => g.hltbMain).length;
  const avgRating = allGames.reduce((sum, g) => sum + (g.steamReviewScore ?? 0), 0) / allGames.length;

  console.log(`\n  📈 AVERAGES ACROSS ${allGames.length} GAMES:`);
  console.log(`     Average Main Story Length: ${avgHours.toFixed(1)} hours`);
  console.log(`     Average Steam Rating: ${avgRating.toFixed(1)}%`);

  const hiddenGems = [...gamesWithScore]
    .filter(g => (g.steamReviewCount ?? 0) < 200000 && (g.valueScore ?? 0) > 10)
    .sort((a, b) => (b.valueScore ?? 0) - (a.valueScore ?? 0));

  if (hiddenGems.length > 0) {
    console.log(`\n  💎 HIDDEN GEMS (High value, fewer reviews):`);
    hiddenGems.slice(0, 5).forEach((g, i) => {
      console.log(`     ${i + 1}. ${g.name} - Value: ${g.valueScore?.toFixed(2)} (${g.steamReviewCount?.toLocaleString()} reviews)`);
    });
  }

  const lowerValue = [...gamesWithScore].sort((a, b) => (a.valueScore ?? 999) - (b.valueScore ?? 999));
  console.log(`\n  ⚠️  LOWER VALUE SCORES (Long time commitment):`);
  lowerValue.slice(0, 3).forEach((g, i) => {
    console.log(`     ${i + 1}. ${g.name} - Value: ${g.valueScore?.toFixed(2)} (${g.hltbMain?.toFixed(0)}h, ${g.steamReviewScore}%)`);
  });

  console.log(`\n${"═".repeat(78)}`);
  console.log(`  Total games: ${allGames.length} | With value scores: ${gamesWithScore.length}`);
  console.log(`${"═".repeat(78)}\n`);
}

main().catch(console.error);
