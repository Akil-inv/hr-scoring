/**
 * The Leadership Acceleration Programme (LAP) HR interview rubric.
 *
 * Five dimensions, each rated 1 (low) to 5 (high), with descriptions for 1, 3
 * and 5 that judges see while scoring. 2 and 4 sit between those. Every rating
 * needs a comment, and each judge answers "Support for LAP" Yes / No. The
 * candidate's score is the average rating, out of 5.
 *
 * Used when the setup workbook's Rubric sheet is left empty.
 */

export type RatingDimension = {
  name: string;
  descriptor: string;
  /** What a 1, 3 and 5 look like. */
  low: string;
  moderate: string;
  high: string;
};

export const RATING_MIN = 1;
export const RATING_MAX = 5;

export const LAP_RUBRIC: { name: string; supportQuestion: string; dimensions: RatingDimension[] } = {
  name: 'Leadership Acceleration Programme (LAP) HR interviews',
  supportQuestion: 'Support for LAP',
  dimensions: [
    {
      name: 'Career Aspirations',
      descriptor: 'Clarity and ambition regarding future roles and career trajectory',
      low: 'No clear career goals; lacks interest in leadership or generalist roles.',
      moderate: 'Expresses some interest in leadership but lacks clarity or commitment to generalist path.',
      high: 'Strong aspiration for senior leadership; clearly articulates interest in generalist roles and long-term growth.',
    },
    {
      name: 'Drive and Motivation',
      descriptor: 'Energy, initiative, and commitment to personal and organizational goals',
      low: 'Passive attitude; limited examples of initiative or ownership.',
      moderate: 'Shows moderate drive; some examples of taking initiative or leading efforts.',
      high: 'Highly driven; consistently demonstrates ownership, resilience, and proactive leadership.',
    },
    {
      name: 'Mobility & Rotation Readiness',
      descriptor: 'Willingness and preparedness for new roles or rotations',
      low: 'Unwilling to relocate or rotate; prefers stability.',
      moderate: 'Open to some mobility; hesitant about full rotation model.',
      high: 'Fully open to geographic and functional rotations; embraces diverse experiences.',
    },
    {
      name: 'Learning Agility & Adaptability',
      descriptor: 'Ability to learn quickly and adapt to new situations',
      low: 'Resistant to change; struggles with unfamiliar situations.',
      moderate: 'Some adaptability; has handled change with mixed success.',
      high: 'Highly agile; thrives in new environments and learns quickly from feedback.',
    },
    {
      name: 'Enterprise Perspective',
      descriptor: 'Understanding and acting for the broader organization',
      low: 'Narrow focus on own function; lacks cross-functional awareness.',
      moderate: 'Some awareness of broader business; limited cross-functional experience.',
      high: 'Strong enterprise mindset; demonstrates strategic thinking and cross-functional collaboration.',
    },
  ],
};

/** Stored on each criterion so the judge portal and reports can show them. */
export function ratingAnchors(d: RatingDimension) {
  return [
    { score: 1, label: 'Low', text: d.low },
    { score: 3, label: 'Moderate', text: d.moderate },
    { score: 5, label: 'High', text: d.high },
  ];
}
