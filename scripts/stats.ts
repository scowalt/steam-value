#!/usr/bin/env bun
import { db } from "../src/db/client";

const all = await db.query.games.findMany();
const ranked = all.filter(g => g.valueScore !== null && !g.isEndless);
const endless = all.filter(g => g.isEndless);
const withHltb = all.filter(g => g.hltbMain && g.hltbMain > 5);

console.log("═".repeat(60));
console.log("DATABASE STATS");
console.log("═".repeat(60));
console.log(`Total games:           ${all.length}`);
console.log(`Ranked (with scores):  ${ranked.length}`);
console.log(`Endless/Multiplayer:   ${endless.length}`);
console.log(`Valid HLTB data (>5h): ${withHltb.length}`);

// Top 10
const sorted = ranked.filter(g => g.hltbMain && g.hltbMain > 5).sort((a, b) => (b.valueScore ?? 0) - (a.valueScore ?? 0));
console.log("\n" + "═".repeat(60));
console.log("TOP 10 BY VALUE SCORE");
console.log("═".repeat(60));
console.log("Rank  Value   Rating  Hours  Name");
console.log("─".repeat(60));
sorted.slice(0, 10).forEach((g, i) => {
  const rank = `#${i+1}`.padStart(3);
  const value = g.valueScore?.toFixed(2).padStart(6) ?? "N/A";
  const rating = `${g.steamReviewScore}%`.padStart(5);
  const hours = `${g.hltbMain?.toFixed(0)}h`.padStart(5);
  const name = g.name.slice(0, 35);
  console.log(`${rank}   ${value}   ${rating}  ${hours}  ${name}`);
});

// Highest rated
const byRating = [...ranked].sort((a, b) => (b.steamReviewScore ?? 0) - (a.steamReviewScore ?? 0));
console.log("\n" + "═".repeat(60));
console.log("HIGHEST RATED");
console.log("═".repeat(60));
byRating.slice(0, 5).forEach((g, i) => {
  console.log(`${i+1}. ${g.name.slice(0,40)} - ${g.steamReviewScore}%`);
});

// Longest games
const byLength = [...all].filter(g => g.hltbMain).sort((a, b) => (b.hltbMain ?? 0) - (a.hltbMain ?? 0));
console.log("\n" + "═".repeat(60));
console.log("LONGEST GAMES");
console.log("═".repeat(60));
byLength.slice(0, 5).forEach((g, i) => {
  console.log(`${i+1}. ${g.name.slice(0,40)} - ${g.hltbMain?.toFixed(0)}h main story`);
});

// Best short games
const shortGood = ranked.filter(g => g.hltbMain && g.hltbMain < 15 && g.steamReviewScore && g.steamReviewScore >= 90)
  .sort((a, b) => (b.valueScore ?? 0) - (a.valueScore ?? 0));
console.log("\n" + "═".repeat(60));
console.log("BEST SHORT GAMES (<15h, 90%+ rating)");
console.log("═".repeat(60));
shortGood.slice(0, 5).forEach((g, i) => {
  console.log(`${i+1}. ${g.name.slice(0,35)} - ${g.hltbMain?.toFixed(0)}h | ${g.steamReviewScore}%`);
});

console.log("\n" + "═".repeat(60));
