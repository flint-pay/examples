import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isActionExpired, redirectTarget, runClientAction } from '../../public/js/client-action.js';

const FUTURE = '2099-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';
const stripeFields = (call = 'handle_next_action') => ({ publishable_key: 'pk_unit', account_id: 'acct_unit', payment_intent: { client_secret: 'pi_unit_secret', stripe_js_call: call } });

function deps(result: unknown = {}, throws = false) {
  const seen = { stripe: [] as { key: string; account: string | undefined }[], secrets: [] as string[], navigated: [] as string[], invoked: 0 };
  return {
    seen,
    deps: {
      loadStripe: async (key: string, account: string | undefined) => {
        seen.stripe.push({ key, account });
        return {
          async handleNextAction(args: { clientSecret: string }) {
            seen.secrets.push(args.clientSecret);
            if (throws) throw new Error('provider exploded');
            return result;
          },
        };
      },
      navigate: (url: string) => { seen.navigated.push(url); },
      onInvoke: () => { seen.invoked += 1; },
    },
  };
}

test('a url action is a top-level redirect and never loads Stripe', async () => {
  const { seen, deps: d } = deps();
  const outcome = await runClientAction({ type: 'url', url: 'https://flint.example.invalid/pay/action_unit', expiresAt: FUTURE }, d);
  assert.deepEqual(outcome, { status: 'redirected' });
  assert.deepEqual(seen.navigated, ['https://flint.example.invalid/pay/action_unit']);
  assert.equal(seen.invoked, 1);
  assert.deepEqual(seen.stripe, []);
});

test('a stripe action runs handleNextAction once with the connected account', async () => {
  const { seen, deps: d } = deps();
  assert.deepEqual(await runClientAction({ type: 'stripe', stripe: stripeFields(), expiresAt: FUTURE }, d), { status: 'stripe' });
  assert.deepEqual(seen.stripe, [{ key: 'pk_unit', account: 'acct_unit' }]);
  assert.deepEqual(seen.secrets, ['pi_unit_secret']);
  assert.deepEqual(seen.navigated, []);
  assert.equal(seen.invoked, 1);
});

test('a stripe setup intent action runs the same way', async () => {
  const { seen, deps: d } = deps();
  const stripe = { publishable_key: 'pk_unit', account_id: 'acct_unit', setup_intent: { client_secret: 'seti_unit_secret', stripe_js_call: 'handle_next_action' } };
  assert.deepEqual(await runClientAction({ type: 'stripe', stripe, expiresAt: FUTURE }, d), { status: 'stripe' });
  assert.deepEqual(seen.secrets, ['seti_unit_secret']);
});

test('the variant comes from type, never from whether a stripe object is present', async () => {
  const { seen, deps: d } = deps();
  // A url action that also carries Stripe fields redirects and does not touch Stripe.
  assert.deepEqual(await runClientAction({ type: 'url', url: 'https://flint.example.invalid/x', stripe: stripeFields(), expiresAt: FUTURE }, d), { status: 'redirected' });
  assert.deepEqual(seen.stripe, []);
  // A stripe object with no type, and a stripe action with no stripe object, are refused.
  assert.deepEqual(await runClientAction({ stripe: stripeFields(), expiresAt: FUTURE }, d), { status: 'unsupported' });
  assert.deepEqual(await runClientAction({ type: 'stripe', expiresAt: FUTURE }, d), { status: 'unsupported' });
  assert.deepEqual(seen.stripe, []);
});

test('an unknown type is unsupported and does not crash, navigate, or call Stripe', async () => {
  const { seen, deps: d } = deps();
  for (const action of [{ type: 'future', url: 'https://flint.example.invalid/x', stripe: stripeFields(), expiresAt: FUTURE }, null, undefined, 'url', 7]) {
    assert.deepEqual(await runClientAction(action, d), { status: 'unsupported' });
  }
  assert.deepEqual(seen.navigated, []);
  assert.deepEqual(seen.stripe, []);
  assert.equal(seen.invoked, 0);
});

