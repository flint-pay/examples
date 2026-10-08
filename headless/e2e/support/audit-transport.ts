import { API_ORIGIN } from './config.ts';
import { digest, invariant, requestId } from './safe.ts';

export type AuditAppend = (entry: Record<string, unknown>) => Promise<void>;
const cleanup: Record<string, string> = { subscription: 'subscription', invoice: 'invoice', checkout_session: 'checkout_session', customer_session: 'customer_session', gift_card: 'gift_card', payment_method: 'payment_method', return_resolution: 'return_resolution', customer_verification: 'expiry', email_change_request: 'expiry' };
const normalized: Record<string, string> = { order_payment_attempt: 'payment_attempt', customer_address: 'address', customer_deletion_request: 'deletion_request' };
const types = new Set(['customer', 'customer_session', 'customer_verification', 'checkout_session', 'invoice', 'order', 'order_line_item', 'order_charge', 'payment_attempt', 'order_payment_attempt', 'payment_intent', 'refund', 'subscription', 'subscription_payment_retry', 'payment_method', 'customer_address', 'email_change_request', 'customer_deletion_request', 'return', 'return_line_item', 'return_resolution', 'gift_card', 'gift_card_load', 'gift_card_notification', 'gift_card_settlement', 'gift_card_redemption', 'gift_card_transaction', 'fulfillment', 'shipment', 'package', 'package_item', 'delivery_quote', 'delivery_selection']);
const objects = new Set(['data', ...types, 'line_items', 'fulfillments', 'payment_intents', 'active_payment_attempt', 'gift_card_settlements', 'gift_card_redemptions', 'gift_cards', 'shipments', 'packages', 'items']);

