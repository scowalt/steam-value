#!/usr/bin/env bun
import { db } from "../src/db/client";
import { games } from "../src/db/schema";
import { fetchWishlist } from "../src/services/steam-wishlist";
import { eq, inArray } from "drizzle-orm";

async function main() {
  const wishlist = await fetchWishlist();

  if (wishlist.size === 0) {
    console.log("No wishlist items found.");
    return;
  }

  console.log(`Found ${wishlist.size} games on Steam wishlist`);

  const allGames = await db.query.games.findMany();

  const wishlistedInDb = allGames.filter((g) => wishlist.has(g.steamAppId));
  const notWishlistedInDb = allGames.filter((g) => !wishlist.has(g.steamAppId));

  console.log(`${wishlistedInDb.length} games in database are on wishlist`);

  if (wishlistedInDb.length > 0) {
    const wishlistedIds = wishlistedInDb.map((g) => g.id);
    await db
      .update(games)
      .set({ isOnWishlist: true })
      .where(inArray(games.id, wishlistedIds));
  }

  if (notWishlistedInDb.length > 0) {
    const notWishlistedIds = notWishlistedInDb.map((g) => g.id);
    await db
      .update(games)
      .set({ isOnWishlist: false })
      .where(inArray(games.id, notWishlistedIds));
  }

  console.log("Wishlist sync complete!");

  if (wishlistedInDb.length > 0) {
    console.log("\nWishlisted games in database:");
    wishlistedInDb.forEach((g) => console.log(`  - ${g.name}`));
  }
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
