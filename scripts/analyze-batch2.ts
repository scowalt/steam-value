#!/usr/bin/env bun
import { db } from "../src/db/client";
import { findGame, insertGames, readAllGames, recoverableManualError, reportManualError } from "../src/db/manual";
import { games } from "../src/db/schema";
import { fetchSteamData } from "../src/scrapers/steam";
import { getHltbById } from "../src/scrapers/hltb";
import { calculateValueScore } from "../src/formula";
import { eq } from "drizzle-orm";

const BATCH2_GAMES: { steamId: number; hltbId: number; name: string; endless?: boolean }[] = [
  { steamId: 17450, hltbId: 2725, name: "Dragon Age: Origins" },
  { steamId: 230230, hltbId: 12968, name: "Divinity: Original Sin" },
  { steamId: 719040, hltbId: 79532, name: "Wasteland 3" },
  { steamId: 1184370, hltbId: 85498, name: "Pathfinder: Wrath of the Righteous" },
  { steamId: 32370, hltbId: 9541, name: "Star Wars: KOTOR" },
  { steamId: 1687950, hltbId: 57552, name: "Persona 5 Royal" },
  { steamId: 637650, hltbId: 41997, name: "Final Fantasy XV" },
  { steamId: 1462040, hltbId: 57493, name: "Final Fantasy VII Remake" },
  { steamId: 740130, hltbId: 71536, name: "Tales of Arise" },
  { steamId: 1817070, hltbId: 103498, name: "Persona 3 Reload" },

  { steamId: 582010, hltbId: 52488, name: "Monster Hunter: World" },
  { steamId: 1446780, hltbId: 79297, name: "Monster Hunter Rise" },
  { steamId: 1325200, hltbId: 71787, name: "Nioh 2" },
  { steamId: 335300, hltbId: 24481, name: "Dark Souls II: SOTFS" },
  { steamId: 2215430, hltbId: 90284, name: "Ghost of Tsushima" },
  { steamId: 1888160, hltbId: 110379, name: "Armored Core VI" },
  { steamId: 1282100, hltbId: 107285, name: "Remnant 2" },
  { steamId: 617290, hltbId: 57832, name: "Remnant: From the Ashes" },
  { steamId: 1971870, hltbId: 114328, name: "Metaphor: ReFantazio" },

  { steamId: 1092790, hltbId: 85112, name: "Inscryption" },
  { steamId: 1794680, hltbId: 99277, name: "Vampire Survivors", endless: true },
  { steamId: 553420, hltbId: 57286, name: "Tunic" },
  { steamId: 972660, hltbId: 70546, name: "Spiritfarer" },
  { steamId: 1313140, hltbId: 96459, name: "Cult of the Lamb" },
  { steamId: 1868140, hltbId: 108895, name: "Dave the Diver" },
  { steamId: 526870, hltbId: 59949, name: "Satisfactory", endless: true },
  { steamId: 1366540, hltbId: 82685, name: "Dyson Sphere Program", endless: true },
  { steamId: 1621690, hltbId: 95269, name: "Core Keeper", endless: true },
  { steamId: 739630, hltbId: 68498, name: "Phasmophobia", endless: true },

  { steamId: 214490, hltbId: 15491, name: "Alien: Isolation" },
  { steamId: 391720, hltbId: 30095, name: "Layers of Fear" },
  { steamId: 424840, hltbId: 38938, name: "Little Nightmares" },
  { steamId: 860510, hltbId: 68505, name: "Little Nightmares II" },
  { steamId: 594330, hltbId: 41540, name: "Visage" },
  { steamId: 242760, hltbId: 15818, name: "The Forest", endless: true },
  { steamId: 1326470, hltbId: 95183, name: "Sons of the Forest", endless: true },
  { steamId: 1562430, hltbId: 103027, name: "Dredge" },

  { steamId: 779340, hltbId: 59073, name: "Total War: Three Kingdoms" },
  { steamId: 34330, hltbId: 10491, name: "Total War: Shogun 2" },
  { steamId: 236850, hltbId: 3604, name: "Europa Universalis IV", endless: true },
  { steamId: 323190, hltbId: 51011, name: "Frostpunk" },
  { steamId: 255710, hltbId: 12631, name: "Cities: Skylines", endless: true },
  { steamId: 493340, hltbId: 49010, name: "Planet Coaster", endless: true },
  { steamId: 703080, hltbId: 63579, name: "Planet Zoo", endless: true },
  { steamId: 535930, hltbId: 51556, name: "Two Point Hospital" },

  { steamId: 397540, hltbId: 57527, name: "Borderlands 3" },
  { steamId: 49520, hltbId: 1274, name: "Borderlands 2" },
  { steamId: 550, hltbId: 5143, name: "Left 4 Dead 2" },
  { steamId: 218620, hltbId: 13229, name: "Payday 2", endless: true },
  { steamId: 1144200, hltbId: 82939, name: "Ready or Not" },
  { steamId: 594650, hltbId: 46680, name: "Hunt: Showdown", endless: true },
  { steamId: 699130, hltbId: 61305, name: "World War Z" },
  { steamId: 1029690, hltbId: 100269, name: "Sniper Elite 5" },

  { steamId: 270880, hltbId: 23826, name: "American Truck Simulator" },
  { steamId: 1250410, hltbId: 70936, name: "Microsoft Flight Simulator" },
  { steamId: 1465360, hltbId: 82213, name: "Snowrunner" },
  { steamId: 613100, hltbId: 51932, name: "House Flipper" },
  { steamId: 1290000, hltbId: 93085, name: "PowerWash Simulator" },
  { steamId: 621060, hltbId: 51612, name: "PC Building Simulator" },

  { steamId: 690790, hltbId: 58127, name: "Dirt Rally 2.0" },
  { steamId: 244210, hltbId: 16032, name: "Assetto Corsa", endless: true },
  { steamId: 284160, hltbId: 19131, name: "BeamNG.drive", endless: true },

  { steamId: 238010, hltbId: 2611, name: "Deus Ex: Human Revolution" },
  { steamId: 337000, hltbId: 26929, name: "Deus Ex: Mankind Divided" },
  { steamId: 480490, hltbId: 42424, name: "Prey (2017)" },
  { steamId: 205100, hltbId: 2577, name: "Dishonored" },
  { steamId: 403640, hltbId: 35063, name: "Dishonored 2" },
  { steamId: 203160, hltbId: 10477, name: "Tomb Raider (2013)" },
  { steamId: 391220, hltbId: 27394, name: "Rise of the Tomb Raider" },
  { steamId: 208650, hltbId: 1318, name: "Batman: Arkham Knight" },
  { steamId: 200260, hltbId: 1315, name: "Batman: Arkham City" },
  { steamId: 35140, hltbId: 1313, name: "Batman: Arkham Asylum" },

  { steamId: 257510, hltbId: 14635, name: "The Talos Principle" },
  { steamId: 736260, hltbId: 58617, name: "Baba Is You" },
  { steamId: 1049410, hltbId: 72372, name: "Superliminal" },
  { steamId: 219890, hltbId: 776, name: "Antichamber" },
  { steamId: 1703340, hltbId: 9772, name: "Stanley Parable: Ultra Deluxe" },

  { steamId: 242550, hltbId: 8285, name: "Rayman Legends" },
  { steamId: 418530, hltbId: 71303, name: "Spelunky 2" },
  { steamId: 48000, hltbId: 5455, name: "Limbo" },
  { steamId: 304430, hltbId: 27514, name: "Inside" },
  { steamId: 253230, hltbId: 16622, name: "A Hat in Time" },
  { steamId: 607080, hltbId: 58832, name: "Psychonauts 2" },

  { steamId: 881100, hltbId: 62059, name: "Noita" },
  { steamId: 262060, hltbId: 17101, name: "Darkest Dungeon" },
  { steamId: 212680, hltbId: 4352, name: "FTL: Faster Than Light" },
  { steamId: 590380, hltbId: 55356, name: "Into the Breach" },
  { steamId: 1253920, hltbId: 83063, name: "Rogue Legacy 2" },
  { steamId: 1649240, hltbId: 93790, name: "Returnal" },

  { steamId: 848450, hltbId: 65029, name: "Subnautica: Below Zero" },
  { steamId: 962130, hltbId: 79832, name: "Grounded" },
  { steamId: 305620, hltbId: 18720, name: "The Long Dark" },
  { steamId: 322330, hltbId: 17854, name: "Don't Starve Together", endless: true },
  { steamId: 648800, hltbId: 54082, name: "Raft", endless: true },
  { steamId: 815370, hltbId: 54538, name: "Green Hell" },

  { steamId: 730, hltbId: 5290, name: "Counter-Strike 2", endless: true },
  { steamId: 570, hltbId: 2838, name: "Dota 2", endless: true },
  { steamId: 440, hltbId: 9950, name: "Team Fortress 2", endless: true },
  { steamId: 1085660, hltbId: 58119, name: "Destiny 2", endless: true },
  { steamId: 230410, hltbId: 12165, name: "Warframe", endless: true },
  { steamId: 238960, hltbId: 8677, name: "Path of Exile", endless: true },
];

