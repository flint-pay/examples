import test from 'node:test';
import assert from 'node:assert/strict';
import type { Driver, Checkout } from '../../support/driver.ts';
import { storefront } from '../../scenarios/storefront.ts';
import { crossApp } from '../../scenarios/cross-app.ts';

type State = { ref: string; billed: boolean; consent: boolean; verified: boolean; saved: boolean; paid: boolean; fields: Record<string, string> };
function harness(billingNeeded = true, savingCards = true) {
  const events: string[] = []; let sequence = 0, savedCard = false;
  const states: State[] = [];
  type Page = { current: State; getByTestId: (id: string) => Locator; locator: (selector: string) => Locator; getByText: (text: string) => Locator; reload: () => Promise<void> };
  class Locator {
    readonly page: Page; readonly id: string;
    constructor(page: Page, id: string) { this.page = page; this.id = id; }
    first() { return this; }
    async isVisible() { return this.id !== 'sf-billing' || billingNeeded; }
    async getAttribute(name: string) {
      assert.equal(name, 'data-state');
      return this.id === 'sf-billing' ? this.page.current.billed ? 'set' : 'needed' : this.page.current.billed ? 'ready' : 'needs_billing';
    }
    async fill(value: string) { this.page.current.fields[this.id] = value; }
    async check() {
      const s = this.page.current; assert.equal(s.billed, true, 'billing must precede payment controls');
      if (this.id === 'sf-save-card') { s.consent = true; events.push(`consent:${s.ref}`); }
      else { assert.equal(savedCard && s.verified, true); s.saved = true; }
    }
    async click() {
      const s = this.page.current;
      if (this.id === 'sf-billing-save') {
        for (const field of ['sf-bill-line1', 'sf-bill-city', 'sf-bill-state', 'sf-bill-postal']) assert.ok(s.fields[field]);
        s.billed = true; events.push(`billing:${s.ref}`);
      } else {
        assert.equal(this.id, 'sf-pay-button'); assert.equal(s.billed && s.saved, true);
        s.paid = true; events.push(`pay:${s.ref}`);
      }
    }
    async _expect(expression: string, options: { expectedText?: { string: string }[]; expressionArg?: string }) {
      if (expression === 'to.be.visible') return { matches: this.id !== 'sf-pay-form' || this.page.current.billed, log: [] };
      assert.equal(expression, 'to.have.attribute.value');
      const received = await this.getAttribute(options.expressionArg!);
      return { matches: received === options.expectedText![0].string, received, log: [] };
    }
  }
  function page(): Page {
    const p = {
      current: undefined as unknown as State,
      getByTestId: (id: string) => new Locator(p, id),
      locator: (selector: string) => { assert.equal(selector, '[data-testid^="sf-saved-method-"]'); return new Locator(p, 'saved'); },
      getByText: (text: string) => { assert.equal(text, 'Payment confirmed by Flint'); return new Locator(p, 'webhook'); },
      reload: async () => { p.current.consent = false; events.push(`reload:${p.current.ref}`); },
    };
    return p;
  }
  const d = {
    fixtures: { buyers: { b1b: { email: 'buyer@example.invalid' } }, values: { sandboxSmsPhone: '+12025550123', realWebhookForwarding: { owned: true, ready: true } } },
    page: async () => page(),
    checkout: async (p: Page, product: string, sandbox?: string, buyer?: string) => {
      assert.equal(product, 'brewing-class'); if (sandbox) { assert.equal(sandbox, 'B'); assert.equal(buyer, 'b1b'); }
      const s: State = { ref: `chk_UNIT_${++sequence}`, billed: !billingNeeded, consent: false, verified: false, saved: false, paid: false, fields: {} };
      p.current = s; states.push(s); events.push(`checkout:${s.ref}`);
      return { page: p, ref: s.ref, orderId: `ord_UNIT_${sequence}` } as unknown as Checkout;
    },
    state: async (c: Checkout) => { const p = c.page as unknown as Page; assert.equal(p.current.billed, true); events.push(`state:${c.ref}`); },
    email: async (buyer: string, _after: Date, family: string) => { assert.equal(buyer, 'b1b'); assert.equal(family, 'checkout_verification'); return { codes: ['246810'] }; },
    job: async (p: Page, path: string, body: { purpose?: string; code?: string }) => {
      assert.ok(path.startsWith(`/checkout/${p.current.ref}/verification`));
      if (path.endsWith('/confirm') && body.code === '246810') p.current.verified = true;
      return { status: body.code === '000000' ? 400 : body.code === '999999' ? 503 : 200 };
    },
    form: async (p: Page, path: string) => { assert.equal(path, `/checkout/${p.current.ref}/verification/confirm`); p.current.verified = true; },
    pay: async (c: Checkout) => {
      const s = (c.page as unknown as Page).current; assert.equal(s.billed, true, 'billing must precede pay');
      if (savingCards) {
        assert.equal(s.consent, true, 'save-card consent must be checked after reload');
        assert.ok(s.verified || s.fields['sf-save-phone'] === d.fixtures.values.sandboxSmsPhone);
      }
      s.paid = true; if (s.verified) savedCard = true; events.push(`pay:${c.ref}`);
    },
    settled: async (c: Checkout) => { assert.equal((c.page as unknown as Page).current.paid, true); events.push(`settled:${c.ref}`); },
    operator: { clients: { clients: { A: { webhookEvents: { list: async (query: unknown) => { assert.deepEqual(query, { event_type: 'order.paid' }); events.push('webhook-read'); return { data: [{ data: { order_id: 'ord_UNIT_1' } }] }; } } } } } },
  };
  return { driver: d as unknown as Driver, events, states };
}

test('SF-24 prepares billing for all three service checkouts before payment', async () => {
  const { driver, events, states } = harness();
  assert.deepEqual(await storefront['SF-24'](driver), ['HOSTED_MODE_EMAIL_AND_SMS_SAVED_METHOD']);
  assert.equal(states.length, 3);
  for (const s of states) assert.ok(events.indexOf(`billing:${s.ref}`) < events.indexOf(`pay:${s.ref}`));
});

test('SF-24 renews save-card consent after verification reload even without billing', async () => {
  const { driver, events } = harness(false);
  await storefront['SF-24'](driver);
  assert.deepEqual(events.filter(e => e.endsWith(':chk_UNIT_1')), ['checkout:chk_UNIT_1', 'consent:chk_UNIT_1', 'reload:chk_UNIT_1', 'consent:chk_UNIT_1', 'pay:chk_UNIT_1', 'settled:chk_UNIT_1']);
});

test('SF-26X prepares billing before payment and retains the delivered webhook check', async () => {
  const { driver, events } = harness(true, false);
  assert.deepEqual(await crossApp['SF-26X'](driver), ['REAL_FLINT_WEBHOOK_DELIVERY']);
  assert.deepEqual(events, ['checkout:chk_UNIT_1', 'billing:chk_UNIT_1', 'state:chk_UNIT_1', 'pay:chk_UNIT_1', 'settled:chk_UNIT_1', 'webhook-read']);
});
