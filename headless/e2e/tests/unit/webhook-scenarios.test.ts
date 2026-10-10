import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Client } from '@flintpay/node';
import type { Webhook_order_paid_merchant } from '@flintpay/node';
import type { Driver } from '../../support/driver.ts';
import { crossApp } from '../../scenarios/cross-app.ts';

function signedHarness(envelope: unknown, orderId = 'ord_UNIT_1') {
  const deliveries: string[] = [], reads: string[] = [], verifiedOrders: unknown[] = [];
  const secret = 'whsec_' + randomBytes(32).toString('base64');
  class Locator {
    async _expect(expression: string, options: { expectedNumber: number }) {
      assert.equal(expression, 'to.have.count'); assert.equal(options.expectedNumber, 1);
      assert.equal(new Set(deliveries).size, 1); return { matches: true, log: [] };
    }
  }
  const page = {
    request: { post: async (_url: string, options: { data: string; headers: Record<string, string> }) => {
      try {
        const verified = new Client().verifyWebhook(Buffer.from(options.data), options.headers, secret);
        verifiedOrders.push((verified.event as Webhook_order_paid_merchant).data.order_id); deliveries.push(options.headers['webhook-id']!);
        return { status: () => 200 };
      } catch { return { status: () => 400 }; }
    } },
    getByText: (text: string, options: { exact: boolean }) => {
      assert.equal(text, 'Payment confirmed by Flint'); assert.equal(options.exact, true);
      return new Locator();
    },
  };
  const driver = {
    config: { run: '20261010T000000Z-00000000' },
    fixtures: { values: { signedWebhookEnvelope: envelope, webhookCheckoutRef: 'chk_UNIT_1' } },
    page: async () => page, sf: () => 'https://storefront.example.invalid',
    goto: async (_page: unknown, origin: string, path: string) => {
      assert.equal(origin, 'https://storefront.example.invalid'); assert.ok(['/', '/checkout/chk_UNIT_1/complete'].includes(path));
    },
    job: async (_page: unknown, path: string) => {
      assert.equal(path, '/checkout/chk_UNIT_1/state'); reads.push(path);
      return { status: 200, body: { state: { order: { order_id: orderId } } } };
    },
  } as unknown as Driver;
  return { driver, secret, deliveries, reads, verifiedOrders };
}
function envelope() {
  return { api_version: '2026-07-22', webhook_event_id: 'evt_UNIT_1', event_type: 'order.paid', payload_version: 1, mode: 'test', merchant_id: 'merchant-unit', created_at: new Date().toISOString(), request: null, data: { order_id: 'ord_UNIT_1', line_items: [], order_payment_intent_ids: [], outstanding_money: { amount: 0, currency: 'USD' }, paid_money: { amount: 100, currency: 'USD' }, total_money: { amount: 100, currency: 'USD' }, payment_status: 'paid', status: 'open' } } satisfies Webhook_order_paid_merchant;
}
function useSecret(secret: string, t: TestContext) {
  const previous = process.env.E2E_WEBHOOK_SECRET; process.env.E2E_WEBHOOK_SECRET = secret;
  t.after(() => { if (previous === undefined) delete process.env.E2E_WEBHOOK_SECRET; else process.env.E2E_WEBHOOK_SECRET = previous; });
}
test('SF-26 signs direct published order data and binds it to the owned checkout', async t => {
  const h = signedHarness(envelope()); useSecret(h.secret, t);
  assert.deepEqual(await crossApp['SF-26'](h.driver), ['LOCAL_SIGNED_WEBHOOK_BAD_SIGNATURE_AND_DEDUP']);
  assert.equal(h.deliveries.length, 2); assert.deepEqual(h.verifiedOrders, ['ord_UNIT_1', 'ord_UNIT_1']); assert.deepEqual(h.reads, ['/checkout/chk_UNIT_1/state']);
});
test('SF-26 refuses the old nested fixture before sending a signed event', async t => {
  const h = signedHarness({ ...envelope(), data: { order: { order_id: 'ord_UNIT_1' } } }); useSecret(h.secret, t);
  await assert.rejects(crossApp['SF-26'](h.driver), { code: 'PUBLISHED_WEBHOOK_ENVELOPE_REQUIRED' });
  assert.equal(h.deliveries.length, 0);
});
test('SF-26 refuses a direct event for a different order than the owned checkout', async t => {
  const h = signedHarness(envelope(), 'ord_UNIT_OTHER'); useSecret(h.secret, t);
  await assert.rejects(crossApp['SF-26'](h.driver), { code: 'WEBHOOK_OWNED_CHECKOUT_REQUIRED' });
  assert.equal(h.deliveries.length, 0);
});
