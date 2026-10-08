import { join } from 'node:path';
import { readPrivateText } from './private-files.ts';
import { digest, invariant } from './safe.ts';
import type { Driver } from './driver.ts';

export type FeedCursor = { consumed: number; prefixHash: string; ready: boolean; unresolved: Set<string> };
export class AuditFeeds {
  cursors = new Map<string, FeedCursor>();
  private queue = Promise.resolve();
  serialized(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work); this.queue = next.catch(() => {}); return next;
  }
}
export async function consumeAppFeed(d: Driver, app: string, text: string, final = false): Promise<void> {
  const state = d.auditFeeds.cursors.get(app) ?? { consumed: 0, prefixHash: digest(''), ready: false, unresolved: new Set<string>() };
  invariant(text.length >= state.consumed && digest(text.slice(0, state.consumed)) === state.prefixHash, 'APP_AUDIT_FEED_REPLACED');
  const complete = text.lastIndexOf('\n') + 1;
  if (final) invariant(complete === text.length, 'APP_AUDIT_PARTIAL_EVENT');
  for (const line of text.slice(state.consumed, complete).split('\n').filter(Boolean)) {
    const entry = JSON.parse(line);
    invariant(entry.schema_version === 1 && entry.run === d.config.run && entry.app === app && entry.sandbox === (app === 'storefrontB' ? 'B' : 'A'), 'APP_AUDIT_IDENTITY_MISMATCH');
    invariant(['READY', 'MUTATION', 'RESOLVED', 'RESOURCE', 'REVOCATION', 'REVOCATION_ALL'].includes(entry.kind), 'APP_AUDIT_EVENT_INVALID');
    if (entry.kind === 'READY') state.ready = true;
    if (entry.kind === 'MUTATION') { state.unresolved.add(entry.fingerprint); d.appMutations.push({ app, operation: entry.operation, targetId: entry.targetId }); }
    if (entry.kind === 'RESOLVED') state.unresolved.delete(entry.fingerprint);
    if (entry.kind === 'REVOCATION') d.revocations.push({ app, sessionId: entry.id });
    if (entry.kind === 'REVOCATION_ALL' && BigInt(entry.count) > 0n) d.revocations.push({ app, customerId: entry.customerId });
    if (entry.kind === 'RESOURCE') {
      invariant(typeof entry.id === 'string' && /^[A-Za-z0-9_-]+$/.test(entry.id) && typeof entry.created === 'boolean', 'APP_AUDIT_RESOURCE_INVALID');
      await d.observeResource(entry.sandbox, entry.type, entry.id, entry.cleanup, entry.reviewAt, entry.requestId, entry.created);
    }
    // Advance only after the resource has been durably recorded.
    state.consumed += line.length + 1; state.prefixHash = digest(text.slice(0, state.consumed)); d.auditFeeds.cursors.set(app, state);
  }
  invariant(state.ready, 'APP_AUDIT_NOT_READY');
  if (final) invariant(state.unresolved.size === 0, 'APP_MUTATION_OUTCOME_UNKNOWN');
}
export async function syncAppAudit(d: Driver, final = false): Promise<void> {
  await d.auditFeeds.serialized(async () => {
    for (const app of ['storefrontA', 'storefrontB', 'accountA']) await consumeAppFeed(d, app, await readPrivateText(join(d.config.privateDir, `app-audit-${app}.jsonl`)), final);
  });
}
export async function revocationCheckpoint(d: Driver): Promise<number> { await syncAppAudit(d); return d.revocations.length; }
export function assertFreshRevocation(d: Driver, checkpoint: number, app: string, customerId: string | undefined): void {
  invariant(d.revocations.slice(checkpoint).some(e => e.app === app && (e.sessionId || customerId && e.customerId === customerId)), 'APP_FRESH_SIGNOUT_REVOCATION_REQUIRED');
}
