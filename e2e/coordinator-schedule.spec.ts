import { test, expect } from '@playwright/test';
import { requireEnv, db, ADMIN_EMAIL, ADMIN_PASSWORD, EVENT_ID } from './helpers';

/**
 * The coordinator's path through the schedule builder.
 *
 * Marked `@destructive` because generating and confirming replaces the event's
 * schedule. Run it against a test environment with a verified restore, not
 * against a schedule anyone is relying on:
 *
 *   npx playwright test --grep-invert @destructive     # everything else
 *   npx playwright test --grep @destructive            # this file
 *
 * The point of testing this in a browser rather than over the API is that the
 * save path had a defect no API test could see: urql resolves with an `error`
 * property rather than rejecting, so the catch never fired, the planner was
 * cleared regardless, and a failed save reported success — then reloaded a
 * second later and destroyed the only copy of a solve that takes two minutes.
 */

test.describe('@destructive coordinator', () => {
  test.beforeAll(() => requireEnv());

  test('logs in and reaches the schedule builder', async ({ page }) => {
    await page.goto('/login');
    await page.locator('input[type="email"], input[name="email"]').fill(ADMIN_EMAIL);
    await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: /sign in|log ?in/i }).click();

    await page.waitForURL(/dashboard/, { timeout: 30_000 });
    await page.goto('/dashboard/schedule');
    await expect(page.getByText('Schedule Builder')).toBeVisible();
  });

  test('generates a schedule and confirms it, and the database agrees', async ({ page }) => {
    test.setTimeout(300_000);

    await page.goto('/login');
    await page.locator('input[type="email"], input[name="email"]').fill(ADMIN_EMAIL);
    await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: /sign in|log ?in/i }).click();
    await page.waitForURL(/dashboard/, { timeout: 30_000 });

    await page.goto('/dashboard/schedule');
    await expect(page.getByText('Schedule Builder')).toBeVisible();

    const teams = Number(
      (await db(`SELECT count(*) AS n FROM teams WHERE event_id=$1 AND deleted_at IS NULL`,
        [EVENT_ID]))[0].n,
    );

    await page.getByRole('button', { name: /^Generate/ }).click();

    // A guided solve across eleven passes took 142 seconds on real data.
    await expect(page.getByText(/Generated \d+ sessions/)).toBeVisible({
      timeout: 280_000,
    });

    await page.getByRole('button', { name: /Confirm all/i }).click();

    // The message must report counts rather than assert success. Before this
    // was fixed it said "79 sessions saved successfully" whether or not
    // anything had been written.
    await expect(page.getByText(/session\(s\) saved|were not saved|Nothing was saved/i))
      .toBeVisible({ timeout: 60_000 });

    // What the database says, which is the only account that matters.
    const [row] = await db(
      `SELECT count(*)::int AS total,
              count(scheduled_start)::int AS with_start,
              count(DISTINCT team_id)::int AS teams
         FROM judging_sessions WHERE event_id = $1
          AND stage NOT IN ('CANCELLED','NO_SHOW')`,
      [EVENT_ID],
    );

    expect(row.total).toBe(teams);
    expect(row.teams).toBe(teams);
    // The batched slot lookup writes scheduled_start. A gap here is the silent
    // failure it was capable of.
    expect(row.with_start).toBe(row.total);

    const [judges] = await db(
      `SELECT count(*)::int AS n FROM session_judges sj
         JOIN judging_sessions s ON s.id = sj.session_id
        WHERE s.event_id = $1`,
      [EVENT_ID],
    );
    expect(judges.n).toBe(row.total * 3);
  });

  test('the saved schedule is legal', async () => {
    // The same invariants check_schedule.py applies to the solver's output,
    // applied here to what was actually written. The two are different code
    // paths and a schedule can be legal in one and not the other.
    const checks = await db(
      `SELECT 'double-booked room-slot' AS check, count(*)::int AS n FROM (
         SELECT room_id, time_slot_id FROM judging_sessions
          WHERE event_id=$1 AND stage NOT IN ('CANCELLED','NO_SHOW')
          GROUP BY 1,2 HAVING count(*) > 1) x
       UNION ALL
       SELECT 'judge in two rooms at once', count(*)::int FROM (
         SELECT sj.judge_id, s.time_slot_id FROM session_judges sj
           JOIN judging_sessions s ON s.id = sj.session_id
          WHERE s.event_id=$1 AND s.stage NOT IN ('CANCELLED','NO_SHOW')
          GROUP BY 1,2 HAVING count(*) > 1) y
       UNION ALL
       SELECT 'panel not three judges', count(*)::int FROM (
         SELECT sj.session_id FROM session_judges sj
           JOIN judging_sessions s ON s.id = sj.session_id
          WHERE s.event_id=$1 AND s.stage NOT IN ('CANCELLED','NO_SHOW')
          GROUP BY 1 HAVING count(*) <> 3) z
       UNION ALL
       SELECT 'conflict violated', count(*)::int FROM session_judges sj
         JOIN judging_sessions s ON s.id = sj.session_id
         JOIN conflict_declarations c
           ON c.judge_id = sj.judge_id AND c.team_id = s.team_id
        WHERE s.event_id=$1 AND c.status='ACTIVE'`,
      [EVENT_ID],
    );

    for (const c of checks) {
      expect(`${c.check}: ${c.n}`).toBe(`${c.check}: 0`);
    }
  });
});
