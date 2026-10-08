import { defineConfig, devices } from '@playwright/test';
import { browserEnvironment } from './tests/browser/support/browser-environment.ts';

// Two kinds of browser tests live here and they are different things:
//
//   local-state          Runs the real views and public/ scripts against an
//                        in-memory stand-in service and a Stripe.js stub.
//                        It checks frontend states only. It is not acceptance.
//   staging-acceptance   Runs against the real app, a sandbox, and Stripe test
//                        mode. It only runs when STOREFRONT_ACCEPTANCE=1.
//
// Authenticated pages and payment forms are involved, so traces, screenshots,
// videos, and raw JSON or HTML reports stay off. Nothing is uploaded.

const localPort = Number(process.env.LOCAL_STATE_PORT ?? 4190);
const acceptance = process.env.STOREFRONT_ACCEPTANCE === '1';

export default defineConfig({
  testDir: 'tests/browser',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: acceptance ? 120_000 : 30_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    launchOptions: { env: browserEnvironment() },
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'local-state',
      testDir: 'tests/browser/local',
      use: { baseURL: `http://localhost:${localPort}` },
    },
    ...(acceptance
      ? [
          {
            name: 'staging-acceptance',
            testDir: 'tests/browser/acceptance',
            use: { baseURL: process.env.APP_ORIGIN ?? 'http://localhost:4100' },
          },
        ]
      : []),
  ],
  webServer: {
    command: 'node tests/browser/support/local-server.ts',
    url: `http://localhost:${localPort}/__health`,
    reuseExistingServer: false,
    timeout: 20_000,
    env: { LOCAL_STATE_PORT: String(localPort) },
  },
});
