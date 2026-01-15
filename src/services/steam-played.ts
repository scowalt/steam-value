/**
 * Steam Played Games Service
 *
 * Fetches games the user has played (has playtime) from Steam Web API.
 * Requires STEAM_API_KEY and STEAM_ID in .env file.
 */

interface OwnedGame {
  appid: number;
  name: string;
  playtime_forever: number; // minutes
  playtime_2weeks?: number;
}

interface GetOwnedGamesResponse {
  response: {
    game_count: number;
    games: OwnedGame[];
  };
}

// In-memory cache for the session
let playedAppsCache: Set<number> | null = null;
let ownedGamesCache: Map<number, number> | null = null; // appId -> playtimeMinutes

/**
 * Fetch games the user has played (any playtime > 0) from Steam Web API.
 */
export async function fetchPlayedApps(): Promise<Set<number>> {
  const apiKey = process.env.STEAM_API_KEY;
  const steamId = process.env.STEAM_ID;

  if (!apiKey || !steamId) {
    console.warn("[Steam Played] Missing STEAM_API_KEY or STEAM_ID in .env");
    return new Set();
  }

  console.log("[Steam Played] Fetching played games from Steam API...");

  const url = new URL("https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("steamid", steamId);
  url.searchParams.set("include_appinfo", "true");
  url.searchParams.set("include_played_free_games", "true");

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Steam API error: ${response.status}`);
  }

  const data: GetOwnedGamesResponse = await response.json();

  if (!data.response?.games) {
    console.warn("[Steam Played] No games found. Is your profile public?");
    playedAppsCache = new Set();
    return playedAppsCache;
  }

  // Filter to games with any playtime
  const playedGames = data.response.games.filter((g) => g.playtime_forever > 0);
  const playedIds = playedGames.map((g) => g.appid);

  playedAppsCache = new Set(playedIds);
  console.log(
    `[Steam Played] Found ${data.response.game_count} owned games, ${playedIds.length} with playtime`
  );

  return playedAppsCache;
}

/**
 * Fetch all owned games with their playtime from Steam Web API.
 * Returns a Map of appId -> playtimeMinutes (includes games with 0 playtime).
 */
export async function fetchOwnedGamesWithPlaytime(): Promise<Map<number, number>> {
  const apiKey = process.env.STEAM_API_KEY;
  const steamId = process.env.STEAM_ID;

  if (!apiKey || !steamId) {
    console.warn("[Steam Played] Missing STEAM_API_KEY or STEAM_ID in .env");
    return new Map();
  }

  console.log("[Steam Played] Fetching owned games from Steam API...");

  const url = new URL("https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("steamid", steamId);
  url.searchParams.set("include_appinfo", "true");
  url.searchParams.set("include_played_free_games", "true");

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Steam API error: ${response.status}`);
  }

  const data: GetOwnedGamesResponse = await response.json();

  if (!data.response?.games) {
    console.warn("[Steam Played] No games found. Is your profile public?");
    ownedGamesCache = new Map();
    return ownedGamesCache;
  }

  // Create map of all owned games (including 0 playtime)
  ownedGamesCache = new Map(
    data.response.games.map((g) => [g.appid, g.playtime_forever])
  );

  console.log(
    `[Steam Played] Found ${data.response.game_count} owned games`
  );

  return ownedGamesCache;
}

/**
 * Get cached owned games map, or fetch if not loaded.
 */
export async function getOwnedGamesWithPlaytime(): Promise<Map<number, number>> {
  if (!ownedGamesCache) {
    await fetchOwnedGamesWithPlaytime();
  }
  return ownedGamesCache ?? new Map();
}

/**
 * Check if the user has played a game (has any playtime).
 */
export async function hasPlayed(appId: number): Promise<boolean> {
  if (!playedAppsCache) {
    await fetchPlayedApps();
  }
  return playedAppsCache?.has(appId) ?? false;
}

/**
 * Get the cached played apps set, or null if not loaded.
 */
export function getPlayedApps(): Set<number> | null {
  return playedAppsCache;
}

/**
 * Clear the played apps cache.
 */
export function clearPlayedCache(): void {
  playedAppsCache = null;
  ownedGamesCache = null;
}
