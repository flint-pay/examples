import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page, Response } from '@playwright/test';
import { Driver } from '../../support/driver.ts';
import type { Checkout } from '../../support/driver.ts';

function deliveryFixture({ ready = false, pickup = false } = {}) {
  const events: string[] = [];
  let optionsReady = ready, selected = false;
  let predicate: ((response: Response) => boolean) | undefined;
  let resolveQuote!: (response: Response) => void;
  let quoteClicked!: () => void;
  const clicked = new Promise<void>(resolve => { quoteClicked = resolve; });
  const fields: Record<string, string> = { country: 'US', line1: '', postal_code: '' };
  class Locator {
    readonly id: string;
    constructor(id: string) { this.id = id; }
    first() { return this; }
    nth(index: number) { assert.equal(index, 0); return this; }
    locator(selector: string) {
      if (selector === '[data-testid^="sf-delivery-option-"]') return new Locator('shipping-option');
      if (selector === 'fieldset[data-group-id]') return new Locator('shipping-group');
      if (selector === 'input[type="radio"]') return new Locator('shipping-option');
      const field = /^\[name="([a-z0-9_]+)"\]$/.exec(selector)?.[1];
      assert.ok(field); return new Locator(field);
    }
    async count() {
      if (this.id === 'sf-delivery-mode-ship') return 0;
      if (this.id === 'shipping-option' || this.id === 'shipping-group') return optionsReady ? 1 : 0;
      return 1;
    }
    async isVisible() { return this.id === 'sf-delivery-options' ? optionsReady : true; }
    async getAttribute(name: string) { assert.equal(name, 'type'); return this.id === 'country' ? 'hidden' : 'text'; }
    async fill(value: string) { assert.notEqual(this.id, 'country'); fields[this.id] = value; events.push('fill:' + this.id); }
    async check() {
      events.push('check:' + this.id);
      if (this.id === 'shipping-option') { assert.ok(optionsReady); selected = true; }
    }
    async click() {
      events.push('click:' + this.id);
      if (this.id === 'sf-delivery-quote') { assert.ok(predicate, 'arm the exact response wait before clicking'); quoteClicked(); }
      if (this.id === 'sf-pickup-search') optionsReady = true;
      if (this.id === 'sf-pickup-select') selected = true;
    }
    async _expect(expression: string, options: { expressionArg?: string; expectedText?: { string: string }[]; timeout?: number }) {
      if (expression === 'to.have.attribute.value') {
        assert.equal(this.id, 'sf-delivery'); assert.equal(options.expressionArg, 'data-mode');
        return { matches: options.expectedText![0].string === 'ship', received: 'ship', log: [] };
      }
      if (expression === 'to.have.value') return { matches: fields[this.id] === options.expectedText![0].string, received: fields[this.id], log: [] };
      assert.equal(expression, 'to.be.visible'); assert.equal(options.timeout, 30_000);
      events.push('visible:' + this.id);
      assert.ok(this.id === 'sf-delivery-selected' ? selected : optionsReady, 'selection assertions must follow the completed quote');
      return { matches: true, log: [] };
    }
  }
  const page = {
    getByTestId: (id: string) => new Locator(id),
    locator: (selector: string) => {
      if (selector.startsWith('form[action=')) return new Locator('form');
      assert.equal(selector, pickup ? '[data-testid^="sf-pickup-location-"]' : '[data-testid^="sf-delivery-option-"]');
      return new Locator(pickup ? 'pickup-option' : 'shipping-option');
    },
    waitForResponse: (matches: (response: Response) => boolean, options: { timeout: number }) => {
      assert.equal(options.timeout, 60_000); events.push('wait:quote'); predicate = matches;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('QUOTE_RESPONSE_TIMEOUT')), options.timeout);
        resolveQuote = response => { clearTimeout(timer); resolve(response); };
      });
    },
  } as unknown as Page;
  const checkout: Checkout = { page, origin: 'https://store.example.invalid', ref: 'test-checkout', sandbox: 'A', orderId: 'test-order', state: { session: { delivery_selection_required: true } } };
  const driver = {
    fixtures: { values: { shippingAddress: { country: 'US', line1: 'Synthetic test street' } } },
    state: async () => { events.push('state'); },
    auditKnownStates: async () => { events.push('audit'); },
  } as unknown as Driver;
  const response = (url = `${checkout.origin}/checkout/${checkout.ref}/delivery/quote`, method = 'POST', status = 200) => ({ url: () => url, request: () => ({ method: () => method }), status: () => status }) as unknown as Response;
  return { driver, checkout, events, fields, clicked, response,
    reply: (value: Response) => { assert.ok(predicate); const matches = predicate(value); if (matches) { optionsReady = value.status() === 200; resolveQuote(value); } return matches; },
  };
}