test('an expired action is not opened, for either type', async () => {
  const { seen, deps: d } = deps();
  assert.deepEqual(await runClientAction({ type: 'url', url: 'https://flint.example.invalid/x', expiresAt: PAST }, d), { status: 'expired' });
  assert.deepEqual(await runClientAction({ type: 'stripe', stripe: stripeFields(), expiresAt: PAST }, d), { status: 'expired' });
  assert.deepEqual(seen.navigated, []);
  assert.deepEqual(seen.stripe, []);
  assert.equal(seen.invoked, 0);
  assert.equal(isActionExpired({ expiresAt: PAST }), true);
  assert.equal(isActionExpired({ expiresAt: FUTURE }), false);
  assert.equal(isActionExpired({ expiresAt: 'not a date' }), false);
  assert.equal(isActionExpired({}), false);
  assert.equal(isActionExpired({ expiresAt: PAST }, Date.parse('1999-01-01T00:00:00Z')), false);
});

test('only an http or https url is followed', async () => {
  const { seen, deps: d } = deps();
  for (const value of ['javascript:alert(1)', 'data:text/html,x', '/relative', 'not a url', '', undefined, 7]) {
    assert.equal(redirectTarget(value), null);
    assert.deepEqual(await runClientAction({ type: 'url', url: value, expiresAt: FUTURE }, d), { status: 'unsupported' });
  }
  assert.deepEqual(seen.navigated, []);
  assert.equal(redirectTarget('https://flint.example.invalid/a?b=1'), 'https://flint.example.invalid/a?b=1');
});

test('an unusable stripe action is refused without calling Stripe', async () => {
  const { seen, deps: d } = deps();
  const withStripe = (stripe: unknown) => ({ type: 'stripe', stripe, expiresAt: FUTURE });
  for (const action of [withStripe(stripeFields('confirm_payment')), withStripe(stripeFields('')), withStripe({ ...stripeFields(), publishable_key: '' }), withStripe({ publishable_key: 'pk_unit' })]) {
    assert.deepEqual(await runClientAction(action, d), { status: 'unsupported' });
  }
  assert.deepEqual(seen.stripe, []);
  assert.equal(seen.invoked, 0);
});

test('a Stripe error or a thrown error is reported and the caller still resumes', async () => {
  const failed = deps({ error: { message: 'Authentication failed', code: 'payment_intent_authentication_failure' } });
  assert.deepEqual(await runClientAction({ type: 'stripe', stripe: stripeFields(), expiresAt: FUTURE }, failed.deps), { status: 'stripe', error: { message: 'Authentication failed', code: 'payment_intent_authentication_failure' } });
  const thrown = deps({}, true);
  assert.deepEqual(await runClientAction({ type: 'stripe', stripe: stripeFields(), expiresAt: FUTURE }, thrown.deps), { status: 'stripe', error: { message: 'provider exploded' } });
});

test('Stripe that cannot load is unavailable and nothing is invoked', async () => {
  const outcome = await runClientAction(
    { type: 'stripe', stripe: stripeFields(), expiresAt: FUTURE },
    { loadStripe: async () => { throw new Error('stripe_blocked'); }, navigate: () => assert.fail('no navigation'), onInvoke: () => assert.fail('not invoked') },
  );
  assert.deepEqual(outcome, { status: 'unavailable' });
});

test('the client secret is not part of any outcome', async () => {
  const { deps: d } = deps();
  const outcomes = [
    await runClientAction({ type: 'stripe', stripe: stripeFields(), expiresAt: FUTURE }, d),
    await runClientAction({ type: 'url', url: 'https://flint.example.invalid/x', expiresAt: FUTURE }, d),
  ];
  assert.equal(JSON.stringify(outcomes).includes('pi_unit_secret'), false);
});
