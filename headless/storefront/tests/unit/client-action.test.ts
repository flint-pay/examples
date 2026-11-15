import { test } from 'node:test';
import assert from 'node:assert/strict';

// The runner reads window.Stripe, so a minimal window stands in for the browser.
const calls: { key: string; options: unknown; secret?: string }[] = [];
const assigned: string[] = [];
let result: unknown = {};
let throws = false;
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
const { runClientAction, isActionExpired } = await import('../../public/js/stripe-payment.js');

const FUTURE = '2099-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';
const stripeFields = (call = 'handle_next_action') => ({ publishable_key: 'pk_unit', account_id: 'acct_unit', payment_intent: { client_secret: 'pi_unit_secret', stripe_js_call: call } });
const payment = (call = 'handle_next_action', expiresAt = FUTURE) => ({ type: 'stripe', stripe: stripeFields(call), expiresAt });
const setup = { type: 'stripe', expiresAt: FUTURE, stripe: { publishable_key: 'pk_unit', account_id: 'acct_unit', setup_intent: { client_secret: 'seti_unit_secret', stripe_js_call: 'handle_next_action' } } };
const url = (value = 'https://flint.example.invalid/pay/action_unit', expiresAt = FUTURE) => ({ type: 'url', url: value, expiresAt });

test('a stripe payment intent action runs once with the connected account and reports invoked', async () => {
  calls.length = 0;
  let hooked = 0;
  assert.deepEqual(await runClientAction(payment() as never, { onInvoke: () => { hooked += 1; } }), { invoked: true });
  assert.equal(hooked, 1);
  assert.deepEqual(calls, [{ key: 'pk_unit', options: { stripeAccount: 'acct_unit' }, secret: 'pi_unit_secret' }]);
});

test('a stripe setup intent action runs the same way', async () => {
  calls.length = 0;
  assert.deepEqual(await runClientAction(setup as never), { invoked: true });
  assert.equal(calls[0]!.secret, 'seti_unit_secret');
});

test('a url action is a top-level redirect and never calls Stripe', async () => {
  calls.length = 0;
  assigned.length = 0;
  let hooked = 0;
  assert.deepEqual(await runClientAction(url() as never, { onInvoke: () => { hooked += 1; } }), { invoked: true, redirected: true });
  assert.deepEqual(assigned, ['https://flint.example.invalid/pay/action_unit']);
  assert.equal(hooked, 1);
  assert.equal(calls.length, 0);
});

test('the variant comes from type, never from whether a stripe object is present', async () => {
  calls.length = 0;
  assigned.length = 0;
  // A url action that also carries Stripe fields redirects and does not touch Stripe.
  assert.deepEqual(await runClientAction({ ...url(), stripe: stripeFields() } as never), { invoked: true, redirected: true });
  assert.equal(calls.length, 0);
  // A stripe action with no stripe object, or no type, is refused, not guessed.
  for (const action of [{ type: 'stripe', expiresAt: FUTURE }, { stripe: stripeFields(), expiresAt: FUTURE }]) {
    assert.equal((await runClientAction(action as never)).invoked, false);
  }
  assert.equal(calls.length, 0);
  assert.equal(assigned.length, 1);
});

test('an unknown type is refused with an error and does not crash', async () => {
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
  let hooked = 0;
  const hooks = { onInvoke: () => { hooked += 1; } };
  for (const action of [url(undefined, PAST), payment('handle_next_action', PAST)]) {
    const run = await runClientAction(action as never, hooks);
    assert.deepEqual(run, { invoked: false, expired: true, error: { message: 'client_action_expired' } });
  }
  assert.equal(calls.length, 0);
  assert.equal(assigned.length, 0);
  assert.equal(hooked, 0);
  assert.equal(isActionExpired({ expiresAt: PAST }), true);
  assert.equal(isActionExpired({ expiresAt: FUTURE }), false);
  assert.equal(isActionExpired({ expiresAt: 'not a date' }), false);
  assert.equal(isActionExpired({}), false);
});

test('a url that is not http or https is never followed', async () => {
  assigned.length = 0;
  for (const value of ['javascript:alert(1)', 'data:text/html,x', '/relative/path', 'not a url', '', null]) {
    const run = await runClientAction(url(value as string) as never);
    assert.equal(run.invoked, false);
    assert.equal(run.error?.message, 'missing_client_action');
  }
  assert.equal(assigned.length, 0);
});

test('unsupported or incomplete stripe actions are refused without calling Stripe or the hook', async () => {
  calls.length = 0;
  let hooked = 0;
  const hooks = { onInvoke: () => { hooked += 1; } };
  const withStripe = (stripe: unknown) => ({ type: 'stripe', expiresAt: FUTURE, stripe });
  for (const action of [payment('confirm_payment'), payment(''), withStripe({ ...stripeFields(), publishable_key: '' }), withStripe({ publishable_key: 'pk_unit', account_id: 'a' }), null, undefined]) {
    const run = await runClientAction(action as never, hooks);
    assert.equal(run.invoked, false);
    assert.equal(run.error?.message, 'missing_client_action');
  }
  assert.equal(calls.length, 0);
  assert.equal(hooked, 0);
});

test('a provider error or a thrown error is returned as invoked with the error', async () => {
  result = { error: { message: 'Authentication failed', code: 'payment_intent_authentication_failure' } };
  assert.deepEqual(await runClientAction(payment() as never), { invoked: true, error: { message: 'Authentication failed', code: 'payment_intent_authentication_failure' } });
  result = {};
  throws = true;
  assert.deepEqual(await runClientAction(payment() as never), { invoked: true, error: { message: 'provider exploded' } });
  throws = false;
});

test('the client secret is not written to a result, a redirect, or the page', async () => {
  calls.length = 0;
  assigned.length = 0;
  result = {};
  const stripeRun = await runClientAction(payment() as never);
  const urlRun = await runClientAction(url() as never);
  assert.equal(JSON.stringify([stripeRun, urlRun, assigned]).includes('pi_unit_secret'), false);
});


import {projectClientAction} from '../../src/flint/projection.ts';
import type {PendingPaymentAction} from '@flintpay/node';

const expiresAt='2099-01-01T00:00:00Z';
const stripeAction={account_id:'acct_example',publishable_key:'pk_test_example',payment_intent:{client_secret:'pi_example_secret_example',stripe_js_call:'handle_next_action'}};
test('server projects URL and Stripe actions by type with the pending action expiry',()=>{
  const pending=(client_action:unknown)=>({pending_action_id:'action_example',expires_at:expiresAt,client_action} as PendingPaymentAction);
  assert.deepEqual(projectClientAction(pending({type:'url',url:'https://payment-return.example.invalid/action/example',stripe:stripeAction})),{type:'url',url:'https://payment-return.example.invalid/action/example',expiresAt});
  assert.deepEqual(projectClientAction(pending({type:'stripe',stripe:stripeAction})),{type:'stripe',stripe:stripeAction,expiresAt});
  assert.equal(projectClientAction(pending({type:'future',stripe:stripeAction})),undefined);
  assert.equal(projectClientAction(undefined),undefined);
});
