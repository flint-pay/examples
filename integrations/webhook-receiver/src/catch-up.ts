import type { Client, WebhookEvent } from '@flintpay/node';
import type { Auth } from './flint.ts';
import { describeError } from './flint.ts';
import { handledEventTypes, log, parseEnvelope, routing } from './events.ts';
import type { Inbox } from './inbox.ts';

const CURSOR = 'catch_up_cursor';
/** Each run reads back over the end of the previous one. Events that commit late are still found; the inbox drops repeats. */
export const OVERLAP_MS = 10 * 60_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

export type CatchUpDeps = { client: Client; auth: Auth; inbox: Inbox; endpointId?: string; lookbackHours: number };
export type CatchUpResult = { listed: number; recorded: number; unavailable: number; since: string };

/**
 * Finds events of the handled types that never reached this app, for example while the server was down or the
 * tunnel URL had changed, and records them in the same inbox as live deliveries.
 *
 * The list response has no payloads, so each missing event is read once more by ID. With an endpoint ID,
 * Flint lists only events that had a delivery to that endpoint.
 */
export async function catchUp(deps: CatchUpDeps, now = Date.now()): Promise<CatchUpResult> {
  const saved = Number(deps.inbox.setting(CURSOR));
  const start = Number.isFinite(saved) && saved > 0 ? saved - OVERLAP_MS : now - deps.lookbackHours * 3_600_000;
  const since = new Date(start).toISOString();
  const result: CatchUpResult = { listed: 0, recorded: 0, unavailable: 0, since };

  for (const eventType of handledEventTypes) {
    const params = {
      page_size: PAGE_SIZE,
      created_after: since,
      event_type: eventType,
      ...(deps.endpointId ? { webhook_endpoint_id: deps.endpointId } : {}),
    };
    let pages = 0;
    for await (const page of deps.client.webhookEvents.listPages(params, deps.auth.merchant())) {
      // Stop rather than move the cursor past events that were never read.
      if (++pages > MAX_PAGES) throw new Error(`More than ${MAX_PAGES * PAGE_SIZE} ${eventType} events since ${since}. Lower CATCH_UP_LOOKBACK_HOURS.`);
      for (const item of page.data) await recordMissing(deps, item, now, result);
    }
  }
  // Move the cursor only after every type was read to the end. A failed run is repeated from the same point.
  deps.inbox.saveSetting(CURSOR, String(now));
  return result;
}

async function recordMissing({ client, auth, inbox }: CatchUpDeps, item: WebhookEvent, now: number, result: CatchUpResult) {
  result.listed++;
  const existing = inbox.event(item.webhook_event_id);
  if (existing && existing.status !== 'unavailable') return;

  const detail = await client.webhookEvents.get(item.webhook_event_id, {}, auth.merchant());
  const event = parseEnvelope(detail.payload);
  if (!event || event.webhook_event_id !== item.webhook_event_id) {
    // Flint omits the payload when the key can't read the event's resource, and after 14 days.
    if (inbox.recordUnavailable({
      webhookEventId: item.webhook_event_id,
      eventType: item.event_type,
      test: item.test,
      createdAt: item.created_at,
      reason: 'Flint returned no payload. Check that the key can read this resource.',
    }, now)) result.unavailable++;
    return;
  }
  if (event.mode !== 'test') throw new Error('Catch-up found a live event. This example only reads sandbox events.');
  const route = routing(event);
  const recorded = inbox.record({
    webhookEventId: event.webhook_event_id,
    eventType: event.event_type,
    source: 'catch_up',
    test: event.test,
    payload: JSON.stringify(detail.payload),
    createdAt: event.created_at,
    process: route.process,
    ignoredReason: route.process ? undefined : route.reason,
  }, now);
  if (recorded) {
    result.recorded++;
    log({ event: 'webhook_recorded', source: 'catch_up', webhook_event_id: event.webhook_event_id, event_type: event.event_type });
  }
}

/** Runs catch-up now and then every intervalSeconds. Failures are logged and the next run tries again. */
export function scheduleCatchUp(run: () => Promise<CatchUpResult>, intervalSeconds: number, onRecorded: () => void): () => Promise<void> {
  let current: Promise<void> | undefined;
  let stopped = false;
  const tick = () => {
    if (current || stopped) return;
    current = run()
      .then((result) => {
        log({ event: 'catch_up_finished', ...result });
        if (result.recorded) onRecorded();
      })
      .catch((error: unknown) => log({ event: 'catch_up_failed', error: describeError(error) }))
      .finally(() => {
        current = undefined;
      });
  };
  tick();
  const timer = intervalSeconds > 0 ? setInterval(tick, intervalSeconds * 1000) : undefined;
  timer?.unref();
  // Stops the timer and waits for a run in progress.
  return async () => {
    stopped = true;
    clearInterval(timer);
    await current;
  };
}
