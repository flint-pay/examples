import test from 'node:test';
import assert from 'node:assert/strict';
import type { Response } from '@playwright/test';
import type { WebhookEvent } from '@flintpay/node';
import type { Driver, Checkout } from '../../support/driver.ts';
import { storefront } from '../../scenarios/storefront.ts';
import { crossApp } from '../../scenarios/cross-app.ts';

type State = { ref: string; billed: boolean; consent: boolean; verified: boolean; saved: boolean; paid: boolean; focused?: string; fields: Record<string, string> };
type Verification = { nativeStatus?: number; nativeCode?: string; nativeCompletion?: Promise<void>; nativeStarted?: () => void; requestStatus?: number; confirmStatus?: number; codes?: string[]; authorized?: boolean };
function harness(billingNeeded = true, savingCards = true, verification: Verification = {}) {
  const events: string[] = []; let sequence = 0, savedCard = false;
  const activations: { ref: string; activation: string }[] = [], keypresses: { ref: string; key: string }[] = [];
  const states: State[] = [];
  type Page = { current: State; completionLoaded: boolean; nativeResponse?: (response: Response) => void; getByTestId: (id: string) => Locator; locator: (selector: string) => Locator; getByText: (text: string) => Locator; reload: () => Promise<void>; waitForResponse: (predicate: (response: Response) => boolean, options: { timeout: number }) => Promise<Response>; keyboard: { press: (key: string) => Promise<void> } };
  class Locator {
    readonly page: Page; readonly id: string;
    constructor(page: Page, id: string) { this.page = page; this.id = id; }
    first() { return this; }
    async isVisible() { return this.id === 'webhook' ? this.page.completionLoaded : this.id !== 'sf-billing' || billingNeeded; }
    async getAttribute(name: string) {
      assert.equal(name, 'data-state');
      return this.id === 'sf-billing' ? this.page.current.billed ? 'set' : 'needed' : this.page.current.billed ? 'ready' : 'needs_billing';
    }
    async fill(value: string) { this.page.current.fields[this.id] = value; }
    async focus() {
      assert.equal(this.id, 'sf-pay-button');
      assert.ok(events.includes(`enabled:${this.page.current.ref}`));
      this.page.current.focused = this.id; events.push(`focus:${this.page.current.ref}`);
    }
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
        throw new Error('saved-card payment must use one keyboard activation');
      }
    }
    async _expect(expression: string, options: { expectedText?: { string: string }[]; expressionArg?: string }) {
      if (expression === 'to.be.visible') return { matches: this.id === 'webhook' ? this.page.completionLoaded : this.id !== 'sf-pay-form' || this.page.current.billed, log: [] };
      if (expression === 'to.be.enabled') { events.push(`enabled:${this.page.current.ref}`); return { matches: this.page.current.billed && this.page.current.saved, log: [] }; }
      if (expression === 'to.be.focused') { events.push(`focused:${this.page.current.ref}`); return { matches: this.page.current.focused === this.id, log: [] }; }
      assert.equal(expression, 'to.have.attribute.value');
      const received = await this.getAttribute(options.expressionArg!);
      return { matches: received === options.expectedText![0].string, received, log: [] };
    }
  }
  function page(): Page {
    const p: Page = {
      current: undefined as unknown as State,
      completionLoaded: false,
      getByTestId: (id: string) => new Locator(p, id),
      locator: (selector: string) => { assert.equal(selector, '[data-testid^="sf-saved-method-"]'); return new Locator(p, 'saved'); },
      getByText: (text: string) => { assert.equal(text, 'Payment confirmed by Flint'); return new Locator(p, 'webhook'); },
      reload: async () => { p.current.consent = false; events.push(`reload:${p.current.ref}`); },
      waitForResponse: (predicate, options) => {
        assert.equal(options.timeout, 60_000);
        return new Promise(resolve => { p.nativeResponse = response => { assert.equal(predicate(response), true); resolve(response); }; });
      },
      keyboard: { press: async key => {
        const s = p.current;
        assert.equal(key, 'Enter'); assert.equal(s.focused, 'sf-pay-button'); assert.equal(s.billed && s.saved && s.verified, true);
        assert.ok(events.includes(`focused:${s.ref}`)); assert.equal(s.paid, false, 'saved-card payment activates once');
        keypresses.push({ ref: s.ref, key }); s.paid = true; events.push(`pay:${s.ref}`);
      } },
    };
    return p;
  }
  const d = {
    fixtures: { buyers: { b1b: { email: 'buyer@example.invalid' } }, values: { sandboxSmsPhone: '+12025550123', realWebhookForwarding: { owned: true, ready: true } } },
    page: async () => page(),
    sf: () => 'https://storefront.example.invalid',
    goto: async (p: Page, origin: string, path: string) => {
      assert.equal(origin, d.sf()); assert.equal(path, `/checkout/${p.current.ref}/complete`);
      assert.equal(events.filter(event => event === 'webhook-read').length, 2, 'unrelated and synthetic metadata must be skipped before reloading completion');
      p.completionLoaded = true; events.push(`completion:${p.current.ref}`);
    },
    checkout: async (p: Page, product: string, sandbox?: string, buyer?: string) => {
      assert.equal(product, 'brewing-class'); if (sandbox) { assert.equal(sandbox, 'B'); assert.equal(buyer, 'b1b'); }
      const s: State = { ref: `chk_UNIT_${++sequence}`, billed: !billingNeeded, consent: false, verified: false, saved: false, paid: false, fields: {} };
      p.current = s; states.push(s); events.push(`checkout:${s.ref}`);
      if (p.nativeResponse) {
        const response = {
          url: () => `${d.sf()}/checkout/${s.ref}/verification`, status: () => verification.nativeStatus ?? 409,
          request: () => ({ method: () => 'POST', postDataJSON: () => ({ purpose: 'use_saved_payment_methods', channel: 'auto', email: d.fixtures.buyers.b1b.email }) }),
          json: async () => { verification.nativeStarted?.(); await verification.nativeCompletion; events.push(`recognition:${s.ref}`); return { error: { code: verification.nativeCode ?? 'CUSTOMER_VERIFICATION_NOT_SENT' } }; },
        } as unknown as Response;
        p.nativeResponse(response); delete p.nativeResponse;
      }
      return { page: p, ref: s.ref, origin: d.sf(), orderId: `ord_UNIT_${sequence}` } as unknown as Checkout;
    },
    state: async (c: Checkout) => { const p = c.page as unknown as Page; assert.equal(p.current.billed, true); events.push(`state:${c.ref}`); return { session: { save_payment_method_offered: true, save_payment_method_requires_verification: !p.current.verified || verification.authorized === false } }; },
    email: async (buyer: string, _after: Date, family: string) => { assert.equal(buyer, 'b1b'); assert.equal(family, 'checkout_verification'); return { codes: verification.codes ?? ['246810'] }; },
    job: async (p: Page, path: string, body: { purpose?: string; code?: string }) => {
      assert.ok(path.startsWith(`/checkout/${p.current.ref}/verification`));
      if (body.purpose === 'save_payment_method') {
        assert.ok(events.includes(`recognition:${p.current.ref}`), 'native recognition must finish before requesting a save code');
        events.push(`save-code:${p.current.ref}`); return { status: verification.requestStatus ?? 200 };
      }
      if (path.endsWith('/confirm') && body.code === '246810') { p.current.verified = verification.confirmStatus === undefined || verification.confirmStatus === 200; return { status: verification.confirmStatus ?? 200 }; }
      return { status: body.code === '000000' ? 400 : body.code === '999999' ? 503 : 200 };
    },
    form: async (p: Page, path: string) => { assert.equal(path, `/checkout/${p.current.ref}/verification/confirm`); p.current.verified = true; },
    pay: async (c: Checkout, number?: string, options: { activation?: string } = {}) => {
      const s = (c.page as unknown as Page).current; assert.equal(s.billed, true, 'billing must precede pay');
      if (savingCards) {
        assert.equal(number, undefined); assert.equal(options.activation, 'keyboard');
        assert.equal(s.consent, true, 'save-card consent must be checked after reload');
        assert.ok(s.verified || s.fields['sf-save-phone'] === d.fixtures.values.sandboxSmsPhone);
      }
      assert.equal(s.paid, false, 'card payment activates once'); activations.push({ ref: s.ref, activation: options.activation ?? 'pointer' });
      s.paid = true; if (s.verified) savedCard = true; events.push(`pay:${c.ref}`);
    },
    settled: async (c: Checkout) => { assert.equal((c.page as unknown as Page).current.paid, true); events.push(`settled:${c.ref}`); },
    operator: { clients: { clients: { A: { webhookEvents: { list: async (query: unknown) => {
      assert.deepEqual(query, { event_type: 'order.paid', resource_type: 'order', resource_id: 'ord_UNIT_1' }); events.push('webhook-read');
      const event={webhook_event_id:'evt_UNIT_1',event_type:'order.paid',event_origin:'business_event',created_at:new Date().toISOString(),resource_type:'order',resource_id:'ord_UNIT_1',test:false} satisfies WebhookEvent;
      return { data: events.filter(event => event === 'webhook-read').length === 1 ? [{...event,resource_type:'invoice'}, {...event,resource_id:'ord_UNIT_OTHER'}, {...event,event_origin:'test_api',test:true}] : [event] };
    } } } } } },
  };
  return { driver: d as unknown as Driver, events, states, activations, keypresses };
}

