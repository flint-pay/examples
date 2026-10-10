import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { browserEnvironment } from '../../support/child.ts';

const osEnvironment = {
  PATH: '/unit/bin', HOME: '/unit/home', USERPROFILE: 'C:\\unit', SystemRoot: 'C:\\Windows',
  TMPDIR: '/unit/tmp', TEMP: '/unit/temp', TMP: '/unit/tmp', LANG: 'en_CA.UTF-8', LC_ALL: 'en_CA.UTF-8', TZ: 'UTC',
  XDG_CACHE_HOME: '/unit/cache', XDG_RUNTIME_DIR: '/unit/runtime', DISPLAY: ':unit',
  SSL_CERT_FILE: '/unit/ca.pem', SSL_CERT_DIR: '/unit/certs', NODE_EXTRA_CA_CERTS: '/unit/node-ca.pem', LD_LIBRARY_PATH: '/unit/lib',
};
// Synthetic authority, including unrelated caller secrets that must fail closed.
const credentials = {
  E2E_SANDBOX_A_API_KEY: 'flint_test_UNIT_APP_A_FAKE', E2E_SANDBOX_B_API_KEY: 'flint_test_UNIT_APP_B_FAKE',
  E2E_OPERATOR_A_API_KEY: 'flint_test_UNIT_OPERATOR_A_FAKE', E2E_OPERATOR_B_API_KEY: 'flint_test_UNIT_OPERATOR_B_FAKE',
  FLINT_API_KEY: 'flint_test_UNIT_SERVER_FAKE', FLINT_WEBHOOK_SECRET: 'UNIT_WEBHOOK_FAKE',
  OP_SERVICE_ACCOUNT_TOKEN: 'UNIT_OP_TOKEN_FAKE', OP_SESSION_unit: 'UNIT_OP_SESSION_FAKE',
  AWS_ACCESS_KEY_ID: 'UNIT_AWS_ID_FAKE', AWS_SECRET_ACCESS_KEY: 'UNIT_AWS_SECRET_FAKE', AWS_SESSION_TOKEN: 'UNIT_AWS_SESSION_FAKE',
  STRIPE_SECRET_KEY: 'UNIT_STRIPE_SECRET_FAKE', STRIPE_WEBHOOK_SECRET: 'UNIT_STRIPE_WEBHOOK_FAKE',
  RESEND_API_KEY: 'UNIT_SENDER_KEY_FAKE', SMTP_PASSWORD: 'UNIT_SMTP_PASSWORD_FAKE', E2E_IMAP_PASSWORD: 'UNIT_INBOX_PASSWORD_FAKE',
  GITHUB_TOKEN: 'UNIT_GITHUB_TOKEN_FAKE', CUSTOM_UNRECOGNIZED_AUTHORITY: 'UNIT_CUSTOM_SECRET_FAKE',
  NODE_OPTIONS: '--require=/unit/privileged-hook.cjs', LC_UNKNOWN_SECRET: 'UNIT_LOCALE_SECRET_FAKE',
};

test('browser environment preserves OS settings without mutating parent authority', () => {
  const parent = { ...osEnvironment, ...credentials, LANG_UNSET: undefined }, before = { ...parent };
  const env = browserEnvironment(parent);
  assert.deepEqual(env, osEnvironment);
  assert.deepEqual(parent, before);
  env.HOME = '/unit/changed';
  assert.equal(parent.HOME, osEnvironment.HOME);
  assert.deepEqual(browserEnvironment({ HOME: undefined, E2E_OPERATOR_A_API_KEY: credentials.E2E_OPERATOR_A_API_KEY }), {});
});

