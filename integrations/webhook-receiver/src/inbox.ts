import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type EventStatus = 'pending' | 'processed' | 'ignored' | 'failed' | 'unavailable';
export type EventSource = 'delivery' | 'catch_up';

export type EventRow = {
  webhook_event_id: string;
  event_type: string;
  source: EventSource;
  test: number;
  payload: string | null;
  status: EventStatus;
  attempts: number;
  next_attempt_at: number;
  lease_until: number | null;
  outcome: string | null;
  last_error: string | null;
  event_created_at: string | null;
  received_at: number;
  updated_at: number;
};

export type NewEvent = {
  webhookEventId: string;
  eventType: string;
  source: EventSource;
  test: boolean;
  payload: string;
  createdAt?: string;
  /** False for event types this app has no handler for, and for test events. They are recorded but not processed. */
  process: boolean;
  ignoredReason?: string;
};

export const MAX_ATTEMPTS = 10;
const LEASE_MS = 60_000;

/** 30 seconds, doubling, at most an hour, with jitter so a backlog doesn't retry in lockstep. */
export function retryDelay(attempts: number, random = Math.random): number {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
  return Math.round(base * (0.8 + 0.4 * random()));
}

/**
 * The durable record of every event this app has seen, keyed by webhook_event_id. Flint sends the same ID
 * on every retry and every manual resend, and the events API lists the same ID, so one primary key
 * deduplicates live deliveries and catch-up alike.
 */
