// HLTB Mapping Verification Service
// Verifies Steam -> HLTB mappings by checking HLTB's profile_steam field

import { getHltbById } from "../scrapers/hltb";
import { getCandidate, type HltbCandidate, type CandidateSource } from "./candidate-lookup";
import { getWikidataCandidate } from "./wikidata-lookup";
import type { HltbData } from "../scrapers/types";

export type VerificationStatus =
  | "verified" // profile_steam matches our Steam ID
  | "wrong_mapping" // profile_steam exists but doesn't match
  | "needs_review" // profile_steam is null/0, can't verify
  | "no_candidate"; // No candidate in any data source

export interface VerificationResult {
  status: VerificationStatus;
  steamAppId: number;
  hltbId: number | null;
  hltbData: HltbData | null;
  candidateName: string | null; // Name from candidate source
  hltbName: string | null; // Name from HLTB page
  candidateSource: CandidateSource | null; // Where we found the candidate
  message: string;
}

/**
 * Verify an HLTB mapping for a Steam game
 *
 * This is the core verification logic:
 * 1. Look up candidate HLTB ID from steamdb
 * 2. Fetch the HLTB page
 * 3. Check if profile_steam matches our Steam ID
 *
 * Only returns verified data - no guessing!
 */
export async function verifyHltbMapping(
  steamAppId: number,
  gameName: string
): Promise<VerificationResult> {
  // Step 1: Look up candidate
  const candidate = await getCandidate(steamAppId);

  if (!candidate) {
    return {
      status: "no_candidate",
      steamAppId,
      hltbId: null,
      hltbData: null,
      candidateName: null,
      hltbName: null,
      candidateSource: null,
      message: `No HLTB candidate found in steamdb or Wikidata for Steam ID ${steamAppId}`,
    };
  }

  // Step 2: Fetch HLTB page to verify
  const hltbData = await getHltbById(candidate.hltbId);

  if (!hltbData) {
    return {
      status: "needs_review",
      steamAppId,
      hltbId: candidate.hltbId,
      hltbData: null,
      candidateName: candidate.name,
      hltbName: null,
      candidateSource: candidate.source,
      message: `Failed to fetch HLTB page ${candidate.hltbId} (source: ${candidate.source})`,
    };
  }

  // Step 3: Verify profile_steam matches
  if (hltbData.profileSteam === steamAppId) {
    // VERIFIED - HLTB confirms this is the right game
    return {
      status: "verified",
      steamAppId,
      hltbId: candidate.hltbId,
      hltbData,
      candidateName: candidate.name,
      hltbName: hltbData.name,
      candidateSource: candidate.source,
      message: `Verified via ${candidate.source}: HLTB profile_steam matches Steam ID`,
    };
  }

  if (hltbData.profileSteam !== null && hltbData.profileSteam !== steamAppId) {
    // WRONG mapping from this source - try Wikidata if we haven't already
    if (candidate.source === "steamdb") {
      const wikidataCandidate = await getWikidataCandidate(steamAppId);
      if (wikidataCandidate && wikidataCandidate.hltbId !== candidate.hltbId) {
        // Wikidata has a different ID - try verifying that one
        const wikidataHltbData = await getHltbById(wikidataCandidate.hltbId);
        if (wikidataHltbData?.profileSteam === steamAppId) {
          // Wikidata's ID is correct!
          return {
            status: "verified",
            steamAppId,
            hltbId: wikidataCandidate.hltbId,
            hltbData: wikidataHltbData,
            candidateName: wikidataCandidate.name,
            hltbName: wikidataHltbData.name,
            candidateSource: "wikidata",
            message: `Verified via wikidata (steamdb had wrong mapping): HLTB profile_steam matches Steam ID`,
          };
        }
      }
    }

    // Neither source worked
    return {
      status: "wrong_mapping",
      steamAppId,
      hltbId: candidate.hltbId,
      hltbData: null, // Don't return wrong data
      candidateName: candidate.name,
      hltbName: hltbData.name,
      candidateSource: candidate.source,
      message: `Wrong mapping (${candidate.source}): HLTB profile_steam (${hltbData.profileSteam}) differs from Steam ID (${steamAppId})`,
    };
  }

  // profile_steam is null - HLTB hasn't linked a Steam game
  return {
    status: "needs_review",
    steamAppId,
    hltbId: candidate.hltbId,
    hltbData: null, // Don't return unverified data
    candidateName: candidate.name,
    hltbName: hltbData.name,
    candidateSource: candidate.source,
    message: `Needs review (${candidate.source}): HLTB page has no Steam link`,
  };
}

/**
 * Verify using a manually provided HLTB ID
 * Used when user provides --hltb-id flag
 */
export async function verifyManualHltbId(
  steamAppId: number,
  hltbId: number
): Promise<VerificationResult> {
  const hltbData = await getHltbById(hltbId);

  if (!hltbData) {
    return {
      status: "needs_review",
      steamAppId,
      hltbId,
      hltbData: null,
      candidateName: null,
      hltbName: null,
      candidateSource: null,
      message: `Failed to fetch HLTB page ${hltbId}`,
    };
  }

  if (hltbData.profileSteam === steamAppId) {
    return {
      status: "verified",
      steamAppId,
      hltbId,
      hltbData,
      candidateName: null,
      hltbName: hltbData.name,
      candidateSource: null,
      message: `Verified (manual): HLTB profile_steam matches Steam ID`,
    };
  }

  if (hltbData.profileSteam !== null && hltbData.profileSteam !== steamAppId) {
    return {
      status: "wrong_mapping",
      steamAppId,
      hltbId,
      hltbData: null,
      candidateName: null,
      hltbName: hltbData.name,
      candidateSource: null,
      message: `Wrong mapping (manual): HLTB profile_steam (${hltbData.profileSteam}) differs from Steam ID (${steamAppId})`,
    };
  }

  // profile_steam is null but user manually specified - trust them but note it
  return {
    status: "needs_review",
    steamAppId,
    hltbId,
    hltbData, // Return data since user explicitly requested this ID
    candidateName: null,
    hltbName: hltbData.name,
    candidateSource: null,
    message: `Unverifiable (manual): HLTB has no Steam link, but using user-provided ID`,
  };
}
