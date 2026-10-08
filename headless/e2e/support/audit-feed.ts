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
    if (entry.kind === 'MUTATION') { invariant(entry.operation!=='ORDER_APPLY_GIFT_CARD'||entry.authMode==='checkout','APP_GIFT_APPLY_MERCHANT_AUTH');state.unresolved.add(entry.fingerprint); d.appMutations.push({ app, fingerprint: entry.fingerprint, operation: entry.operation, targetId: entry.targetId,keyHash:entry.keyHash,authMode:entry.authMode,challengeProof:entry.challengeProof,timestamp: entry.timestamp }); }
    if (entry.kind === 'RESOLVED') { state.unresolved.delete(entry.fingerprint); for (const mutation of d.appMutations) if (mutation.app === app && mutation.fingerprint === entry.fingerprint && mutation.status === undefined) { mutation.status = entry.status; mutation.resolvedAt = entry.timestamp; } }
    if (entry.kind === 'REVOCATION') d.revocations.push({ app, sessionId: entry.id });
    if (entry.kind === 'REVOCATION_ALL' && BigInt(entry.count) > 0n) d.revocations.push({ app, customerId: entry.customerId });
    if (entry.kind === 'RESOURCE') {
      invariant(typeof entry.id === 'string' && /^[A-Za-z0-9_-]+$/.test(entry.id) && typeof entry.created === 'boolean', 'APP_AUDIT_RESOURCE_INVALID');
      d.appResources.push({ app, id: entry.id, type: entry.type, created: entry.created, customerId: entry.customerId, timestamp: entry.timestamp });
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
export function assertFreshRevocation(d: Driver, checkpoint: number, app: string, expected: { sessionId: string } | { customerId: string }): void {
  invariant(d.revocations.slice(checkpoint).some(e => e.app === app && ('sessionId' in expected ? e.sessionId === expected.sessionId : e.customerId === expected.customerId)), 'APP_FRESH_SIGNOUT_REVOCATION_REQUIRED');
}

export function currentAppFamily(d: Driver, customerId: string | undefined): string {
  invariant(customerId, 'APP_CUSTOMER_BINDING_REQUIRED');
  const event = d.appResources.filter(e => ['accountA', 'storefrontA'].includes(e.app) && e.type === 'customer_session' && e.created && e.customerId === customerId && Number.isFinite(e.timestamp)).sort((a,b) => a.timestamp - b.timestamp).at(-1);
  invariant(event && !d.appResources.some(e => e.type === 'customer_session' && e.customerId === customerId && e.timestamp === event.timestamp && e.id !== event.id), 'APP_EXACT_FAMILY_EVIDENCE_REQUIRED'); return event.id;
}