test('ship-only delivery uses a ready quote without requesting another', async () => {
  const f = deliveryFixture({ ready: true });
  await Driver.prototype.delivery.call(f.driver, f.checkout);
  assert.deepEqual(f.events, ['visible:shipping-option', 'check:shipping-option', 'visible:sf-delivery-selected', 'state', 'audit']);
});

test('fresh delivery waits for its exact POST response before option selection, ignoring mismatches', async () => {
  const f = deliveryFixture();
  const delivery = Driver.prototype.delivery.call(f.driver, f.checkout);
  await f.clicked;
  assert.deepEqual(f.events, ['fill:line1', 'wait:quote', 'click:sf-delivery-quote']);
  assert.equal(f.reply(f.response('https://other.example.invalid/checkout/test-checkout/delivery/quote')), false);
  assert.equal(f.reply(f.response(`${f.checkout.origin}/checkout/other-checkout/delivery/quote`)), false);
  assert.equal(f.reply(f.response(undefined, 'GET')), false);
  assert.equal(f.reply(f.response(`${f.checkout.origin}/checkout/test-checkout/delivery/quote?other=true`)), false);
  assert.equal(f.events.some(event => event.startsWith('visible:')), false);
  assert.equal(f.reply(f.response()), true); await delivery;
  assert.equal(f.events.filter(event => event === 'click:sf-delivery-quote').length, 1);
  assert.deepEqual(f.events.slice(-5), ['visible:shipping-option', 'check:shipping-option', 'visible:sf-delivery-selected', 'state', 'audit']);
  assert.equal(f.fields.country, 'US');
});

test('a first 503 followed by the native successful retry selects delivery after one click', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const f = deliveryFixture();
  const delivery = Driver.prototype.delivery.call(f.driver, f.checkout);
  await f.clicked;
  assert.equal(f.reply(f.response(undefined, 'POST', 503)), false);
  assert.deepEqual(f.events, ['fill:line1', 'wait:quote', 'click:sf-delivery-quote']);
  t.mock.timers.tick(2000);
  assert.equal(f.reply(f.response()), true); await delivery;
  assert.equal(f.events.filter(event => event === 'click:sf-delivery-quote').length, 1);
  assert.deepEqual(f.events.slice(-5), ['visible:shipping-option', 'check:shipping-option', 'visible:sf-delivery-selected', 'state', 'audit']);
});

test('persistent 503s exhaust the original 60-second budget before selection or state reads', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const f = deliveryFixture();
  const delivery = Driver.prototype.delivery.call(f.driver, f.checkout);
  const rejected = assert.rejects(delivery, /QUOTE_RESPONSE_TIMEOUT/);
  let ended = false; void delivery.then(() => { ended = true; }, () => { ended = true; });
  await f.clicked; assert.equal(f.reply(f.response(undefined, 'POST', 503)), false);
  t.mock.timers.tick(2000); assert.equal(f.reply(f.response(undefined, 'POST', 503)), false);
  t.mock.timers.tick(57_999); await Promise.resolve();
  assert.equal(ended, false);
  assert.deepEqual(f.events, ['fill:line1', 'wait:quote', 'click:sf-delivery-quote']);
  t.mock.timers.tick(1); await rejected;
  assert.equal(ended, true); assert.equal(Date.now(), 60_000);
  assert.deepEqual(f.events, ['fill:line1', 'wait:quote', 'click:sf-delivery-quote']);
});

test('pickup keeps its existing search and explicit selection without a shipping quote wait', async () => {
  const f = deliveryFixture({ pickup: true });
  await Driver.prototype.delivery.call(f.driver, f.checkout, true);
  assert.deepEqual(f.events, ['check:sf-delivery-mode-pickup', 'fill:postal_code', 'click:sf-pickup-search', 'visible:pickup-option', 'check:pickup-option', 'click:sf-pickup-select', 'visible:sf-delivery-selected', 'state', 'audit']);
});
