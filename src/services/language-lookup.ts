// Language Lookup Service
// Provides language support checks for Steam games
// Sources: 1) steamdb-raw.json (local), 2) Steam API via rate-limited client (fallback)

import { steam } from "../lib/steam-client";

interface SteamDbEntry {
  sid: number;
  name: string;
  languages?: string;
}

// In-memory index: Steam App ID -> languages array
let languageIndex: Map<number, string[]> | null = null;
let loadPromise: Promise<void> | null = null;

const STEAMDB_PATH = new URL("../data/steamdb-raw.json", import.meta.url).pathname;

/**
 * Load the steamdb dataset and build the language index
 */
async function loadIndex(): Promise<void> {
  if (languageIndex) return;

  console.log("[Language Lookup] Loading steamdb dataset...");
  const file = Bun.file(STEAMDB_PATH);

  if (!(await file.exists())) {
    console.warn("[Language Lookup] steamdb-raw.json not found.");
    languageIndex = new Map();
    return;
  }

  const data: SteamDbEntry[] = await file.json();
  languageIndex = new Map();

  for (const entry of data) {
    if (entry.languages) {
      const languages = entry.languages.split(",").map((l) => l.trim());
      languageIndex.set(entry.sid, languages);
    } else {
      languageIndex.set(entry.sid, []);
    }
  }

  console.log(`[Language Lookup] Indexed ${languageIndex.size} games`);
}

/**
 * Ensure the index is loaded (with deduplication)
 */
async function ensureLoaded(): Promise<void> {
  if (languageIndex) return;

  if (!loadPromise) {
    loadPromise = loadIndex();
  }

  await loadPromise;
}

/**
 * Fetch languages from Steam API (via rate-limited client)
 */
async function fetchLanguagesFromSteam(steamAppId: number): Promise<string[] | null> {
  // Uses the centralized steam client which has built-in rate limiting and caching
  return steam.getLanguages(steamAppId);
}

/**
 * Get supported languages for a Steam App ID
 * First checks steamdb, then falls back to Steam API
 * Returns null only if both sources fail
 */
export async function getLanguages(steamAppId: number): Promise<string[] | null> {
  await ensureLoaded();

  // Try local steamdb first (instant)
  const localLanguages = languageIndex?.get(steamAppId);
  if (localLanguages !== undefined) {
    return localLanguages;
  }

  // Fall back to Steam API
  return fetchLanguagesFromSteam(steamAppId);
}

/**
 * Check if a game supports English
 * Returns:
 * - true: Game supports English
 * - false: Game exists but doesn't support English
 * - null: Game not in dataset (unknown)
 */
export async function hasEnglishSupport(steamAppId: number): Promise<boolean | null> {
  const languages = await getLanguages(steamAppId);
  if (languages === null) return null;
  return languages.includes("English");
}
