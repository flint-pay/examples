import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, API_ORIGIN } from '../../support/config.ts';
import { appEnvironment } from '../../support/app-environment.ts';
import { VerifiedClients } from '../../support/sdk.ts';
import type { Fixtures } from '../../support/fixtures.ts';

// Synthetic values for pure configuration and injected-client checks only.
function environment(): NodeJS.ProcessEnv { return {
  E2E_FLINT_API_BASE_URL: API_ORIGIN, E2E_SANDBOX_A_API_KEY: 'flint_test_UNIT_APP_A_FAKE', E2E_SANDBOX_B_API_KEY: 'flint_test_UNIT_APP_B_FAKE', E2E_OPERATOR_A_API_KEY: 'flint_test_UNIT_OPERATOR_A_FAKE',
  E2E_SANDBOX_A_ID: 'test_UNIT_A', E2E_SANDBOX_B_ID: 'test_UNIT_B', E2E_SANDBOX_A_MERCHANT_ID: 'mer_UNIT', E2E_SANDBOX_B_MERCHANT_ID: 'mer_UNIT', E2E_SANDBOX_A_PROVIDER_ID: 'acct_UNIT_A', E2E_SANDBOX_B_PROVIDER_ID: 'acct_UNIT_B',
  E2E_RUN_ID: '20000101T000000Z-00000000', E2E_TARGET_COMMIT: '0'.repeat(40), E2E_API_TARGET_COMMIT: '1'.repeat(40), E2E_STOREFRONT_A_ARTIFACT_ID: 'UNIT_SF_A', E2E_STOREFRONT_B_ARTIFACT_ID: 'UNIT_SF_B', E2E_ACCOUNT_A_ARTIFACT_ID: 'UNIT_AC_A', E2E_API_ARTIFACT_ID: 'UNIT_API', E2E_PRIVATE_RUN_DIR: '/tmp/unit-private', E2E_FIXTURE_FILE: '/tmp/unit-private/fixture.json',
}; }
test('operator A must be distinct from both narrow app keys and cannot be live', () => {
  const env = environment(), c = loadConfig(env); assert.notEqual(c.operatorPins.A.key, c.pins.A.key);
  for (const key of [env.E2E_SANDBOX_A_API_KEY, env.E2E_SANDBOX_B_API_KEY, 'flint_live_UNIT_OPERATOR_FAKE']) assert.throws(() => loadConfig({ ...env, E2E_OPERATOR_A_API_KEY: key }));
});
test('app process environments contain only their narrow keys with separate sandbox identity stores', () => {
  const c = loadConfig(environment()), f = { values: {} } as Fixtures;
  for (const sandbox of ['A', 'B'] as const) {
    const app = { name: sandbox === 'A' ? 'accountA' : 'storefrontB', app: sandbox === 'A' ? 'account' : 'storefront', sandbox, origin: sandbox === 'A' ? c.origins.accountA : c.origins.storefrontB, identity: `identity-${sandbox}.sqlite`, cookie: sandbox === 'A' ? 'cedar_session' : 'cedar_session_b' };
    const env = appEnvironment(c, f, '/tmp/unit-private', 'whsec_UNIT_FAKE', app);
    assert.equal(env.FLINT_API_KEY, c.pins[sandbox].key); assert.equal(env.FLINT_SANDBOX_ID, c.pins[sandbox].sandboxId); assert.equal(Object.values(env).includes(c.operatorPins.A.key), false); assert.equal('E2E_OPERATOR_A_API_KEY' in env, false);
    assert.equal(env.IDENTITY_DATABASE_PATH, `/tmp/unit-private/identity-${sandbox}.sqlite`);
  }
});
test('operator and app contexts are verified independently and privileged app scopes fail', async () => {
  const c = loadConfig(environment()), f = { readiness: { A: { ...c.pins.A, mode: 'test' }, B: { ...c.pins.B, mode: 'test' } } } as unknown as Fixtures;
  const clients = new VerifiedClients(c, f), context = { environment: 'sandbox', auth_type: 'api_key', merchant_id: c.pins.A.merchantId, sandbox_id: c.pins.A.sandboxId, scopes: [] as string[] };
  const seen: string[] = []; clients.clients.A = { developer: { getAuthContext: async () => { seen.push('operator'); return context; } } } as any;
  clients.appClients.A = { developer: { getAuthContext: async () => { seen.push('app'); return context; } } } as any;
  await clients.verifyContext('A'); assert.deepEqual(seen, ['operator', 'app']);
  clients.appClients.A = { developer: { getAuthContext: async () => ({ ...context, scopes: ['commerce.gift_cards.secrets.write'] }) } } as any;
  await assert.rejects(() => clients.verifyContext('A'), { message: 'APP_PRIVILEGED_GIFT_SCOPE_FORBIDDEN' });
  clients.appClients.A = { developer: { getAuthContext: async () => ({ ...context, sandbox_id: 'test_UNIT_FOREIGN' }) } } as any;
  await assert.rejects(() => clients.verifyContext('A'), { message: 'APP_CREDENTIAL_CONTEXT_MISMATCH' });
});
