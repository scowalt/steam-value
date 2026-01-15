import { formulaConfig } from "./config";
import type { Game } from "../db/schema";

export interface ValueScoreInput {
  steamReviewScore: number | null;
  steamReviewCount: number | null;
  hltbMain: number | null;
  hltbMainExtra: number | null;
  hltbCompletionist: number | null;
  isEndless?: boolean | null;
  releaseDate?: string | null; // ISO date string "YYYY-MM-DD"
}

/**
 * Calculate the value score for a game.
 *
 * The formula rewards:
 * - Higher review scores (with Bayesian confidence scaling)
 * - Shorter completion times (quality density)
 * - Newer releases (age decay)
 *
 * Returns null if required data is missing.
 */
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

  // Endless games (MMO/survival/multiplayer) don't get value scores
  if (isEndless) {
    return null;
  }

  // Check for required data
  if (steamReviewScore === null || steamReviewScore === undefined) {
    return null;
  }

  // Get the appropriate time metric
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

  // If no HLTB data, return null (can't calculate density)
  if (hours === null || hours === undefined) {
    return null;
  }

  // Apply minimum hours floor
  const effectiveHours = Math.max(hours, minHours);

  // Bayesian confidence scaling: pull low-review scores toward baseline
  let confidenceScore = steamReviewScore;
  if (steamReviewCount && steamReviewCount > 0) {
    const confidence = steamReviewCount / (steamReviewCount + confidenceThreshold);
    confidenceScore = steamReviewScore * confidence + baselineScore * (1 - confidence);
  } else {
    // No reviews = baseline score
    confidenceScore = baselineScore;
  }

  // Base formula: quality^exponent / time^exponent
  const adjustedScore = Math.pow(confidenceScore, reviewScoreExponent);
  let score = adjustedScore / Math.pow(effectiveHours, hoursPenaltyExponent);

  // Age decay: penalize older games
  if (releaseDate) {
    const releaseYear = new Date(releaseDate).getFullYear();
    const currentYear = new Date().getFullYear();
    const yearsOld = currentYear - releaseYear;
    const ageMultiplier = Math.max(minAgeMultiplier, 1 - yearsOld * ageDecayPerYear);
    score *= ageMultiplier;
  }

  return Math.round(score * 100) / 100; // Round to 2 decimal places
}

/**
 * Calculate value score for a Game record from the database.
 */
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

/**
 * Format a value score for display.
 */
export function formatValueScore(score: number | null): string {
  if (score === null) return "N/A";
  return score.toFixed(2);
}
