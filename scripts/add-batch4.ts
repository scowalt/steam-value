#!/usr/bin/env bun
import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { fetchSteamData } from "../src/scrapers/steam";
import { getHltbById } from "../src/scrapers/hltb";
import { calculateValueScore } from "../src/formula";
import { eq } from "drizzle-orm";

// 100 more popular Steam games to analyze
const GAMES: { steamId: number; hltbId?: number; endless?: boolean }[] = [
  // Classic FPS
  { steamId: 10, hltbId: 2299 },          // Counter-Strike
  { steamId: 70, hltbId: 4250 },          // Half-Life
  { steamId: 130, hltbId: 4257 },         // Half-Life: Blue Shift
  { steamId: 50, hltbId: 4253 },          // Half-Life: Opposing Force
  { steamId: 80, hltbId: 2303 },          // Counter-Strike: Condition Zero
  { steamId: 240, hltbId: 2298 },         // Counter-Strike: Source
  { steamId: 380, hltbId: 4076 },         // Half-Life 2: Episode One
  { steamId: 420, hltbId: 4077 },         // Half-Life 2: Episode Two
  { steamId: 320, hltbId: 4255 },         // Half-Life 2: Deathmatch (endless)

  // More Valve games
  { steamId: 500, hltbId: 5251 },         // Left 4 Dead
  { steamId: 630 },                        // Alien Swarm (free)
  { steamId: 1840, hltbId: 9048 },        // Source Filmmaker

  // Indie darlings
  { steamId: 113200, hltbId: 10067 },     // The Binding of Isaac
  { steamId: 239350, hltbId: 15662 },     // Spelunky
  { steamId: 242680, hltbId: 6458 },      // Nuclear Throne
  { steamId: 233450, hltbId: 8763 },      // Prison Architect
  { steamId: 233470, hltbId: 8766 },      // Smugglers 5
  { steamId: 248820, hltbId: 15827 },     // Risk of Rain
  { steamId: 200900, hltbId: 2110 },      // Cave Story+
  { steamId: 214560, hltbId: 5388 },      // Mark of the Ninja
  { steamId: 219150, hltbId: 5118 },      // Hotline Miami
  { steamId: 274170, hltbId: 21413 },     // Hotline Miami 2
  { steamId: 207170, hltbId: 4938 },      // Legend of Grimrock
  { steamId: 251060, hltbId: 14899 },     // Westerado: Double Barreled
  { steamId: 234140, hltbId: 5509 },      // Mad Max
  { steamId: 220200, hltbId: 8814 },      // Kerbal Space Program
  { steamId: 235540, hltbId: 12803 },     // Warhammer 40,000: Space Marine
  { steamId: 236110, hltbId: 3207 },      // Dungeon Defenders
  { steamId: 237930, hltbId: 9874 },      // Transistor
  { steamId: 242920, hltbId: 15682 },     // Banished
  { steamId: 203770, hltbId: 2409 },      // Crusader Kings II
  { steamId: 211360, hltbId: 8714 },      // ARMA III (endless)
  { steamId: 221380, hltbId: 656 },       // Age of Empires II HD
  { steamId: 204880, hltbId: 10282 },     // Warframe (endless)

  // RPGs and strategy
  { steamId: 47890, hltbId: 2771 },       // The Witcher 2
  { steamId: 202970, hltbId: 2767 },      // Call of Duty: Black Ops II
  { steamId: 212910, hltbId: 8869 },      // Rocket League (endless)
  { steamId: 227940, hltbId: 13224 },     // Crysis 3
  { steamId: 200510, hltbId: 10222 },     // XCOM: Enemy Unknown
  { steamId: 233130, hltbId: 7814 },      // Shadow Warrior
  { steamId: 235460, hltbId: 5516 },      // Metal Gear Rising
  { steamId: 227100, hltbId: 8782 },      // Crysis 2
  { steamId: 17460, hltbId: 5442 },       // Mass Effect
  { steamId: 24980, hltbId: 5444 },       // Mass Effect 2

  // More popular games
  { steamId: 224760, hltbId: 9951 },      // FEZ
  { steamId: 224580, hltbId: 3172 },      // Dyad
  { steamId: 231330, hltbId: 12810 },     // Drunken Robot Pornography
  { steamId: 234390, hltbId: 10113 },     // Telltale Walking Dead S2
  { steamId: 236090, hltbId: 8813 },      // Killzone Shadow Fall
  { steamId: 208140, hltbId: 3260 },      // Endless Space
  { steamId: 206190, hltbId: 4935 },      // Gunpoint
  { steamId: 214950, hltbId: 6939 },      // Total War: ROME II
  { steamId: 223830, hltbId: 10005 },     // Xenonauts
  { steamId: 234080, hltbId: 1355 },      // Gone Home
  { steamId: 233270, hltbId: 12798 },     // Far Cry 3: Blood Dragon
  { steamId: 236430, hltbId: 8812 },      // Dark Souls II

  // Action games
  { steamId: 236870, hltbId: 10004 },     // Hitman: Absolution
  { steamId: 239030, hltbId: 10030 },     // Papers, Please
  { steamId: 239820, hltbId: 4914 },      // Game Dev Tycoon
  { steamId: 239140, hltbId: 2620 },      // Deus Ex: Human Revolution DC
  { steamId: 241600, hltbId: 8817 },      // Rogue Legacy
  { steamId: 241930, hltbId: 15672 },     // Middle-earth: Shadow of Mordor
  { steamId: 239160, hltbId: 9961 },      // Thief (2014)
  { steamId: 245620, hltbId: 10168 },     // Tropico 5
  { steamId: 247080, hltbId: 15740 },     // Crypt of the NecroDancer
  { steamId: 249590, hltbId: 15791 },     // Teslagrad
  { steamId: 249650, hltbId: 15792 },     // SteamWorld Dig
  { steamId: 252950, hltbId: 8848 },      // Rocket League
  { steamId: 254700, hltbId: 15878 },     // Besiege
  { steamId: 255520, hltbId: 15886 },     // Viscera Cleanup Detail
  { steamId: 256290, hltbId: 15923 },     // Child of Light
  { steamId: 258520, hltbId: 15975 },     // The Long Dark
  { steamId: 261640, hltbId: 10206 },     // Hand of Fate
  { steamId: 263060, hltbId: 12819 },     // MilitAnt
  { steamId: 263340, hltbId: 16179 },     // Dungeon of the Endless
  { steamId: 265890, hltbId: 16267 },     // Cities XXL
  { steamId: 266510, hltbId: 16305 },     // Sheltered
  { steamId: 269210, hltbId: 16469 },     // Hero Siege
  { steamId: 271640, hltbId: 16589 },     // Broforce
  { steamId: 274190, hltbId: 11099 },     // Broforce
  { steamId: 275390, hltbId: 21570 },     // Guacamelee STCE
  { steamId: 277850, hltbId: 21703 },     // Shovel Knight
  { steamId: 282900, hltbId: 22089 },     // Hyperdimension Neptunia
  { steamId: 286100, hltbId: 22297 },     // Tooth and Tail
  { steamId: 286690, hltbId: 22361 },     // Metro 2033 Redux
  { steamId: 287390, hltbId: 22398 },     // Metro Last Light Redux
  { steamId: 292120, hltbId: 22722 },     // GRAV
  { steamId: 295790, hltbId: 22976 },     // Pillars of Eternity
  { steamId: 298110, hltbId: 17051 },     // Far Cry 4
  { steamId: 300550, hltbId: 23267 },     // Shadowrun: Dragonfall DC
  { steamId: 301520, hltbId: 23348 },     // Robocraft (endless)
  { steamId: 303210, hltbId: 23555 },     // The Beginners Guide
  { steamId: 307780, hltbId: 23950 },     // Ori and the Blind Forest
  { steamId: 310380, hltbId: 24257 },     // SOMA
  { steamId: 312530, hltbId: 24513 },     // Duck Game
  { steamId: 313120, hltbId: 24583 },     // Stranded Deep
  { steamId: 313340, hltbId: 24656 },     // Cossacks 3

  // More recent indie games
  { steamId: 319910, hltbId: 25288 },     // Armello
  { steamId: 320040, hltbId: 25336 },     // Ashes of the Singularity
  { steamId: 324800, hltbId: 25796 },     // Darkwood
];

