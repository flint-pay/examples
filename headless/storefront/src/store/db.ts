import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {LocalError} from '../flint/errors.ts';

export function protectedDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const db = new DatabaseSync(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  return db;
}

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = protectedDatabase(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS carts (cart_id TEXT PRIMARY KEY, session_hash TEXT NOT NULL, user_id TEXT, status TEXT NOT NULL DEFAULT 'open', merged_into TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cart_lines (line_id TEXT PRIMARY KEY, cart_id TEXT NOT NULL REFERENCES carts(cart_id), product_id TEXT NOT NULL, variant_id TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 20));
      CREATE TABLE IF NOT EXISTS checkouts (checkout_ref TEXT PRIMARY KEY, cart_id TEXT, session_hash TEXT NOT NULL, user_id TEXT, kind TEXT NOT NULL, subscription_plan_id TEXT, order_id TEXT, checkout_session_id TEXT, checkout_auth_token TEXT, generation INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'open', last_attempt_id TEXT, pay_seq INTEGER NOT NULL DEFAULT 0, resume_seq INTEGER NOT NULL DEFAULT 0, needs_replacement INTEGER NOT NULL DEFAULT 0, cart_dirty INTEGER NOT NULL DEFAULT 0, flash TEXT NOT NULL DEFAULT '[]', details TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER);
      CREATE TABLE IF NOT EXISTS actions (action_id TEXT PRIMARY KEY, resource TEXT NOT NULL, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, body TEXT, body_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempt_id TEXT, created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS unresolved_payment ON actions(resource) WHERE kind IN ('pay','resume','cancel') AND status IN ('pending','unknown');
      CREATE TABLE IF NOT EXISTS resource_locks (resource TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS webhook_events (webhook_id TEXT PRIMARY KEY, type TEXT NOT NULL, object_id TEXT, received_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS order_signals (order_id TEXT PRIMARY KEY, paid_at INTEGER NOT NULL);
    `);
    if(!this.all<{name:string}>('PRAGMA table_info(checkouts)').some(column=>column.name==='cart_dirty'))this.db.exec('ALTER TABLE checkouts ADD COLUMN cart_dirty INTEGER NOT NULL DEFAULT 0');
    if(!this.all<{name:string}>('PRAGMA table_info(checkouts)').some(column=>column.name==='cart_finalized'))this.db.exec('ALTER TABLE checkouts ADD COLUMN cart_finalized INTEGER NOT NULL DEFAULT 0');
    if(!this.all<{name:string}>('PRAGMA table_info(carts)').some(column=>column.name==='merged_into'))this.db.exec('ALTER TABLE carts ADD COLUMN merged_into TEXT');
    this.cleanup();
  }
  cleanup(){
    this.run('UPDATE checkouts SET checkout_auth_token=NULL WHERE completed_at IS NOT NULL AND completed_at<?',Date.now()-24*60*60*1000);
  }
  get<T>(sql: string, ...values: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...values) as T | undefined; }
  all<T>(sql: string, ...values: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...values) as T[]; }
  run(sql: string, ...values: SQLInputValue[]) { return this.db.prepare(sql).run(...values); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async locked<T>(resource: string, fn: (assertOwnership: () => void) => Promise<T>): Promise<T> {
    const owner = randomUUID();
    const deadline = Date.now() + 10_000;
    let acquired = false;
    while (!acquired) {
      acquired = this.transaction(() => {
        this.run('DELETE FROM resource_locks WHERE resource=? AND expires_at<?', resource, Date.now());
        return this.run('INSERT OR IGNORE INTO resource_locks VALUES(?,?,?)', resource, owner, Date.now()+120_000).changes === 1;
      });
      if (!acquired) {
        if (Date.now() > deadline) throw new LocalError('CHECKOUT_PAYMENT_RESOLVING',409);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    const assertOwnership = () => {
      if (!this.get('SELECT owner FROM resource_locks WHERE resource=? AND owner=? AND expires_at>?', resource, owner, Date.now())) throw new Error('lock_ownership_lost');
    };
    const heartbeat = setInterval(() => this.run('UPDATE resource_locks SET expires_at=? WHERE resource=? AND owner=?', Date.now()+120_000, resource, owner), 20_000);
    heartbeat.unref();
    try { return await fn(assertOwnership); }
    finally { clearInterval(heartbeat); this.run('DELETE FROM resource_locks WHERE resource=? AND owner=?', resource, owner); }
  }
  close() { this.db.close(); }
}

export type CheckoutRecord = {
  checkout_ref: string; cart_id: string | null; session_hash: string; user_id: string | null;
  kind: 'order'|'subscription'; subscription_plan_id: string | null; order_id: string | null;
  checkout_session_id: string | null; checkout_auth_token: string | null; generation: number;
  status: string; last_attempt_id: string | null; pay_seq: number; resume_seq: number;
  needs_replacement: number; cart_dirty: number; cart_finalized:number; flash: string; details: string; created_at: number; updated_at: number; completed_at: number | null;
};
export type ActionRecord = {action_id:string;resource:string;kind:string;idempotency_key:string;body:string|null;body_hash:string;status:string;attempt_id:string|null;created_at:number};