for (const guardCodes of [[], ['FLINT_COMMERCE_REQUEST', 'RELAY_VALIDATION_FAILED', 'GUARD_INSPECTION_FAILED', 'FLINT_COMMERCE_REQUEST']]) test(`acceptance entrypoint preserves browser environment and safe guard evidence (${guardCodes.length ? 'guard failure' : 'clean launch'})`, () => {
  const entrypoint = new URL('../../scripts/e2e.ts', import.meta.url).href;
  const configEnvironment = {
    E2E_FLINT_API_BASE_URL: 'https://api.staging.withflintpay.com', E2E_SANDBOX_A_ID: 'test_UNIT_A', E2E_SANDBOX_B_ID: 'test_UNIT_B',
    E2E_SANDBOX_A_MERCHANT_ID: 'mer_UNIT', E2E_SANDBOX_B_MERCHANT_ID: 'mer_UNIT', E2E_SANDBOX_A_PROVIDER_ID: 'acct_UNIT_A', E2E_SANDBOX_B_PROVIDER_ID: 'acct_UNIT_B',
    E2E_RUN_ID: '20000101T000000Z-00000000', E2E_TARGET_COMMIT: '0'.repeat(40), E2E_API_TARGET_COMMIT: '1'.repeat(40),
    E2E_STOREFRONT_A_ARTIFACT_ID: 'UNIT_SF_A', E2E_STOREFRONT_B_ARTIFACT_ID: 'UNIT_SF_B', E2E_ACCOUNT_A_ARTIFACT_ID: 'UNIT_AC_A', E2E_API_ARTIFACT_ID: 'UNIT_API',
    E2E_PRIVATE_RUN_DIR: '/unit/private', E2E_FIXTURE_FILE: '/unit/private/fixture.json',
  };
  const mocks = {
    '@playwright/test': `import assert from 'node:assert/strict';
      export const chromium = { launch: async options => {
        assert.deepEqual(options, { headless: true, env: ${JSON.stringify(osEnvironment)} });
        for (const [name, value] of Object.entries(${JSON.stringify(credentials)})) assert.equal(process.env[name], value);
        globalThis.browserBoundaryLaunched = true;
        return { close: async () => { globalThis.browserBoundaryClosed = true; } };
      } };`,
    '../support/fixtures.ts': 'export const loadFixtures = async () => ({ resources: [] }); export const assertSessionExceptions = () => {};',
    '../support/private-files.ts': 'export const privateDirectory = async dir => dir;',
    '../support/sdk.ts': `import assert from 'node:assert/strict';
      export class VerifiedClients { constructor(config) {
        assert.equal(config.operatorPins.A.key, ${JSON.stringify(credentials.E2E_OPERATOR_A_API_KEY)});
        assert.equal(config.pins.A.key, ${JSON.stringify(credentials.E2E_SANDBOX_A_API_KEY)});
        assert.equal(config.pins.B.key, ${JSON.stringify(credentials.E2E_SANDBOX_B_API_KEY)});
      } requestIds = new Set(); async verify() {} }`,
    '../support/results.ts': `export class Results {
      roots = new Map(); rows = new Map();
      finish(id, status, evidence) { this.rows.set(id, { id, status, evidence }); }
      updateRoot(root) { this.roots.set(root.id, root); }
      stopped(id, prerequisite) { this.rows.set(id, { id, status: 'NOT RUN', prerequisite }); }
      async save() { globalThis.guardReport = { scenarios: [...this.rows.values()], prerequisites: [...this.roots.values()] }; }
    }`,
    '../support/ledger.ts': 'export class Ledger { async load() {} }',
    '../support/operator.ts': 'export class Operator { async cleanup() {} }',
    '../support/driver.ts': `import { HarnessError } from ${JSON.stringify(new URL('../../support/safe.ts', import.meta.url).href)};
      export class Driver {
        scanner = { violations: new Set() };
        guards = new Map([[{}, { violations: new Set(${JSON.stringify(guardCodes)}), requestIds: new Set() }]]);
        async guardCheck() { if (${guardCodes.length > 0}) throw new HarnessError('BROWSER_BOUNDARY_VIOLATION'); }
        async close() {}
      }`,
    '../support/inbox.ts': 'export const createInbox = () => undefined;',
    '../support/readiness.ts': 'export const inventoryReadiness = () => {}; export const prerequisites = () => [];',
    '../support/build.ts': 'export const verifyBuilds = async () => {};',
    '../support/source.ts': 'export const verifySourceCheckout = () => {};',
    '../support/lock.ts': 'export const acquirePairLock = async () => async () => {};',
    '../support/app-vault.ts': 'export const verifyVaultAuthority = async () => {}; export class VaultGateError extends Error {}',
    '../support/audit-feed.ts': 'export const syncAppAudit = async () => {};',
    '../scenarios/registry.ts': `export const rows = ${guardCodes.length ? "[{ id: 'U-01' }, { id: 'U-02' }]" : '[]'}, executionOrder = rows.map(row => row.id);
      export const handlers = { 'U-01': async () => [] }, dependencies = {}; export const validateRegistry = () => {};`,
  };
  // Import the real runner and environment helper; replace service dependencies only.
  const source = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    import { fileURLToPath } from 'node:url';
    const entrypoint = ${JSON.stringify(entrypoint)}, mocks = ${JSON.stringify(mocks)};
    Object.assign(process.env, ${JSON.stringify({ ...osEnvironment, ...credentials, ...configEnvironment })});
    const parent = { ...process.env };
    process.argv = [process.execPath, fileURLToPath(entrypoint), '--apply'];
    globalThis.fetch = () => { throw new Error('OFFLINE_TEST_NETWORK_FORBIDDEN'); };
    registerHooks({
      resolve(specifier, context, next) {
        if (context.parentURL === entrypoint && Object.hasOwn(mocks, specifier)) return { url: 'browser-boundary:' + specifier, shortCircuit: true };
        return next(specifier, context);
      },
      load(url, context, next) {
        if (url.startsWith('browser-boundary:')) return { format: 'module', source: mocks[url.slice('browser-boundary:'.length)], shortCircuit: true };
        return next(url, context);
      },
    });
    process.on('beforeExit', () => {
      assert.equal(globalThis.browserBoundaryLaunched, true);
      assert.equal(globalThis.browserBoundaryClosed, true);
      assert.deepEqual({ ...process.env }, parent);
      if (${guardCodes.length > 0}) {
        assert.deepEqual(globalThis.guardReport.scenarios[0], { id: 'U-01', status: 'FAIL', evidence: ${JSON.stringify(['BROWSER_BOUNDARY_VIOLATION', ...new Set(guardCodes)])} });
        assert.deepEqual(globalThis.guardReport.scenarios[1], { id: 'U-02', status: 'NOT RUN', prerequisite: 'PRQ-GUARDS' });
        assert.equal(globalThis.guardReport.prerequisites.find(root => root.id === 'PRQ-GUARDS').status, 'FAIL');
      }
    });
    await import(entrypoint);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    env: {}, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, guardCodes.length ? 1 : 0, result.stdout + result.stderr);
  assert.match(result.stdout, guardCodes.length ? /"event":"ACCEPTANCE_INCOMPLETE"/ : /"event":"ACCEPTANCE_COMPLETE"/);
  assert.equal(result.stderr, '');
});

