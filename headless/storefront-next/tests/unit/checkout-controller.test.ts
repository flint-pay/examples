// The checkout controller's pending-action paths, run in Node with a stand-in for the page and for this app's
// routes: a url action that is waiting on load, an expired action whose cancel fails, and a page restored from the
// back-forward cache after the redirect. Nothing here talks to Flint or Stripe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The controller imports through the app's `@/` alias, which Node does not know.
const src = fileURLToPath(new URL('../../src/', import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier.startsWith('@/') ? pathToFileURL(src + specifier.slice(2)).href : specifier, context);
  },
});

const { CheckoutController } = await import('../../src/components/checkout/controller.ts');
const { message } = await import('../../src/shared/copy.ts');

const usd = (amount: string) => ({ amount, currency: 'USD' });
const FUTURE = '2099-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';
const urlAction = (expiresAt = FUTURE) => ({ type: 'url' as const, url: 'https://hosted.example.test/pa_1', expiresAt });

function checkoutState(affirm = false): any {
  return {
    session: { status: 'open' },
    order: { settlement_amounts: { outstanding_money: usd('1000') }, payment_intents: [{ payment_intent_id: 'pi_1', payment_source: { type: affirm ? 'affirm' : 'card' } }] },
    attempt: { status: 'requires_action', payment_intents: [{ payment_intent_id: 'pi_1', status: 'requires_action' }], pending_actions: [{ pending_action_id: 'pa_1' }] },
  };
}

