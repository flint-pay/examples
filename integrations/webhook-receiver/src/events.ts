import { SdkError } from '@flintpay/node';
import type { Client } from '@flintpay/node';
import type { Auth } from './flint.ts';
import { describeError } from './flint.ts';
import type { Inbox } from './inbox.ts';

/** The fields of the Flint event envelope this app reads. Unknown fields are kept in the stored payload. */
export type Envelope = {
  webhook_event_id: string;
  event_type: string;
  mode: string;
  test: boolean;
  created_at?: string;
  payload_version: number;
  data: Record<string, unknown>;
  /** The affected resource: data.object from payload_version 2, or data itself on older events. */
  resource: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Returns the envelope, or undefined when the JSON is not a Flint event. */
export function parseEnvelope(value: unknown): Envelope | undefined {
  if (!isRecord(value) || !isRecord(value.data)) return undefined;
  const { webhook_event_id: id, event_type: type, mode, test, created_at: createdAt } = value;
  if (typeof id !== 'string' || !id || typeof type !== 'string' || !type || typeof mode !== 'string') return undefined;
  if (test !== undefined && typeof test !== 'boolean') return undefined;
  // payload_version 2 carries the resource, as its GET returns it, in data.object. Events Flint queued before
  // that change still arrive as version 1, with the fields directly in data.
  const version = typeof value.payload_version === 'number' ? value.payload_version : 1;
  const resource = version >= 2 ? value.data.object : value.data;
  if (!isRecord(resource)) return undefined;
  return {
    webhook_event_id: id,
    event_type: type,
    mode,
    test: test === true,
    created_at: typeof createdAt === 'string' ? createdAt : undefined,
    payload_version: version,
    data: value.data,
    resource,
  };
}

/** A handler that failed for a reason a retry can't fix. The event is marked failed for review. */
export class PermanentError extends Error {}

export type HandlerContext = { client: Client; auth: Auth };
/**
 * A handler reads what it needs from Flint first, then returns the database writes to run. The writes run in
 * the same transaction that marks the event processed, so a crash can't record one without the other.
 * The returned string is the outcome shown by `npm run webhooks -- status`.
 */
export type Handler = (event: Envelope, context: HandlerContext) => Promise<(inbox: Inbox) => string>;

/**
 * One event drives fulfillment: order.paid covers every payment path. Treat the event as a signal and read the
 * order again, because events can arrive late, twice, or out of order.
 */
export const handlers = {
  'order.paid': async (event, { client, auth }) => {
    const orderId = event.resource.order_id;
    if (typeof orderId !== 'string' || !orderId) throw new PermanentError('order.paid without an order_id');
    const order = await client.orders.get(orderId, {}, auth.merchant());
    return (inbox) => {
      if (order.payment_status !== 'paid') return `order is ${order.payment_status}, nothing to fulfill`;
      return inbox.addFulfillment(order.order_id, event.webhook_event_id) ? 'fulfillment recorded' : 'already fulfilled';
    };
  },
} satisfies Record<string, Handler>;

export type HandledEventType = keyof typeof handlers;
export const handledEventTypes = Object.keys(handlers) as HandledEventType[];

export function handlerFor(eventType: string): Handler | undefined {
  return Object.hasOwn(handlers, eventType) ? handlers[eventType as HandledEventType] : undefined;
}

/** Whether an event is processed, and why not when it isn't. */
export function routing(event: Pick<Envelope, 'event_type' | 'test'>): { process: true } | { process: false; reason: string } {
  // Test events are small fixtures, not real resources, and Flint never retries them. Record them, don't act on them.
  if (event.test) return { process: false, reason: 'test event, recorded only' };
  if (!handlerFor(event.event_type)) return { process: false, reason: 'no handler for this event type' };
  return { process: true };
}

function permanent(error: unknown): boolean {
  if (error instanceof PermanentError) return true;
  return error instanceof SdkError && ['not_found', 'validation', 'protocol'].includes(error.kind);
}

/** Processes one due event. Returns false when nothing was due. */
export async function processNext(inbox: Inbox, context: HandlerContext, now = Date.now): Promise<boolean> {
  const row = inbox.claim(now());
  if (!row) return false;
  try {
    const event = row.payload === null ? undefined : parseEnvelope(JSON.parse(row.payload));
    const handler = event && handlerFor(event.event_type);
    if (!event || !handler) throw new PermanentError('stored payload is not a handled Flint event');
    const apply = await handler(event, context);
    const outcome = inbox.complete(row.webhook_event_id, apply, now());
    if (outcome !== undefined) log({ event: 'webhook_processed', webhook_event_id: row.webhook_event_id, event_type: row.event_type, outcome });
  } catch (error) {
    const message = describeError(error);
    const status = inbox.retryLater(row.webhook_event_id, message, permanent(error), now());
    log({ event: 'webhook_processing_failed', webhook_event_id: row.webhook_event_id, event_type: row.event_type, status, error: message });
  }
  return true;
}

/** Processes events in the background. kick() after recording an event; due retries are picked up on a timer. */
export class Worker {
  #inbox: Inbox;
  #context: HandlerContext;
  #pollMs: number;
  #current: Promise<void> | undefined;
  #again = false;
  #stopped = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(inbox: Inbox, context: HandlerContext, pollMs = 5_000) {
    this.#inbox = inbox;
    this.#context = context;
    this.#pollMs = pollMs;
  }

  start() {
    this.#timer = setInterval(() => this.kick(), this.#pollMs);
    this.#timer.unref();
    this.kick();
  }

  kick() {
    if (this.#stopped) return;
    if (this.#current) {
      this.#again = true;
      return;
    }
    this.#current = this.drain().finally(() => {
      this.#current = undefined;
      if (this.#again) {
        this.#again = false;
        this.kick();
      }
    });
  }

  /** Resolves when everything currently due has been tried once. */
  async drain() {
    try {
      while (!this.#stopped && await processNext(this.#inbox, this.#context));
    } catch (error) {
      log({ event: 'webhook_worker_error', error: describeError(error) });
    }
  }

  /** Stops taking new events and waits for the one in progress. */
  async stop() {
    this.#stopped = true;
    clearInterval(this.#timer);
    await this.#current;
  }
}

/** One JSON line per log entry. Payloads, headers, and secrets are never logged. */
export function log(entry: Record<string, unknown>) {
  console.info(JSON.stringify(entry));
}
