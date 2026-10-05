
import { getHltbById } from "../scrapers/hltb";
import { getCandidate, type HltbCandidate, type CandidateSource } from "./candidate-lookup";
import { getWikidataCandidate } from "./wikidata-lookup";
import type { HltbData } from "../scrapers/types";

export type VerificationStatus =
  | "verified"  
  | "wrong_mapping"  
  | "needs_review"  
  | "no_candidate";  

export interface VerificationResult {
  status: VerificationStatus;
  steamAppId: number;
  hltbId: number | null;
  hltbData: HltbData | null;
  candidateName: string | null;  
  hltbName: string | null;  
  candidateSource: CandidateSource | null;  
  message: string;
}

export async function verifyHltbMapping(
  steamAppId: number,
  gameName: string
): Promise<VerificationResult> {
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

  if (hltbData.profileSteam === steamAppId) {
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
    if (candidate.source === "steamdb") {
      const wikidataCandidate = await getWikidataCandidate(steamAppId);
      if (wikidataCandidate && wikidataCandidate.hltbId !== candidate.hltbId) {
        const wikidataHltbData = await getHltbById(wikidataCandidate.hltbId);
        if (wikidataHltbData?.profileSteam === steamAppId) {
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

    return {
      status: "wrong_mapping",
      steamAppId,
      hltbId: candidate.hltbId,
      hltbData: null,  
      candidateName: candidate.name,
      hltbName: hltbData.name,
      candidateSource: candidate.source,
      message: `Wrong mapping (${candidate.source}): HLTB profile_steam (${hltbData.profileSteam}) differs from Steam ID (${steamAppId})`,
    };
  }

  return {
    status: "needs_review",
    steamAppId,
    hltbId: candidate.hltbId,
    hltbData: null,  
    candidateName: candidate.name,
    hltbName: hltbData.name,
    candidateSource: candidate.source,
    message: `Needs review (${candidate.source}): HLTB page has no Steam link`,
  };
}

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

  return {
    status: "needs_review",
    steamAppId,
    hltbId,
    hltbData,  
    candidateName: null,
    hltbName: hltbData.name,
    candidateSource: null,
    message: `Unverifiable (manual): HLTB has no Steam link, but using user-provided ID`,
  };
}
