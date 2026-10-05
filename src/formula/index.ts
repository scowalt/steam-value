import { formulaConfig } from "./config";
import type { Game } from "../db/schema";

export interface ValueScoreInput {
  steamReviewScore: number | null;
  steamReviewCount: number | null;
  hltbMain: number | null;
  hltbMainExtra: number | null;
  hltbCompletionist: number | null;
  isEndless?: boolean | null;
  releaseDate?: string | null;  
}

export function calculateValueScore(input: ValueScoreInput): number | null {
  const { steamReviewScore, steamReviewCount, hltbMain, hltbMainExtra, hltbCompletionist, isEndless, releaseDate } = input;
  const {
    timeMetric,
    reviewScoreExponent,
    hoursPenaltyExponent,
    minHours,
    confidenceThreshold,
    baselineScore,
    ageDecayPerYear,
    minAgeMultiplier,
  } = formulaConfig;

  if (isEndless) {
    return null;
  }

  if (steamReviewScore === null || steamReviewScore === undefined) {
    return null;
  }

  let hours: number | null;
  switch (timeMetric) {
    case "main":
      hours = hltbMain;
      break;
    case "mainExtra":
      hours = hltbMainExtra;
      break;
    case "completionist":
      hours = hltbCompletionist;
      break;
  }

  if (hours === null || hours === undefined) {
    return null;
  }

  const effectiveHours = Math.max(hours, minHours);

  let confidenceScore = steamReviewScore;
  if (steamReviewCount && steamReviewCount > 0) {
    const confidence = steamReviewCount / (steamReviewCount + confidenceThreshold);
    confidenceScore = steamReviewScore * confidence + baselineScore * (1 - confidence);
  } else {
    confidenceScore = baselineScore;
  }

  const adjustedScore = Math.pow(confidenceScore, reviewScoreExponent);
  let score = adjustedScore / Math.pow(effectiveHours, hoursPenaltyExponent);

  if (releaseDate) {
    const releaseYear = new Date(releaseDate).getFullYear();
    const currentYear = new Date().getFullYear();
    const yearsOld = currentYear - releaseYear;
    const ageMultiplier = Math.max(minAgeMultiplier, 1 - yearsOld * ageDecayPerYear);
    score *= ageMultiplier;
  }

  return Math.round(score * 100) / 100;  
}

export function calculateGameValueScore(game: Game): number | null {
  return calculateValueScore({
    steamReviewScore: game.steamReviewScore,
    steamReviewCount: game.steamReviewCount,
    hltbMain: game.hltbMain,
    hltbMainExtra: game.hltbMainExtra,
    hltbCompletionist: game.hltbCompletionist,
    isEndless: game.isEndless,
    releaseDate: game.releaseDate,
  });
}

export function formatValueScore(score: number | null): string {
  if (score === null) return "N/A";
  return score.toFixed(2);
}
