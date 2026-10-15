import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../../src/config.ts';
import { createAuth, createClient, preflight } from '../../src/flint.ts';
import { Inbox } from '../../src/inbox.ts';
import { catchUp } from '../../src/catch-up.ts';
import { parseEnvelope } from '../../src/events.ts';
import { deliveryAttempts, failedDeliveries, sendTestEvent } from '../../src/deliveries.ts';

// These tests call the sandbox in .env. They read events and deliveries, and, when FLINT_WEBHOOK_ENDPOINT_ID is
// set, send one test event to that endpoint. They don't create or change endpoints. Nothing is mocked.
test('webhook APIs against the configured sandbox', { timeout: 120_000 }, async (t) => {
  const config = readConfig();
  if (!config.sandboxGuard) throw new Error('Set FLINT_SANDBOX_ID to the sandbox these tests may call.');
  const client = createClient(config.apiBaseUrl, config.sandboxGuard);
  const auth = createAuth(config.apiKey);
  assert.equal((await preflight(client, auth, config.sandboxGuard)).sandboxId, config.sandboxGuard);
  const inbox = new Inbox(':memory:');

  try {
    await t.test('catch-up reads stored payloads that parse as event envelopes', async () => {
      const result = await catchUp({ client, auth, inbox, endpointId: config.endpointId, lookbackHours: config.catchUpLookbackHours });
      assert.equal(result.listed >= result.recorded + result.unavailable, true);
      for (const row of inbox.all<{ payload: string | null; status: string }>('SELECT payload, status FROM events')) {
        if (row.status === 'unavailable') continue;
        const event = parseEnvelope(JSON.parse(row.payload!));
        assert.ok(event, 'a stored payload is a full event envelope');
        assert.equal(event.mode, 'test');
      }
    });

    await t.test('failed deliveries can be listed with their attempts', async () => {
      const found = await failedDeliveries({ client, auth }, { endpointId: config.endpointId, since: new Date(Date.now() - 72 * 3_600_000), limit: 3 });
      for (const { delivery } of found) {
        assert.equal(delivery.status, 'failed');
        const attempts = await deliveryAttempts({ client, auth }, delivery.webhook_delivery_id);
        assert.ok(attempts.length > 0);
      }
    });

    await t.test('a test event is sent to the configured endpoint', { skip: !config.endpointId && 'FLINT_WEBHOOK_ENDPOINT_ID is not set' }, async () => {
      const action = await sendTestEvent({ client, auth }, config.endpointId!, 'order.paid');
      assert.ok(action.webhook_event_id);
      assert.ok(['queued', 'sending', 'delivered', 'failed'].includes(action.attempt_status));
    });
  } finally {
    inbox.close();
  }
});
