import { runtime } from '@/server/runtime.ts';

type Event = Record<string, unknown>;
const record = (value: unknown): Event => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Event) : {});

// Optional. The checkout never waits for webhooks; a verified order.paid adds a line to the confirmation,
// and checkout_session.invalidated marks the session for replacement on the next read.
export async function POST(request: Request) {
  const { client, config, store } = await runtime();
  if (!config.webhookSecret) return new Response(null, { status: 404 });
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > 65536) return Response.json({ error: 'too_large' }, { status: 413 });
  let event: Event;
  try {
    event = record(client.verifyWebhook(raw, request.headers, config.webhookSecret).event);
  } catch {
    return Response.json({ error: 'invalid_signature' }, { status: 400 });
  }
  if (event.mode !== 'test') return Response.json({ error: 'invalid_mode' }, { status: 400 });
  const eventId = request.headers.get('webhook-id');
  if (!eventId || typeof event.event_type !== 'string') return Response.json({ error: 'invalid_event' }, { status: 400 });
  const type = event.event_type;
  // payload_version 2 carries the resource in data.object; events queued before it still put the fields in data.
  const data = event.payload_version === undefined || event.payload_version === 1 ? record(event.data) : record(record(event.data).object);
  const objectId = data[`${type.split('.')[0]}_id`];
  store.transaction(() => {
    const inserted = store.run('INSERT OR IGNORE INTO webhook_events VALUES(?,?,?,?)', eventId, type, typeof objectId === 'string' ? objectId : null, Date.now());
    if (inserted.changes !== 1) return;
    if (type === 'order.paid' && typeof data.order_id === 'string') store.run('INSERT OR IGNORE INTO order_signals VALUES(?,?)', data.order_id, Date.now());
    if (type === 'checkout_session.invalidated' && typeof data.checkout_session_id === 'string') store.run('UPDATE checkouts SET needs_replacement=1 WHERE checkout_session_id=?', data.checkout_session_id);
  });
  return Response.json({ received: true });
}
