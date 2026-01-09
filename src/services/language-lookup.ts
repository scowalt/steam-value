// Language Lookup Service
// Provides language support checks for Steam games
// Sources: 1) steamdb-raw.json (local), 2) Steam API (fallback)

interface SteamDbEntry {
  sid: number;
  name: string;
  languages?: string;
}

interface SteamAppDetailsResponse {
  [appId: string]: {
    success: boolean;
    data?: {
      supported_languages?: string;
    };
  };
}

// In-memory index: Steam App ID -> languages array
let languageIndex: Map<number, string[]> | null = null;
let loadPromise: Promise<void> | null = null;

// Cache for Steam API lookups
const steamApiCache = new Map<number, string[] | null>();

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
 * Parse Steam's HTML-encoded supported_languages string
 * Example: "English<strong>*</strong>, French<strong>*</strong>, German"
 * Returns: ["English", "French", "German"]
 */
function parseSteamLanguages(html: string): string[] {
  // Order matters: replace <br> BEFORE removing other HTML tags
  const cleaned = html
    .replace(/<br\s*\/?>/gi, ",") // Replace <br> with comma first
    .replace(/<[^>]*>/g, "") // Then remove other HTML tags
    .replace(/\*/g, ""); // Remove asterisks

  // Split by comma and clean up
  return cleaned
    .split(",")
    .map((lang) => lang.trim())
    .filter((lang) => lang.length > 0 && !lang.includes("languages with"));
}

/**
 * Fetch languages from Steam API
 */
async function fetchLanguagesFromSteam(steamAppId: number): Promise<string[] | null> {
  // Check cache first
  if (steamApiCache.has(steamAppId)) {
    return steamApiCache.get(steamAppId) ?? null;
  }

  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${steamAppId}`;
    const response = await fetch(url);

    if (!response.ok) {
      console.warn(`[Language Lookup] Steam API returned ${response.status} for ${steamAppId}`);
      steamApiCache.set(steamAppId, null);
      return null;
    }

    const data = (await response.json()) as SteamAppDetailsResponse;
    const appData = data[steamAppId.toString()];

    if (!appData?.success || !appData.data?.supported_languages) {
      steamApiCache.set(steamAppId, null);
      return null;
    }

    const languages = parseSteamLanguages(appData.data.supported_languages);
    steamApiCache.set(steamAppId, languages);
    return languages;
  } catch (error) {
    console.warn(`[Language Lookup] Failed to fetch from Steam API for ${steamAppId}:`, error);
    steamApiCache.set(steamAppId, null);
    return null;
  }
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
