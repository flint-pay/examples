import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { Driver } from '../../support/driver.ts';
import type { Checkout } from '../../support/driver.ts';

type StateResponse = { status: number; body: any };
const resolving: StateResponse = { status: 409, body: { error: { code: 'CHECKOUT_PAYMENT_RESOLVING' }, state: { order: { order_id: 'conflict-projection' } } } };
const ready: StateResponse = { status: 200, body: { state: { order: { order_id: 'authoritative-order' } } } };
function stateDriver(reply: (request: number) => Promise<StateResponse>) {
  const checkout: Checkout = { page: {} as Page, ref: 'test-checkout', origin: 'https://store.example.invalid', sandbox: 'A', orderId: '', state: null };
  let requests = 0;
  const driver = { job: async (page: Page, path: string, body?: unknown) => {
    assert.equal(page, checkout.page); assert.equal(path, '/checkout/test-checkout/state');
    assert.equal(body, undefined, 'state recovery must only read');
    return reply(++requests);
  } } as unknown as Driver;
  return { checkout, driver, requests: () => requests };
}

test('initial state repeats only the resolving conflict and requires a fresh authoritative 200', async () => {
  const f = stateDriver(async request => {
    await new Promise(resolve => setTimeout(resolve, 5));
    return request === 1 ? resolving : ready;
  });
  const state = await Driver.prototype.state.call(f.driver, f.checkout, { initial: true });
  assert.equal(state, ready.body.state); assert.equal(f.checkout.orderId, 'authoritative-order');
  assert.equal(f.requests(), 2);
});

for (const response of [
  { status: 409, body: { error: { code: 'PAYMENT_ATTEMPT_IN_PROGRESS' } } },
  { status: 503, body: { error: { code: 'CHECKOUT_PAYMENT_RESOLVING' } } },
  { status: 401, body: { error: { code: 'SESSION_ENDED' } } },
  { status: 409, body: null },
]) test(`initial state refuses unexpected ${response.status}/${response.body?.error?.code ?? 'no error code'} without retrying`, async () => {
  const f = stateDriver(async () => response);
  await assert.rejects(() => Driver.prototype.state.call(f.driver, f.checkout, { initial: true }), { code: 'CHECKOUT_STATE_INVALID' });
  assert.equal(f.requests(), 1); assert.equal(f.checkout.state, null); assert.equal(f.checkout.orderId, '');
});

test('initial state stops after three resolving responses without accepting their projections', async () => {
  const f = stateDriver(async () => resolving);
  await assert.rejects(() => Driver.prototype.state.call(f.driver, f.checkout, { initial: true }), { code: 'CHECKOUT_STATE_INVALID' });
  assert.equal(f.requests(), 3); assert.equal(f.checkout.state, null); assert.equal(f.checkout.orderId, '');
});

for (const phase of ['fetch', 'body']) test(`initial state aborts a stalled ${phase} within the shared deadline without late ledger writes`, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), milliseconds); return controller.signal;
  });
  let secondStarted!: () => void;
  const started = new Promise<void>(resolve => { secondStarted = resolve; });
  let requests = 0, aborted = 0;
  let resolveLate!: (value: any) => void;
  t.mock.method(globalThis, 'fetch', async (path: string, options: RequestInit) => {
    assert.equal(path, '/checkout/test-checkout/state'); assert.equal(options.method, 'GET');
    if (++requests === 1) {
      t.mock.timers.tick(20_000);
      return new Response(JSON.stringify({ error: { code: 'CHECKOUT_PAYMENT_RESOLVING' } }), { status: 409 });
    }
    const stalled = new Promise<any>((resolve, reject) => {
      resolveLate = resolve;
      options.signal!.addEventListener('abort', () => { aborted++; reject(options.signal!.reason); }, { once: true });
    });
    secondStarted();
    return phase === 'fetch' ? stalled : { status: 200, text: () => stalled };
  });
  const tracked: string[] = [];
  const f = stateDriver(async () => { throw new Error('must use the actual job'); });
  f.checkout.page = {
    url: () => f.checkout.origin,
    evaluate: (fn: (args: any) => Promise<unknown>, args: any) => fn(args),
  } as unknown as Page;
  Object.assign(f.driver, {
    job: Driver.prototype.job,
    config: { origins: { storefrontA: f.checkout.origin } },
    csrf: async () => 'synthetic-csrf', sf: () => f.checkout.origin,
    trackOrder: async (_sandbox: string, orderId: string) => { tracked.push(orderId); },
  });
  const reading = Driver.prototype.state.call(f.driver, f.checkout, { initial: true });
  const rejected = assert.rejects(reading, { code: 'CHECKOUT_STATE_INVALID' });
  await started;
  t.mock.timers.tick(10_000);
  await rejected;
  assert.equal(aborted, 1); assert.equal(requests, 2);
  resolveLate(phase === 'fetch' ? new Response(JSON.stringify(ready.body)) : JSON.stringify(ready.body));
  await Promise.resolve();
  assert.deepEqual(tracked, []); assert.equal(f.checkout.state, null); assert.equal(f.checkout.orderId, '');
});

test('initial state refuses another request when the shared deadline has expired', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const f = stateDriver(async () => { t.mock.timers.tick(30_000); return resolving; });
  await assert.rejects(() => Driver.prototype.state.call(f.driver, f.checkout, { initial: true }), { code: 'CHECKOUT_STATE_INVALID' });
  assert.equal(f.requests(), 1);
});