test('SF-24 prepares billing for all three service checkouts before payment', async () => {
  const { driver, events, states } = harness();
  assert.deepEqual(await storefront['SF-24'](driver), ['HOSTED_MODE_EMAIL_AND_SMS_SAVED_METHOD']);
  assert.equal(states.length, 3);
  for (const s of states) assert.ok(events.indexOf(`billing:${s.ref}`) < events.indexOf(`pay:${s.ref}`));
});

test('SF-24 uses two keyboard card payments and one focused saved-card Enter without refilling its card', async () => {
  const { driver, events, activations, keypresses } = harness();
  await storefront['SF-24'](driver);
  assert.deepEqual(activations, [{ ref: 'chk_UNIT_1', activation: 'keyboard' }, { ref: 'chk_UNIT_3', activation: 'keyboard' }]);
  assert.deepEqual(keypresses, [{ ref: 'chk_UNIT_2', key: 'Enter' }]);
  assert.deepEqual(events.filter(event => event.endsWith(':chk_UNIT_2')), ['checkout:chk_UNIT_2', 'billing:chk_UNIT_2', 'state:chk_UNIT_2', 'enabled:chk_UNIT_2', 'focus:chk_UNIT_2', 'focused:chk_UNIT_2', 'pay:chk_UNIT_2', 'settled:chk_UNIT_2']);
  assert.equal(events.filter(event => event.startsWith('pay:')).length, 3);
  assert.equal(events.filter(event => event.startsWith('settled:')).length, 3);
});

