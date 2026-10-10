import test from 'node:test';
import assert from 'node:assert/strict';
import type { SubscriptionPaymentRetry } from '@flintpay/node';
import { assertExclusiveRetryStart, assertRetrySettlement } from '../../support/account-retry.ts';

const subscriptionId = 'sub_UNIT_EXAMPLE', retryId = 'retry_UNIT_EXAMPLE', customerId = 'cus_UNIT_EXAMPLE';
const identity = { subscription_id: subscriptionId, subscription_payment_retry_id: retryId };
const accepted = { status: 200, body: { retry: identity } };
const conflict = (code = 'SUBSCRIPTION_PAYMENT_RETRY_IN_PROGRESS', status = 409) => ({ status, body: { error: { code } } });

test('distinct retry starts require one accepted response and one authoritative new retry, in either response order', () => {
  const old = { ...identity, subscription_payment_retry_id: 'retry_UNIT_OLD' };
  for (const code of ['SUBSCRIPTION_PAYMENT_RETRY_IN_PROGRESS', 'ACTION_NOT_AVAILABLE']) {
    for (const responses of [[accepted, conflict(code)], [conflict(code), accepted]]) {
      assert.equal(assertExclusiveRetryStart(subscriptionId, [old.subscription_payment_retry_id], responses, [old, identity]), retryId);
    }
  }
});

test('coalesced successes, missing acceptance and unrelated failures cannot prove a competing retry was rejected', () => {
  for (const responses of [[accepted, accepted], [conflict(), conflict()], [accepted, conflict('RATE_LIMITED', 429)], [accepted, conflict('ACTION_IN_PROGRESS')], [accepted, conflict('SUBSCRIPTION_PAYMENT_RETRY_IN_PROGRESS', 500)]]) {
    assert.throws(() => assertExclusiveRetryStart(subscriptionId, [], responses, [identity]));
  }
  for (const retry of [{ ...identity, subscription_payment_retry_id: '' }, { ...identity, subscription_id: 'sub_UNIT_FOREIGN' }, {}]) {
    assert.throws(() => assertExclusiveRetryStart(subscriptionId, [], [{ status: 200, body: { retry } }, conflict()], [identity]), { code: 'RETRY_RESPONSE_IDENTITY' });
  }
});

test('both recognized conflicts fail without exactly one new retry matching the accepted subscription and ID', () => {
  for (const code of ['SUBSCRIPTION_PAYMENT_RETRY_IN_PROGRESS', 'ACTION_NOT_AVAILABLE']) {
    for (const after of [[], [identity, { ...identity, subscription_payment_retry_id: 'retry_UNIT_SECOND' }], [{ ...identity, subscription_payment_retry_id: 'retry_UNIT_OTHER' }], [{ ...identity, subscription_id: 'sub_UNIT_FOREIGN' }]]) {
      assert.throws(() => assertExclusiveRetryStart(subscriptionId, [], [accepted, conflict(code)], after));
    }
    assert.throws(() => assertExclusiveRetryStart(subscriptionId, [retryId], [accepted, conflict(code)], [identity]), { code: 'RETRY_CREATED_COUNT' });
  }
});

function settled() {
  const retry: SubscriptionPaymentRetry = { ...identity, idempotency_key: 'UNIT_EXAMPLE_KEY', status: 'succeeded', order_id: 'ord_UNIT_EXAMPLE', order_payment_attempt_id: 'attempt_UNIT_EXAMPLE', created_at: '2000-01-01T00:00:00Z', updated_at: '2000-01-01T00:00:00Z' };
  const order = { order_id: retry.order_id, subscription_id: subscriptionId, customer_id: customerId, payment_status: 'paid', settlement_amounts: { outstanding_money: { amount: '0', currency: 'USD' } } };
  const attempts = [{ order_payment_attempt_id: retry.order_payment_attempt_id, status: 'succeeded', payment_intents: [{ payment_intent_id: 'pi_UNIT_EXAMPLE', status: 'succeeded' }] }];
  return { retry, order, attempts };
}

test('retry settlement requires the exact retry, subscription, customer, order and succeeded attempt with one charge', () => {
  const { retry, order, attempts } = settled();
  assertRetrySettlement(retry, subscriptionId, retryId, customerId, order, attempts);
  for (const change of [{ subscription_id: 'sub_UNIT_FOREIGN' }, { subscription_payment_retry_id: 'retry_UNIT_OTHER' }, { status: 'processing' }, { order_id: undefined }, { order_payment_attempt_id: undefined }, { order_payment_attempt_id: 'attempt_UNIT_OTHER' }]) {
    assert.throws(() => assertRetrySettlement({ ...retry, ...change }, subscriptionId, retryId, customerId, order, attempts));
  }
  for (const change of [{ order_id: 'ord_UNIT_OTHER' }, { subscription_id: 'sub_UNIT_FOREIGN' }, { customer_id: 'cus_UNIT_FOREIGN' }, { payment_status: 'unpaid' }, { settlement_amounts: { outstanding_money: { amount: '1', currency: 'USD' } } }]) {
    assert.throws(() => assertRetrySettlement(retry, subscriptionId, retryId, customerId, { ...order, ...change }, attempts));
  }
  assert.throws(() => assertRetrySettlement(retry, subscriptionId, retryId, customerId, order, [{ ...attempts[0], status: 'failed' }]));
  assert.throws(() => assertRetrySettlement(retry, subscriptionId, retryId, customerId, order, [...attempts, { ...attempts[0], order_payment_attempt_id: 'attempt_UNIT_SECOND' }]), { code: 'SUCCEEDED_ATTEMPT_COUNT' });
  assert.throws(() => assertRetrySettlement(retry, subscriptionId, retryId, customerId, order, [{ ...attempts[0], payment_intents: [...attempts[0].payment_intents, { payment_intent_id: 'pi_UNIT_SECOND', status: 'succeeded' }] }]), { code: 'SETTLED_PAYMENT_COUNT' });
});
