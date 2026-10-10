import { expect } from '@playwright/test';
import { Client } from '@flintpay/node';
import { createHmac } from 'node:crypto';
import type { Driver } from '../support/driver.ts';
import type { Scenario } from './storefront.ts';
import { billing } from './storefront.ts';
import { invariant } from '../support/safe.ts';
import { pinnedFetch } from '../support/sdk.ts';
import { runChild } from '../support/child.ts';
import { checkoutRoot } from '../support/private-files.ts';
import { syncAppAudit, revocationCheckpoint, assertFreshRevocation, currentAppFamily } from '../support/audit-feed.ts';

export async function buyerClient(d: Driver, customerId: string, sandbox: 'A' | 'B' = 'A'): Promise<Client> {
  const step = { name: `buyer-${customerId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-40)}`, sandbox, operation: 'customerSessions.create', args: [{ customer_id: customerId, expires_in_seconds: '300' }], creates: [{ path: 'customer_session_id', type: 'customer_session', cleanup: 'customer_session', reviewAt: new Date(Date.now() + 3600_000).toISOString() }], purpose: 'public-buyer-assertions' };
  const response = await d.operator.execute(step);
  return new Client({ baseUrl: d.config.apiOrigin, customerToken: response.data.secret, transport: pinnedFetch(), maxAttempts: 1 });
}
async function notFound(operation: Promise<unknown>): Promise<void> {
  const error = await operation.then(() => null, e => e); invariant(error?.status === 404, 'FOREIGN_RESOURCE_NOT_HIDDEN');
}
export const crossApp: Record<string, Scenario> = {
  'X-01': async d => {
    const page = await d.page('combined'); await d.login(page, 'b1', d.sf()); await d.goto(page, d.config.origins.accountA, '/'); await expect(page.getByTestId('ac-home')).toBeVisible();
    let before = await revocationCheckpoint(d); let familyId = currentAppFamily(d, d.fixtures.buyers.b1.customerId); await d.form(page, '/sign-out'); await syncAppAudit(d); assertFreshRevocation(d, before, 'accountA', { sessionId: familyId });
    await d.goto(page, d.sf(), '/sign-in'); await expect(page.locator('form[action="/sign-in"]')).toBeVisible();
    await d.login(page, 'b1', d.sf()); await d.goto(page, d.config.origins.accountA, '/'); await d.goto(page, d.sf(), '/'); before = await revocationCheckpoint(d); familyId = currentAppFamily(d, d.fixtures.buyers.b1.customerId);
    await d.form(page, '/sign-out'); await syncAppAudit(d); assertFreshRevocation(d, before, 'storefrontA', { sessionId: familyId });
    await d.goto(page, d.config.origins.accountA, '/'); await expect(page.locator('form[action="/sign-in"]')).toBeVisible();
    return ['COMBINED_IDENTITY_BOTH_LOGOUTS_REAL_API_REVOCATION'];
  },
  'I-01': async d => {
    const order = d.created.get('guestCardOrder') ?? d.fixtures.values.guestCardOrder, invoice = d.created.get('invoice') ?? d.fixtures.values.invoiceId;
    invariant(order && invoice && d.fixtures.buyers.b1.customerId && d.fixtures.buyers.b1b.customerId, 'ISOLATION_FIXTURES_REQUIRED');
    const b = d.operator.clients.clients.B;
    await notFound(b.orders.get(order)); await notFound(b.customers.get(d.fixtures.buyers.b1.customerId)); await notFound(b.invoices.get(invoice));
    const buyer = await buyerClient(d, d.fixtures.buyers.b1b.customerId, 'B'); await notFound(buyer.me.getOrder(order));
    const key = `fx-${d.config.run}-same-key-two-sandboxes`, args = [{ external_reference_id: key, line_items: [{ name: 'Isolation acceptance service', quantity: '1', unit_price_money: { amount: '100', currency: 'USD' }, fulfillment: { requirement: 'none' as const } }] }];
    const ids: string[] = [];
    for (const sandbox of ['A', 'B'] as const) {
      const result = await d.operator.ledger.action('cross-sandbox-key', sandbox, 'orders.create', args, async durableKey => {
        const c = await d.operator.clients.writable(sandbox); const r = await c.orders.createWithResponse(args[0], { idempotencyKey: durableKey }); return { data: r.body.data, requestId: r.meta.requestId };
      }, async response => { await d.trackOrder(sandbox, response.data.order_id); }, key);
      ids.push(result.data.order_id);
    }
    invariant(ids[0] !== ids[1], 'IDEMPOTENCY_CROSS_SANDBOX_COLLISION'); return ['SANDBOX_BUYER_RESOURCE_AND_IDEMPOTENCY_ISOLATION'];
  },
  'I-02': async d => {
    const item = d.mails.find(m => m.family === 'fulfillment_updates'); invariant(item, 'PREFERENCE_EMAIL_REQUIRED');
    const token = d.created.get('preferenceToken'); invariant(token, 'PREFERENCE_TOKEN_REQUIRED'); const e = await d.operator.clients.clients.B.emailPreferenceLinks.lookup({ token }).then(() => null, e => e);
    invariant(e?.status === 404 && e?.code === 'EMAIL_PREFERENCE_LINK_INVALID', 'PREFERENCE_TOKEN_WRONG_SANDBOX'); return ['PREFERENCE_TOKEN_ENVIRONMENT_ISOLATION'];
  },
  'I-03': async d => {
    const sameEmailCustomer = d.fixtures.values.sameEmailCustomerB, proof = d.fixtures.values.sameEmailVerificationB;
    invariant(sameEmailCustomer && proof, 'SAME_EMAIL_B_PUBLIC_PROOF_REQUIRED');
    const c = await d.operator.clients.writable('B'); invariant((await c.customers.get(sameEmailCustomer)).email === d.fixtures.buyers.b1.email, 'SAME_EMAIL_FIXTURE_MISMATCH');
    const result = await d.operator.ledger.action('link-same-email-b', 'B', 'customers.linkGuestPurchases', [sameEmailCustomer, proof], k => c.customers.linkGuestPurchases(sameEmailCustomer, { customer_verification_id: proof }, { idempotencyKey: k }), async () => {});
    invariant(result.linked_order_count === '0', 'CROSS_SANDBOX_GUEST_LINKED'); const a = await d.operator.clients.clients.A.orders.get(d.created.get('guestAchOrder')!); invariant(a.customer_id === d.fixtures.buyers.b1.customerId, 'SANDBOX_A_BINDING_CHANGED'); return ['SAME_EMAIL_GUEST_LINK_SANDBOX_ISOLATION'];
  },
  'B-01': async d => {
    await d.guardCheck();
    const page = await d.page('accessibility'); await d.goto(page, d.sf(), '/');
    for (const path of ['/', '/products/house-blend', '/cart', '/sign-in', '/sign-up']) { await d.goto(page, d.sf(), path); await d.axe(page, `sf:${path}`); }
    await d.login(page, 'b1'); for (const path of ['/', '/orders', '/payment-methods', '/profile/email']) { await d.goto(page, d.config.origins.accountA, path); await d.axe(page, `ac:${path}`); }
    await page.keyboard.press('Tab'); invariant(await page.evaluate(() => document.activeElement !== document.body), 'KEYBOARD_FOCUS_MISSING');
    await page.emulateMedia({ reducedMotion: 'reduce' }); await page.evaluate(() => { document.documentElement.style.zoom = '2'; }); await d.axe(page, 'keyboard-zoom-reduced-motion');
    const required = ['sf-home', 'sf-product', 'sf-cart-filled', 'sf-cart-empty', 'sf-checkout-ready', 'sf-checkout-declined', 'sf-checkout-requires-action', 'sf-checkout-bank-processing', 'sf-checkout-total-changed', 'sf-complete-paid', 'sf-complete-processing', 'ac-home', 'ac-orders', 'ac-order', 'ac-invoice-pay-ready', 'ac-invoice-pay-declined', 'ac-return', 'ac-subscription', 'ac-payment-methods', 'ac-profile-email', 'ac-email-preferences-token', 'sign-in', 'sign-up', 'verify-email'];
    invariant(required.every(s => d.visitedAxeStates.has(s)), 'AXE_STATE_COVERAGE_INCOMPLETE'); await d.guardCheck(); return ['WHOLE_RUN_GUARDS_KEYBOARD_AXE_ALL_REQUIRED_STATES'];
  },
  'SF-26': async d => {
    const secret = process.env.E2E_WEBHOOK_SECRET; invariant(secret && secret.startsWith('whsec_'), 'RUN_WEBHOOK_SECRET_REQUIRED');
    const envelope = d.fixtures.values.signedWebhookEnvelope; invariant(envelope?.event_type === 'order.paid' && typeof envelope.data?.order_id === 'string', 'PUBLISHED_WEBHOOK_ENVELOPE_REQUIRED');
    const checkoutRef = d.fixtures.values.webhookCheckoutRef; invariant(checkoutRef, 'WEBHOOK_OWNED_CHECKOUT_REQUIRED');
    const body = JSON.stringify(envelope), id = `msg_${d.config.run}`, timestamp = Math.floor(Date.now() / 1000).toString();
    const key = Buffer.from(secret.slice(6), 'base64'); const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
    const headers = { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` };
    const page = await d.page('webhooks'); await d.goto(page, d.sf(), '/');
    const owned = await d.job(page, `/checkout/${checkoutRef}/state`);
    invariant(owned.status === 200 && owned.body?.state?.order?.order_id === envelope.data.order_id, 'WEBHOOK_OWNED_CHECKOUT_REQUIRED');
    const send = async (h: Record<string, string>) => page.request.post(`${d.sf()}/webhooks/flint`, { data: body, headers: h });
    invariant((await send({ ...headers, 'webhook-signature': 'v1,invalid' })).status() === 400, 'WEBHOOK_BAD_SIGNATURE_ACCEPTED');
    invariant((await send(headers)).status() === 200 && (await send(headers)).status() === 200, 'WEBHOOK_VALID_OR_DEDUP_FAILED');
    // Duplicate delivery must not duplicate its buyer-visible signal.
    await d.goto(page, d.sf(), `/checkout/${checkoutRef}/complete`); await expect(page.getByText('Payment confirmed by Flint', { exact: true })).toHaveCount(1);
    return ['LOCAL_SIGNED_WEBHOOK_BAD_SIGNATURE_AND_DEDUP'];
  },
  'SF-26X': async d => {
    invariant(d.fixtures.values.realWebhookForwarding?.owned && d.fixtures.values.realWebhookForwarding?.ready, 'PUBLIC_WEBHOOK_FORWARDER_AUTHORITY_REQUIRED');
    const page = await d.page('real-webhook'), c = await d.checkout(page, 'brewing-class'); await billing(d, c); await d.pay(c); await d.settled(c);
    await expect.poll(async () => {
      const events = await d.operator.clients.clients.A.webhookEvents.list({ event_type: 'order.paid', resource_type: 'order', resource_id: c.orderId });
      return events.data.some(e => e.event_type === 'order.paid' && e.resource_type === 'order' && e.resource_id === c.orderId && e.event_origin === 'business_event' && !e.test);
    }, { timeout: 60_000 }).toBe(true);
    // The confirmation badge reads the stored delivery signal when the completion document renders.
    await expect.poll(async () => {
      await d.goto(page, c.origin, `/checkout/${c.ref}/complete`);
      return page.getByText('Payment confirmed by Flint', { exact: true }).isVisible();
    }, { timeout: 60_000 }).toBe(true);
    return ['REAL_FLINT_WEBHOOK_DELIVERY'];
  },
  'U-01': async d => {
    const commands = [['npm', ['--prefix', 'headless/storefront', 'test']], ['npm', ['--prefix', 'headless/account', 'test']], ['node', ['scripts/validate-manifests.mjs']], ['node', ['scripts/generate-index.mjs', '--check']], ['node', ['scripts/check-identity-copies.mjs']], ['node', ['scripts/check-punctuation.mjs']]] as const;
    for (const [command, args] of commands) await runChild(command, [...args], checkoutRoot, d.scanner, {});
    return ['INDEPENDENT_APP_UNIT_AND_ROOT_CONTRACT_CHECKS'];
  },
};
