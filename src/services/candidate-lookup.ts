// Candidate Lookup Service
// Provides O(1) lookup for Steam App ID -> HLTB ID candidates
// Sources: 1) Local steamdb dataset, 2) Wikidata SPARQL (fallback)

import { getWikidataCandidate } from "./wikidata-lookup";

interface SteamDbEntry {
  sid: number;
  name: string;
  hltb_url?: string;
  hltb_single?: number | null;
  hltb_complete?: number | null;
}

export type CandidateSource = "steamdb" | "wikidata";

export interface HltbCandidate {
  steamAppId: number;
  hltbId: number;
  name: string;
  hltbSingle: number | null; // hours from steamdb (may be outdated)
  hltbComplete: number | null;
  source: CandidateSource;
}

// In-memory index: Steam App ID -> HLTB Candidate
let candidateIndex: Map<number, HltbCandidate> | null = null;
let loadPromise: Promise<void> | null = null;

const STEAMDB_PATH = new URL("../data/steamdb-raw.json", import.meta.url).pathname;

/**
 * Parse HLTB ID from URL
 * Handles both formats:
 * - https://howlongtobeat.com/game?id=1234
 * - https://howlongtobeat.com/game/1234
 */
function parseHltbIdFromUrl(url: string): number | null {
  // Try ?id= format first
  const queryMatch = url.match(/[?&]id=(\d+)/);
  if (queryMatch) return parseInt(queryMatch[1]);

  // Try /game/1234 format
  const pathMatch = url.match(/\/game\/(\d+)/);
  if (pathMatch) return parseInt(pathMatch[1]);

  return null;
}

/**
 * Load the steamdb dataset and build the index
 */
async function loadIndex(): Promise<void> {
  if (candidateIndex) return;

  console.log("[Candidate Lookup] Loading steamdb dataset...");
  const file = Bun.file(STEAMDB_PATH);

  if (!(await file.exists())) {
    console.warn("[Candidate Lookup] steamdb-raw.json not found. Run scripts/sync-hltb-map.ts to download it.");
    candidateIndex = new Map();
    return;
  }

  const data: SteamDbEntry[] = await file.json();
  candidateIndex = new Map();

  let withHltb = 0;
  for (const entry of data) {
    if (!entry.hltb_url) continue;

    const hltbId = parseHltbIdFromUrl(entry.hltb_url);
    if (!hltbId) continue;

    candidateIndex.set(entry.sid, {
      steamAppId: entry.sid,
      hltbId,
      name: entry.name,
      hltbSingle: entry.hltb_single ?? null,
      hltbComplete: entry.hltb_complete ?? null,
      source: "steamdb",
    });
    withHltb++;
  }

  console.log(`[Candidate Lookup] Indexed ${withHltb} candidates from ${data.length} games`);
}

/**
 * Ensure the index is loaded (with deduplication)
 */
async function ensureLoaded(): Promise<void> {
  if (candidateIndex) return;

  if (!loadPromise) {
    loadPromise = loadIndex();
  }

  await loadPromise;
}

/**
 * Look up a candidate HLTB ID for a Steam App ID
 * First checks local steamdb, then falls back to Wikidata
 * Returns null if no candidate is found in either source
 */
export async function getCandidate(steamAppId: number): Promise<HltbCandidate | null> {
  await ensureLoaded();

  // Try local steamdb first (instant)
  const localCandidate = candidateIndex?.get(steamAppId);
  if (localCandidate) {
    return localCandidate;
  }

  // Fall back to Wikidata (requires network request)
  const wikidataCandidate = await getWikidataCandidate(steamAppId);
  if (wikidataCandidate) {
    // Convert to HltbCandidate format
    const candidate: HltbCandidate = {
      steamAppId: wikidataCandidate.steamAppId,
      hltbId: wikidataCandidate.hltbId,
      name: wikidataCandidate.name,
      hltbSingle: null, // Wikidata doesn't have playtime data
      hltbComplete: null,
      source: "wikidata",
    };
    // Cache it locally for this session
    candidateIndex?.set(steamAppId, candidate);
    return candidate;
  }

  return null;
}

/**
 * Get the total number of candidates in the index
 */
export async function getCandidateCount(): Promise<number> {
  await ensureLoaded();
  return candidateIndex?.size ?? 0;
}

/**
 * Get all candidates (for batch processing)
 */
export async function getAllCandidates(): Promise<HltbCandidate[]> {
  await ensureLoaded();
  return Array.from(candidateIndex?.values() ?? []);
}
