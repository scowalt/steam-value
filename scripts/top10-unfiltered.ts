#!/usr/bin/env bun
import { db } from "../src/db/client";
import { readAllGames } from "../src/db/manual";

const all = await readAllGames(db);
const ranked = all.filter(g => g.valueScore !== null && !g.isEndless);
const sorted = ranked.sort((a, b) => (b.valueScore ?? 0) - (a.valueScore ?? 0));

console.log("TOP 10 BY VALUE (unfiltered)");
console.log("═".repeat(65));
console.log("Rank  Value    Rating  Hours   Name");
console.log("─".repeat(65));
sorted.slice(0, 15).forEach((g, i) => {
  const rank = `#${i+1}`.padStart(3);
  const value = g.valueScore?.toFixed(2).padStart(7) ?? "N/A";
  const rating = `${g.steamReviewScore}%`.padStart(5);
  const hours = g.hltbMain ? `${g.hltbMain.toFixed(1)}h`.padStart(6) : "?".padStart(6);
  const name = g.name.slice(0, 35);
  console.log(`${rank}  ${value}   ${rating}  ${hours}   ${name}`);
});
console.log("─".repeat(65));
