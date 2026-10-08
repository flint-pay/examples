import { defineConfig, devices } from '@playwright/test';
import { browserEnvironment } from './tests/browser/support/browser-environment.ts';

// Two kinds of browser tests live here and they are different things:
//
//   local   Frontend state tests. They render the real views with canned data and script the
//           app's JSON routes on a local harness (tests/browser/support/harness.ts). Stripe.js is
//           replaced by a local double. These prove page states and interactions. They do not
//           prove anything about Flint, Stripe, or a sandbox.
//
//   staging Smoke checks against a running copy of the real app (ACCOUNT_BASE_URL) that is wired
//           to a staging sandbox. Full buyer journeys with email and real payments belong to the
//           shared acceptance harness in headless/e2e, not to this file.
//
// Run local tests with `npm run test:browser`. Run staging checks with
// `ACCOUNT_BROWSER_MODE=staging ACCOUNT_BASE_URL=http://localhost:4200 npm run test:browser`.
//
// Traces, screenshots, and videos stay off because they capture signed-in pages and network
// bodies. The only reporter is the console list. Nothing is uploaded.

const staging = process.env.ACCOUNT_BROWSER_MODE === 'staging';
const harnessPort = Number(process.env.HARNESS_PORT ?? 4291);

if (staging) {
  const base = process.env.ACCOUNT_BASE_URL;
  if (!base) throw new Error('Set ACCOUNT_BASE_URL to the running account app, for example http://localhost:4200.');
  if (/withflintpay\.com/i.test(base)) throw new Error('ACCOUNT_BASE_URL must be the merchant app, never a Flint host.');
}

export default defineConfig({
  testDir: './tests/browser',
  testMatch: staging ? 'staging/**/*.spec.ts' : 'local/**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    launchOptions: { env: browserEnvironment() },
    baseURL: staging ? process.env.ACCOUNT_BASE_URL : `http://127.0.0.1:${harnessPort}`,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    locale: 'en-US',
    timezoneId: 'America/Chicago',
  },
  projects: [{ name: staging ? 'staging' : 'local-state', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } }],
  webServer: staging
    ? undefined
    : {
        command: 'node tests/browser/support/harness.ts',
        url: `http://127.0.0.1:${harnessPort}/__render/not-found`,
        reuseExistingServer: false,
        timeout: 30_000,
        env: { HARNESS_PORT: String(harnessPort) },
      },
});
