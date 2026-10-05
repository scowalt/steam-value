#!/usr/bin/env bun
import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { desc, asc } from "drizzle-orm";
import { formulaConfig } from "../src/formula/config";

async function main() {
  const sortArg = process.argv[2];
  const sortByScore = sortArg !== "--by-name";

  const allGames = await db.query.games.findMany({
    orderBy: sortByScore ? desc(games.valueScore) : asc(games.name),
  });

  if (allGames.length === 0) {
    console.log("\nNo games found. Add some games with:");
    console.log("  bun add <steam_app_id>");
    process.exit(0);
  }

  const rankedGames = allGames.filter((g) => !g.isEndless);
  const endlessGames = allGames.filter((g) => g.isEndless);

  console.log("═".repeat(80));
  console.log("STEAM VALUE - Ranked Games");
  console.log("═".repeat(80));
  console.log(`Formula: rating ÷ √hours | timeMetric=${formulaConfig.timeMetric}`);
  console.log("─".repeat(80));

  if (rankedGames.length > 0) {
    const sortedRanked = [...rankedGames].sort((a, b) => {
      if (a.valueScore === null && b.valueScore === null) return 0;
      if (a.valueScore === null) return 1;
      if (b.valueScore === null) return -1;
      return b.valueScore - a.valueScore;
    });

    console.log(
      padRight("Rank", 6) +
      padRight("Value", 8) +
      padRight("Score", 7) +
      padRight("Hours", 7) +
      padRight("Reviews", 10) +
      "Name"
    );
    console.log("─".repeat(80));

    sortedRanked.forEach((game, index) => {
      const rank = game.valueScore !== null ? `#${index + 1}` : "";
      const value = game.valueScore?.toFixed(2) ?? "N/A";
      const score = game.steamReviewScore !== null ? `${game.steamReviewScore}%` : "N/A";
      const hours = getHours(game)?.toFixed(1) ?? "N/A";
      const reviews = game.steamReviewCount?.toLocaleString() ?? "N/A";

      console.log(
        padRight(rank, 6) +
        padRight(value, 8) +
        padRight(score, 7) +
        padRight(hours, 7) +
        padRight(reviews, 10) +
        truncate(game.name, 40)
      );
    });

    console.log("─".repeat(80));
    console.log(`Total ranked: ${rankedGames.length} games`);

    const missingHltb = rankedGames.filter((g) => g.valueScore === null && !g.isEndless);
    if (missingHltb.length > 0) {
      console.log(`Note: ${missingHltb.length} game(s) missing value score (no HLTB data)`);
    }
  } else {
    console.log("No ranked games yet.");
  }

  if (endlessGames.length > 0) {
    console.log("\n" + "═".repeat(80));
    console.log("ENDLESS / MULTIPLAYER GAMES (not ranked)");
    console.log("═".repeat(80));
    console.log(
      padRight("", 6) +
      padRight("", 8) +
      padRight("Score", 7) +
      padRight("", 7) +
      padRight("Reviews", 10) +
      "Name"
    );
    console.log("─".repeat(80));

    const sortedEndless = [...endlessGames].sort(
      (a, b) => (b.steamReviewScore ?? 0) - (a.steamReviewScore ?? 0)
    );

    sortedEndless.forEach((game) => {
      const score = game.steamReviewScore !== null ? `${game.steamReviewScore}%` : "N/A";
      const reviews = game.steamReviewCount?.toLocaleString() ?? "N/A";

      console.log(
        padRight("", 6) +
        padRight("--", 8) +
        padRight(score, 7) +
        padRight("--", 7) +
        padRight(reviews, 10) +
        truncate(game.name, 40)
      );
    });

    console.log("─".repeat(80));
    console.log(`Total endless: ${endlessGames.length} games`);
  }

  console.log("\n" + "═".repeat(80));
  console.log(`Total: ${allGames.length} games (${rankedGames.length} ranked, ${endlessGames.length} endless)`);
  console.log("═".repeat(80));
}

function getHours(game: typeof games.$inferSelect): number | null {
  switch (formulaConfig.timeMetric) {
    case "main":
      return game.hltbMain;
    case "mainExtra":
      return game.hltbMainExtra;
    case "completionist":
      return game.hltbCompletionist;
  }
}

function padRight(str: string, len: number): string {
  return str.toString().padEnd(len);
}

function truncate(str: string, len: number): string {
  return str.length > len ? str.slice(0, len - 3) + "..." : str;
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