// Paths are taken from the pinned public SDK. Preview POSTs do not create resources.
export function creationTypes(path: string): Set<string> {
  const result = new Set<string>();
  const add = (...values: string[]) => values.forEach(v => result.add(v));
  if (path === '/v1/customers') add('customer');
  if (path === '/v1/refunds') add('refund');
  if (/^\/v1\/customer-sessions(?:\/refresh)?$/.test(path)) add('customer_session');
  if (/^\/v1\/(?:customer-verifications|checkout-sessions\/[^/]+\/customer-verifications)$/.test(path)) add('customer_verification');
  if (path === '/v1/orders') add('order', 'order_line_item', 'fulfillment');
  if (path === '/v1/checkout-sessions') add('checkout_session', 'order', 'order_line_item', 'fulfillment');
  if (/^\/v1\/(?:me\/)?(?:invoices|return-resolutions)\/[^/]+\/checkout-session$/.test(path)) add('checkout_session');
  if (/^\/v1\/orders\/[^/]+\/line-items$/.test(path)) add('order_line_item', 'fulfillment');
  if (/^\/v1\/orders\/[^/]+\/charges$/.test(path)) add('order_charge');
  if (/^\/v1\/orders\/[^/]+\/fulfillments$/.test(path)) add('fulfillment');
  if (/^\/v1\/orders\/[^/]+\/(?:pay|payment-intents)$/.test(path)) add('payment_attempt', 'payment_intent', 'payment_method', 'subscription', 'gift_card_settlement', 'gift_card_redemption', 'gift_card_transaction');
  if (/^\/v1\/checkout-sessions\/[^/]+\/delivery-quotes$/.test(path)) add('delivery_quote');
  if (/^\/v1\/checkout-sessions\/[^/]+\/delivery-selections$/.test(path)) add('delivery_selection');
  if (path === '/v1/me/addresses') add('address');
  if (path === '/v1/me/deletion-requests') add('deletion_request');
  if (path === '/v1/me/email-change-requests') add('email_change_request');
  if (/^\/v1\/(?:me\/)?returns$/.test(path)) add('return', 'return_line_item');
  if (/^\/v1\/(?:me\/)?subscriptions\/[^/]+\/payment-retries$/.test(path)) add('subscription_payment_retry', 'payment_attempt', 'payment_intent');
  if (/^\/v1\/(?:me\/)?payment-methods$/.test(path)) add('payment_method');
  if (path === '/v1/subscriptions') add('subscription', 'order', 'order_line_item', 'fulfillment');
  if (path === '/v1/gift-cards') add('gift_card', 'gift_card_load', 'gift_card_notification', 'gift_card_transaction');
  if (path === '/v1/invoices') add('invoice', 'order', 'order_line_item');
  return result;
}
function resources(value: any): { id: string; type: string; cleanup: string; reviewAt: string }[] {
  const found = new Map<string, { id: string; type: string; cleanup: string; reviewAt: string }>();
  const visit = (v: any) => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!v || typeof v !== 'object') return;
    for (const [key, val] of Object.entries(v)) {
      const originalType = key.endsWith('_id') ? key.slice(0, -3) : key.endsWith('_ids') ? key.slice(0, -4) : '';
      const type = normalized[originalType] ?? originalType;
      if (types.has(originalType)) for (const id of Array.isArray(val) ? val : [val]) if (typeof id === 'string') {
        invariant(/^[A-Za-z0-9_-]+$/.test(id), 'APP_AUDIT_RESOURCE_INVALID');
        const reviewAt = typeof v.expires_at === 'string' && Number.isFinite(Date.parse(v.expires_at)) ? v.expires_at : new Date(Date.now() + 30 * 86400_000).toISOString();
        found.set(`${type}:${id}`, { id, type, cleanup: cleanup[type] ?? 'review', reviewAt });
      }
      // Authority, arbitrary metadata, mail and error payloads are never traversed.
      if (objects.has(key)) visit(val);
    }
  };
  visit(value); return [...found.values()];
}
export function auditedFetch(originalFetch: typeof fetch, append: AuditAppend): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    const writing = !['GET', 'HEAD'].includes(request.method);
    invariant(!writing || !/(^|\.)(stripe\.com|stripe\.network|affirm\.com|plaid\.com)$/.test(url.hostname), 'APP_DIRECT_PROVIDER_WRITE_FORBIDDEN');
    if (!/(^|\.)withflintpay\.com$/.test(url.hostname)) return originalFetch(input, init);
    invariant(url.origin === API_ORIGIN && !url.username && !url.password && url.pathname.startsWith('/v1/'), 'APP_PUBLIC_STAGING_TRANSPORT_REQUIRED');
    for (const name of ['flint-merchant-id', 'flint-mode', 'flint-merchant-environment-id', 'x-portal-session-secret', 'x-first-party-token']) invariant(!request.headers.has(name), 'APP_FIRST_PARTY_HEADER_FORBIDDEN');
    invariant(!request.headers.get('authorization')?.includes('flint_live_'), 'APP_LIVE_CREDENTIAL_FORBIDDEN');
    const key = request.headers.get('idempotency-key'), creates = request.method === 'POST' ? creationTypes(url.pathname) : new Set<string>();
    if (creates.size) invariant(key, 'APP_CREATION_DURABLE_KEY_REQUIRED');
    const body = writing ? await request.clone().text() : '';
    // Exact requests remain in the application's durable journal. Export only hashes.
    const fingerprint = digest({ method: request.method, url: request.url, body, keyHash: key ? digest(key) : null });
    if (writing) await append({ kind: 'MUTATION', fingerprint, keyHash: key ? digest(key) : null, ...(/^\/v1\/orders\/[A-Za-z0-9_-]+\/pay$/.test(url.pathname) ? { operation: 'ORDER_PAY', targetId: url.pathname.split('/')[3] } : {}) });
    const response = await originalFetch(input, { ...init, redirect: 'manual' });
    invariant(response.status < 300 || response.status >= 400, 'APP_API_REDIRECT_FORBIDDEN');
    let errorCode: unknown;
    if (response.headers.get('content-type')?.includes('json')) {
      const value = await response.clone().json() as any;
      errorCode = value?.error?.code;
      if (writing && response.ok) {
        let args: unknown; try { args = JSON.parse(body); } catch { args = {}; }
        const supplied = new Set(resources(args).map(r => r.id));
        const pathIds = new Set(url.pathname.split('/'));
        for (const resource of resources(value?.data)) await append({ kind: 'RESOURCE', ...resource, created: creates.has(resource.type) && !supplied.has(resource.id) && !pathIds.has(resource.id), requestId: requestId(response.headers.get('x-request-id')) });
        if (value?.data?.revoked === true && typeof value.data.customer_session_id === 'string') await append({ kind: 'REVOCATION', id: value.data.customer_session_id });
        if (typeof value?.data?.revoked_count === 'string' && /^(0|[1-9]\d*)$/.test(value.data.revoked_count) && typeof value.data.customer_id === 'string') await append({ kind: 'REVOCATION_ALL', customerId: value.data.customer_id, count: value.data.revoked_count });
      }
    }
    if (writing && response.status < 500 && errorCode !== 'IDEMPOTENCY_KEY_IN_PROGRESS') await append({ kind: 'RESOLVED', fingerprint, status: response.status });
    return response;
  };
}
