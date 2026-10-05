#!/usr/bin/env bun
import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { getHltbById } from "../src/scrapers/hltb";
import { calculateValueScore } from "../src/formula";
import { eq } from "drizzle-orm";

const CORRECT_HLTB_IDS: Record<string, number> = {
  "Sekiro": 57415,            
  "Celeste": 42818,           
  "Undertale": 21336,         
  "DOOM": 2028,               
  "Titanfall": 10019,         
  "Shovel Knight": 20456,     
  "Half-Life 2": 4260,        
  "Crusader Kings III": 79468,  
  "Horizon Zero Dawn": 36936,  
  "The Witness": 26833,        
  "Portal 2": 7119,            
  "Portal": 7112,              
  "Outer Wilds": 44504,        
  "Hollow Knight": 26286,      
  "Hades": 64351,              
  "Dead Cells": 45812,         
};

async function fixGame(namePattern: string, correctHltbId: number) {
  const allGames = await db.query.games.findMany();
  const game = allGames.find(g => g.name.includes(namePattern));

  if (!game) {
    console.log(`  Not found: ${namePattern}`);
    return;
  }

  const hltbData = await getHltbById(correctHltbId);
  if (!hltbData) {
    console.log(`  Failed HLTB fetch for ${namePattern}`);
    return;
  }

  const valueScore = calculateValueScore({
    steamReviewScore: game.steamReviewScore,
    steamReviewCount: game.steamReviewCount,
    hltbMain: hltbData.main,
    hltbMainExtra: hltbData.mainExtra,
    hltbCompletionist: hltbData.completionist,
    isEndless: game.isEndless,
  });

  await db.update(games)
    .set({
      hltbId: correctHltbId,
      hltbMain: hltbData.main,
      hltbMainExtra: hltbData.mainExtra,
      hltbCompletionist: hltbData.completionist,
      valueScore,
    })
    .where(eq(games.id, game.id));

  console.log(`  Fixed: ${game.name} | ${hltbData.main?.toFixed(1)}h main | Value: ${valueScore?.toFixed(2) ?? 'N/A'}`);
}

async function main() {
  console.log("Fixing HLTB data with correct IDs...\n");

  for (const [namePattern, hltbId] of Object.entries(CORRECT_HLTB_IDS)) {
    await fixGame(namePattern, hltbId);
    await new Promise(r => setTimeout(r, 400));  
  }

  console.log("\nDone!");
}

main().catch(console.error);
