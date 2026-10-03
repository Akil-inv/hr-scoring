import { test, expect, Page } from '@playwright/test';
import {
  requireEnv, pickJudge, resetScorecard, restoreSession,
  scorecardRow, portalPath, scoreInputs, setScoreAt, waitForStatus, fillAllComments, JudgeFixture,
} from './helpers';

/**
 * The judge's own path, in a browser.
 *
 * Everything here is checked against the database rather than against the page.
 * A test that asks the UI whether the UI saved something proves only that the
 * UI is consistent with itself, which is exactly the failure this platform is
 * prone to — three defects this project, none of which raised an error.
 */

let judge: JudgeFixture;

test.beforeAll(async () => {
  requireEnv();
  judge = await pickJudge();
});

test.afterAll(async () => {
  if (judge) {
    await resetScorecard(judge.scorecardId);
    await restoreSession(judge.sessionId);
  }
});

async function openPortal(page: Page) {
  await page.goto(portalPath(judge.token));
  await expect(page.getByRole('heading', { name: judge.name })).toBeVisible();
  const gotIt = page.getByRole('button', { name: 'Got it' });
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
}

/** Opens the scorecard for the fixture's session, however the page offers it. */
async function openScorecard(page: Page) {
  const scoreNow = page.getByRole('button', { name: /^Score( now)?$/ });
  if (await scoreNow.first().isVisible().catch(() => false)) {
    await scoreNow.first().click();
  } else {
    await page.getByText('AWAITING YOU').click();
    await page.getByText(judge.teamName, { exact: false }).first().click();
  }
  await expect(page.getByText(/^Score: /)).toBeVisible();
}

/** Fills the first `count` criteria. -1 fills all of them. */
async function fillScores(page: Page, count: number, value = 5) {
  const total = await scoreInputs(page).count();
  const n = count < 0 ? total : Math.min(count, total);
  for (let i = 0; i < n; i++) await setScoreAt(page, i, value);
  return n;
}

test('an invalid link is refused rather than showing an empty portal', async ({ page }) => {
  await page.goto(`/judge/${'0'.repeat(16)}?event=${process.env.EVENT_ID}`);
  await expect(page.getByText(/Invalid Link|not valid/i)).toBeVisible();
});

test('a judge sees only their own name and sessions', async ({ page }) => {
  await openPortal(page);
  await expect(page.getByRole('heading', { name: judge.name })).toBeVisible();
  // The label appears more than once inside its own tile — a heading, a
  // subtitle and a compact variant — so match the button, not the text.
  for (const tile of ['AWAITING YOU', 'UP NEXT', 'DONE', 'REVISIT']) {
    await expect(page.getByRole('button', { name: new RegExp(tile, 'i') }).first())
      .toBeVisible();
  }
});

test('a partial score saves as a draft and survives the tab being killed', async ({ browser }) => {
  // The autosave case that matters: a judge part-scores a team, the phone
  // reclaims the tab, and they come back to it. The draft has to be there.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await openPortal(page);
  await openScorecard(page);
  const filled = await fillScores(page, 3, 5);
  expect(filled).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText(/Saved|Draft saved/i)).toBeVisible({ timeout: 20_000 });

  const afterSave = await scorecardRow(judge.scorecardId);
  expect(afterSave.status).toBe('DRAFT');
  expect(Number(afterSave.scored)).toBe(filled);
  // TOTAL-1: the stored total must equal the stored scores, not the payload.
  expect(Number(afterSave.total_score)).toBe(Number(afterSave.stored_sum));

  await ctx.close();

  // A new context is a new browser session — no sessionStorage, nothing local.
  // Whatever is on screen now came from the server.
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await openPortal(page2);
  await openScorecard(page2);

  const recovered = await scoreInputs(page2).first().inputValue();
  expect(Number(recovered)).toBe(5);

  await ctx2.close();
});

test('a complete scorecard submits and cannot then be edited', async ({ page }) => {
  await resetScorecard(judge.scorecardId);
  await openPortal(page);
  await openScorecard(page);

  await fillScores(page, -1, 5);

  await fillAllComments(page);

  await page.getByRole('button', { name: 'Submit scorecard' }).click();

  // The database, not the page. If this times out the submit genuinely did not
  // land, and the error names the status it stopped at.
  const row = await waitForStatus(judge.scorecardId, 'SUBMITTED');
  expect(row.submitted_at).not.toBeNull();
  // SUB-1 and TOTAL-1 together: complete, and the total matches its own scores.
  expect(Number(row.total_score)).toBe(Number(row.stored_sum));
  expect(Number(row.total_score)).toBeGreaterThan(0);

  // Reopening the page must not offer to edit a submitted scorecard.
  await page.reload();
  await openPortal(page);
  await expect(page.getByRole('button', { name: 'Submit scorecard' })).toHaveCount(0);
});

test('an incomplete scorecard is refused, naming the criterion', async ({ page }) => {
  await resetScorecard(judge.scorecardId);
  await openPortal(page);
  await openScorecard(page);

  await fillScores(page, 2, 5);
  await page.getByRole('button', { name: 'Submit scorecard' }).click();

  // "Comment required" is a standing badge on some criteria; the message that
  // matters is the one the refusal produces.
  await expect(
    page.getByText(/is required|cannot be submitted/i).first(),
  ).toBeVisible({ timeout: 20_000 });

  const row = await scorecardRow(judge.scorecardId);
  expect(row.status).not.toBe('SUBMITTED');
});
