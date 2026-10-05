#!/usr/bin/env bun
import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { steam } from "../src/lib/steam-client";
import { eq } from "drizzle-orm";

async function main() {
  const allGames = await db.query.games.findMany();
  console.log(`Hydrating game modes for ${allGames.length} games...\n`);

  let processed = 0;
  let updated = 0;

  let singlePlayer = 0;
  let multiplayer = 0;
  let coOp = 0;
  let onlineCoOp = 0;
  let localCoOp = 0;
  let pvp = 0;
  let mmo = 0;

  for (const game of allGames) {
    processed++;

    const modes = await steam.getGameModes(game.steamAppId);

    const needsUpdate =
      modes.hasSinglePlayer !== game.hasSinglePlayer ||
      modes.hasMultiplayer !== game.hasMultiplayer ||
      modes.hasCoOp !== game.hasCoOp ||
      modes.hasOnlineCoOp !== game.hasOnlineCoOp ||
      modes.hasLocalCoOp !== game.hasLocalCoOp ||
      modes.hasPvP !== game.hasPvP ||
      modes.hasOnlinePvP !== game.hasOnlinePvP ||
      modes.hasLocalPvP !== game.hasLocalPvP ||
      modes.hasCrossplatform !== game.hasCrossplatform ||
      modes.isMMO !== game.isMMO;

    if (needsUpdate) {
      await db
        .update(games)
        .set({
          hasSinglePlayer: modes.hasSinglePlayer,
          hasMultiplayer: modes.hasMultiplayer,
          hasCoOp: modes.hasCoOp,
          hasOnlineCoOp: modes.hasOnlineCoOp,
          hasLocalCoOp: modes.hasLocalCoOp,
          hasPvP: modes.hasPvP,
          hasOnlinePvP: modes.hasOnlinePvP,
          hasLocalPvP: modes.hasLocalPvP,
          hasCrossplatform: modes.hasCrossplatform,
          isMMO: modes.isMMO,
        })
        .where(eq(games.id, game.id));

      updated++;

      const tags = [];
      if (modes.hasSinglePlayer) tags.push("SP");
      if (modes.hasMultiplayer) tags.push("MP");
      if (modes.hasCoOp) tags.push("Co-op");
      if (modes.hasOnlineCoOp) tags.push("Online Co-op");
      if (modes.hasLocalCoOp) tags.push("Local Co-op");
      if (modes.hasPvP) tags.push("PvP");
      if (modes.isMMO) tags.push("MMO");

      if (tags.length > 0) {
        console.log(`  ${game.name}: ${tags.join(", ")}`);
      }
    }

    if (modes.hasSinglePlayer) singlePlayer++;
    if (modes.hasMultiplayer) multiplayer++;
    if (modes.hasCoOp) coOp++;
    if (modes.hasOnlineCoOp) onlineCoOp++;
    if (modes.hasLocalCoOp) localCoOp++;
    if (modes.hasPvP) pvp++;
    if (modes.isMMO) mmo++;

    if (processed % 50 === 0) {
      console.log(`Progress: ${processed}/${allGames.length}`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total games: ${allGames.length}`);
  console.log(`Updated: ${updated}`);
  console.log(`\n=== Game Mode Stats ===`);
  console.log(`Single-player: ${singlePlayer}`);
  console.log(`Multiplayer: ${multiplayer}`);
  console.log(`Co-op: ${coOp}`);
  console.log(`Online Co-op: ${onlineCoOp}`);
  console.log(`Local Co-op: ${localCoOp}`);
  console.log(`PvP: ${pvp}`);
  console.log(`MMO: ${mmo}`);
}

main().catch(console.error);
