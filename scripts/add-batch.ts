#!/usr/bin/env bun
import { db } from "../src/db/client";
import { findGame, insertGames, recoverableManualError } from "../src/db/manual";
import { games } from "../src/db/schema";
import { fetchSteamData } from "../src/scrapers/steam";
import { getHltbById } from "../src/scrapers/hltb";
import { calculateValueScore } from "../src/formula";
import { eq } from "drizzle-orm";

const batchNum = parseInt(process.argv[2] ?? "1");

const ALL_GAMES: { steamId: number; hltbId: number; name: string; endless?: boolean }[][] = [
  [
    { steamId: 17450, hltbId: 2725, name: "Dragon Age: Origins" },
    { steamId: 230230, hltbId: 12968, name: "Divinity: Original Sin" },
    { steamId: 719040, hltbId: 79532, name: "Wasteland 3" },
    { steamId: 1184370, hltbId: 85498, name: "Pathfinder: WotR" },
    { steamId: 32370, hltbId: 9541, name: "Star Wars: KOTOR" },
    { steamId: 1687950, hltbId: 57552, name: "Persona 5 Royal" },
    { steamId: 637650, hltbId: 41997, name: "Final Fantasy XV" },
    { steamId: 1462040, hltbId: 57493, name: "FF VII Remake" },
    { steamId: 740130, hltbId: 71536, name: "Tales of Arise" },
    { steamId: 1817070, hltbId: 103498, name: "Persona 3 Reload" },
  ],
  [
    { steamId: 582010, hltbId: 52488, name: "Monster Hunter: World" },
    { steamId: 1446780, hltbId: 79297, name: "Monster Hunter Rise" },
    { steamId: 1325200, hltbId: 71787, name: "Nioh 2" },
    { steamId: 335300, hltbId: 24481, name: "Dark Souls II" },
    { steamId: 2215430, hltbId: 90284, name: "Ghost of Tsushima" },
    { steamId: 1888160, hltbId: 110379, name: "Armored Core VI" },
    { steamId: 1282100, hltbId: 107285, name: "Remnant 2" },
    { steamId: 617290, hltbId: 57832, name: "Remnant: From Ashes" },
    { steamId: 1971870, hltbId: 114328, name: "Metaphor: ReFantazio" },
  ],
  [
    { steamId: 1092790, hltbId: 85112, name: "Inscryption" },
    { steamId: 1794680, hltbId: 99277, name: "Vampire Survivors", endless: true },
    { steamId: 553420, hltbId: 57286, name: "Tunic" },
    { steamId: 972660, hltbId: 70546, name: "Spiritfarer" },
    { steamId: 1313140, hltbId: 96459, name: "Cult of the Lamb" },
    { steamId: 1868140, hltbId: 108895, name: "Dave the Diver" },
    { steamId: 526870, hltbId: 59949, name: "Satisfactory", endless: true },
    { steamId: 1366540, hltbId: 82685, name: "Dyson Sphere Program", endless: true },
    { steamId: 739630, hltbId: 68498, name: "Phasmophobia", endless: true },
  ],
  [
    { steamId: 214490, hltbId: 15491, name: "Alien: Isolation" },
    { steamId: 391720, hltbId: 30095, name: "Layers of Fear" },
    { steamId: 424840, hltbId: 38938, name: "Little Nightmares" },
    { steamId: 860510, hltbId: 68505, name: "Little Nightmares II" },
    { steamId: 594330, hltbId: 41540, name: "Visage" },
    { steamId: 242760, hltbId: 15818, name: "The Forest", endless: true },
    { steamId: 1326470, hltbId: 95183, name: "Sons of the Forest", endless: true },
    { steamId: 1562430, hltbId: 103027, name: "Dredge" },
  ],
  [
    { steamId: 779340, hltbId: 59073, name: "Total War: Three Kingdoms" },
    { steamId: 34330, hltbId: 10491, name: "Total War: Shogun 2" },
    { steamId: 236850, hltbId: 3604, name: "Europa Universalis IV", endless: true },
    { steamId: 323190, hltbId: 51011, name: "Frostpunk" },
    { steamId: 255710, hltbId: 12631, name: "Cities: Skylines", endless: true },
    { steamId: 535930, hltbId: 51556, name: "Two Point Hospital" },
  ],
  [
    { steamId: 397540, hltbId: 57527, name: "Borderlands 3" },
    { steamId: 49520, hltbId: 1274, name: "Borderlands 2" },
    { steamId: 550, hltbId: 5143, name: "Left 4 Dead 2" },
    { steamId: 218620, hltbId: 13229, name: "Payday 2", endless: true },
    { steamId: 1144200, hltbId: 82939, name: "Ready or Not" },
    { steamId: 594650, hltbId: 46680, name: "Hunt: Showdown", endless: true },
    { steamId: 1029690, hltbId: 100269, name: "Sniper Elite 5" },
  ],
  [
    { steamId: 270880, hltbId: 23826, name: "American Truck Sim" },
    { steamId: 1250410, hltbId: 70936, name: "MS Flight Sim" },
    { steamId: 1465360, hltbId: 82213, name: "Snowrunner" },
    { steamId: 613100, hltbId: 51932, name: "House Flipper" },
    { steamId: 1290000, hltbId: 93085, name: "PowerWash Sim" },
    { steamId: 621060, hltbId: 51612, name: "PC Building Sim" },
    { steamId: 690790, hltbId: 58127, name: "Dirt Rally 2.0" },
  ],
  [
    { steamId: 238010, hltbId: 2611, name: "Deus Ex: HR" },
    { steamId: 337000, hltbId: 26929, name: "Deus Ex: MD" },
    { steamId: 480490, hltbId: 42424, name: "Prey (2017)" },
    { steamId: 205100, hltbId: 2577, name: "Dishonored" },
    { steamId: 403640, hltbId: 35063, name: "Dishonored 2" },
    { steamId: 203160, hltbId: 10477, name: "Tomb Raider 2013" },
    { steamId: 391220, hltbId: 27394, name: "Rise of Tomb Raider" },
  ],
  [
    { steamId: 208650, hltbId: 1318, name: "Batman: Arkham Knight" },
    { steamId: 200260, hltbId: 1315, name: "Batman: Arkham City" },
    { steamId: 35140, hltbId: 1313, name: "Batman: Arkham Asylum" },
    { steamId: 257510, hltbId: 14635, name: "The Talos Principle" },
    { steamId: 736260, hltbId: 58617, name: "Baba Is You" },
    { steamId: 1049410, hltbId: 72372, name: "Superliminal" },
    { steamId: 219890, hltbId: 776, name: "Antichamber" },
  ],
  [
    { steamId: 242550, hltbId: 8285, name: "Rayman Legends" },
    { steamId: 418530, hltbId: 71303, name: "Spelunky 2" },
    { steamId: 48000, hltbId: 5455, name: "Limbo" },
    { steamId: 304430, hltbId: 27514, name: "Inside" },
    { steamId: 253230, hltbId: 16622, name: "A Hat in Time" },
    { steamId: 607080, hltbId: 58832, name: "Psychonauts 2" },
    { steamId: 881100, hltbId: 62059, name: "Noita" },
    { steamId: 262060, hltbId: 17101, name: "Darkest Dungeon" },
    { steamId: 212680, hltbId: 4352, name: "FTL" },
    { steamId: 590380, hltbId: 55356, name: "Into the Breach" },
  ],
];

