#!/usr/bin/env bun

import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { asc } from "drizzle-orm";
import { deleteGames, readAllRows, reportManualError } from "../src/db/manual";
import { fetchPlayedApps } from "../src/services/steam-played";

async function main() {
  const played = await fetchPlayedApps();

  if (played.size === 0) {
    console.log("No played apps found. Check your STEAM_API_KEY and STEAM_ID.");
    return;
  }

  console.log(`\nFound ${played.size} games with playtime on Steam\n`);

  const allGames = await readAllRows(({ limit, offset }) => db
    .select({
      id: games.id,
      steamAppId: games.steamAppId,
      name: games.name,
    })
    .from(games).orderBy(asc(games.id)).limit(limit).offset(offset));

  const toRemove = allGames.filter((g) => played.has(g.steamAppId));

  if (toRemove.length === 0) {
    console.log("No played games found in database. Nothing to remove.");
    return;
  }

  console.log(`${toRemove.length} played games found in database:\n`);
  toRemove.forEach((g) => console.log(`  - ${g.name} (${g.steamAppId})`));

  const ids = toRemove.map((g) => g.id);
  await deleteGames(db, ids);

  console.log(`\nRemoved ${toRemove.length} games from database.`);
}

main().catch(reportManualError);
