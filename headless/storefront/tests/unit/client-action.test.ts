import { test } from 'node:test';
import assert from 'node:assert/strict';

// The runner reads window.Stripe, so a minimal window stands in for the browser.
const calls: { key: string; options: unknown; secret?: string }[] = [];
let result: unknown = {};
let throws = false;
(globalThis as any).window = {
  setTimeout,
  Stripe: (key: string, options: unknown) => ({
    async handleNextAction(args: { clientSecret: string }) {
      calls.push({ key, options, secret: args.clientSecret });
      if (throws) throw new Error('provider exploded');
      return result;
    },
  }),
};
const { runClientAction } = await import('../../public/js/stripe-payment.js');

const payment = (call = 'handle_next_action') => ({ publishable_key: 'pk_unit', account_id: 'acct_unit', payment_intent: { client_secret: 'pi_unit_secret', stripe_js_call: call } });
const setup = { publishable_key: 'pk_unit', account_id: 'acct_unit', setup_intent: { client_secret: 'seti_unit_secret', stripe_js_call: 'handle_next_action' } };

test('a payment intent action runs once with the connected account and reports invoked', async () => {
  calls.length = 0;
  let hooked = 0;
  assert.deepEqual(await runClientAction(payment(), { onInvoke: () => { hooked += 1; } }), { invoked: true });
  assert.equal(hooked, 1);
  assert.deepEqual(calls, [{ key: 'pk_unit', options: { stripeAccount: 'acct_unit' }, secret: 'pi_unit_secret' }]);
});

test('a setup intent action runs the same way', async () => {
  calls.length = 0;
  assert.deepEqual(await runClientAction(setup as never), { invoked: true });
  assert.equal(calls[0]!.secret, 'seti_unit_secret');
});

test('unsupported or incomplete actions are refused without calling Stripe or the hook', async () => {
  calls.length = 0;
  let hooked = 0;
  const hooks = { onInvoke: () => { hooked += 1; } };
  for (const action of [payment('confirm_payment'), payment(''), { ...payment(), publishable_key: '' }, { publishable_key: 'pk_unit', account_id: 'a' }, null, undefined]) {
    const run = await runClientAction(action as never, hooks);
    assert.equal(run.invoked, false);
    assert.equal(run.error?.message, 'missing_client_action');
  }
  assert.equal(calls.length, 0);
  assert.equal(hooked, 0);
});

test('a provider error or a thrown error is returned as invoked with the error', async () => {
  result = { error: { message: 'Authentication failed', code: 'payment_intent_authentication_failure' } };
  assert.deepEqual(await runClientAction(payment()), { invoked: true, error: { message: 'Authentication failed', code: 'payment_intent_authentication_failure' } });
  result = {};
  throws = true;
  assert.deepEqual(await runClientAction(payment()), { invoked: true, error: { message: 'provider exploded' } });
  throws = false;
});
