#!/usr/bin/env bun

import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { hasEnglishSupport, getLanguages } from "../src/services/language-lookup";
import { eq, inArray } from "drizzle-orm";

interface NonEnglishGame {
  id: number;
  steamAppId: number;
  name: string;
  languages: string[] | null;
}

async function findNonEnglishGames(): Promise<NonEnglishGame[]> {
  const allGames = await db.select().from(games);
  const nonEnglish: NonEnglishGame[] = [];

  for (const game of allGames) {
    const englishSupport = await hasEnglishSupport(game.steamAppId);

    if (englishSupport === false) {
      const languages = await getLanguages(game.steamAppId);
      nonEnglish.push({
        id: game.id,
        steamAppId: game.steamAppId,
        name: game.name,
        languages,
      });
    } else if (englishSupport === null) {
      console.log(`  [UNKNOWN] ${game.name} (Steam ${game.steamAppId}) - could not verify, keeping`);
    }
  }

  return nonEnglish;
}

async function main() {
  const args = process.argv.slice(2);
  const shouldRemove = args.includes("--remove");
  const showHelp = args.includes("--help") || args.includes("-h");

  if (showHelp) {
    console.log("Usage: bun scripts/filter-english.ts [options]");
    console.log("\nOptions:");
    console.log("  --preview   Preview non-English games (default)");
    console.log("  --remove    Remove non-English games from database");
    console.log("  --help      Show this help message");
    process.exit(0);
  }

  console.log("Scanning database for non-English games...\n");

  const nonEnglish = await findNonEnglishGames();

  if (nonEnglish.length === 0) {
    console.log("\nAll games support English!");
    process.exit(0);
  }

  console.log(`\nFound ${nonEnglish.length} game(s) without English support:\n`);

  for (const game of nonEnglish) {
    const langs = game.languages?.join(", ") || "unknown";
    console.log(`  - ${game.name} (Steam ${game.steamAppId})`);
    console.log(`    Languages: ${langs}`);
  }

  if (shouldRemove) {
    console.log(`\nRemoving ${nonEnglish.length} game(s)...`);

    const idsToRemove = nonEnglish.map((g) => g.id);
    await db.delete(games).where(inArray(games.id, idsToRemove));

    console.log("Done! Games removed.");
  } else {
    console.log("\nRun with --remove to delete these games.");
  }
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