/** A stand-in page: waits run at once, and the controller's pageshow listener can be fired. */
function installWindow() {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const navigated: string[] = [];
  (globalThis as any).window = {
    setTimeout: (callback: () => void) => {
      queueMicrotask(callback);
      return 0;
    },
    clearTimeout: () => {},
    addEventListener: (type: string, listener: (event: any) => void) => (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(listener),
    removeEventListener: (type: string, listener: (event: any) => void) => listeners.get(type)?.delete(listener),
    location: { assign: (url: string) => navigated.push(url) },
  };
  return { navigated, fire: (type: string, event: object) => listeners.get(type)?.forEach((listener) => listener(event)) };
}

type Call = { method: string; suffix: string };

function controllerFor(state: any, respond: (call: Call) => any) {
  const page = installWindow();
  const calls: Call[] = [];
  const controller: any = new CheckoutController({ ref: 'chk_example', csrf: 'csrf', store: 'Example Store', state, contact: { name: '', email: '', phone: '' } });
  controller.request = async (method: 'GET' | 'POST', suffix: string) => {
    calls.push({ method, suffix });
    return respond({ method, suffix });
  };
  controller.mountPayment = async () => {};
  controller.focus = () => {};
  controller.reload = async () => true;
  return { controller, calls, page };
}

const paths = (calls: Call[], suffix: string) => calls.filter((call) => call.suffix === suffix);

test('a url action found on load waits for the buyer: Continue and Pay another way, and no redirect', async () => {
  const { controller, page } = controllerFor(checkoutState(), () => ({ ok: true, status: 200 }));
  await controller.authenticate(urlAction(), { onLoad: true });
  const snap = controller.getSnapshot();
  assert.equal(snap.paymentState, 'affirm_incomplete');
  assert.equal(snap.incomplete, 'action');
  assert.equal(snap.message.text, message('payment_action_incomplete', { store: 'Example Store' }));
  assert.equal(snap.redirecting, false);
  assert.deepEqual(page.navigated, []);
});

test('the unfinished wording names Affirm only when the open action is Affirm', async () => {
  const { controller } = controllerFor(checkoutState(true), () => ({ ok: true, status: 200 }));
  await controller.authenticate(urlAction(), { onLoad: true });
  const snap = controller.getSnapshot();
  assert.equal(snap.incomplete, 'affirm');
  assert.equal(snap.message.text, message('affirm_incomplete', { store: 'Example Store' }));
});

test('a url action from a payment the buyer just submitted redirects instead', async () => {
  const { controller, page } = controllerFor(checkoutState(), () => ({ ok: true, status: 200 }));
  await controller.authenticate(urlAction());
  assert.deepEqual(page.navigated, ['https://hosted.example.test/pa_1']);
  assert.equal(controller.getSnapshot().redirecting, true);
  assert.equal(controller.getSnapshot().paymentState, 'authenticating');
});

test('an expired action is cancelled once and the buyer gets the form with the try again message', async () => {
  const { controller, calls } = controllerFor(checkoutState(), ({ suffix }) => (suffix === '/cancel-attempt' ? { ok: true, status: 200, state: checkoutState() } : { ok: false, status: 500 }));
  await controller.authenticate(urlAction(PAST), { onLoad: true });
  assert.equal(paths(calls, '/cancel-attempt').length, 1);
  const snap = controller.getSnapshot();
  assert.equal(snap.paymentState, 'declined');
  assert.equal(snap.message.text, message('payment_action_expired', { store: 'Example Store' }));
});

test('a cancel that fails twice then works is retried and ends on the form', async () => {
  let cancels = 0;
  const { controller, calls } = controllerFor(checkoutState(), ({ suffix }) => {
    if (suffix !== '/cancel-attempt') return { ok: false, status: 500 };
    cancels += 1;
    return cancels < 3 ? { ok: false, status: 409 } : { ok: true, status: 200, state: checkoutState() };
  });
  await controller.authenticate(urlAction(PAST), { onLoad: true });
  assert.equal(paths(calls, '/cancel-attempt').length, 3);
  assert.equal(controller.getSnapshot().paymentState, 'declined');
});

test('a cancel that keeps failing stops after three tries, keeps the expiry message, and leaves a manual retry', async () => {
  const { controller, calls } = controllerFor(checkoutState(), () => ({ ok: false, status: 409, error: { kind: 'conflict', code: 'ATTEMPT_NOT_CANCELABLE' } }));
  await controller.authenticate(urlAction(PAST), { onLoad: true });
  assert.equal(paths(calls, '/cancel-attempt').length, 3);
  // Nothing reads the attempt again on its own, which is what looped before.
  assert.equal(paths(calls, '/attempt').length, 0);
  assert.equal(paths(calls, '/resume').length, 0);
  const snap = controller.getSnapshot();
  assert.equal(snap.paymentState, 'affirm_incomplete');
  assert.match(snap.message.text, new RegExp(message('payment_action_expired', { store: 'Example Store' }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(snap.message.text.endsWith(message('generic_error', { store: 'Example Store' })));
  assert.equal(snap.message.tone, 'error');
});

test('a page restored after the redirect reads the payment again and waits for the buyer', async () => {
  const state = checkoutState();
  const { controller, calls, page } = controllerFor(state, ({ method, suffix }) =>
    method === 'GET' && suffix === '/attempt' ? { ok: true, status: 200, state, next: 'authenticate', client_action: urlAction() } : { ok: true, status: 200, state, next: 'wait' },
  );
  controller.attach();
  await controller.authenticate(urlAction());
  assert.equal(controller.getSnapshot().redirecting, true);
  assert.equal(page.navigated.length, 1);

  // A restore that is not from the cache changes nothing.
  page.fire('pageshow', { persisted: false });
  assert.equal(controller.getSnapshot().redirecting, true);

  page.fire('pageshow', { persisted: true });
  for (let tick = 0; tick < 20 && controller.getSnapshot().paymentState !== 'affirm_incomplete'; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  const snap = controller.getSnapshot();
  assert.equal(snap.redirecting, false);
  assert.equal(snap.paymentState, 'affirm_incomplete');
  // It did not leave a second time, and it did not resume an action it had only opened.
  assert.equal(page.navigated.length, 1);
  assert.equal(paths(calls, '/resume').length, 0);
  // Leaving the page removes the listener, so a later restore does nothing.
  controller.leaveGift = () => {};
  controller.destroy();
  controller.set({ redirecting: true });
  page.fire('pageshow', { persisted: true });
  assert.equal(controller.getSnapshot().redirecting, true);
});
