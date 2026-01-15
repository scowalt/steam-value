/**
 * Steam Sync Service
 *
 * Syncs ignored, wishlist, ownership, and playtime status from Steam to the database.
 */
import { db } from "../db/client";
import { games } from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import { getOwnedGamesWithPlaytime } from "./steam-played";

interface SteamUserData {
  rgIgnoredApps: Record<string, number>;
  rgWishlist: number[];
}

export interface SyncResult {
  success: boolean;
  ignoredCount: number;
  wishlistCount: number;
  ownedCount: number;
  gamesUpdated: number;
  gamesRemoved: number;
  error?: string;
}

/**
 * Fetch user data from Steam's dynamicstore endpoint.
 */
async function fetchSteamUserData(): Promise<SteamUserData | null> {
  const cookie = process.env.STEAM_LOGIN_SECURE;

  if (!cookie) {
    console.warn("[Steam Sync] No STEAM_LOGIN_SECURE cookie configured");
    return null;
  }

  const response = await fetch(
    "https://store.steampowered.com/dynamicstore/userdata/",
    {
      headers: {
        Cookie: `steamLoginSecure=${cookie}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Steam API error: ${response.status}`);
  }

  return response.json();
}

/**
 * Sync ignored and wishlist status from Steam to the database.
 */
export async function syncSteamStatus(): Promise<SyncResult> {
  console.log("[Steam Sync] Starting sync...");

  try {
    const userData = await fetchSteamUserData();

    if (!userData) {
      return {
        success: false,
        ignoredCount: 0,
        wishlistCount: 0,
        ownedCount: 0,
        gamesUpdated: 0,
        gamesRemoved: 0,
        error: "No Steam cookie configured",
      };
    }

    const ignoredSet = new Set(
      Object.keys(userData.rgIgnoredApps || {}).map(Number)
    );
    const wishlistSet = new Set(userData.rgWishlist || []);

    console.log(`[Steam Sync] Found ${ignoredSet.size} ignored, ${wishlistSet.size} wishlisted`);

    // Get all games from DB
    const allGames = await db.query.games.findMany();

    // Update ignored status for all games
    const toMarkIgnored: number[] = [];
    const toUnmarkIgnored: number[] = [];

    for (const game of allGames) {
      const isIgnored = ignoredSet.has(game.steamAppId);
      if (isIgnored && !game.isIgnored) {
        toMarkIgnored.push(game.id);
      } else if (!isIgnored && game.isIgnored) {
        toUnmarkIgnored.push(game.id);
      }
    }

    if (toMarkIgnored.length > 0) {
      await db
        .update(games)
        .set({ isIgnored: true })
        .where(inArray(games.id, toMarkIgnored));
      console.log(`[Steam Sync] Marked ${toMarkIgnored.length} games as ignored`);
    }

    if (toUnmarkIgnored.length > 0) {
      await db
        .update(games)
        .set({ isIgnored: false })
        .where(inArray(games.id, toUnmarkIgnored));
      console.log(`[Steam Sync] Unmarked ${toUnmarkIgnored.length} games as ignored`);
    }

    const ignoredUpdated = toMarkIgnored.length + toUnmarkIgnored.length;

    // Batch updates by wishlist status
    const toMarkWishlisted: number[] = [];
    const toUnmarkWishlisted: number[] = [];

    for (const game of allGames) {
      const isWishlisted = wishlistSet.has(game.steamAppId);
      if (isWishlisted && !game.isOnWishlist) {
        toMarkWishlisted.push(game.id);
      } else if (!isWishlisted && game.isOnWishlist) {
        toUnmarkWishlisted.push(game.id);
      }
    }

    // Apply wishlist updates
    if (toMarkWishlisted.length > 0) {
      await db
        .update(games)
        .set({ isOnWishlist: true })
        .where(inArray(games.id, toMarkWishlisted));
    }

    if (toUnmarkWishlisted.length > 0) {
      await db
        .update(games)
        .set({ isOnWishlist: false })
        .where(inArray(games.id, toUnmarkWishlisted));
    }

    const wishlistUpdated = toMarkWishlisted.length + toUnmarkWishlisted.length;
    console.log(`[Steam Sync] Updated ${wishlistUpdated} wishlist statuses`);

    // Sync ownership and playtime
    const ownedGames = await getOwnedGamesWithPlaytime();
    console.log(`[Steam Sync] Found ${ownedGames.size} owned games`);

    let ownershipUpdated = 0;
    for (const game of allGames) {
      const playtime = ownedGames.get(game.steamAppId);
      const isOwned = playtime !== undefined;
      const playtimeMinutes = playtime ?? null;

      // Only update if something changed
      if (game.isOwned !== isOwned || game.playtimeMinutes !== playtimeMinutes) {
        await db
          .update(games)
          .set({ isOwned, playtimeMinutes })
          .where(eq(games.id, game.id));
        ownershipUpdated++;
      }
    }

    console.log(`[Steam Sync] Updated ${ownershipUpdated} ownership/playtime statuses`);

    return {
      success: true,
      ignoredCount: ignoredSet.size,
      wishlistCount: wishlistSet.size,
      ownedCount: ownedGames.size,
      gamesUpdated: ignoredUpdated + wishlistUpdated + ownershipUpdated,
      gamesRemoved: 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Steam Sync] Error:", message);
    return {
      success: false,
      ignoredCount: 0,
      wishlistCount: 0,
      ownedCount: 0,
      gamesUpdated: 0,
      gamesRemoved: 0,
      error: message,
    };
  }
}