for (const [path, modes] of [
  ['../../single-app.config.ts', [{ E2E_SINGLE_APP: 'storefront' }, { E2E_SINGLE_APP: 'account' }]],
  ['../../../storefront/playwright.config.ts', [{ STOREFRONT_ACCEPTANCE: '0' }, { STOREFRONT_ACCEPTANCE: '1' }]],
  ['../../../account/playwright.config.ts', [{ ACCOUNT_BROWSER_MODE: 'local' }, { ACCOUNT_BROWSER_MODE: 'staging' }]],
] as const) {
  for (const mode of modes) test(`${path} supplies only OS env to browser launches in ${Object.values(mode)[0]} mode`, () => {
    const configUrl = new URL(path, import.meta.url).href;
    const source = `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      Object.assign(process.env, ${JSON.stringify({ ...osEnvironment, ...credentials, ...mode, ACCOUNT_BASE_URL: 'http://localhost:4200', E2E_PRIVATE_RUN_DIR: '/unit/private' })});
      const parent = { ...process.env };
      registerHooks({
        resolve(specifier, context, next) {
          if (specifier === '@playwright/test') return { url: 'browser-boundary:config', shortCircuit: true };
          return next(specifier, context);
        },
        load(url, context, next) {
          if (url === 'browser-boundary:config') return { format: 'module', source: 'export const defineConfig = config => config; export const devices = { "Desktop Chrome": {} };', shortCircuit: true };
          return next(url, context);
        },
      });
      const { default: config } = await import(${JSON.stringify(configUrl)});
      assert.deepEqual(config.use.launchOptions.env, ${JSON.stringify(osEnvironment)});
      for (const project of config.projects ?? [{}]) {
        const use = { ...config.use, ...project.use };
        assert.deepEqual(use.launchOptions.env, ${JSON.stringify(osEnvironment)});
      }
      assert.deepEqual({ ...process.env }, parent);
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
      env: {}, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
