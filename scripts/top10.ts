#!/usr/bin/env bun
import { db } from "../src/db/client";
import { games } from "../src/db/schema";

const allGames = await db.query.games.findMany();
const ranked = allGames.filter(g => g.valueScore !== null && !g.isEndless);
const sorted = ranked.sort((a, b) => (b.valueScore ?? 0) - (a.valueScore ?? 0));

console.log("");
console.log("TOP 10 GAMES BY VALUE SCORE");
console.log("═".repeat(70));
console.log("Rank   Value   Rating   Hours   Name");
console.log("─".repeat(70));

sorted.slice(0, 10).forEach((g, i) => {
  const rank = ("#" + (i + 1)).padStart(4);
  const value = (g.valueScore?.toFixed(2) ?? "N/A").padStart(7);
  const rating = (g.steamReviewScore + "%").padStart(5);
  const hours = ((g.hltbMain?.toFixed(0) ?? "?") + "h").padStart(6);
  const name = g.name.slice(0, 38);
  console.log(rank + "  " + value + "   " + rating + "  " + hours + "   " + name);
});

console.log("─".repeat(70));
console.log(`Total: ${allGames.length} games | Ranked: ${ranked.length} | Endless: ${allGames.filter(g => g.isEndless).length}`);