async function addGame(steamId: number, hltbId?: number, endless = false) {
  // Check if exists
  const existing = await db.query.games.findFirst({
    where: eq(games.steamAppId, steamId),
  });
  if (existing) {
    return { status: "exists", name: existing.name };
  }

  try {
    const steam = await fetchSteamData(steamId);
    let hltb = null;

    if (hltbId && !endless) {
      hltb = await getHltbById(hltbId);
    }

    const score = calculateValueScore({
      steamReviewScore: steam.reviewScore,
      steamReviewCount: steam.reviewCount,
      hltbMain: hltb?.main ?? null,
      hltbMainExtra: hltb?.mainExtra ?? null,
      hltbCompletionist: hltb?.completionist ?? null,
      isEndless: endless,
    });

    await db.insert(games).values({
      steamAppId: steamId,
      name: steam.name,
      steamReviewScore: steam.reviewScore,
      steamReviewCount: steam.reviewCount,
      hltbId: hltb?.hltbId ?? null,
      hltbMain: hltb?.main ?? null,
      hltbMainExtra: hltb?.mainExtra ?? null,
      hltbCompletionist: hltb?.completionist ?? null,
      valueScore: score,
      isEndless: endless,
    });

    return {
      status: "added",
      name: steam.name,
      score: score?.toFixed(2),
      hours: hltb?.main?.toFixed(1),
    };
  } catch (e: any) {
    return { status: "error", error: e.message?.slice(0, 50) };
  }
}

async function main() {
  console.log(`Adding ${GAMES.length} games...\n`);

  let added = 0, skipped = 0, errors = 0;

  for (let i = 0; i < GAMES.length; i++) {
    const g = GAMES[i];
    const result = await addGame(g.steamId, g.hltbId, g.endless);

    if (result.status === "added") {
      console.log(`[${i+1}/${GAMES.length}] Added: ${result.name} | ${result.hours ?? "?"}h | Score: ${result.score ?? "N/A"}`);
      added++;
    } else if (result.status === "exists") {
      console.log(`[${i+1}/${GAMES.length}] Exists: ${result.name}`);
      skipped++;
    } else {
      console.log(`[${i+1}/${GAMES.length}] Error: ${g.steamId} - ${result.error}`);
      errors++;
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n${"═".repeat(50)}`);
  console.log(`Added: ${added} | Skipped: ${skipped} | Errors: ${errors}`);

  const total = await db.query.games.findMany();
  console.log(`Total games in database: ${total.length}`);
}

main().catch(console.error);
