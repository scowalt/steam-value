
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
  hltbSingle: number | null;  
  hltbComplete: number | null;
  source: CandidateSource;
}

let candidateIndex: Map<number, HltbCandidate> | null = null;
let loadPromise: Promise<void> | null = null;

const STEAMDB_PATH = new URL("../data/steamdb-raw.json", import.meta.url).pathname;

function parseHltbIdFromUrl(url: string): number | null {
  const queryMatch = url.match(/[?&]id=(\d+)/);
  if (queryMatch) return parseInt(queryMatch[1]);

  const pathMatch = url.match(/\/game\/(\d+)/);
  if (pathMatch) return parseInt(pathMatch[1]);

  return null;
}

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

async function ensureLoaded(): Promise<void> {
  if (candidateIndex) return;

  if (!loadPromise) {
    loadPromise = loadIndex();
  }

  await loadPromise;
}

export async function getCandidate(steamAppId: number): Promise<HltbCandidate | null> {
  await ensureLoaded();

  const localCandidate = candidateIndex?.get(steamAppId);
  if (localCandidate) {
    return localCandidate;
  }

  const wikidataCandidate = await getWikidataCandidate(steamAppId);
  if (wikidataCandidate) {
    const candidate: HltbCandidate = {
      steamAppId: wikidataCandidate.steamAppId,
      hltbId: wikidataCandidate.hltbId,
      name: wikidataCandidate.name,
      hltbSingle: null,  
      hltbComplete: null,
      source: "wikidata",
    };
    candidateIndex?.set(steamAppId, candidate);
    return candidate;
  }

  return null;
}

export async function getCandidateCount(): Promise<number> {
  await ensureLoaded();
  return candidateIndex?.size ?? 0;
}

export async function getAllCandidates(): Promise<HltbCandidate[]> {
  await ensureLoaded();
  return Array.from(candidateIndex?.values() ?? []);
}