const GAMES = BATCH2_GAMES.filter(g => typeof g.hltbId === 'number');

async function addGame(steamId: number, hltbId: number, name: string, isEndless: boolean = false) {
  const existing = await findGame(db, steamId);

  if (existing) {
    return { status: "exists", game: existing };
  }

  try {
    const steamData = await fetchSteamData(steamId);

    let hltbData = null;
    try {
      hltbData = await getHltbById(hltbId);
    } catch {
    }

    const valueScore = calculateValueScore({
      steamReviewScore: steamData.reviewScore,
      steamReviewCount: steamData.reviewCount,
      hltbMain: hltbData?.main ?? null,
      hltbMainExtra: hltbData?.mainExtra ?? null,
      hltbCompletionist: hltbData?.completionist ?? null,
      isEndless,
    });

    const result = await insertGames(db, [{
        steamAppId: steamId,
        name: steamData.name,
        steamReviewScore: steamData.reviewScore,
        steamReviewCount: steamData.reviewCount,
        hltbId: hltbData?.hltbId ?? null,
        hltbMain: hltbData?.main ?? null,
        hltbMainExtra: hltbData?.mainExtra ?? null,
        hltbCompletionist: hltbData?.completionist ?? null,
        valueScore,
        isEndless,
      }]);

    return { status: "added", game: result[0], hltbData };
  } catch (error) {
    return { status: "error", error: recoverableManualError(error).message };
  }
}

