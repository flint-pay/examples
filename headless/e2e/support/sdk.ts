import { Client } from '@flintpay/node';
import type { Config, Sandbox } from './config.ts';
import { API_ORIGIN, pinApiOrigin } from './config.ts';
import type { Fixtures } from './fixtures.ts';
import { invariant, requestId } from './safe.ts';

export type PublicClient = InstanceType<typeof Client>;
let gate = Promise.resolve();
let nextRequestAt = 0;
export function pinnedFetch(baseFetch: typeof fetch = fetch, ids?: Set<string>): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    invariant(url.origin === API_ORIGIN && !url.username && !url.password, 'SDK_ORIGIN_FORBIDDEN');
    invariant(url.pathname.startsWith('/v1/'), 'NONPUBLIC_API_FORBIDDEN');
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const name of ['flint-merchant-id', 'flint-mode', 'flint-merchant-environment-id', 'x-portal-session-secret', 'x-first-party-token']) invariant(!headers.has(name), 'FIRST_PARTY_HEADER_FORBIDDEN');
    const paced = gate.then(async () => { const delay = nextRequestAt - Date.now(); if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay)); nextRequestAt = Date.now() + 150; });
    gate = paced.catch(() => {}); await paced;
    const response = await baseFetch(input, { ...init, redirect: 'manual' });
    const id = requestId(response.headers.get('x-request-id')); if (id) ids?.add(id);
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      const milliseconds = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 1000;
      if (Number.isFinite(milliseconds)) nextRequestAt = Math.max(nextRequestAt, Date.now() + Math.max(1000, milliseconds));
    }
    invariant(response.status < 300 || response.status >= 400, 'SDK_REDIRECT_FORBIDDEN');
    return response;
  };
}
export function client(config: Config, sandbox: Sandbox, ids?: Set<string>, role: 'operator' | 'app' = 'operator'): PublicClient {
  pinApiOrigin(config.apiOrigin);
  return new Client({ apiKey: (role === 'app' ? config.pins : config.operatorPins)[sandbox].key, baseUrl: API_ORIGIN, transport: pinnedFetch(fetch, ids), maxAttempts: 1, timeoutMs: 30_000 });
}
export class VerifiedClients {
  readonly clients: Record<Sandbox, PublicClient>;
  readonly appClients: Record<Sandbox, PublicClient>;
  readonly requestIds = new Set<string>();
  verified = new Set<Sandbox>();
  readonly config: Config; readonly fixtures: Fixtures;
  constructor(config: Config, fixtures: Fixtures) { this.config = config; this.fixtures = fixtures; this.clients = { A: client(config, 'A', this.requestIds), B: client(config, 'B', this.requestIds) }; this.appClients = { A: client(config, 'A', this.requestIds, 'app'), B: client(config, 'B', this.requestIds, 'app') }; }
  async verifyContext(sandbox: Sandbox): Promise<void> {
    pinApiOrigin(this.config.apiOrigin);
    const context = await this.clients[sandbox].developer.getAuthContext();
    const appContext = await this.appClients[sandbox].developer.getAuthContext();
    const p = this.config.pins[sandbox];
    invariant(appContext.environment === 'sandbox' && appContext.auth_type === 'api_key' && appContext.merchant_id === p.merchantId && appContext.sandbox_id === p.sandboxId, 'APP_CREDENTIAL_CONTEXT_MISMATCH');
    invariant(!appContext.scopes.some(s => s === '*' || s === 'commerce.gift_cards.secrets.write'), 'APP_PRIVILEGED_GIFT_SCOPE_FORBIDDEN');
    const readiness = this.fixtures.readiness[sandbox];
    invariant(readiness.mode === 'test' && readiness.merchantId === p.merchantId && readiness.sandboxId === p.sandboxId && readiness.providerId === p.providerId, 'PROVIDER_TUPLE_MISMATCH');
    invariant(context.environment === 'sandbox' && context.auth_type === 'api_key' && context.merchant_id === p.merchantId && context.sandbox_id === p.sandboxId, 'CREDENTIAL_CONTEXT_MISMATCH');
  }
  async verify(sandbox: Sandbox): Promise<void> {
    await this.verifyContext(sandbox);
    const caps = await this.clients[sandbox].capabilities.list({ domain: 'payments' });
    const card = caps.data.find(c => c.capability === 'accept_card_payments');
    invariant(card?.status === 'ready' && this.fixtures.readiness[sandbox].cards, 'PAYMENT_READINESS_CONTRADICTION');
    if (this.fixtures.readiness[sandbox].affirm) invariant(caps.data.find(c => c.capability === 'accept_affirm_payments')?.status === 'ready', 'AFFIRM_READINESS_CONTRADICTION');
    this.verified.add(sandbox);
  }
  async writable(sandbox: Sandbox, cleanup = false): Promise<PublicClient> {
    invariant(this.config.apply, 'EXPLICIT_APPLY_REQUIRED');
    // Recheck every credential before every operator mutation, including teardown.
    if (cleanup) await this.verifyContext(sandbox); else await this.verify(sandbox);
    return this.clients[sandbox];
  }
}
