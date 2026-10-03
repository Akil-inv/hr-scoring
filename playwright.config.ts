import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright covers the paths nothing else reaches.
 *
 * The API is tested by test_judge_portal.py over real HTTP, and the ranking
 * arithmetic by simulate_scoring.py. What neither touches is the browser: the
 * autosave timer, recovery after a tab is killed, and a judge moving between a
 * phone and a laptop. That last one is the only rule in the specification with
 * no automated coverage at all, and it is the one a judge is most likely to
 * trigger by accident.
 *
 *   BASE_URL=https://judge.uobigedm.com npx playwright test
 *   BASE_URL=http://localhost:3000 npx playwright test        # local stack
 *
 * Serial, not parallel. These tests generate schedules and submit scorecards
 * against a shared database; running them at once would have them fight over
 * the same rows and fail for reasons that have nothing to do with the code.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 300_000,        // a guided solve took 142s on real data
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,              // a flake here is a finding, not noise to paper over
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 20_000,
    ignoreHTTPSErrors: true,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    {
      // The judges are reading between presentations, often on a phone. A
      // layout that works at 1280px and not at 390px is a layout that fails on
      // the day.
      // Pixel 5 rather than iPhone 13: the iPhone profile runs WebKit, which
      // is a second browser to install for a viewport test. The thing being
      // checked here is the 390px layout, not Safari.
      name: 'mobile',
      use: { ...devices['Pixel 5'] },
      testMatch: /judge-.*\.spec\.ts/,
    },
  ],
});
