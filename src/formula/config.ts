/**
 * Formula Configuration
 *
 * Tweak these parameters to adjust how value scores are calculated.
 * After changing, run `bun recalc` to update all games.
 */
export const formulaConfig = {
  /**
   * Which HLTB time metric to use for calculations
   * - 'main': Main story only
   * - 'mainExtra': Main story + extras
   * - 'completionist': 100% completion
   */
  timeMetric: "main" as "main" | "mainExtra" | "completionist",

  /**
   * Exponent applied to review score.
   * Higher values make high ratings more impactful.
   *
   * - 1.0 = Linear (95% is 1.19x better than 80%)
   * - 1.5 = Moderate curve (95% is 1.29x better than 80%)
   * - 2.0 = Strong curve (95% is 1.41x better than 80%)
   */
  reviewScoreExponent: 3.0,

  /**
   * How much to penalize longer games.
   * Formula: score / (hours ^ exponent)
   *
   * - 0.0 = No penalty for length (pure quality)
   * - 0.5 = Square root penalty (balanced)
   * - 1.0 = Linear penalty (strong time preference)
   */
  hoursPenaltyExponent: 0.05,

  /**
   * Minimum hours used in calculation.
   * Prevents division by very small numbers.
   */
  minHours: 1,

  /**
   * Bayesian confidence scaling parameters.
   * Pulls low-review-count scores toward baseline.
   *
   * Formula: adjustedScore = (score * C) + (baseline * (1 - C))
   * where C = reviewCount / (reviewCount + confidenceThreshold)
   */

  /**
   * Number of reviews needed for 50% confidence in score.
   * Games with fewer reviews are pulled toward baseline more strongly.
   *
   * - 250 = Moderate (250 reviews = 50% blend)
   * - 500 = Standard (500 reviews = 50% blend)
   * - 1000 = Conservative (1000 reviews = 50% blend)
   */
  confidenceThreshold: 500,

  /**
   * Baseline score to regress toward for low-review games.
   * This is the "average" game score assumption.
   */
  baselineScore: 70,

  /**
   * Age decay parameters.
   * Older games receive a penalty to favor newer experiences.
   */

  /**
   * Penalty per year since release.
   * 0.02 = 2% per year = 10% per 5 years (mild)
   * 0.04 = 4% per year = 20% per 5 years (moderate)
   */
  ageDecayPerYear: 0.02,

  /**
   * Minimum age multiplier (floor).
   * Prevents very old games from being penalized too harshly.
   * 0.5 = 20+ year old games cap at 50% penalty
   */
  minAgeMultiplier: 0.5,

  /**
   * Minimum review count to include a game.
   * Games below this threshold get a warning.
   */
  minReviewCount: 100,
};
