#!/usr/bin/env bun
import { db } from "../src/db/client";
import { reportManualError, syncManualWishlist } from "../src/db/manual";
import { fetchWishlist } from "../src/services/steam-wishlist";

async function main() {
  const wishlist = await fetchWishlist();

  if (wishlist.size === 0) {
    console.log("No wishlist items found.");
    return;
  }

  console.log(`Found ${wishlist.size} games on Steam wishlist`);

  const { wishlisted: wishlistedInDb } = await syncManualWishlist(db, wishlist);
  console.log(`${wishlistedInDb.length} games in database are on wishlist`);

  console.log("Wishlist sync complete!");

  if (wishlistedInDb.length > 0) {
    console.log("\nWishlisted games in database:");
    wishlistedInDb.forEach((g) => console.log(`  - ${g.name}`));
  }
}

main().catch(reportManualError);
