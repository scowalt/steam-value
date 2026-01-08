#!/usr/bin/env bun
import { db } from "../src/db/client";
import { games } from "../src/db/schema";

const allGames = await db.query.games.findMany();

// Filter: has value score, not endless, has reasonable HLTB data (>5h)
const ranked = allGames.filter(g =>
  g.valueScore !== null &&
  !g.isEndless &&
  g.hltbMain !== null &&
  g.hltbMain > 5
);

const sorted = ranked.sort((a, b) => (b.valueScore ?? 0) - (a.valueScore ?? 0));

console.log("");
console.log("TOP 10 GAMES BY VALUE SCORE (Filtered: >5h playtime)");
console.log("═".repeat(72));
console.log("Rank   Value   Rating   Hours   Name");
console.log("─".repeat(72));

sorted.slice(0, 10).forEach((g, i) => {
  const rank = ("#" + (i + 1)).padStart(4);
  const value = (g.valueScore?.toFixed(2) ?? "N/A").padStart(7);
  const rating = (g.steamReviewScore + "%").padStart(5);
  const hours = ((g.hltbMain?.toFixed(0) ?? "?") + "h").padStart(6);
  const name = g.name.slice(0, 40);
  console.log(rank + "  " + value + "   " + rating + "  " + hours + "   " + name);
});

console.log("─".repeat(72));
console.log(`Total games: ${allGames.length} | With valid data (>5h): ${ranked.length}`);
console.log("");

// Also show some stats
const avgValue = sorted.reduce((sum, g) => sum + (g.valueScore ?? 0), 0) / sorted.length;
const avgHours = sorted.reduce((sum, g) => sum + (g.hltbMain ?? 0), 0) / sorted.length;
console.log(`Average value score: ${avgValue.toFixed(2)}`);
console.log(`Average playtime: ${avgHours.toFixed(1)}h`);
