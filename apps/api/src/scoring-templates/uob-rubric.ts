/**
 * The UOB Innovation Challenge scoring rubric.
 *
 * Transcribed from the judging criteria sheet dated 31 July 2026. Five
 * categories, nine scoring rows, one hundred points.
 *
 * Changes from the previous version, which came from an earlier draft:
 *
 *   - Business Impact drops from five rows to four. "Are the metrics sound and
 *     comprehensive" and "does the solution meet all the success metrics" merge
 *     into a single five-point row, and quantitative impact rises from ten
 *     points to fifteen.
 *   - The quantitative threshold is SGD 500k, not USD, and gains a middle band:
 *     eight points for below 500k or a 10–50% efficiency gain.
 *   - Feasibility becomes one row of ten rather than two of five, and Team
 *     Collaboration one row of twenty rather than two of ten. Both are scored
 *     as a pair of questions answered together — all, one, or neither — so
 *     splitting them would change the arithmetic rather than preserve it.
 *
 * The guidance text carries the bands verbatim. A judge deciding between eight
 * and fifteen should not have to remember what the threshold was; it sits
 * under the slider.
 */

export type RubricRow = {
  /** The guiding question. Shown as the row label. */
  name: string;
  maxScore: number;
  /** Anchor guidance, shown beneath the slider. */
  guidanceText?: string;
  requiresComment?: boolean;
};

export type RubricCategory = {
  name: string;
  maxScore: number;
  /** Shown behind an info affordance on the category header. */
  description?: string;
  rows: RubricRow[];
};

export const UOB_RUBRIC: { name: string; description: string; categories: RubricCategory[] } = {
  name: 'UOB Innovation Challenge',
  description: 'Judging criteria, 31 July 2026',
  categories: [
    {
      name: 'Innovative & Differentiated Approach',
      maxScore: 20,
      description:
        'Demonstrates the ability to clearly identify and effectively address a ' +
        'specific pain point, with a high degree of originality and an innovative ' +
        "approach reflected in the solution's uniqueness and value proposition.",
      rows: [
        {
          name: 'Does the solution fully address the problem statement(s) / objective(s)?',
          maxScore: 10,
          guidanceText: '10 fully satisfied · 5 partially satisfied · 0 not satisfied',
        },
        {
          name: 'Is the solution innovative?',
          maxScore: 10,
          guidanceText:
            '10 original (pioneer) · 5 innovative or differentiated · ' +
            '0 not innovative or differentiated',
        },
      ],
    },
    {
      name: 'Business Impact',
      maxScore: 40,
      description:
        'Demonstrates tangible value with credible metrics or estimates across one ' +
        'or more of: revenue uplift — enhanced customer propositions, monetization, ' +
        'growth outcomes; efficiency gains — automation, workflow redesign, time ' +
        'savings, productivity lift; loss avoidance — strengthened risk detection ' +
        'and controls, process resilience.',
      rows: [
        {
          name: 'How many value types does the POC address?',
          maxScore: 10,
          guidanceText:
            '10 more than one value type · 5 one value type · 0 no value type',
        },
        {
          name:
            'Quantitative impact — is the potential value from the POC more than ' +
            'SGD 500k per annum, or above 50% efficiency gain?',
          maxScore: 15,
          guidanceText:
            '15 at or above SGD 500k, or above 50% efficiency gain · ' +
            '8 below SGD 500k, or 10–50% efficiency gain · ' +
            '0 no quantitative benefit, or below 10%',
        },
        {
          name:
            'Qualitative impact — does the solution improve customer or employee ' +
            'experience, external or within UOB business units?',
          maxScore: 10,
          guidanceText: '10 fully satisfied · 0 not satisfied',
        },
        {
          name: 'Are the POC success metrics outlined sound and comprehensive?',
          maxScore: 5,
          guidanceText: '5 fully satisfied · 0 not satisfied',
        },
      ],
    },
    {
      name: 'Feasibility & Scalability',
      maxScore: 10,
      description:
        'Demonstrates a practical solution with a clear path to delivery, and the ' +
        'ability to scale across similar use cases and adopt across teams, ' +
        'processes or markets.',
      rows: [
        {
          // Two questions, one score. The sheet grants ten only when both are
          // fulfilled, so scoring them separately would let a team reach ten
          // having satisfied one.
          name:
            'Is the solution and delivery plan clear, and is it scalable across ' +
            'other use cases?',
          maxScore: 10,
          guidanceText:
            '10 both questions fulfilled · 5 one question fulfilled · ' +
            '0 neither fulfilled',
        },
      ],
    },
    {
      name: 'Team Collaboration & Resourcefulness',
      maxScore: 20,
      description:
        'Demonstrates strong teamwork, with cross-functional collaboration ' +
        'encouraged, by prioritising the integration of existing enterprise tools, ' +
        'data and platforms. PoCs may explore new tools where appropriate, while ' +
        'minimising the need for additional investments.',
      rows: [
        {
          name:
            'Does the team portray teamwork including cross-functional ' +
            'collaboration, and leverage at least one existing enterprise tool?',
          maxScore: 20,
          guidanceText:
            '20 both questions fulfilled · 10 one question fulfilled · ' +
            '0 neither fulfilled',
        },
      ],
    },
    {
      name: "Judge's Bonus",
      maxScore: 10,
      description: "Bonus points at the judge's discretion.",
      rows: [
        {
          name: 'Bonus points at your discretion',
          maxScore: 10,
          guidanceText:
            'No anchors — use your judgement. A reason is required so the score ' +
            'can be understood later.',
          // The only unanchored score on the card, so the only one whose
          // reasoning cannot be reconstructed from the rubric afterwards.
          requiresComment: true,
        },
      ],
    },
  ],
};

// The sheet totals one hundred. An edit that breaks that should fail at startup
// rather than quietly produce scorecards that cannot reach full marks.
const total = UOB_RUBRIC.categories.reduce((sum, c) => sum + c.maxScore, 0);
if (total !== 100) {
  throw new Error(`UOB rubric totals ${total}, expected 100`);
}

for (const category of UOB_RUBRIC.categories) {
  const rows = category.rows.reduce((sum, r) => sum + r.maxScore, 0);
  if (rows !== category.maxScore) {
    throw new Error(
      `UOB rubric: "${category.name}" rows total ${rows}, category says ${category.maxScore}`,
    );
  }
}
