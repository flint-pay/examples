import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SdkError } from '@flintpay/node';
import type { Client, Order } from '@flintpay/node';
import { Inbox, MAX_ATTEMPTS, retryDelay } from '../../src/inbox.ts';
import { processNext, routing } from '../../src/events.ts';
import { createAuth } from '../../src/flint.ts';
import { envelope } from './support.ts';

const auth = createAuth('flint_test_unit');

function ordersClient(read: (orderId: string) => Promise<Partial<Order>>) {
  const reads: string[] = [];
  const client = { orders: { get: async (orderId: string) => (reads.push(orderId), read(orderId)) } } as unknown as Client;
  return { client, reads };
}

function recordOrderPaid(inbox: Inbox, id: string, orderId: string, now = Date.now()) {
  const event = envelope({ webhook_event_id: id, data: { order_id: orderId } });
  inbox.record({ webhookEventId: id, eventType: 'order.paid', source: 'delivery', test: false, payload: JSON.stringify(event), process: true }, now);
}

const notFound = () => new SdkError('not_found', 'Order not found', 'response', false, { status: 404, headers: {}, attempts: 1, durationMs: 1 }, 'ORDER_NOT_FOUND');
const unavailable = () => new SdkError('server', 'Unavailable', 'response', true, { status: 503, headers: {}, attempts: 3, durationMs: 1 }, 'UNAVAILABLE');

test('order.paid reads the order again and records one fulfillment per order, whatever the number of events', async () => {
  const inbox = new Inbox(':memory:');
  try {
    const { client, reads } = ordersClient(async (orderId) => ({ order_id: orderId, payment_status: 'paid' }));
    recordOrderPaid(inbox, 'whev_example_one', 'ord_example_one');
    recordOrderPaid(inbox, 'whev_example_two', 'ord_example_one');
    assert.equal(await processNext(inbox, { client, auth }), true);
    assert.equal(await processNext(inbox, { client, auth }), true);
    assert.equal(await processNext(inbox, { client, auth }), false);

    assert.deepEqual(reads, ['ord_example_one', 'ord_example_one']);
    assert.equal(inbox.event('whev_example_one')?.outcome, 'fulfillment recorded');
    assert.equal(inbox.event('whev_example_two')?.outcome, 'already fulfilled');
    assert.deepEqual(inbox.all<object>('SELECT order_id, webhook_event_id FROM fulfillments').map((row) => ({ ...row })), [{ order_id: 'ord_example_one', webhook_event_id: 'whev_example_one' }]);
  } finally {
    inbox.close();
  }
});

test('the event is a signal: an order that is not paid when read is not fulfilled', async () => {
  const inbox = new Inbox(':memory:');
  try {
    const { client } = ordersClient(async (orderId) => ({ order_id: orderId, payment_status: 'partially_paid' }));
    recordOrderPaid(inbox, 'whev_example_one', 'ord_example_one');
    await processNext(inbox, { client, auth });
    assert.equal(inbox.event('whev_example_one')?.status, 'processed');
    assert.equal(inbox.event('whev_example_one')?.outcome, 'order is partially_paid, nothing to fulfill');
    assert.equal(inbox.all('SELECT * FROM fulfillments').length, 0);
  } finally {
    inbox.close();
  }
});

test('a failed read is retried later with backoff, then marked failed after the last attempt', async () => {
  const inbox = new Inbox(':memory:');
  try {
    let now = Date.now();
    const { client } = ordersClient(async () => { throw unavailable(); });
    recordOrderPaid(inbox, 'whev_example_one', 'ord_example_one', now);
    await processNext(inbox, { client, auth }, () => now);
    let row = inbox.event('whev_example_one')!;
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    assert.match(row.last_error ?? '', /^UNAVAILABLE 503/);
    assert.ok(row.next_attempt_at >= now + 24_000, 'the retry waits');
    assert.equal(await processNext(inbox, { client, auth }, () => now), false, 'nothing is due before the retry time');

    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      now = inbox.event('whev_example_one')!.next_attempt_at;
      assert.equal(await processNext(inbox, { client, auth }, () => now), true);
    }
    row = inbox.event('whev_example_one')!;
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, MAX_ATTEMPTS);
  } finally {
    inbox.close();
  }
});

test('a failure a retry cannot fix is marked failed at once, and requeue puts it back', async () => {
  const inbox = new Inbox(':memory:');
  try {
    let read: () => Promise<Partial<Order>> = async () => { throw notFound(); };
    const { client } = ordersClient(() => read());
    recordOrderPaid(inbox, 'whev_example_one', 'ord_example_one');
    await processNext(inbox, { client, auth });
    assert.equal(inbox.event('whev_example_one')?.status, 'failed');
    assert.equal(inbox.event('whev_example_one')?.attempts, 1);

    read = async () => ({ order_id: 'ord_example_one', payment_status: 'paid' });
    assert.equal(inbox.requeue('whev_example_one'), true);
    await processNext(inbox, { client, auth });
    assert.equal(inbox.event('whev_example_one')?.status, 'processed');
  } finally {
    inbox.close();
  }
});

test('an event without an order ID fails without calling Flint', async () => {
  const inbox = new Inbox(':memory:');
  try {
    const { client, reads } = ordersClient(async () => ({}));
    const event = envelope({ data: {} });
    inbox.record({ webhookEventId: 'whev_example_one', eventType: 'order.paid', source: 'delivery', test: false, payload: JSON.stringify(event), process: true });
    await processNext(inbox, { client, auth });
    assert.equal(inbox.event('whev_example_one')?.status, 'failed');
    assert.equal(inbox.event('whev_example_one')?.last_error, 'order.paid without an order_id');
    assert.equal(reads.length, 0);
  } finally {
    inbox.close();
  }
});

test('two workers never process the same event at the same time', async () => {
  const inbox = new Inbox(':memory:');
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { client, reads } = ordersClient(async (orderId) => { await gate; return { order_id: orderId, payment_status: 'paid' }; });
    recordOrderPaid(inbox, 'whev_example_one', 'ord_example_one');
    const first = processNext(inbox, { client, auth });
    assert.equal(await processNext(inbox, { client, auth }), false, 'the event is leased to the first worker');
    release();
    await first;
    assert.equal(reads.length, 1);
  } finally {
    inbox.close();
  }
});

test('routing records test events and unknown types without processing them', () => {
  assert.deepEqual(routing({ event_type: 'order.paid', test: false }), { process: true });
  assert.deepEqual(routing({ event_type: 'order.paid', test: true }), { process: false, reason: 'test event, recorded only' });
  assert.deepEqual(routing({ event_type: 'toString', test: false }), { process: false, reason: 'no handler for this event type' });
});

test('retry delays grow from about 30 seconds to at most about an hour', () => {
  assert.equal(retryDelay(1, () => 0.5), 30_000);
  assert.equal(retryDelay(2, () => 0.5), 60_000);
  assert.equal(retryDelay(20, () => 0.5), 3_600_000);
  assert.ok(retryDelay(1, () => 0) >= 24_000 && retryDelay(1, () => 1) <= 36_000);
});
