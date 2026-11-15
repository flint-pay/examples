import { test } from 'node:test';
import assert from 'node:assert/strict';

// The runner reads window.Stripe and looks for the Stripe script, so a minimal window and document stand in for the browser.
const calls: { key: string; options: unknown; secret?: string }[] = [];
const assigned: string[] = [];
let result: unknown = {};
let throws = false;
(globalThis as any).document = { querySelector: () => ({}), head: { append() {} }, createElement: () => ({}) };
(globalThis as any).window = {
  setTimeout,
  location: { assign: (url: string) => { assigned.push(url); } },
  Stripe: (key: string, options: unknown) => ({
    async handleNextAction(args: { clientSecret: string }) {
      calls.push({ key, options, secret: args.clientSecret });
      if (throws) throw new Error('provider exploded');
      return result;
    },
  }),
};
const { runClientAction, isActionExpired } = await import('../../src/client/stripe-payment.ts');

const FUTURE = '2099-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';
const stripeFields = (call = 'handle_next_action', key = 'pk_unit') => ({ publishable_key: key, account_id: 'acct_unit', payment_intent: { client_secret: 'pi_unit_secret', stripe_js_call: call } });
const stripe = (call = 'handle_next_action', expiresAt = FUTURE) => ({ type: 'stripe', stripe: stripeFields(call), expiresAt });
const url = (value: unknown = 'https://flint.example.invalid/pay/action_unit', expiresAt = FUTURE) => ({ type: 'url', url: value, expiresAt });

test('a stripe action runs once with the connected account and reports invoked', async () => {
  calls.length = 0;
  let hooked = 0;
  assert.deepEqual(await runClientAction(stripe() as never, { onInvoke: () => { hooked += 1; } }), { invoked: true });
  assert.equal(hooked, 1);
  assert.deepEqual(calls, [{ key: 'pk_unit', options: { stripeAccount: 'acct_unit' }, secret: 'pi_unit_secret' }]);
});

test('a url action is a top-level redirect and never calls Stripe', async () => {
  calls.length = 0;
  assigned.length = 0;
  assert.deepEqual(await runClientAction(url() as never), { invoked: true, redirected: true });
  assert.deepEqual(assigned, ['https://flint.example.invalid/pay/action_unit']);
  assert.equal(calls.length, 0);
});

test('the variant comes from type, never from whether a stripe object is present', async () => {
  calls.length = 0;
  assigned.length = 0;
  assert.deepEqual(await runClientAction({ ...url(), stripe: stripeFields() } as never), { invoked: true, redirected: true });
  assert.equal(calls.length, 0);
  for (const action of [{ type: 'stripe', expiresAt: FUTURE }, { stripe: stripeFields(), expiresAt: FUTURE }]) {
    assert.equal((await runClientAction(action as never)).invoked, false);
  }
  assert.equal(calls.length, 0);
});

test('an unknown type is refused with an error and does not crash or navigate', async () => {
  calls.length = 0;
  assigned.length = 0;
  const run = await runClientAction({ type: 'future', url: 'https://flint.example.invalid/x', stripe: stripeFields(), expiresAt: FUTURE } as never);
  assert.deepEqual(run, { invoked: false, error: { message: 'unsupported_client_action' } });
  assert.equal(calls.length, 0);
  assert.equal(assigned.length, 0);
});

test('an action past its expiry is not opened, for either type', async () => {
  calls.length = 0;
  assigned.length = 0;
  for (const action of [url(undefined, PAST), stripe('handle_next_action', PAST)]) {
    assert.deepEqual(await runClientAction(action as never), { invoked: false, expired: true, error: { message: 'client_action_expired' } });
  }
  assert.equal(calls.length, 0);
  assert.equal(assigned.length, 0);
  assert.equal(isActionExpired({ expiresAt: PAST }), true);
  assert.equal(isActionExpired({ expiresAt: FUTURE }), false);
  assert.equal(isActionExpired({ expiresAt: 'not a date' }), false);
});

test('a url that is not http or https is never followed', async () => {
  assigned.length = 0;
  for (const value of ['javascript:alert(1)', 'data:text/html,x', '/relative/path', 'not a url', '', null]) {
    const run = await runClientAction(url(value) as never);
    assert.equal(run.invoked, false);
    assert.equal(run.error?.message, 'missing_client_action');
  }
  assert.equal(assigned.length, 0);
});

test('unsupported or incomplete stripe actions are refused without calling Stripe', async () => {
  calls.length = 0;
  let hooked = 0;
  const hooks = { onInvoke: () => { hooked += 1; } };
  const withStripe = (value: unknown) => ({ type: 'stripe', expiresAt: FUTURE, stripe: value });
  for (const action of [stripe('confirm_payment'), stripe(''), withStripe({ ...stripeFields(), publishable_key: '' }), withStripe({ publishable_key: 'pk_unit' }), null, undefined]) {
    const run = await runClientAction(action as never, hooks);
    assert.equal(run.invoked, false);
    assert.equal(run.error?.message, 'missing_client_action');
  }
  assert.equal(calls.length, 0);
  assert.equal(hooked, 0);
});

test('a provider error or a thrown error is returned as invoked with the error', async () => {
  result = { error: { message: 'Authentication failed', code: 'payment_intent_authentication_failure' } };
  assert.deepEqual(await runClientAction(stripe() as never), { invoked: true, error: { message: 'Authentication failed', code: 'payment_intent_authentication_failure' } });
  result = {};
  throws = true;
  assert.deepEqual(await runClientAction(stripe() as never), { invoked: true, error: { message: 'provider exploded' } });
  throws = false;
});

test('the client secret is not part of any result or redirect', async () => {
  assigned.length = 0;
  result = {};
  const runs = [await runClientAction(stripe() as never), await runClientAction(url() as never)];
  assert.equal(JSON.stringify([runs, assigned]).includes('pi_unit_secret'), false);
});
