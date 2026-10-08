import { randomBytes } from 'node:crypto';
import { invariant } from './safe.ts';

export const API_ORIGIN = 'https://api.staging.withflintpay.com';
export const SDK_VERSION = '3.0.0-beta.20261007031000';
export type Sandbox = 'A' | 'B';
export type Buyer = 'b1' | 'b2' | 'd' | 'b1b';
export type Pin = { merchantId: string; sandboxId: string; providerId: string; key: string };
export type Config = { run: string; apiOrigin: typeof API_ORIGIN; pins: Record<Sandbox, Pin>; operatorPins: Record<Sandbox, Pin>; origins: { storefrontA: string; storefrontB: string; accountA: string }; privateDir: string; fixtureFile: string; suite: 'standard' | 'extended'; inbox?: 'imap' | 'operator'; inboxAddress: string; targetCommit: string; apiCommit: string; builds: Record<string, string>; healthPaths?: Record<string, string>; apply: boolean };

export function origin(value: string): string {
  const url = new URL(value);
  invariant(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash && ['http:', 'https:'].includes(url.protocol), 'INVALID_APP_ORIGIN');
  invariant(!/(^|\.)withflintpay\.com$/i.test(url.hostname), 'FLINT_APP_ORIGIN_FORBIDDEN');
  invariant(url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'APP_HTTPS_REQUIRED');
  return url.origin;
}
export function pinApiOrigin(value: string | undefined): typeof API_ORIGIN {
  invariant(value === API_ORIGIN, 'STAGING_ORIGIN_REQUIRED');
  return API_ORIGIN;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env, apply = false): Config {
  const apiOrigin = pinApiOrigin(env.E2E_FLINT_API_BASE_URL);
  const required = (name: string): string => { const v = env[name]; invariant(v && !v.includes('<') && !v.includes('PLACEHOLDER'), 'CONFIG_REQUIRED'); return v; };
  const pins = Object.fromEntries((['A', 'B'] as const).map(s => {
    const key = required(`E2E_SANDBOX_${s}_API_KEY`);
    invariant(/^flint_test_[A-Za-z0-9_-]+$/.test(key), 'TEST_KEY_REQUIRED');
    return [s, { key, merchantId: required(`E2E_SANDBOX_${s}_MERCHANT_ID`), sandboxId: required(`E2E_SANDBOX_${s}_ID`), providerId: required(`E2E_SANDBOX_${s}_PROVIDER_ID`) }];
  })) as Record<Sandbox, Pin>;
  invariant(pins.A.sandboxId !== pins.B.sandboxId && pins.A.key !== pins.B.key, 'TWO_DISTINCT_SANDBOXES_REQUIRED');
  const operatorA = required('E2E_OPERATOR_A_API_KEY');
  const operatorB = env.E2E_OPERATOR_B_API_KEY || pins.B.key;
  invariant([operatorA, operatorB].every(k => /^flint_test_[A-Za-z0-9_-]+$/.test(k)), 'OPERATOR_TEST_KEY_REQUIRED');
  invariant(operatorA !== pins.A.key && operatorA !== pins.B.key, 'OPERATOR_APP_KEY_SEPARATION_REQUIRED');
  const operatorPins = { A: { ...pins.A, key: operatorA }, B: { ...pins.B, key: operatorB } };
  const run = env.E2E_RUN_ID ?? `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}-${randomBytes(4).toString('hex')}`;
  invariant(/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(run), 'INVALID_RUN_ID');
  const inbox = env.E2E_INBOX;
  invariant(!inbox || ['imap', 'operator'].includes(inbox), 'INVALID_INBOX_MODE');
  const suite = env.E2E_SUITE ?? 'standard';
  invariant(suite === 'standard' || suite === 'extended', 'INVALID_SUITE');
  const targetCommit = required('E2E_TARGET_COMMIT');
  invariant(/^[a-f0-9]{40}$/.test(targetCommit), 'TARGET_COMMIT_REQUIRED');
  const apiCommit = required('E2E_API_TARGET_COMMIT'); invariant(/^[a-f0-9]{40}$/.test(apiCommit), 'API_TARGET_COMMIT_REQUIRED');
  return { run, apiOrigin, pins, operatorPins, suite, apply, inbox: inbox as Config['inbox'], inboxAddress: env.E2E_INBOX_ADDRESS ?? '',
    privateDir: required('E2E_PRIVATE_RUN_DIR'), fixtureFile: required('E2E_FIXTURE_FILE'), targetCommit, apiCommit,
    origins: { storefrontA: origin(env.E2E_STOREFRONT_A_ORIGIN ?? 'http://localhost:4100'), storefrontB: origin(env.E2E_STOREFRONT_B_ORIGIN ?? 'http://localhost:4110'), accountA: origin(env.E2E_ACCOUNT_A_ORIGIN ?? 'http://localhost:4200') },
    healthPaths: { storefrontA: env.E2E_STOREFRONT_A_HEALTH_PATH ?? '/healthz', storefrontB: env.E2E_STOREFRONT_B_HEALTH_PATH ?? '/healthz', accountA: env.E2E_ACCOUNT_A_HEALTH_PATH ?? '/healthz', api: env.E2E_API_HEALTH_PATH ?? '/health' },
    builds: { storefrontA: required('E2E_STOREFRONT_A_ARTIFACT_ID'), storefrontB: required('E2E_STOREFRONT_B_ARTIFACT_ID'), accountA: required('E2E_ACCOUNT_A_ARTIFACT_ID'), api: required('E2E_API_ARTIFACT_ID') } };
}
export function alias(config: Pick<Config, 'inboxAddress' | 'run'>, role: Buyer): string {
  const parts = config.inboxAddress.split('@');
  invariant(parts.length === 2 && /^[a-zA-Z0-9._+-]+$/.test(parts[0]) && /^[a-zA-Z0-9.-]+$/.test(parts[1]), 'INBOX_ADDRESS_REQUIRED');
  return `${parts[0]}+fx-${config.run}-${role}@${parts[1]}`;
}