async function main() {
  console.log("BATCH 2: Adding 100 more games...\n");

  const results = { added: 0, exists: 0, errors: 0 };

  for (const game of GAMES) {
    process.stdout.write(`  ${game.name.padEnd(35)} `);

    const result = await addGame(game.steamId, game.hltbId, game.name, game.endless ?? false);

    if (result.status === "added") {
      const score = result.game?.valueScore?.toFixed(2) ?? "N/A";
      const hours = result.hltbData?.main?.toFixed(0) ?? "?";
      const tag = game.endless ? " [endless]" : "";
      console.log(`✓ Value: ${score.padStart(6)} | ${hours}h${tag}`);
      results.added++;
    } else if (result.status === "exists") {
      console.log(`○ Exists`);
      results.exists++;
    } else {
      console.log(`✗ ${result.error?.slice(0, 30)}`);
      results.errors++;
    }

    await new Promise((r) => setTimeout(r, 350));
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Summary: ${results.added} added, ${results.exists} existing, ${results.errors} errors`);

  const allGames = await readAllGames(db);
  const ranked = allGames.filter(g => g.valueScore !== null && !g.isEndless);
  console.log(`\nTotal games: ${allGames.length} | Ranked: ${ranked.length} | Endless: ${allGames.filter(g => g.isEndless).length}`);
}

main().catch(reportManualError);
