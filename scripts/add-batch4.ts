#!/usr/bin/env bun
import { db } from "../src/db/client";
import { findGame, insertGames, readAllGames, recoverableManualError, reportManualError } from "../src/db/manual";
import { games } from "../src/db/schema";
import { fetchSteamData } from "../src/scrapers/steam";
import { getHltbById } from "../src/scrapers/hltb";
import { calculateValueScore } from "../src/formula";
import { eq } from "drizzle-orm";

const GAMES: { steamId: number; hltbId?: number; endless?: boolean }[] = [
  { steamId: 10, hltbId: 2299 },           
  { steamId: 70, hltbId: 4250 },           
  { steamId: 130, hltbId: 4257 },          
  { steamId: 50, hltbId: 4253 },           
  { steamId: 80, hltbId: 2303 },           
  { steamId: 240, hltbId: 2298 },          
  { steamId: 380, hltbId: 4076 },          
  { steamId: 420, hltbId: 4077 },          
  { steamId: 320, hltbId: 4255 },          

  { steamId: 500, hltbId: 5251 },          
  { steamId: 630 },                         
  { steamId: 1840, hltbId: 9048 },         

  { steamId: 113200, hltbId: 10067 },      
  { steamId: 239350, hltbId: 15662 },      
  { steamId: 242680, hltbId: 6458 },       
  { steamId: 233450, hltbId: 8763 },       
  { steamId: 233470, hltbId: 8766 },       
  { steamId: 248820, hltbId: 15827 },      
  { steamId: 200900, hltbId: 2110 },       
  { steamId: 214560, hltbId: 5388 },       
  { steamId: 219150, hltbId: 5118 },       
  { steamId: 274170, hltbId: 21413 },      
  { steamId: 207170, hltbId: 4938 },       
  { steamId: 251060, hltbId: 14899 },      
  { steamId: 234140, hltbId: 5509 },       
  { steamId: 220200, hltbId: 8814 },       
  { steamId: 235540, hltbId: 12803 },      
  { steamId: 236110, hltbId: 3207 },       
  { steamId: 237930, hltbId: 9874 },       
  { steamId: 242920, hltbId: 15682 },      
  { steamId: 203770, hltbId: 2409 },       
  { steamId: 211360, hltbId: 8714 },       
  { steamId: 221380, hltbId: 656 },        
  { steamId: 204880, hltbId: 10282 },      

  { steamId: 47890, hltbId: 2771 },        
  { steamId: 202970, hltbId: 2767 },       
  { steamId: 212910, hltbId: 8869 },       
  { steamId: 227940, hltbId: 13224 },      
  { steamId: 200510, hltbId: 10222 },      
  { steamId: 233130, hltbId: 7814 },       
  { steamId: 235460, hltbId: 5516 },       
  { steamId: 227100, hltbId: 8782 },       
  { steamId: 17460, hltbId: 5442 },        
  { steamId: 24980, hltbId: 5444 },        

  { steamId: 224760, hltbId: 9951 },       
  { steamId: 224580, hltbId: 3172 },       
  { steamId: 231330, hltbId: 12810 },      
  { steamId: 234390, hltbId: 10113 },      
  { steamId: 236090, hltbId: 8813 },       
  { steamId: 208140, hltbId: 3260 },       
  { steamId: 206190, hltbId: 4935 },       
  { steamId: 214950, hltbId: 6939 },       
  { steamId: 223830, hltbId: 10005 },      
  { steamId: 234080, hltbId: 1355 },       
  { steamId: 233270, hltbId: 12798 },      
  { steamId: 236430, hltbId: 8812 },       

  { steamId: 236870, hltbId: 10004 },      
  { steamId: 239030, hltbId: 10030 },      
  { steamId: 239820, hltbId: 4914 },       
  { steamId: 239140, hltbId: 2620 },       
  { steamId: 241600, hltbId: 8817 },       
  { steamId: 241930, hltbId: 15672 },      
  { steamId: 239160, hltbId: 9961 },       
  { steamId: 245620, hltbId: 10168 },      
  { steamId: 247080, hltbId: 15740 },      
  { steamId: 249590, hltbId: 15791 },      
  { steamId: 249650, hltbId: 15792 },      
  { steamId: 252950, hltbId: 8848 },       
  { steamId: 254700, hltbId: 15878 },      
  { steamId: 255520, hltbId: 15886 },      
  { steamId: 256290, hltbId: 15923 },      
  { steamId: 258520, hltbId: 15975 },      
  { steamId: 261640, hltbId: 10206 },      
  { steamId: 263060, hltbId: 12819 },      
  { steamId: 263340, hltbId: 16179 },      
  { steamId: 265890, hltbId: 16267 },      
  { steamId: 266510, hltbId: 16305 },      
  { steamId: 269210, hltbId: 16469 },      
  { steamId: 271640, hltbId: 16589 },      
  { steamId: 274190, hltbId: 11099 },      
  { steamId: 275390, hltbId: 21570 },      
  { steamId: 277850, hltbId: 21703 },      
  { steamId: 282900, hltbId: 22089 },      
  { steamId: 286100, hltbId: 22297 },      
  { steamId: 286690, hltbId: 22361 },      
  { steamId: 287390, hltbId: 22398 },      
  { steamId: 292120, hltbId: 22722 },      
  { steamId: 295790, hltbId: 22976 },      
  { steamId: 298110, hltbId: 17051 },      
  { steamId: 300550, hltbId: 23267 },      
  { steamId: 301520, hltbId: 23348 },      
  { steamId: 303210, hltbId: 23555 },      
  { steamId: 307780, hltbId: 23950 },      
  { steamId: 310380, hltbId: 24257 },      
  { steamId: 312530, hltbId: 24513 },      
  { steamId: 313120, hltbId: 24583 },      
  { steamId: 313340, hltbId: 24656 },      

  { steamId: 319910, hltbId: 25288 },      
  { steamId: 320040, hltbId: 25336 },      
  { steamId: 324800, hltbId: 25796 },      
];

async function addGame(steamId: number, hltbId?: number, endless = false) {
  const existing = await findGame(db, steamId);
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

    await insertGames(db, [{
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
    }]);

    return {
      status: "added",
      name: steam.name,
      score: score?.toFixed(2),
      hours: hltb?.main?.toFixed(1),
    };
  } catch (error) {
    return { status: "error", error: recoverableManualError(error).message.slice(0, 50) };
  }
}

async function main() {
  console.log(`Adding ${GAMES.length} games...\n`);

  let added = 0, skipped = 0, errors = 0;

  for (let i = 0; i < GAMES.length; i++) {
    const g = GAMES[i]!;
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

    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n${"═".repeat(50)}`);
  console.log(`Added: ${added} | Skipped: ${skipped} | Errors: ${errors}`);

  const total = await readAllGames(db);
  console.log(`Total games in database: ${total.length}`);
}

main().catch(reportManualError);
