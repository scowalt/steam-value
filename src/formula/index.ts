import { formulaConfig } from "./config";
import type { Game } from "../db/schema";

export interface ValueScoreInput {
  steamReviewScore: number | null;
  steamReviewCount: number | null;
  hltbMain: number | null;
  hltbMainExtra: number | null;
  hltbCompletionist: number | null;
  isEndless?: boolean | null;
}

/**
 * Calculate the value score for a game.
 *
 * The formula rewards:
 * - Higher review scores
 * - Shorter completion times (quality density)
 * - Optionally: more reviews (higher confidence)
 *
 * Returns null if required data is missing.
 */
export function calculateValueScore(input: ValueScoreInput): number | null {
  const { steamReviewScore, steamReviewCount, hltbMain, hltbMainExtra, hltbCompletionist, isEndless } = input;
  const { timeMetric, hoursPenaltyExponent, minHours, reviewCountWeight, minReviewCount } = formulaConfig;

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

  // Base formula: quality / time^exponent
  let score = steamReviewScore / Math.pow(effectiveHours, hoursPenaltyExponent);

  // Apply review count bonus (more reviews = more confidence)
  if (reviewCountWeight > 0 && steamReviewCount && steamReviewCount > 0) {
    const countBonus = 1 + Math.log10(steamReviewCount) * reviewCountWeight;
    score *= countBonus;
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
  });
}

/**
 * Format a value score for display.
 */
export function formatValueScore(score: number | null): string {
  if (score === null) return "N/A";
  return score.toFixed(2);
}
