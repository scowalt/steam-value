#!/usr/bin/env bun
import { db } from "../src/db/client";
import { findGame, insertGames, readAllGames, recoverableManualError, reportManualError } from "../src/db/manual";
import { games } from "../src/db/schema";
import { fetchSteamData } from "../src/scrapers/steam";
import { getHltbById } from "../src/scrapers/hltb";
import { calculateValueScore } from "../src/formula";
import { eq, desc } from "drizzle-orm";

const TOP_100_GAMES: { steamId: number; hltbId: number; name: string; endless?: boolean }[] = [
  { steamId: 1086940, hltbId: 68033, name: "Baldur's Gate 3" },
  { steamId: 1245620, hltbId: 68151, name: "ELDEN RING" },
  { steamId: 1091500, hltbId: 2127, name: "Cyberpunk 2077" },
  { steamId: 489830, hltbId: 38557, name: "Skyrim Special Edition" },
  { steamId: 292030, hltbId: 10270, name: "The Witcher 3" },
  { steamId: 374320, hltbId: 26803, name: "Dark Souls III" },
  { steamId: 570940, hltbId: 2224, name: "Dark Souls Remastered" },
  { steamId: 377160, hltbId: 30765, name: "Fallout 4" },
  { steamId: 22380, hltbId: 3348, name: "Fallout: New Vegas" },
  { steamId: 1328670, hltbId: 82917, name: "Mass Effect Legendary" },
  { steamId: 435150, hltbId: 42075, name: "Divinity: Original Sin 2" },
  { steamId: 632470, hltbId: 65025, name: "Disco Elysium" },
  { steamId: 291650, hltbId: 26535, name: "Pillars of Eternity" },
  { steamId: 2054970, hltbId: 113375, name: "Dragon's Dogma 2" },
  { steamId: 814380, hltbId: 57386, name: "Sekiro" },
  { steamId: 1627720, hltbId: 115655, name: "Lies of P" },
  { steamId: 2358720, hltbId: 127308, name: "Black Myth: Wukong" },

  { steamId: 367520, hltbId: 26286, name: "Hollow Knight" },
  { steamId: 1145360, hltbId: 69955, name: "Hades" },
  { steamId: 1593500, hltbId: 70727, name: "God of War" },
  { steamId: 1151640, hltbId: 41618, name: "Horizon Zero Dawn" },
  { steamId: 870780, hltbId: 61064, name: "Control" },
  { steamId: 752590, hltbId: 60772, name: "A Plague Tale: Innocence" },
  { steamId: 1196590, hltbId: 85556, name: "Resident Evil Village" },
  { steamId: 2050650, hltbId: 119068, name: "Resident Evil 4 (2023)" },
  { steamId: 883710, hltbId: 57712, name: "Resident Evil 2 (2019)" },
  { steamId: 601150, hltbId: 57505, name: "Devil May Cry 5" },
  { steamId: 1174180, hltbId: 61912, name: "Red Dead Redemption 2" },
  { steamId: 271590, hltbId: 4063, name: "Grand Theft Auto V" },

  { steamId: 504230, hltbId: 49970, name: "Celeste" },
  { steamId: 588650, hltbId: 50614, name: "Dead Cells" },
  { steamId: 646570, hltbId: 52827, name: "Slay the Spire" },
  { steamId: 268910, hltbId: 39233, name: "Cuphead" },
  { steamId: 391540, hltbId: 26523, name: "Undertale" },
  { steamId: 753640, hltbId: 62668, name: "Outer Wilds" },
  { steamId: 264710, hltbId: 37238, name: "Subnautica" },
  { steamId: 413150, hltbId: 41753, name: "Stardew Valley" },
  { steamId: 1966720, hltbId: 117429, name: "Lethal Company" },
  { steamId: 892970, hltbId: 69175, name: "Valheim", endless: true },

  { steamId: 220, hltbId: 4210, name: "Half-Life 2" },
  { steamId: 620, hltbId: 8016, name: "Portal 2" },
  { steamId: 400, hltbId: 8017, name: "Portal" },
  { steamId: 782330, hltbId: 63268, name: "Doom Eternal" },
  { steamId: 379720, hltbId: 38058, name: "Doom (2016)" },
  { steamId: 8870, hltbId: 1066, name: "Bioshock Infinite" },
  { steamId: 7670, hltbId: 1057, name: "Bioshock" },
  { steamId: 552520, hltbId: 54028, name: "Far Cry 5" },
  { steamId: 1237970, hltbId: 10348, name: "Titanfall 2" },
  { steamId: 412020, hltbId: 58916, name: "Metro Exodus" },
  { steamId: 548430, hltbId: 61305, name: "Deep Rock Galactic", endless: true },

  { steamId: 289070, hltbId: 36705, name: "Civilization VI" },
  { steamId: 394360, hltbId: 33233, name: "Hearts of Iron IV" },
  { steamId: 1142710, hltbId: 55463, name: "Total War: WARHAMMER III" },
  { steamId: 261550, hltbId: 42489, name: "Mount & Blade II: Bannerlord" },
  { steamId: 1158310, hltbId: 75126, name: "Crusader Kings III" },
  { steamId: 281990, hltbId: 27042, name: "Stellaris" },
  { steamId: 813780, hltbId: 58682, name: "Age of Empires II: DE" },
  { steamId: 268500, hltbId: 36879, name: "XCOM 2" },
  { steamId: 1363080, hltbId: 120823, name: "Manor Lords" },

  { steamId: 105600, hltbId: 10056, name: "Terraria" },
  { steamId: 427520, hltbId: 40064, name: "Factorio", endless: true },
  { steamId: 294100, hltbId: 18838, name: "RimWorld", endless: true },
  { steamId: 108600, hltbId: 8525, name: "Project Zomboid", endless: true },
  { steamId: 251570, hltbId: 5233, name: "7 Days to Die", endless: true },
  { steamId: 252490, hltbId: 20265, name: "Rust", endless: true },
  { steamId: 221100, hltbId: 4112, name: "DayZ", endless: true },
  { steamId: 1604030, hltbId: 101459, name: "V Rising", endless: true },

  { steamId: 227300, hltbId: 5003, name: "Euro Truck Simulator 2" },
  { steamId: 2300320, hltbId: 125553, name: "Farming Simulator 25" },
  { steamId: 1551360, hltbId: 89890, name: "Forza Horizon 5" },

  { steamId: 261570, hltbId: 25174, name: "Ori and the Blind Forest" },
  { steamId: 1057090, hltbId: 70780, name: "Ori and the Will of Wisps" },
  { steamId: 250760, hltbId: 22050, name: "Shovel Knight" },
  { steamId: 40800, hltbId: 9960, name: "Super Meat Boy" },
  { steamId: 322170, hltbId: 16369, name: "Geometry Dash" },

  { steamId: 57300, hltbId: 915, name: "Amnesia: The Dark Descent" },
  { steamId: 238320, hltbId: 15012, name: "Outlast" },
  { steamId: 282140, hltbId: 23561, name: "SOMA" },
  { steamId: 418240, hltbId: 86959, name: "Shadow of the Tomb Raider" },

  { steamId: 653530, hltbId: 58033, name: "Return of the Obra Dinn" },
  { steamId: 210970, hltbId: 15091, name: "The Witness" },
  { steamId: 501300, hltbId: 46393, name: "What Remains of Edith Finch" },
  { steamId: 383870, hltbId: 37675, name: "Firewatch" },
  { steamId: 319630, hltbId: 28085, name: "Life is Strange" },

  { steamId: 774361, hltbId: 61023, name: "Blasphemous" },
  { steamId: 283640, hltbId: 29054, name: "Salt and Sanctuary" },
  { steamId: 311690, hltbId: 40314, name: "Enter the Gungeon" },
  { steamId: 250900, hltbId: 25123, name: "Binding of Isaac: Rebirth" },
  { steamId: 632360, hltbId: 60417, name: "Risk of Rain 2" },

  { steamId: 381210, hltbId: 28631, name: "Dead by Daylight", endless: true },
  { steamId: 359550, hltbId: 32573, name: "Rainbow Six Siege", endless: true },
  { steamId: 4000, hltbId: 4212, name: "Garry's Mod", endless: true },
  { steamId: 1623730, hltbId: 114063, name: "Palworld" },

  { steamId: 20920, hltbId: 10268, name: "The Witcher 2" },
  { steamId: 524220, hltbId: 54308, name: "NieR:Automata" },
  { steamId: 1222670, hltbId: 109976, name: "The Last of Us Part I" },
  { steamId: 1172470, hltbId: 73911, name: "Apex Legends", endless: true },
  { steamId: 236390, hltbId: 7324, name: "War Thunder", endless: true },
];