test('initial state rejects a 200 without an authoritative order ID after resolving', async () => {
  const f = stateDriver(async request => request === 1 ? resolving : { status: 200, body: { state: { order: {} } } });
  await assert.rejects(() => Driver.prototype.state.call(f.driver, f.checkout, { initial: true }), { code: 'CHECKOUT_STATE_INVALID' });
  assert.equal(f.requests(), 2); assert.equal(f.checkout.state, null); assert.equal(f.checkout.orderId, '');
});

test('ordinary state reads still reject resolving immediately', async () => {
  const f = stateDriver(async () => resolving);
  await assert.rejects(() => Driver.prototype.state.call(f.driver, f.checkout), { code: 'CHECKOUT_STATE_INVALID' });
  assert.equal(f.requests(), 1); assert.equal(f.checkout.state, null); assert.equal(f.checkout.orderId, '');
});

type Field = { tagName: string; type?: string; value: string };
function formPage() {
  const fields: Record<string, Field> = {
    country: { tagName: 'INPUT', type: 'hidden', value: 'US' },
    label: { tagName: 'INPUT', type: 'text', value: '' },
    purpose: { tagName: 'SELECT', value: 'shipping' },
  };
  const submissions: Record<string, string>[] = [];
  class Locator {
    readonly field?: Field;
    constructor(field?: Field) { this.field = field; }
    first() { return this; }
    locator(selector: string) {
      const name = /^\[name="([^"]+)"\]$/.exec(selector)?.[1];
      return new Locator(name ? fields[name] : undefined);
    }
    async evaluate(fn: (element: Field) => unknown) { return fn(this.field!); }
    async getAttribute(name: string) { return name === 'type' ? this.field?.type ?? null : null; }
    async fill(value: string) {
      assert.notEqual(this.field?.type, 'hidden', 'a browser cannot fill a hidden input');
      assert.equal(this.field?.tagName, 'INPUT'); this.field!.value = value;
    }
    async selectOption(value: string) { assert.equal(this.field?.tagName, 'SELECT'); this.field!.value = value; }
    async click() { submissions.push(Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.value]))); }
    async _expect(expression: string, options: { expectedText?: { string: string }[] }) {
      if (expression === 'to.be.visible') return { matches: true, log: [] };
      assert.equal(expression, 'to.have.value');
      return { matches: this.field?.value === options.expectedText![0].string, received: this.field?.value, log: [] };
    }
  }
  const page = {
    locator: (selector: string) => { assert.equal(selector, 'form[action="/addresses"]:visible'); return new Locator(); },
    waitForLoadState: async (state: string) => { assert.equal(state, 'domcontentloaded'); },
    waitForNavigation: async (options: { waitUntil: string }) => { assert.equal(options.waitUntil, 'domcontentloaded'); },
  } as unknown as Page;
  return { page, fields, submissions };
}

test('form submits the existing hidden country with edited input and select values', async () => {
  const { page, fields, submissions } = formPage();
  await Driver.prototype.form.call({} as Driver, page, '/addresses', { country: 'US', label: 'Acceptance address', purpose: 'billing' });
  assert.deepEqual(submissions, [{ country: 'US', label: 'Acceptance address', purpose: 'billing' }]);
  assert.equal(fields.country.value, 'US');
});

test('form refuses a hidden-value mismatch before changing it or submitting', async () => {
  const { page, fields, submissions } = formPage();
  await assert.rejects(() => Driver.prototype.form.call({} as Driver, page, '/addresses', { country: 'CA' }), /toHaveValue/);
  assert.equal(fields.country.value, 'US'); assert.deepEqual(submissions, []);
});

function challengeFrame(url: string, label: string, events: string[]) {
  return {
    url: () => url,
    getByRole: (role: string, options: { name: RegExp }) => {
      assert.equal(role, 'button');
      return { isVisible: async () => options.name.test(label), click: async () => { events.push(`click:${url}:${label}`); } };
    },
  };
}
for (const [outcome, label] of [['success', 'COMPLETE'], ['fail', 'FAIL'], ['success', 'Complete authentication'], ['fail', 'Fail authentication']] as const) {
  test(`challenge selects ${label} in a Stripe frame after the existing audits`, async () => {
    const events: string[] = [];
    const page = { frames: () => [challengeFrame('https://account.example.invalid', label, events), challengeFrame('https://hooks.stripe.com/3ds', label, events)] } as unknown as Page;
    const driver = { auditKnownStates: async (p: Page) => { assert.equal(p, page); events.push('audit'); } } as unknown as Driver;
    await Driver.prototype.challenge.call(driver, page, outcome);
    assert.deepEqual(events, ['audit', `click:https://hooks.stripe.com/3ds:${label}`]);
  });
}

test('challenge refuses merchant frames, lookalikes, insecure or credentialed origins, and inexact labels', async () => {
  const events: string[] = [];
  const credentialed = new URL('https://hooks.stripe.com'); credentialed.username = 'user';
  const frames = ['about:blank', 'https://account.example.invalid', 'https://evilstripe.com', 'https://stripe.com.example.invalid', 'http://hooks.stripe.com', credentialed.href, 'https://hooks.stripe.com:444'].map(url => challengeFrame(url, 'COMPLETE', events));
  frames.push(challengeFrame('https://hooks.stripe.com/3ds', 'Complete authentication extra', events));
  let waits = 0;
  const page = { frames: () => frames, waitForTimeout: async (delay: number) => { assert.equal(delay, 100); waits++; } } as unknown as Page;
  const driver = { auditKnownStates: async () => { events.push('audit'); } } as unknown as Driver;
  await assert.rejects(() => Driver.prototype.challenge.call(driver, page, 'success'), { code: 'PROVIDER_CHALLENGE_CONTROL_MISSING' });
  assert.deepEqual(events, []); assert.equal(waits, 300);
});
