#!/usr/bin/env bun

import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { fetchSteamData, isGame, getGameModes, getControllerSupport } from "../src/scrapers/steam";
import { verifyHltbMapping } from "../src/services/hltb-mapping";
import { hasEnglishSupport } from "../src/services/language-lookup";
import { isIgnored } from "../src/services/steam-ignored";
import { calculateValueScore } from "../src/formula";
import { eq, inArray } from "drizzle-orm";

interface SteamDbEntry {
  sid: number;
  name: string;
  hltb_url?: string;
  store_uscore?: number;
}

async function main() {
  const limit = parseInt(process.argv[2] || "100");

  const file = Bun.file("./src/data/steamdb-raw.json");
  const steamdbData: SteamDbEntry[] = await file.json();

  const existing = await db.select({ steamAppId: games.steamAppId }).from(games);
  const existingIds = new Set(existing.map(g => g.steamAppId));

  const candidates = steamdbData
    .filter(g => g.hltb_url && !existingIds.has(g.sid))
    .sort((a, b) => (b.store_uscore ?? 0) - (a.store_uscore ?? 0))
    .slice(0, limit * 20);  

  console.log(`Found ${candidates.length} candidates, processing up to ${limit}...\n`);

  let added = 0;
  let skipped = 0;
  let failed = 0;

  for (const candidate of candidates) {
    if (added >= limit) break;

    process.stdout.write(`[${added + 1}/${limit}] ${candidate.name.slice(0, 35).padEnd(35)} `);

    try {
      const isActualGame = await isGame(candidate.sid);
      if (!isActualGame) {
        console.log("⊘ Not a game");
        skipped++;
        continue;
      }

      const gameIsIgnored = await isIgnored(candidate.sid);

      const hasEnglish = await hasEnglishSupport(candidate.sid);
      if (hasEnglish === false) {
        console.log("⊘ No English");
        skipped++;
        continue;
      }

      const steamData = await fetchSteamData(candidate.sid);

      const verification = await verifyHltbMapping(candidate.sid, steamData.name);

      if (verification.status !== "verified" || !verification.hltbData) {
        console.log(`⊘ ${verification.status}`);
        skipped++;
        continue;
      }

      const gameModes = await getGameModes(candidate.sid);
      const controllerSupport = await getControllerSupport(candidate.sid);

      const valueScore = calculateValueScore({
        steamReviewScore: steamData.reviewScore,
        steamReviewCount: steamData.reviewCount,
        hltbMain: verification.hltbData.main,
        hltbMainExtra: verification.hltbData.mainExtra,
        hltbCompletionist: verification.hltbData.completionist,
        isEndless: gameModes.isMMO,
      });

      await db.insert(games).values({
        steamAppId: candidate.sid,
        name: steamData.name,
        steamReviewScore: steamData.reviewScore,
        steamReviewCount: steamData.reviewCount,
        hltbId: verification.hltbData.hltbId,
        hltbMain: verification.hltbData.main,
        hltbMainExtra: verification.hltbData.mainExtra,
        hltbCompletionist: verification.hltbData.completionist,
        valueScore,
        isEndless: gameModes.isMMO,
        isIgnored: gameIsIgnored,
        controllerSupport,
        hasSinglePlayer: gameModes.hasSinglePlayer,
        hasMultiplayer: gameModes.hasMultiplayer,
        hasCoOp: gameModes.hasCoOp,
        hasOnlineCoOp: gameModes.hasOnlineCoOp,
        hasLocalCoOp: gameModes.hasLocalCoOp,
        hasPvP: gameModes.hasPvP,
        hasOnlinePvP: gameModes.hasOnlinePvP,
        hasLocalPvP: gameModes.hasLocalPvP,
        hasCrossplatform: gameModes.hasCrossplatform,
        isMMO: gameModes.isMMO,
      });

      const hours = verification.hltbData.main?.toFixed(0) ?? "?";
      const ignoredTag = gameIsIgnored ? " [Ignored]" : "";
      console.log(`✓ ${steamData.reviewScore}% | ${hours}h | ${valueScore?.toFixed(0) ?? "N/A"}${ignoredTag}`);
      added++;

    } catch (e: any) {
      console.log(`✗ ${e.message?.slice(0, 30) ?? "Error"}`);
      failed++;
    }

  }

  console.log(`\n=== Summary ===`);
  console.log(`Added: ${added}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed: ${failed}`);
}

main().catch(console.error);