test('SF-24 renews save-card consent after verification reload even without billing', async () => {
  const { driver, events } = harness(false);
  await storefront['SF-24'](driver);
  assert.deepEqual(events.filter(e => e.endsWith(':chk_UNIT_1')), ['checkout:chk_UNIT_1', 'recognition:chk_UNIT_1', 'consent:chk_UNIT_1', 'save-code:chk_UNIT_1', 'state:chk_UNIT_1', 'reload:chk_UNIT_1', 'consent:chk_UNIT_1', 'pay:chk_UNIT_1', 'settled:chk_UNIT_1']);
});

test('SF-24 waits for the native recognition response body before requesting a save code', async () => {
  let release!: () => void, started!: () => void;
  const nativeCompletion = new Promise<void>(resolve => { release = resolve; });
  const nativeStarted = new Promise<void>(resolve => { started = resolve; });
  const { driver, events } = harness(false, true, { nativeCompletion, nativeStarted: started });
  const execution = storefront['SF-24'](driver);
  await nativeStarted;
  assert.deepEqual(events, ['checkout:chk_UNIT_1']);
  release(); await execution;
  assert.ok(events.indexOf('recognition:chk_UNIT_1') < events.indexOf('save-code:chk_UNIT_1'));
});

test('SF-24 accepts successful native recognition before requesting its save code', async () => {
  const { driver, events } = harness(false, true, { nativeStatus: 200 });
  await storefront['SF-24'](driver);
  assert.ok(events.includes('save-code:chk_UNIT_1'));
});

for (const [name, verification, code] of [
  ['unexpected native failure', { nativeCode: 'PAYMENT_ATTEMPT_IN_PROGRESS' }, 'NATIVE_RECOGNITION_FAILED'],
  ['rejected save-code request', { requestStatus: 409 }, 'SAVE_CARD_VERIFICATION_REQUEST_FAILED'],
  ['missing delivered code', { codes: [] }, 'EMAIL_CODE_AMBIGUOUS'],
  ['ambiguous delivered codes', { codes: ['246810', '135790'] }, 'EMAIL_CODE_AMBIGUOUS'],
  ['rejected actual-code confirmation', { confirmStatus: 400 }, 'SAVE_CARD_VERIFICATION_CONFIRM_FAILED'],
  ['missing saved-card authorization', { authorized: false }, 'SAVE_CARD_AUTHORIZATION_REQUIRED'],
] as const) {
  test(`SF-24 stops before paying after ${name}`, async () => {
    const { driver, events } = harness(false, true, verification as Verification);
    await assert.rejects(storefront['SF-24'](driver), { code });
    assert.equal(events.some(event => event.startsWith('pay:')), false);
    assert.equal(events.some(event => event.startsWith('reload:')), false);
  });
}

test('SF-26X correlates payload-free event metadata before reloading its owned completion', async () => {
  const { driver, events, activations, keypresses } = harness(true, false);
  assert.deepEqual(await crossApp['SF-26X'](driver), ['REAL_FLINT_WEBHOOK_DELIVERY']);
  assert.deepEqual(events, ['checkout:chk_UNIT_1', 'billing:chk_UNIT_1', 'state:chk_UNIT_1', 'pay:chk_UNIT_1', 'settled:chk_UNIT_1', 'webhook-read', 'webhook-read', 'completion:chk_UNIT_1']);
  assert.deepEqual(activations, [{ ref: 'chk_UNIT_1', activation: 'pointer' }]); assert.deepEqual(keypresses, []);
});
