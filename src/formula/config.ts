export const formulaConfig = {
  timeMetric: "main" as "main" | "mainExtra" | "completionist",

  reviewScoreExponent: 3.0,

  hoursPenaltyExponent: 0.05,

  minHours: 1,


  confidenceThreshold: 500,

  baselineScore: 70,


  ageDecayPerYear: 0.02,

  minAgeMultiplier: 0.5,

  minReviewCount: 100,
};
