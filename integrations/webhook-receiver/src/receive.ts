import { SdkError } from '@flintpay/node';
import type { Client } from '@flintpay/node';
import { parseEnvelope, routing, log } from './events.ts';
import type { Inbox } from './inbox.ts';

export const MAX_BODY_BYTES = 1024 * 1024;

export type Received = { status: number; body: Record<string, unknown>; recorded?: boolean };

/**
 * Verify, deduplicate, record, acknowledge. Nothing slow happens here: Flint waits at most 10 seconds for a 2xx,
 * so the work itself runs later from the inbox. A 2xx is returned only after the event is committed, so a crash
 * before that point makes Flint deliver it again.
 */
export function receive(rawBody: Uint8Array, headers: Headers, deps: { client: Client; inbox: Inbox; secrets: readonly string[] }): Received {
  if (rawBody.byteLength > MAX_BODY_BYTES) return { status: 413, body: { error: 'too_large' } };

  let verified: unknown;
  try {
    // Verify the bytes exactly as they arrived. Parsing and re-serializing the JSON first breaks the signature.
    verified = deps.client.verifyWebhook(rawBody, headers, deps.secrets).event;
  } catch (error) {
    if (!(error instanceof SdkError)) throw error;
    // Record only the reason. The body, the headers, and the secret stay out of logs.
    log({ event: 'webhook_rejected', kind: error.kind, code: error.code });
    return { status: 400, body: { error: 'invalid_signature' } };
  }

  const event = parseEnvelope(verified);
  if (!event) {
    log({ event: 'webhook_rejected', code: 'not_a_flint_event' });
    return { status: 400, body: { error: 'invalid_event' } };
  }
  // The signature covers the webhook-id header and the body, and Flint sets both to the same ID.
  const headerId = headers.get('webhook-id');
  if (headerId && headerId !== event.webhook_event_id) {
    log({ event: 'webhook_rejected', code: 'event_id_mismatch', webhook_event_id: event.webhook_event_id });
    return { status: 400, body: { error: 'invalid_event' } };
  }
  // This example runs against a sandbox only. A live event means the endpoint is registered in the wrong mode.
  if (event.mode !== 'test') {
    log({ event: 'webhook_rejected', code: 'live_event_refused', webhook_event_id: event.webhook_event_id });
    return { status: 400, body: { error: 'live_event_refused' } };
  }

  const route = routing(event);
  const recorded = deps.inbox.record({
    webhookEventId: event.webhook_event_id,
    eventType: event.event_type,
    source: 'delivery',
    test: event.test,
    payload: Buffer.from(rawBody).toString('utf8'),
    createdAt: event.created_at,
    process: route.process,
    ignoredReason: route.process ? undefined : route.reason,
  });
  log({
    event: recorded ? 'webhook_recorded' : 'webhook_duplicate',
    webhook_event_id: event.webhook_event_id,
    event_type: event.event_type,
    ...(route.process ? {} : { ignored: route.reason }),
  });
  // Duplicates and event types without a handler still get a 2xx. Anything else makes Flint retry for days.
  return { status: 200, body: { received: true, duplicate: !recorded }, recorded };
}
