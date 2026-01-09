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
  source: "cache" | "web_search";
}

// In-memory cache for lookups during session
const lookupCache = new Map<number, HltbLookupResult>();

/**
 * Look up HLTB data for a Steam game
 */
export async function lookupHltbForSteam(
  steamAppId: number,
  gameName: string
): Promise<HltbLookupResult | null> {
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
    source: "cache",
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
