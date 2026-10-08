import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
import { checkoutRoot } from './support/private-files.ts';
import { invariant } from './support/safe.ts';
import { browserEnvironment } from './support/child.ts';

const app = process.env.E2E_SINGLE_APP;
invariant(app === 'storefront' || app === 'account', 'SINGLE_APP_REQUIRED');
export default defineConfig({
  testDir: join(checkoutRoot, 'headless', app, 'tests/browser', app === 'storefront' ? 'acceptance' : 'staging'),
  testMatch: '**/*.spec.ts', fullyParallel: false, workers: 1, retries: 0,
  timeout: 120_000, expect: { timeout: 8_000 },
  reporter: [['./support/single-app-reporter.ts']],
  outputDir: join(process.env.E2E_PRIVATE_RUN_DIR ?? '', `single-app-${app}-temporary`),
  use: { launchOptions: { env: browserEnvironment() }, baseURL: app === 'storefront' ? process.env.E2E_STOREFRONT_A_ORIGIN : process.env.E2E_ACCOUNT_A_ORIGIN, serviceWorkers: 'block', trace: 'off', screenshot: 'off', video: 'off', acceptDownloads: false },
  // The parent's existing run-owned, audited processes serve these endpoints.
});
