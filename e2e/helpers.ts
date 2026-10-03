import { createHash } from 'node:crypto';
import { Client } from 'pg';
import type { Page } from '@playwright/test';

/**
 * Helpers shared by the specs.
 *
 * Everything that needs to know the state of the world asks Postgres directly
 * rather than reading it back off the page. A test that asserts what the UI
 * says about what the UI just did proves only that the UI is self-consistent.
 */

export const EVENT_ID = process.env.EVENT_ID ?? '';
export const DATABASE_URL = process.env.DATABASE_URL ?? '';
export const JUDGE_TOKEN_SALT =
  process.env.JUDGE_TOKEN_SALT ?? 'hackjudge-salt-2026';
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@hackathon.local';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin123';

export function requireEnv() {
  const missing: string[] = [];
  if (!EVENT_ID) missing.push('EVENT_ID');
  if (!DATABASE_URL) missing.push('DATABASE_URL');
  if (missing.length) {
    throw new Error(
      `Set ${missing.join(' and ')} before running. These tests read the ` +
        `database to check what the UI actually did.`,
    );
  }
}

export async function db<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows as T[];
  } finally {
    await client.end();
  }
}

/** Mirrors JudgePortalService.generateToken. */
export function judgeToken(judgeId: string): string {
  return createHash('sha256')
    .update(judgeId + JUDGE_TOKEN_SALT)
    .digest('hex')
    .slice(0, 16);
}

export interface JudgeFixture {
  id: string;
  name: string;
  tier: string;
  token: string;
  sessionId: string;
  scorecardId: string;
  teamName: string;
}

/**
 * A judge with a session whose stage allows scoring, and that session's
 * scorecard reset to NOT_STARTED so a spec starts from a known place.
 *
 * `tier` filters to an IG judge when the spec needs the break control, which
 * PS judges do not have.
 */
export async function pickJudge(opts: { tier?: string[] } = {}): Promise<JudgeFixture> {
  const tiers = opts.tier ?? ['L2', 'L3', 'L4', 'PS'];
  const rows = await db(
    `SELECT j.id, j.name, j.judge_tier AS tier, s.id AS session_id,
            sc.id AS scorecard_id, t.name AS team_name
       FROM session_judges sj
       JOIN judges j ON j.id = sj.judge_id
       JOIN judging_sessions s ON s.id = sj.session_id
       JOIN teams t ON t.id = s.team_id
       JOIN scorecards sc ON sc.session_id = s.id AND sc.judge_id = j.id
      WHERE s.event_id = $1
        AND j.deleted_at IS NULL
        AND j.judge_tier = ANY($2)
        AND (SELECT count(*) FROM session_judges x WHERE x.session_id = s.id) = 3
      ORDER BY t.name, j.name
      LIMIT 1`,
    [EVENT_ID, tiers],
  );
  if (!rows.length) {
    throw new Error(
      'No 3-judge session found. Generate and save a schedule first.',
    );
  }
  const r = rows[0];

  await db(`UPDATE judging_sessions SET stage = 'IN_PROGRESS' WHERE id = $1`, [
    r.session_id,
  ]);
  await resetScorecard(r.scorecard_id);

  return {
    id: r.id,
    name: r.name,
    tier: r.tier,
    token: judgeToken(r.id),
    sessionId: r.session_id,
    scorecardId: r.scorecard_id,
    teamName: r.team_name,
  };
}

export async function resetScorecard(scorecardId: string) {
  await db(`DELETE FROM criterion_scores WHERE scorecard_id = $1`, [scorecardId]);
  await db(
    `UPDATE scorecards
        SET status='NOT_STARTED', total_score=NULL, submitted_at=NULL,
            overall_strengths=NULL, areas_for_improvement=NULL,
            recommendation=NULL, flagged_for_review=false
      WHERE id = $1`,
    [scorecardId],
  );
}

export async function restoreSession(sessionId: string, stage = 'SCHEDULED') {
  await db(`UPDATE judging_sessions SET stage = $2 WHERE id = $1`, [
    sessionId,
    stage,
  ]);
  await db(
    `UPDATE session_judges SET on_break=false, break_at=NULL WHERE session_id = $1`,
    [sessionId],
  );
}

export async function scorecardRow(scorecardId: string) {
  const rows = await db(
    `SELECT sc.status, sc.total_score, sc.submitted_at, sc.updated_at,
            (SELECT count(*) FROM criterion_scores c
              WHERE c.scorecard_id = sc.id AND c.score IS NOT NULL) AS scored,
            (SELECT coalesce(sum(c.score),0) FROM criterion_scores c
              WHERE c.scorecard_id = sc.id) AS stored_sum
       FROM scorecards sc WHERE sc.id = $1`,
    [scorecardId],
  );
  return rows[0];
}

export function portalPath(token: string) {
  return `/judge/${token}?event=${EVENT_ID}`;
}

/**
 * The score inputs, one per criterion.
 *
 * Each criterion renders a range slider and a number box bound to the same
 * value. Selecting both returns two elements per criterion, so every index
 * addresses the wrong half of a pair — filling "the first three" writes two
 * scores to criterion one and one to criterion two.
 *
 * The number box is the one to drive: fill() on it sets a value directly,
 * where a range input needs a drag or a keyboard nudge to fire React's
 * onChange reliably.
 */
export function scoreInputs(page: Page) {
  return page.locator('input[type="number"]');
}

export async function setScoreAt(page: Page, index: number, value: number) {
  const input = scoreInputs(page).nth(index);
  const max = Number((await input.getAttribute('max')) ?? 10);
  await input.fill(String(Math.min(value, max)));
  // React state updates on change; blur guarantees it has committed before the
  // next action reads it back.
  await input.blur();
}

/**
 * Waits for a scorecard to reach a status, polling the database.
 *
 * Asserting on a UI string proved a poor idea: the message may render briefly,
 * or somewhere a text locator cannot reach, and either way it tells you what
 * the page believes rather than what was stored. The database is the account
 * that matters — and if it never reaches the expected status, that is a finding
 * about the platform rather than about the test.
 */
export async function waitForStatus(
  scorecardId: string,
  status: string,
  timeoutMs = 30_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    last = await scorecardRow(scorecardId);
    if (last?.status === status) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `scorecard ${scorecardId} never reached ${status}; last seen ` +
      `status=${last?.status} total=${last?.total_score} scored=${last?.scored}`,
  );
}

/**
 * Fills every comment box on the open scorecard.
 *
 * At least one criterion is marked requiresComment — on this rubric it is
 * "Bonus points at your discretion" — and the submit is refused without it.
 * Filling only the two Overall assessment boxes leaves that criterion empty,
 * and the scorecard sits at DRAFT with every score present, which looks like a
 * broken submit and is not one.
 */
export async function fillAllComments(page: Page, text = 'Reviewed against the rubric.') {
  const boxes = page.locator('textarea:not([disabled])');
  const n = await boxes.count();
  for (let i = 0; i < n; i++) {
    const box = boxes.nth(i);
    if (await box.isVisible().catch(() => false)) {
      await box.fill(text);
    }
  }
  return n;
}
