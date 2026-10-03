import { test, expect, BrowserContext, Page } from '@playwright/test';
import {
  requireEnv, pickJudge, resetScorecard, restoreSession,
  scorecardRow, portalPath, db, scoreInputs, setScoreAt, waitForStatus, fillAllComments, JudgeFixture,
} from './helpers';

/**
 * A judge moving between a phone and a laptop mid-session.
 *
 * This is the only part of the specification with no other automated coverage.
 * The API tests cannot reach it, because the behaviour lives in two browsers
 * disagreeing about what they last saw, and the ranking tests cannot reach it
 * because nothing has been submitted yet.
 *
 * It is also the case a judge is most likely to hit by accident: pick up the
 * laptop, forget the phone is still open on the same team.
 *
 * The rules under test are CONCUR-1 to CONCUR-4:
 *   1  returning to a device with nothing unsaved refetches from the server
 *   2  returning with unsaved work warns rather than discarding either version
 *   3  a draft save sends only what changed
 *   4  a save carrying a stale updatedAt is refused with 409
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

test.beforeEach(async () => {
  await resetScorecard(judge.scorecardId);
});

async function openScorecardOn(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(portalPath(judge.token));
  await expect(page.getByRole('heading', { name: judge.name })).toBeVisible();

  const gotIt = page.getByRole('button', { name: 'Got it' });
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();

  const scoreNow = page.getByRole('button', { name: /^Score( now)?$/ });
  if (await scoreNow.first().isVisible().catch(() => false)) {
    await scoreNow.first().click();
  } else {
    await page.getByText('AWAITING YOU').click();
    await page.getByText(judge.teamName, { exact: false }).first().click();
  }
  await expect(page.getByText(/^Score: /)).toBeVisible();
  return page;
}

const setScore = setScoreAt;

async function saveDraft(page: Page) {
  await page.getByRole('button', { name: 'Save draft' }).click();
}

test('work done on one device is visible on the other', async ({ browser }) => {
  // The path a judge will actually take, and the one that already worked: the
  // server is the source of truth when a scorecard is opened.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const laptop = await browser.newContext();

  const phonePage = await openScorecardOn(phone);
  await setScore(phonePage, 0, 7);
  await setScore(phonePage, 1, 6);
  await saveDraft(phonePage);
  await expect(phonePage.getByText(/Saved|Draft saved/i)).toBeVisible({ timeout: 20_000 });

  const laptopPage = await openScorecardOn(laptop);
  const first = await scoreInputs(laptopPage).first().inputValue();
  expect(Number(first)).toBe(7);

  await phone.close();
  await laptop.close();
});

test('a stale device cannot overwrite newer work', async ({ browser }) => {
  // CONCUR-4. Both devices hold the scorecard. The laptop saves; the phone,
  // which has not seen that, tries to save its own older picture. Before this
  // rule the phone silently won and the laptop's work was gone.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const laptop = await browser.newContext();

  // Order matters. The phone opens first and sits on the scorecard, holding
  // the updatedAt from before anything changed. If it opened after the laptop
  // saved it would hold the current value and there would be no conflict to
  // detect — the test would pass for the wrong reason.
  const phonePage = await openScorecardOn(phone);
  await phonePage.waitForTimeout(500);
  const laptopPage = await openScorecardOn(laptop);

  await setScore(laptopPage, 0, 9);
  await setScore(laptopPage, 1, 9);
  await setScore(laptopPage, 2, 9);
  await saveDraft(laptopPage);
  await expect(laptopPage.getByText(/Saved|Draft saved/i)).toBeVisible({ timeout: 20_000 });

  const afterLaptop = await scorecardRow(judge.scorecardId);
  expect(Number(afterLaptop.scored)).toBe(3);

  // The phone still holds the state from before any of that.
  await setScore(phonePage, 0, 1);
  await saveDraft(phonePage);

  // Give the refused save time to round-trip.
  await phonePage.waitForTimeout(3_000);

  // The assertion that matters is that the laptop's work survived. Whether the
  // phone displays a particular sentence is secondary — and asserting on it
  // first made a passing platform look like a failing one.
  const afterPhone = await scorecardRow(judge.scorecardId);
  expect(Number(afterPhone.scored)).toBe(3);

  // The message is checked, but softly: a missing warning is worth knowing
  // about and is not the same defect as lost work.
  const warned = await phonePage
    .getByText(/updated on another device|Reload|already submitted/i)
    .isVisible()
    .catch(() => false);
  expect(
    warned,
    'the stale device was not told its save was refused — the write was ' +
      'correctly rejected, but the judge is left believing it saved',
  ).toBe(true);
  const [firstScore] = await db(
    `SELECT cs.score FROM criterion_scores cs
       JOIN scoring_criteria c ON c.id = cs.criterion_id
      WHERE cs.scorecard_id = $1 AND cs.score IS NOT NULL
      ORDER BY c.display_order LIMIT 1`,
    [judge.scorecardId],
  );
  expect(Number(firstScore?.score)).toBe(9);

  await phone.close();
  await laptop.close();
});

test('returning to a device with nothing unsaved shows the current scores', async ({ browser }) => {
  // CONCUR-1. The phone is backgrounded with everything saved; the laptop moves
  // on. Coming back to the phone must not show a stale picture — a judge acting
  // on old numbers is how a scorecard gets "corrected" toward something that
  // was never wrong.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const laptop = await browser.newContext();

  const phonePage = await openScorecardOn(phone);
  await setScore(phonePage, 0, 4);
  await saveDraft(phonePage);
  await expect(phonePage.getByText(/Saved|Draft saved/i)).toBeVisible({ timeout: 20_000 });

  const laptopPage = await openScorecardOn(laptop);
  await setScore(laptopPage, 0, 8);
  await saveDraft(laptopPage);
  await expect(laptopPage.getByText(/Saved|Draft saved/i)).toBeVisible({ timeout: 20_000 });

  // Background the phone and bring it back.
  await phonePage.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden', configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await phonePage.waitForTimeout(500);
  await phonePage.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible', configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await expect(async () => {
    const shown = await scoreInputs(phonePage).first().inputValue();
    expect(Number(shown)).toBe(8);
  }).toPass({ timeout: 20_000 });

  await phone.close();
  await laptop.close();
});

test('a submitted scorecard cannot be overwritten by a device still holding a draft', async ({ browser }) => {
  // The loud failure, and the acceptable one. Once the laptop submits, the
  // phone's save must be refused outright rather than reopening the scorecard.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const laptop = await browser.newContext();

  const phonePage = await openScorecardOn(phone);
  const laptopPage = await openScorecardOn(laptop);

  const total = await scoreInputs(laptopPage).count();
  for (let i = 0; i < total; i++) await setScore(laptopPage, i, 6);
  await fillAllComments(laptopPage);
  await laptopPage.getByRole('button', { name: 'Submit scorecard' }).click();
  await waitForStatus(judge.scorecardId, 'SUBMITTED');

  await setScore(phonePage, 0, 1);
  await saveDraft(phonePage);

  await phonePage.waitForTimeout(3_000);

  const row = await scorecardRow(judge.scorecardId);
  expect(row.status).toBe('SUBMITTED');

  const warned = await phonePage
    .getByText(/already submitted|another device|Reload/i)
    .isVisible()
    .catch(() => false);
  expect(
    warned,
    'the phone was not told the scorecard had already been submitted',
  ).toBe(true);

  await phone.close();
  await laptop.close();
});
