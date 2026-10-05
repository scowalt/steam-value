#!/usr/bin/env bun
import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { fetchSteamData } from "../src/scrapers/steam";
import { getHltbById } from "../src/scrapers/hltb";
import { calculateValueScore } from "../src/formula";
import { eq } from "drizzle-orm";

const GAMES: { steamId: number; hltbId: number; name: string; endless?: boolean }[] = [
  { steamId: 1151340, hltbId: 69082, name: "Fallout 76", endless: true },
  { steamId: 1240440, hltbId: 85028, name: "Hades II" },
  { steamId: 1938090, hltbId: 98731, name: "Call of Duty MW2" },
  { steamId: 2379780, hltbId: 117095, name: "Balatro" },
  { steamId: 990080, hltbId: 65026, name: "Hogwarts Legacy" },
  { steamId: 1817190, hltbId: 103266, name: "Marvels Spider-Man" },
  { steamId: 1222730, hltbId: 72078, name: "Marvels Spider-Man MM" },

  { steamId: 1364780, hltbId: 101813, name: "Street Fighter 6" },
  { steamId: 976310, hltbId: 67070, name: "Mortal Kombat 11" },
  { steamId: 1384160, hltbId: 87298, name: "Guilty Gear Strive", endless: true },

  { steamId: 1061090, hltbId: 70931, name: "Hyperlight Breaker" },
  { steamId: 1062520, hltbId: 72163, name: "Age of Darkness" },
  { steamId: 851850, hltbId: 62010, name: "Ancestors Human Odyssey" },
  { steamId: 1113000, hltbId: 74052, name: "Persona 4 Golden" },
  { steamId: 1245040, hltbId: 85096, name: "Persona 4 Arena" },

  { steamId: 346110, hltbId: 25355, name: "ARK Survival Evolved", endless: true },
  { steamId: 211820, hltbId: 3047, name: "Starbound", endless: true },
  { steamId: 367520, hltbId: 36774, name: "Hollow Knight" },
  { steamId: 1055540, hltbId: 73053, name: "A Short Hike" },
  { steamId: 460950, hltbId: 41182, name: "Katana ZERO" },

  { steamId: 22240, hltbId: 2399, name: "Warhammer 40K: DOW II" },
  { steamId: 594570, hltbId: 46476, name: "Total War: WARHAMMER II" },
  { steamId: 269270, hltbId: 5177, name: "Homeworld Remastered" },
  { steamId: 244450, hltbId: 15055, name: "XCOM Enemy Unknown" },
  { steamId: 1259420, hltbId: 72688, name: "Solasta" },

  { steamId: 2280, hltbId: 2592, name: "Deus Ex GOTY" },
  { steamId: 6910, hltbId: 2593, name: "Deus Ex Invisible War" },
  { steamId: 9350, hltbId: 10088, name: "Thief Deadly Shadows" },
  { steamId: 9420, hltbId: 10098, name: "Thief II" },
  { steamId: 211600, hltbId: 10089, name: "Thief Gold" },

  { steamId: 546560, hltbId: 43513, name: "Half-Life: Alyx" },

  { steamId: 447040, hltbId: 36834, name: "Watch Dogs 2" },
  { steamId: 2299150, hltbId: 111377, name: "Sifu" },
  { steamId: 976730, hltbId: 67413, name: "Halo Infinite" },
  { steamId: 1240720, hltbId: 62941, name: "Halo MCC" },

  { steamId: 251260, hltbId: 15090, name: "The Stanley Parable" },
  { steamId: 945360, hltbId: 66271, name: "Among Us", endless: true },
  { steamId: 976310, hltbId: 67070, name: "Phasmophobia" },

  { steamId: 1517290, hltbId: 91152, name: "EA Sports FC 24", endless: true },
  { steamId: 2396200, hltbId: 130697, name: "EA Sports FC 25", endless: true },
];

console.log("Adding batch 3 games...\n");
let added = 0, exists = 0, errors = 0;

for (const g of GAMES) {
  const existing = await db.query.games.findFirst({ where: eq(games.steamAppId, g.steamId) });
  if (existing) {
    console.log(`${g.name.slice(0,28).padEnd(28)} ○ Exists`);
    exists++;
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

    await db.insert(games).values({
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
    });

    const tag = g.endless ? " [endless]" : "";
    console.log(`${steam.name.slice(0,28).padEnd(28)} ✓ ${hltb?.main?.toFixed(0) ?? "?"}h | Value: ${score?.toFixed(2) ?? "N/A"}${tag}`);
    added++;
  } catch (e: any) {
    console.log(`${g.name.slice(0,28).padEnd(28)} ✗ ${e.message?.slice(0,25)}`);
    errors++;
  }

  await new Promise(r => setTimeout(r, 400));
}

console.log(`\nDone! Added: ${added}, Exists: ${exists}, Errors: ${errors}`);
const total = await db.query.games.findMany();
console.log(`Total games: ${total.length}`);
