/**
 * Steam Wishlist Service
 *
 * Fetches and caches the user's wishlist from Steam.
 * Requires STEAM_LOGIN_SECURE cookie in .env file.
 */

interface SteamUserData {
  rgWishlist: number[];
}

let wishlistCache: Set<number> | null = null;

/**
 * Fetch the user's wishlist from Steam's dynamicstore endpoint.
 */
export async function fetchWishlist(): Promise<Set<number>> {
  const cookie = process.env.STEAM_LOGIN_SECURE;

  if (!cookie) {
    console.warn("[Steam Wishlist] No STEAM_LOGIN_SECURE cookie configured");
    return new Set();
  }

  console.log("[Steam Wishlist] Fetching wishlist from Steam...");

  const response = await fetch(
    "https://store.steampowered.com/dynamicstore/userdata/",
    {
      headers: {
        Cookie: `steamLoginSecure=${cookie}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch Steam userdata: ${response.status}`);
  }

  const data: SteamUserData = await response.json();

  if (!data.rgWishlist || !Array.isArray(data.rgWishlist)) {
    console.warn("[Steam Wishlist] No wishlist found - cookie may be expired");
    wishlistCache = new Set();
    return wishlistCache;
  }

  wishlistCache = new Set(data.rgWishlist);
  console.log(`[Steam Wishlist] Loaded ${wishlistCache.size} wishlisted apps`);

  return wishlistCache;
}

/**
 * Check if an app is on the user's wishlist.
 */
export async function isOnWishlist(appId: number): Promise<boolean> {
  if (!wishlistCache) {
    await fetchWishlist();
  }
  return wishlistCache?.has(appId) ?? false;
}

/**
 * Get the cached wishlist set.
 */
export function getWishlist(): Set<number> | null {
  return wishlistCache;
}
