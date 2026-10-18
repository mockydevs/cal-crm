// Scoring bounds and calculations, on their own so the automation catalog can use them
// without loading the score profile and rule endpoints with them.

export const SCORING_LIMITS = {
  /** Rules a profile holds. */
  rules: 100,
  /** Points one rule or one workflow step adds or subtracts. */
  points: 1000,
  /** A score stays between minus this and this. */
  score: 1_000_000,
  /** Characters of the profile's name and description. */
  name: 100,
  description: 500,
} as const;

export const scoreCalculations = ['add', 'subtract'] as const;
export type ScoreCalculation = (typeof scoreCalculations)[number];
export const scoreComparisons = ['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte'] as const;
export type ScoreComparison = (typeof scoreComparisons)[number];
