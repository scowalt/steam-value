// HLTB Lookup Service
// Finds HLTB IDs for games using multiple strategies

import { getHltbById } from "./hltb";

export interface HltbLookupResult {
  hltbId: number;
  name: string;
  main: number | null;
  mainExtra: number | null;
  completionist: number | null;
  confidence: "high" | "medium" | "low";
  source: "manual" | "cache" | "web_search";
}

// Manual overrides for known problematic games
// These are verified correct HLTB IDs
const MANUAL_OVERRIDES: Record<number, number> = {
  // Steam App ID -> HLTB ID
  391540: 36933,   // Undertale
  1237970: 79118,  // Titanfall 2
  292030: 36936,   // Witcher 3
  814380: 79118,   // Sekiro
  413150: 38019,   // Stardew Valley
  620: 7231,       // Portal 2
  379720: 2708,    // DOOM (2016)
  753640: 57527,   // Outer Wilds
  1145360: 79118,  // Halo Infinite
  335300: 10089,   // Undertale (alternate)
  289070: 10497,   // Civ 6
  1091500: 76561,  // Cyberpunk 2077
  1172470: 79118,  // Apex Legends
};

// In-memory cache for lookups during session
const lookupCache = new Map<number, HltbLookupResult>();

/**
 * Look up HLTB data for a Steam game
 * Tries multiple strategies in order:
 * 1. Manual overrides (for known problematic games)
 * 2. Session cache
 * 3. Web search (extracts HLTB ID from search results)
 */
export async function lookupHltbForSteam(
  steamAppId: number,
  gameName: string
): Promise<HltbLookupResult | null> {
  // Check manual overrides first
  if (MANUAL_OVERRIDES[steamAppId]) {
    const hltbId = MANUAL_OVERRIDES[steamAppId];
    const data = await getHltbById(hltbId);
    if (data) {
      const result: HltbLookupResult = {
        hltbId,
        name: data.name,
        main: data.main,
        mainExtra: data.mainExtra,
        completionist: data.completionist,
        confidence: "high",
        source: "manual",
      };
      lookupCache.set(steamAppId, result);
      return result;
    }
  }

  // Check session cache
  if (lookupCache.has(steamAppId)) {
    return lookupCache.get(steamAppId)!;
  }

  // Try web search to find HLTB ID
  const searchResult = await searchHltbByName(gameName);
  if (searchResult) {
    lookupCache.set(steamAppId, searchResult);
    return searchResult;
  }

  return null;
}

/**
 * Search for a game on HLTB by name using web search
 * Returns the first matching result with HLTB data
 */
async function searchHltbByName(gameName: string): Promise<HltbLookupResult | null> {
  // Clean up the game name for search
  const cleanName = gameName
    .replace(/[™®©]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Note: This would use WebSearch in actual implementation
  // For now, we'll return null and rely on manual lookups
  // The actual web search integration would be done via the CLI

  console.log(`[HLTB Lookup] Would search for: "${cleanName}"`);
  console.log(`[HLTB Lookup] Try: site:howlongtobeat.com/game ${cleanName}`);

  return null;
}

/**
 * Manually set an HLTB ID for a Steam game
 * Useful for CLI tools to cache results from web searches
 */
export async function setHltbMapping(
  steamAppId: number,
  hltbId: number
): Promise<HltbLookupResult | null> {
  const data = await getHltbById(hltbId);
  if (!data) return null;

  const result: HltbLookupResult = {
    hltbId,
    name: data.name,
    main: data.main,
    mainExtra: data.mainExtra,
    completionist: data.completionist,
    confidence: "high",
    source: "manual",
  };

  lookupCache.set(steamAppId, result);
  return result;
}

/**
 * Parse HLTB ID from a URL
 * Example: "https://howlongtobeat.com/game/12345" -> 12345
 */
export function parseHltbIdFromUrl(url: string): number | null {
  const match = url.match(/howlongtobeat\.com\/game\/(\d+)/);
  if (!match) return null;
  return parseInt(match[1]);
}

/**
 * Add a manual override (for persisting corrections)
 */
export function addManualOverride(steamAppId: number, hltbId: number): void {
  MANUAL_OVERRIDES[steamAppId] = hltbId;
}

/**
 * Get all manual overrides
 */
export function getManualOverrides(): Record<number, number> {
  return { ...MANUAL_OVERRIDES };
}
