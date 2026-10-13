#!/usr/bin/env bun

import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { asc } from "drizzle-orm";
import { deleteGames, readAllRows, reportManualError } from "../src/db/manual";
import { fetchIgnoredApps } from "../src/services/steam-ignored";

async function main() {
  const ignored = await fetchIgnoredApps();

  if (ignored.size === 0) {
    console.log("No ignored apps found. Check your STEAM_LOGIN_SECURE cookie.");
    return;
  }

  console.log(`Found ${ignored.size} ignored games on Steam\n`);

  const allGames = await readAllRows(({ limit, offset }) => db
    .select({
      id: games.id,
      steamAppId: games.steamAppId,
      name: games.name,
    })
    .from(games).orderBy(asc(games.id)).limit(limit).offset(offset));

  const toRemove = allGames.filter((g) => ignored.has(g.steamAppId));

  if (toRemove.length === 0) {
    console.log("No ignored games found in database. Nothing to remove.");
    return;
  }

  console.log(`${toRemove.length} ignored games found in database:\n`);
  toRemove.forEach((g) => console.log(`  - ${g.name} (${g.steamAppId})`));

  const ids = toRemove.map((g) => g.id);
  await deleteGames(db, ids);

  console.log(`\nRemoved ${toRemove.length} games from database.`);
}

main().catch(reportManualError);
