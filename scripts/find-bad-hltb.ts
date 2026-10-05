#!/usr/bin/env bun
import { db } from "../src/db/client";

const all = await db.query.games.findMany();

const suspicious = all
  .filter(g => g.hltbMain !== null && g.hltbMain < 3 && !g.isEndless)
  .sort((a, b) => (a.hltbMain ?? 0) - (b.hltbMain ?? 0));

console.log("GAMES WITH SUSPICIOUSLY SHORT HLTB DATA (<3h)");
console.log("These likely have wrong HLTB IDs");
console.log("═".repeat(70));
console.log("Hours  HLTB ID    Name");
console.log("─".repeat(70));

suspicious.forEach(g => {
  const hours = g.hltbMain?.toFixed(2).padStart(5) ?? "?";
  const hltbId = (g.hltbId?.toString() ?? "null").padStart(8);
  console.log(`${hours}h  ${hltbId}   ${g.name.slice(0, 50)}`);
});

console.log("─".repeat(70));
console.log(`Total: ${suspicious.length} games need verification`);
