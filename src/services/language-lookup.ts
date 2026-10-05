
import { steam } from "../lib/steam-client";

interface SteamDbEntry {
  sid: number;
  name: string;
  languages?: string;
}

let languageIndex: Map<number, string[]> | null = null;
let loadPromise: Promise<void> | null = null;

const STEAMDB_PATH = new URL("../data/steamdb-raw.json", import.meta.url).pathname;

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

async function ensureLoaded(): Promise<void> {
  if (languageIndex) return;

  if (!loadPromise) {
    loadPromise = loadIndex();
  }

  await loadPromise;
}

async function fetchLanguagesFromSteam(steamAppId: number): Promise<string[] | null> {
  return steam.getLanguages(steamAppId);
}

export async function getLanguages(steamAppId: number): Promise<string[] | null> {
  await ensureLoaded();

  const localLanguages = languageIndex?.get(steamAppId);
  if (localLanguages !== undefined) {
    return localLanguages;
  }

  return fetchLanguagesFromSteam(steamAppId);
}

export async function hasEnglishSupport(steamAppId: number): Promise<boolean | null> {
  const languages = await getLanguages(steamAppId);
  if (languages === null) return null;
  return languages.includes("English");
}