export class Inbox {
  db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events (
        webhook_event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('delivery', 'catch_up')),
        test INTEGER NOT NULL,
        payload TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processed', 'ignored', 'failed', 'unavailable')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        lease_until INTEGER,
        outcome TEXT,
        last_error TEXT,
        event_created_at TEXT,
        received_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_due ON events (status, next_attempt_at);
      CREATE TABLE IF NOT EXISTS fulfillments (order_id TEXT PRIMARY KEY, webhook_event_id TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resends (webhook_delivery_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
  }

  close() {
    this.db.close();
  }

  get<T>(sql: string, ...values: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...values) as T | undefined;
  }
  all<T>(sql: string, ...values: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...values) as T[];
  }
  run(sql: string, ...values: SQLInputValue[]) {
    return this.db.prepare(sql).run(...values);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  event(webhookEventId: string): EventRow | undefined {
    return this.get<EventRow>('SELECT * FROM events WHERE webhook_event_id = ?', webhookEventId);
  }

  /**
   * Records an event once. Returns false for a duplicate. The write is committed when this returns, so the
   * HTTP handler can acknowledge the delivery. An event that catch-up listed but could not read is filled in.
   */
  record(event: NewEvent, now = Date.now()): boolean {
    const status: EventStatus = event.process ? 'pending' : 'ignored';
    const result = this.run(
      `INSERT INTO events (webhook_event_id, event_type, source, test, payload, status, outcome, next_attempt_at, event_created_at, received_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (webhook_event_id) DO UPDATE SET
         payload = excluded.payload, status = excluded.status, outcome = excluded.outcome, source = excluded.source,
         last_error = NULL, next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at
       WHERE events.status = 'unavailable'`,
      event.webhookEventId, event.eventType, event.source, event.test ? 1 : 0, event.payload, status,
      event.process ? null : event.ignoredReason ?? null, now, event.createdAt ?? null, now, now,
    );
    return Number(result.changes) === 1;
  }

  /** Catch-up saw this event but Flint returned no payload, for example because the key can't read the resource. */
  recordUnavailable(event: { webhookEventId: string; eventType: string; test: boolean; createdAt?: string; reason: string }, now = Date.now()): boolean {
    const result = this.run(
      `INSERT INTO events (webhook_event_id, event_type, source, test, payload, status, last_error, next_attempt_at, event_created_at, received_at, updated_at)
       VALUES (?, ?, 'catch_up', ?, NULL, 'unavailable', ?, ?, ?, ?, ?)
       ON CONFLICT (webhook_event_id) DO NOTHING`,
      event.webhookEventId, event.eventType, event.test ? 1 : 0, event.reason, now, event.createdAt ?? null, now, now,
    );
    return Number(result.changes) === 1;
  }

  /** Takes the next due event with a short lease, so two workers never process the same event at once. */
  claim(now = Date.now()): EventRow | undefined {
    return this.transaction(() => {
      const row = this.get<EventRow>(
        `SELECT * FROM events WHERE status = 'pending' AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until < ?)
         ORDER BY next_attempt_at, received_at LIMIT 1`, now, now);
      if (!row) return undefined;
      this.run('UPDATE events SET lease_until = ? WHERE webhook_event_id = ?', now + LEASE_MS, row.webhook_event_id);
      return { ...row, lease_until: now + LEASE_MS };
    });
  }

  /**
   * Runs the handler's database writes and marks the event processed in one transaction. If the event is no
   * longer pending (another worker finished it), nothing is written and this returns undefined.
   */
  complete(webhookEventId: string, apply: (inbox: Inbox) => string, now = Date.now()): string | undefined {
    return this.transaction(() => {
      if (this.event(webhookEventId)?.status !== 'pending') return undefined;
      const outcome = apply(this);
      this.run(
        `UPDATE events SET status = 'processed', outcome = ?, attempts = attempts + 1, last_error = NULL, lease_until = NULL, updated_at = ?
         WHERE webhook_event_id = ?`, outcome, now, webhookEventId);
      return outcome;
    });
  }

  /** Schedules another try, or marks the event failed when it can't succeed or has run out of attempts. */
  retryLater(webhookEventId: string, error: string, permanent: boolean, now = Date.now()): EventStatus {
    const row = this.event(webhookEventId);
    if (!row || row.status !== 'pending') return row?.status ?? 'failed';
    const attempts = row.attempts + 1;
    const status: EventStatus = permanent || attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    this.run(
      `UPDATE events SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ?, lease_until = NULL, updated_at = ?
       WHERE webhook_event_id = ?`, status, attempts, error, now + retryDelay(attempts), now, webhookEventId);
    return status;
  }

  /** Puts a failed or finished event back in the queue. Resending from Flint doesn't do this: the ID is already recorded. */
  requeue(webhookEventId: string, now = Date.now()): boolean {
    const result = this.run(
      `UPDATE events SET status = 'pending', attempts = 0, next_attempt_at = ?, lease_until = NULL, last_error = NULL, outcome = NULL, updated_at = ?
       WHERE webhook_event_id = ? AND payload IS NOT NULL AND test = 0 AND status IN ('failed', 'processed', 'ignored')`,
      now, now, webhookEventId);
    return Number(result.changes) === 1;
  }

  nextDueAt(): number | undefined {
    return this.get<{ due: number | null }>(`SELECT MIN(MAX(next_attempt_at, COALESCE(lease_until, 0))) AS due FROM events WHERE status = 'pending'`)?.due ?? undefined;
  }

  /** The example side effect. It is keyed by order, not by event: different events can describe the same sale. */
  addFulfillment(orderId: string, webhookEventId: string, now = Date.now()): boolean {
    return Number(this.run('INSERT INTO fulfillments VALUES (?, ?, ?) ON CONFLICT (order_id) DO NOTHING', orderId, webhookEventId, now).changes) === 1;
  }

  setting(name: string): string | undefined {
    return this.get<{ value: string }>('SELECT value FROM settings WHERE name = ?', name)?.value;
  }
  saveSetting(name: string, value: string) {
    this.run('INSERT INTO settings VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value', name, value);
  }

  /** The idempotency key for one resend request, saved before it is sent and reused if the answer is lost. */
  resendKey(webhookDeliveryId: string, newKey: () => string, now = Date.now()): string {
    this.run('INSERT INTO resends VALUES (?, ?, ?) ON CONFLICT (webhook_delivery_id) DO NOTHING', webhookDeliveryId, newKey(), now);
    return this.get<{ idempotency_key: string }>('SELECT idempotency_key FROM resends WHERE webhook_delivery_id = ?', webhookDeliveryId)!.idempotency_key;
  }
  finishResend(webhookDeliveryId: string) {
    this.run('DELETE FROM resends WHERE webhook_delivery_id = ?', webhookDeliveryId);
  }

  summary(limit = 15) {
    return {
      counts: this.all<{ status: EventStatus; count: number }>('SELECT status, COUNT(*) AS count FROM events GROUP BY status ORDER BY status'),
      recent: this.all<EventRow>('SELECT * FROM events ORDER BY received_at DESC LIMIT ?', limit),
      fulfillments: this.all<{ order_id: string; webhook_event_id: string; created_at: number }>(
        'SELECT * FROM fulfillments ORDER BY created_at DESC LIMIT ?', limit),
    };
  }
}
