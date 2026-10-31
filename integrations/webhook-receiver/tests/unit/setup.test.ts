import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebhookEndpoint } from '@flintpay/node';
import { readConfig, validSigningSecret } from '../../src/config.ts';
import { updateEnvFile } from '../../src/env-file.ts';
import { planSetup } from '../../scripts/setup.ts';
import { newSecret } from './support.ts';

const base = { FLINT_API_KEY: 'flint_test_unit', FLINT_API_BASE_URL: 'https://api.staging.withflintpay.com', PORT: '4500' };
const url = 'https://receiver.example.com/webhooks/flint';
const endpoint = (overrides: Partial<WebhookEndpoint> = {}): WebhookEndpoint => ({
  webhook_endpoint_id: 'we_example', url, status: 'active', enabled_events: ['order.paid'], api_version: 'default', version: '1', signing_methods: ['hmac'], ...overrides,
});

test('config refuses live keys, malformed secrets, and a lookback longer than Flint keeps payloads', () => {
  assert.throws(() => readConfig({ ...base, FLINT_API_KEY: 'flint_live_unit' }), /live credentials are refused/);
  assert.throws(() => readConfig({ ...base, FLINT_WEBHOOK_SECRET: 'whsec_short' }), /FLINT_WEBHOOK_SECRET/);
  assert.throws(() => readConfig({ ...base, FLINT_WEBHOOK_PREVIOUS_SECRET: newSecret() }), /set FLINT_WEBHOOK_SECRET/);
  assert.throws(() => readConfig({ ...base, CATCH_UP_LOOKBACK_HOURS: '400' }), /CATCH_UP_LOOKBACK_HOURS/);
  assert.throws(() => readConfig({ ...base, WEBHOOK_URL: 'http://localhost:4500/webhooks/flint' }), /WEBHOOK_URL/);
  assert.throws(() => readConfig({ ...base, FLINT_API_BASE_URL: 'https://example.com' }), /FLINT_API_BASE_URL/);

  const current = newSecret();
  const previous = newSecret();
  const config = readConfig({ ...base, FLINT_WEBHOOK_SECRET: current, FLINT_WEBHOOK_PREVIOUS_SECRET: previous, WEBHOOK_URL: url });
  assert.deepEqual(config.webhookSecrets, [current, previous]);
  assert.equal(config.catchUpIntervalSeconds, 300);
  assert.equal(config.catchUpLookbackHours, 72);
  assert.deepEqual(readConfig(base).webhookSecrets, []);
});

test('a signing secret is whsec_ and the canonical base64 of 32 bytes', () => {
  assert.equal(validSigningSecret(newSecret()), true);
  assert.equal(validSigningSecret(newSecret().replace('whsec_', 'whsek_')), false);
  assert.equal(validSigningSecret(`whsec_${Buffer.alloc(16).toString('base64')}`), false);
});

test('setup creates an endpoint for the handled events when none matches', () => {
  assert.deepEqual(planSetup({ url, hasSecret: false, rotate: false }), [{ kind: 'create', url, events: ['order.paid'] }]);
});

test('setup updates the URL of the saved endpoint instead of creating a second one', () => {
  const steps = planSetup({ endpoint: endpoint({ url: 'https://old-tunnel.example.com/webhooks/flint' }), url, savedEndpointId: 'we_example', hasSecret: true, rotate: false });
  assert.deepEqual(steps, [{ kind: 'update', changes: { url } }]);
});

test('setup adds missing event types, keeps an all-events subscription, and enables a disabled endpoint', () => {
  assert.deepEqual(planSetup({ endpoint: endpoint({ enabled_events: ['refund.updated'], status: 'inactive' }), url, savedEndpointId: 'we_example', hasSecret: true, rotate: false }),
    [{ kind: 'update', changes: { enabled_events: ['refund.updated', 'order.paid'], status: 'active', expected_version: '1' } }]);
  assert.deepEqual(planSetup({ endpoint: endpoint({ enabled_events: ['*'] }), url, savedEndpointId: 'we_example', hasSecret: true, rotate: false }), []);
});

test('an endpoint found by URL needs a secret saved for it, which only rotation can provide', () => {
  assert.deepEqual(planSetup({ endpoint: endpoint(), url, hasSecret: true, rotate: false }), [{ kind: 'save_endpoint_id' }, { kind: 'needs_secret' }]);
  assert.deepEqual(planSetup({ endpoint: endpoint(), url, hasSecret: false, rotate: true }), [{ kind: 'save_endpoint_id' }, { kind: 'rotate' }]);
  assert.deepEqual(planSetup({ endpoint: endpoint(), url, savedEndpointId: 'we_example', hasSecret: true, rotate: true }), [{ kind: 'rotate' }]);
});

test('updating .env replaces and removes only the named lines and keeps the file private', () => {
  const directory = mkdtempSync(join(tmpdir(), 'webhook-env-'));
  try {
    const path = join(directory, '.env');
    writeFileSync(path, '# comment\nFLINT_API_KEY=flint_test_unit\nFLINT_WEBHOOK_SECRET=old\nFLINT_WEBHOOK_PREVIOUS_SECRET=older\n', { mode: 0o644 });
    updateEnvFile(path, { FLINT_WEBHOOK_SECRET: 'new', FLINT_WEBHOOK_PREVIOUS_SECRET: null, FLINT_WEBHOOK_ENDPOINT_ID: 'we_example' });
    assert.equal(readFileSync(path, 'utf8'), '# comment\nFLINT_API_KEY=flint_test_unit\nFLINT_WEBHOOK_SECRET=new\nFLINT_WEBHOOK_ENDPOINT_ID=we_example\n');
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
