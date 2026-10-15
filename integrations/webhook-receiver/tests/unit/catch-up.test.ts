import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SdkError } from '@flintpay/node';
import type { Client, WebhookEvent } from '@flintpay/node';
import { Inbox } from '../../src/inbox.ts';
import { catchUp, OVERLAP_MS } from '../../src/catch-up.ts';
import { resendDelivery } from '../../src/deliveries.ts';
import { receive } from '../../src/receive.ts';
import { createAuth } from '../../src/flint.ts';
import { envelope, newSecret, sdk, signed } from './support.ts';

const auth = createAuth('flint_test_unit');

const listed = (id: string): WebhookEvent => ({
  webhook_event_id: id,
  event_type: 'order.paid',
  created_at: '2026-10-15T12:00:00Z',
  event_origin: 'business_event',
  test: false,
  resource_type: 'order',
}) as WebhookEvent;

/** A stand-in for the events API: listed events in pages, and payloads by ID. */
function eventsClient(pages: WebhookEvent[][], payloads: Record<string, unknown>) {
  const listCalls: Record<string, unknown>[] = [];
  const reads: string[] = [];
  const client = {
    webhookEvents: {
      listPages: async function* (params: Record<string, unknown>) {
        listCalls.push(params);
        for (const data of pages) yield { data };
      },
      get: async (id: string) => (reads.push(id), { ...listed(id), payload: payloads[id] }),
    },
  } as unknown as Client;
  return { client, listCalls, reads };
}

test('catch-up records missed events from their stored payloads and skips events already recorded', async () => {
  const inbox = new Inbox(':memory:');
  try {
    const now = Date.parse('2026-10-15T13:00:00Z');
    inbox.record({ webhookEventId: 'whev_example_seen', eventType: 'order.paid', source: 'delivery', test: false, payload: JSON.stringify(envelope({ webhook_event_id: 'whev_example_seen' })), process: true });
    const { client, listCalls, reads } = eventsClient(
      [[listed('whev_example_seen'), listed('whev_example_missed')], [listed('whev_example_hidden')]],
      { whev_example_missed: envelope({ webhook_event_id: 'whev_example_missed' }) },
    );
    const result = await catchUp({ client, auth, inbox, endpointId: 'we_example', lookbackHours: 72 }, now);

    assert.deepEqual(result, { listed: 3, recorded: 1, unavailable: 1, since: '2026-10-12T13:00:00.000Z' });
    assert.deepEqual(listCalls, [{ page_size: 100, created_after: '2026-10-12T13:00:00.000Z', event_type: 'order.paid', webhook_endpoint_id: 'we_example' }]);
    assert.deepEqual(reads, ['whev_example_missed', 'whev_example_hidden'], 'only events missing here are read by ID');
    assert.equal(inbox.event('whev_example_missed')?.source, 'catch_up');
    assert.equal(inbox.event('whev_example_missed')?.status, 'pending');
    assert.equal(inbox.event('whev_example_hidden')?.status, 'unavailable');

    // The next run starts where this one ended, less the overlap.
    const next = eventsClient([], {});
    const second = await catchUp({ client: next.client, auth, inbox, lookbackHours: 72 }, now + 60_000);
    assert.equal(second.since, new Date(now - OVERLAP_MS).toISOString());
    assert.equal(next.listCalls[0]?.webhook_endpoint_id, undefined);
  } finally {
    inbox.close();
  }
});

test('an event catch-up could not read is filled in by a later delivery', () => {
  const inbox = new Inbox(':memory:');
  try {
    inbox.recordUnavailable({ webhookEventId: 'whev_example_one', eventType: 'order.paid', test: false, reason: 'no payload' });
    const secret = newSecret();
    const delivery = signed(JSON.stringify(envelope()), secret);
    assert.deepEqual(receive(delivery.raw, delivery.headers, { client: sdk(), inbox, secrets: [secret] }).body, { received: true, duplicate: false });
    const row = inbox.event('whev_example_one');
    assert.equal(row?.status, 'pending');
    assert.equal(row?.source, 'delivery');
    assert.equal(row?.last_error, null);
  } finally {
    inbox.close();
  }
});

test('a failed run leaves the cursor where it was, so the next run reads the same events again', async () => {
  const inbox = new Inbox(':memory:');
  try {
    const now = Date.parse('2026-10-15T13:00:00Z');
    const failing = {
      webhookEvents: {
        listPages: async function* () {
          yield { data: [] };
          throw new Error('connection reset');
        },
      },
    } as unknown as Client;
    await assert.rejects(catchUp({ client: failing, auth, inbox, lookbackHours: 1 }, now), /connection reset/);
    assert.equal(inbox.setting('catch_up_cursor'), undefined);
  } finally {
    inbox.close();
  }
});

test('catch-up refuses a live event', async () => {
  const inbox = new Inbox(':memory:');
  try {
    const { client } = eventsClient([[listed('whev_example_one')]], { whev_example_one: envelope({ mode: 'live' }) });
    await assert.rejects(catchUp({ client, auth, inbox, lookbackHours: 1 }), /live event/);
    assert.equal(inbox.event('whev_example_one'), undefined);
  } finally {
    inbox.close();
  }
});

test('a resend reuses its saved idempotency key when the answer was lost, and gets a new key after Flint answers', async () => {
  const inbox = new Inbox(':memory:');
  try {
    const keys: string[] = [];
    let lose = true;
    const client = {
      webhookDeliveries: {
        resend: async (_id: string, _params: unknown, options: { idempotencyKey: string }) => {
          keys.push(options.idempotencyKey);
          if (lose) throw new SdkError('transport', 'socket hang up', 'unknown', true);
          return { webhook_event_id: 'whev_example_one', attempt_number: 2, attempt_status: 'delivered', delivery_status: 'delivered' };
        },
      },
    } as unknown as Client;

    await assert.rejects(resendDelivery({ client, auth }, inbox, 'whdel_example', 'endpoint fixed'));
    lose = false;
    await resendDelivery({ client, auth }, inbox, 'whdel_example');
    await resendDelivery({ client, auth }, inbox, 'whdel_example');
    assert.equal(keys[0], keys[1], 'the retry replays the first request');
    assert.notEqual(keys[1], keys[2], 'a later resend is a new request');
    assert.equal(inbox.all('SELECT * FROM resends').length, 0);
  } finally {
    inbox.close();
  }
});