const batch = ALL_GAMES[batchNum - 1];
if (!batch) {
  console.log("Invalid batch. Use 1-10");
  process.exit(1);
}

console.log(`Running batch ${batchNum}/${ALL_GAMES.length}...\n`);

for (const g of batch) {
  const existing = await findGame(db, g.steamId);
  if (existing) {
    console.log(`${g.name.padEnd(25)} ○ Exists`);
    continue;
  }

  try {
    const steam = await fetchSteamData(g.steamId);
    let hltb = null;
    try { hltb = await getHltbById(g.hltbId); } catch {}

    const score = calculateValueScore({
      steamReviewScore: steam.reviewScore,
      steamReviewCount: steam.reviewCount,
      hltbMain: hltb?.main ?? null,
      hltbMainExtra: hltb?.mainExtra ?? null,
      hltbCompletionist: hltb?.completionist ?? null,
      isEndless: g.endless,
    });

    await insertGames(db, [{
      steamAppId: g.steamId,
      name: steam.name,
      steamReviewScore: steam.reviewScore,
      steamReviewCount: steam.reviewCount,
      hltbId: hltb?.hltbId ?? null,
      hltbMain: hltb?.main ?? null,
      hltbMainExtra: hltb?.mainExtra ?? null,
      hltbCompletionist: hltb?.completionist ?? null,
      valueScore: score,
      isEndless: g.endless ?? false,
    }]);

    const tag = g.endless ? " [endless]" : "";
    console.log(`${steam.name.slice(0,25).padEnd(25)} ✓ ${hltb?.main?.toFixed(0) ?? "?"}h | Value: ${score?.toFixed(2) ?? "N/A"}${tag}`);
  } catch (error) {
    const failure = recoverableManualError(error);
    console.log(`${g.name.padEnd(25)} ✗ ${failure.message.slice(0,30)}`);
  }

  await new Promise(r => setTimeout(r, 400));
}

console.log("\nBatch complete!");
