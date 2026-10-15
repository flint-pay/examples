import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Inbox } from '../../src/inbox.ts';
import { receive } from '../../src/receive.ts';
import { createApp } from '../../src/app.ts';
import { envelope, newSecret, sdk, signed } from './support.ts';

const client = sdk();

test('a verified event is recorded once, and a repeated delivery is acknowledged as a duplicate', () => {
  const inbox = new Inbox(':memory:');
  try {
    const secret = newSecret();
    const body = JSON.stringify(envelope());
    const first = signed(body, secret);
    assert.deepEqual(receive(first.raw, first.headers, { client, inbox, secrets: [secret] }), { status: 200, body: { received: true, duplicate: false }, recorded: true });
    // A retry carries the same event ID with a new timestamp and signature.
    const retry = signed(body, secret, { timestamp: Math.floor(Date.now() / 1000) + 5 });
    assert.deepEqual(receive(retry.raw, retry.headers, { client, inbox, secrets: [secret] }).body, { received: true, duplicate: true });
    const row = inbox.event('whev_example_one');
    assert.equal(row?.status, 'pending');
    assert.equal(row?.source, 'delivery');
    assert.equal(row?.payload, body);
    assert.equal(inbox.all('SELECT * FROM events').length, 1);
  } finally {
    inbox.close();
  }
});

test('the signature must match the original bytes, the secret, and a recent timestamp', () => {
  const inbox = new Inbox(':memory:');
  try {
    const secret = newSecret();
    const body = JSON.stringify(envelope(), null, 2);
    const original = signed(body, secret);
    const deps = { client, inbox, secrets: [secret] };

    // The same JSON, re-serialized after parsing, is different bytes.
    const reserialized = new TextEncoder().encode(JSON.stringify(JSON.parse(body)));
    assert.equal(receive(reserialized, original.headers, deps).status, 400);
    const tampered = new TextEncoder().encode(body.replace('ord_example_one', 'ord_example_two'));
    assert.equal(receive(tampered, original.headers, deps).status, 400);
    assert.equal(receive(original.raw, original.headers, { ...deps, secrets: [newSecret()] }).status, 400);
    const stale = signed(body, secret, { timestamp: Math.floor(Date.now() / 1000) - 600 });
    assert.equal(receive(stale.raw, stale.headers, deps).status, 400);
    const unsigned = new Headers(original.headers);
    unsigned.delete('webhook-signature');
    assert.equal(receive(original.raw, unsigned, deps).status, 400);

    assert.equal(inbox.all('SELECT * FROM events').length, 0);
    assert.equal(receive(original.raw, original.headers, deps).status, 200);
  } finally {
    inbox.close();
  }
});

test('during a rotation, deliveries signed with the previous secret are accepted', () => {
  const inbox = new Inbox(':memory:');
  try {
    const current = newSecret();
    const previous = newSecret();
    const delivery = signed(JSON.stringify(envelope()), previous);
    assert.equal(receive(delivery.raw, delivery.headers, { client, inbox, secrets: [current, previous] }).status, 200);
    assert.equal(receive(delivery.raw, delivery.headers, { client, inbox, secrets: [current] }).status, 400);
  } finally {
    inbox.close();
  }
});

test('live events, mismatched IDs, and bodies that are not Flint events are refused', () => {
  const inbox = new Inbox(':memory:');
  try {
    const secret = newSecret();
    const deps = { client, inbox, secrets: [secret] };
    const live = signed(JSON.stringify(envelope({ mode: 'live' })), secret);
    assert.deepEqual(receive(live.raw, live.headers, deps).body, { error: 'live_event_refused' });
    const mismatch = signed(JSON.stringify(envelope()), secret, { id: 'whev_example_other' });
    assert.deepEqual(receive(mismatch.raw, mismatch.headers, deps).body, { error: 'invalid_event' });
    const notAnEvent = signed(JSON.stringify({ webhook_event_id: 'whev_example_one', hello: 'world' }), secret);
    assert.deepEqual(receive(notAnEvent.raw, notAnEvent.headers, deps).body, { error: 'invalid_event' });
    assert.equal(inbox.all('SELECT * FROM events').length, 0);
  } finally {
    inbox.close();
  }
});

test('unhandled event types and test events get a 2xx and are recorded without processing', () => {
  const inbox = new Inbox(':memory:');
  try {
    const secret = newSecret();
    const deps = { client, inbox, secrets: [secret] };
    const other = signed(JSON.stringify(envelope({ webhook_event_id: 'whev_example_refund', event_type: 'refund.updated', data: {} })), secret);
    assert.equal(receive(other.raw, other.headers, deps).status, 200);
    assert.equal(inbox.event('whev_example_refund')?.status, 'ignored');
    assert.equal(inbox.event('whev_example_refund')?.outcome, 'no handler for this event type');

    const fixture = signed(JSON.stringify(envelope({ webhook_event_id: 'whev_example_test', test: true })), secret);
    assert.equal(receive(fixture.raw, fixture.headers, deps).status, 200);
    assert.equal(inbox.event('whev_example_test')?.status, 'ignored');
    assert.equal(inbox.event('whev_example_test')?.test, 1);
  } finally {
    inbox.close();
  }
});

test('the app exposes only the webhook route and a health check, and refuses oversized bodies before reading them', async () => {
  const inbox = new Inbox(':memory:');
  try {
    const secret = newSecret();
    let kicks = 0;
    const app = createApp({ client, inbox, secrets: [secret], onRecorded: () => kicks++ });
    const delivery = signed(JSON.stringify(envelope()), secret);
    const post = () => app.request('http://localhost/webhooks/flint', { method: 'POST', headers: delivery.headers, body: delivery.raw });
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 200);
    assert.equal(kicks, 1, 'only a newly recorded event wakes the worker');

    const large = await app.request('http://localhost/webhooks/flint', { method: 'POST', headers: { 'content-length': String(2 * 1024 * 1024) }, body: 'x' });
    assert.equal(large.status, 413);
    assert.deepEqual(await (await app.request('http://localhost/healthz')).json(), { ok: true, mode: 'test' });
    assert.equal((await app.request('http://localhost/')).status, 404);
    assert.equal((await app.request('http://localhost/webhooks/flint')).status, 404);
  } finally {
    inbox.close();
  }
});
