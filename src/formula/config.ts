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
   * How much to penalize longer games.
   * Formula: score / (hours ^ exponent)
   *
   * - 0.0 = No penalty for length (pure quality)
   * - 0.5 = Square root penalty (balanced)
   * - 1.0 = Linear penalty (strong time preference)
   */
  hoursPenaltyExponent: 0.4,

  /**
   * Minimum hours used in calculation.
   * Prevents division by very small numbers.
   */
  minHours: 1,

  /**
   * Bonus for games with more reviews (more confidence in score).
   * Applied as: score * (1 + log10(reviewCount) * weight)
   *
   * - 0.0 = No bonus
   * - 0.05 = Slight bonus for popular games
   * - 0.1 = Moderate bonus
   */
  reviewCountWeight: 0.05,

  /**
   * Minimum review count to include a game.
   * Games below this threshold get a warning.
   */
  minReviewCount: 100,
};
