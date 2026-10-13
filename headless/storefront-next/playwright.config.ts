import { defineConfig, devices } from '@playwright/test';

// Staging acceptance: drives a running copy of this app against a sandbox with real Stripe.js in
// test mode. Opt in with STOREFRONT_ACCEPTANCE=1. Payment forms are involved, so traces,
// screenshots, and videos stay off.

export default defineConfig({
  testDir: 'tests/acceptance',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.APP_ORIGIN ?? 'http://localhost:4300',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
