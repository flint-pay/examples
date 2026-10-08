import { readPrivate, writePrivate, writePrivateText } from './private-files.ts';
import { dirname, join } from 'node:path';
import { digest, invariant, requestId, apiFailure } from './safe.ts';
import type { Sandbox } from './config.ts';

export type Disposition = 'CLEANED UP' | 'PENDING EXPIRY' | 'PENDING AUTHORIZED CLEANUP' | 'RETAINED FOR RECONCILIATION';
export type Resource = { resource: string; type: string; mode: 'test'; sandbox: Sandbox; merchant: string; sandboxId: string; createdBy: string; purpose: string; creationRequestId?: string; cleanup: string; owner: string; reviewAt: string; status: Disposition; owned: boolean };
type Action = { key: string; fingerprint: string; operation: string; args: unknown[]; sandbox: Sandbox; phase: 'prepared' | 'unknown' | 'known' | 'rejected' | 'abandoned'; reconcileActionId?: string; response?: unknown; responseNeedsReplay?: boolean };
type State = { run: string;giftChallengeTrippedAt?:number; resources: Resource[]; actions: Record<string, Action>; settings: Record<string, { snapshot: any; applied?: any; restored: boolean }> };
// Persist reconciliation evidence without browser, checkout, customer or gift authority.
export function redactJournalResponse(value: any): any {
  if (Array.isArray(value)) return value.map(redactJournalResponse);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(secret|refresh_token|checkout_auth_token|client_secret|code|gift_card_code|recipient_token|recipient_access_token|token|proof|customer_session_secret|checkout_session_secret|checkout_access|url|[a-z_]+_url)$/.test(key)).map(([key, item]) => [key, redactJournalResponse(item)]));
}
export class Ledger {
  state: State;
  readonly file: string; readonly run: string;
  constructor(file: string, run: string) { this.file = file; this.run = run; this.state = { run, resources: [], actions: {}, settings: {} }; }
  async load(): Promise<void> {
    try { this.state = await readPrivate<State>(this.file); invariant(this.state.run === this.run, 'LEDGER_RUN_MISMATCH'); }
    catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
  }
  async save(): Promise<void> {
    const actions = Object.fromEntries(Object.entries(this.state.actions).map(([name, action]) => {
      if (action.response === undefined) return [name, action];
      const normalized = JSON.parse(JSON.stringify(action.response));
      const response = redactJournalResponse(normalized);
      return [name, { ...action, response, responseNeedsReplay: action.responseNeedsReplay || digest(response) !== digest(normalized) }];
    }));
    await writePrivate(this.file, { ...this.state, actions });
    const cell = (value: unknown) => String(value ?? '').replaceAll('|', '/').replace(/[\r\n]/g, ' ');
    const heading = '| Resource | Mode | Merchant / sandbox | Created by | Purpose and creation evidence | Cleanup mechanism | Disposition owner | Expiry or review time | Status |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n';
    const rows = this.state.resources.map(r => [r.type + ' ' + r.resource, r.mode, r.merchant + ' / ' + r.sandboxId, r.createdBy, r.purpose + (r.creationRequestId ? '; ' + r.creationRequestId : ''), r.cleanup, r.owner, r.reviewAt, r.status].map(cell).join(' | '));
    await writePrivateText(join(dirname(this.file), 'ledger.md'), heading + rows.map(r => `| ${r} |\n`).join(''));
  }
  async track(resource: Resource): Promise<void> {
    invariant(resource.resource && resource.cleanup && resource.owner && Number.isFinite(Date.parse(resource.reviewAt)), 'RESOURCE_DISPOSITION_REQUIRED');
    const prior = this.state.resources.find(r => r.sandbox === resource.sandbox && r.type === resource.type && r.resource === resource.resource);
    const identity = (r: Resource) => ({ type: r.type, resource: r.resource, sandbox: r.sandbox, sandboxId: r.sandboxId, merchant: r.merchant, owned: r.owned, createdBy: r.createdBy, cleanup: r.cleanup });
    invariant(!prior || digest(identity(prior)) === digest(identity(resource)), 'RESOURCE_OWNERSHIP_CONFLICT');
    if (!prior) this.state.resources.push(resource);
    await this.save();
  }
  async record(spec: Omit<Resource, 'status'>): Promise<void> { await this.track({ ...spec, status: spec.owned ? 'PENDING AUTHORIZED CLEANUP' : 'RETAINED FOR RECONCILIATION' }); }
  async action<T>(name: string, sandbox: Sandbox, operation: string, args: unknown[], send: (key: string) => Promise<T>, reconcile: (response: T) => Promise<void>, suppliedKey?: string): Promise<T> {
    invariant(/^[a-zA-Z0-9_-]{1,100}$/.test(name), 'ACTION_NAME_INVALID');
    const fingerprint = digest({ sandbox, operation, args });
    const actionId = `${sandbox}:${name}`;
    let action = this.state.actions[actionId];
    invariant(!action || action.phase !== 'abandoned', 'UNREPLAYABLE_ACTION_ABANDONED');
    invariant(!action || action.fingerprint === fingerprint, 'IDEMPOTENCY_REQUEST_CHANGED');
    invariant(!action || !suppliedKey || action.key === suppliedKey, 'IDEMPOTENCY_KEY_CHANGED');
    if (!action) {
      action = { key: suppliedKey ?? `fx-${this.run}-${sandbox}-${name}`, fingerprint, operation, args, sandbox, phase: 'prepared' };
      this.state.actions[actionId] = action;
      await this.save();
    }
    if (action.phase === 'known' && !action.responseNeedsReplay) {
      await reconcile(action.response as T);
      return action.response as T;
    }
    if (action.phase === 'unknown' && action.response !== undefined && !action.responseNeedsReplay) {
      await reconcile(action.response as T); action.phase = 'known'; await this.save(); return action.response as T;
    }
    invariant(!action.args.some(a => a && typeof a === 'object' && 'credential_source' in a) || action.phase === 'prepared', 'IN_MEMORY_AUTHORITY_CANNOT_BE_REPLAYED');
    // Persist unknown before the network call. A killed process must reconcile this key.
    action.phase = 'unknown'; await this.save();
    let response: T;
    try { response = await send(action.key); }
    catch (e) {
      const failure = apiFailure(e);
      if (failure.status && failure.status >= 400 && failure.status < 500 && failure.status !== 409 && (e as any)?.outcome !== 'unknown') { action.phase = 'rejected'; await this.save(); }
      throw e;
    }
    action.response = response; action.responseNeedsReplay = false;
    await this.save();
    await reconcile(response);
    action.phase = 'known'; await this.save();
    return response;
  }
  validAbandonment(action: Action): boolean {
    const reconcile = action.reconcileActionId && this.state.actions[action.reconcileActionId];
    const count = reconcile && (reconcile.response as any)?.revoked_count;
    const customer = reconcile && this.state.resources.find(r => r.type === 'customer' && r.resource === reconcile.args[0] && r.sandbox === reconcile.sandbox && r.owned && r.createdBy === this.run);
    return action.args.some(a => a && typeof a === 'object' && 'credential_source' in a && typeof (a as any).credential_source === 'string') && !!reconcile && reconcile.phase === 'known' && reconcile.operation === 'customers.revokeSessions' && reconcile.sandbox === action.sandbox && !!customer && typeof count === 'string' && /^(0|[1-9]\d*)$/.test(count);
  }
  async abandonUnreplayable(actionId: string, reconcileActionId: string): Promise<void> {
    const action = this.state.actions[actionId];
    invariant(action && action.phase === 'unknown', 'UNREPLAYABLE_ACTION_REQUIRED');
    const candidate = { ...action, reconcileActionId };
    invariant(this.validAbandonment(candidate), 'OWNED_CUSTOMER_REVOCATION_RECONCILIATION_REQUIRED');
    action.reconcileActionId = reconcileActionId; action.phase = 'abandoned'; await this.save();
  }
  assertTracked(): void {
    invariant(Object.values(this.state.actions).every(a => a.phase === 'known' || a.phase === 'rejected' || a.phase === 'abandoned' && this.validAbandonment(a)), 'UNRECONCILED_CREATION_OR_MUTATION');
    invariant(this.state.resources.every(r => r.cleanup && r.owner && r.reviewAt), 'UNTRACKED_RESOURCE');
    invariant(Object.values(this.state.settings).every(s => s.restored), 'SETTINGS_NOT_RESTORED');
    invariant(this.state.resources.every(r => r.status !== 'PENDING AUTHORIZED CLEANUP'), 'CLEANUP_INCOMPLETE');
  }
  async disposition(resource: Resource, status: Disposition): Promise<void> { resource.status = status; await this.save(); }
  async snapshot(name: string, value: any): Promise<void> {
    if (!this.state.settings[name]) this.state.settings[name] = { snapshot: value, restored: false };
    await this.save();
  }
  safeView(): unknown {
    return this.state.resources.map(({ resource, type, mode, sandbox, createdBy, purpose, creationRequestId, cleanup, owner, reviewAt, status }) => ({ resource, type, mode, sandbox, createdBy, purpose, creationRequestId: requestId(creationRequestId), cleanup, owner, reviewAt, status }));
  }
}