async function addGame(steamId: number, hltbId: number, expectedName: string, isEndless: boolean = false) {
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
  console.log("╔══════════════════════════════════════════════════════════════════════════════╗");
  console.log("║               STEAM 100 GAMES ANALYSIS                                       ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════════╝\n");

  const results = { added: 0, exists: 0, errors: 0 };

  for (const game of TOP_100_GAMES) {
    process.stdout.write(`  ${game.name.padEnd(32)} `);

    const result = await addGame(game.steamId, game.hltbId, game.name, game.endless ?? false);

    if (result.status === "added") {
      const score = result.game?.valueScore?.toFixed(2) ?? "N/A";
      const hours = result.hltbData?.main?.toFixed(0) ?? "?";
      const endless = game.endless ? " [endless]" : "";
      console.log(`✓ Added | Value: ${score.padStart(6)} | ${hours}h${endless}`);
      results.added++;
    } else if (result.status === "exists") {
      console.log(`○ Exists`);
      results.exists++;
    } else {
      console.log(`✗ ${result.error?.slice(0, 35)}`);
      results.errors++;
    }

    await new Promise((r) => setTimeout(r, 350));
  }

  console.log(`\n${"─".repeat(78)}`);
  console.log(`  Summary: ${results.added} added, ${results.exists} existing, ${results.errors} errors`);
  console.log(`${"─".repeat(78)}\n`);

  const allGames = await readAllGames(db);
  const rankedGames = allGames.filter((g) => g.valueScore !== null && !g.isEndless);
  const byValue = [...rankedGames].sort((a, b) => (b.valueScore ?? 0) - (a.valueScore ?? 0));

  console.log("╔══════════════════════════════════════════════════════════════════════════════╗");
  console.log("║  🏆 TOP 10 GAMES BY VALUE SCORE                                              ║");
  console.log("╠══════════════════════════════════════════════════════════════════════════════╣");
  console.log("║  Rank   Value   Rating   Hours   Name                                        ║");
  console.log("╠──────────────────────────────────────────────────────────────────────────────╣");

  byValue.slice(0, 10).forEach((game, i) => {
    const rank = `#${i + 1}`.padStart(4);
    const value = (game.valueScore?.toFixed(2) ?? "N/A").padStart(7);
    const rating = `${game.steamReviewScore}%`.padStart(5);
    const hours = `${game.hltbMain?.toFixed(0) ?? "?"}h`.padStart(6);
    const name = game.name.slice(0, 40).padEnd(40);
    console.log(`║  ${rank}  ${value}   ${rating}  ${hours}   ${name} ║`);
  });
  console.log("╚══════════════════════════════════════════════════════════════════════════════╝\n");

  const endlessGames = allGames.filter((g) => g.isEndless);
  console.log(`Total games analyzed: ${allGames.length}`);
  console.log(`Ranked games: ${rankedGames.length} | Endless games: ${endlessGames.length}`);
  console.log(`Games with value scores: ${rankedGames.length}`);
}

main().catch(reportManualError);
