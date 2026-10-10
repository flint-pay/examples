import type { SubscriptionPaymentRetry } from '@flintpay/node';
import { assertOneCharge } from './money.ts';
import { invariant } from './safe.ts';

type RetryIdentity = Pick<SubscriptionPaymentRetry, 'subscription_payment_retry_id' | 'subscription_id'>;

export function assertExclusiveRetryStart(subscriptionId: string, before: readonly string[], responses: { status: number; body: any }[], after: RetryIdentity[]): string {
  const accepted = responses.filter(r => r.status === 200);
  invariant(responses.length === 2 && accepted.length === 1, 'RETRY_ACCEPTED_RESPONSE_COUNT');
  const retry = accepted[0].body?.retry;
  invariant(typeof retry?.subscription_payment_retry_id === 'string' && retry.subscription_payment_retry_id.length > 0 && retry.subscription_id === subscriptionId, 'RETRY_RESPONSE_IDENTITY');
  const competing = responses.find(r => r !== accepted[0])!;
  invariant(competing.status === 409 && ['SUBSCRIPTION_PAYMENT_RETRY_IN_PROGRESS', 'ACTION_NOT_AVAILABLE'].includes(competing.body?.error?.code), 'DOUBLE_RETRY_NOT_REJECTED');
  const created = after.filter(r => !before.includes(r.subscription_payment_retry_id));
  invariant(created.length === 1, 'RETRY_CREATED_COUNT');
  invariant(created[0].subscription_id === subscriptionId && created[0].subscription_payment_retry_id === retry.subscription_payment_retry_id, 'RETRY_CREATED_IDENTITY');
  return retry.subscription_payment_retry_id;
}

export function assertRetrySettlement(retry: SubscriptionPaymentRetry, subscriptionId: string, retryId: string, customerId: string, order: Record<string, any>, attempts: Record<string, any>[]): void {
  invariant(retry.subscription_id === subscriptionId && retry.subscription_payment_retry_id === retryId, 'RETRY_READ_IDENTITY');
  invariant(retry.status === 'succeeded', 'RETRY_NOT_SUCCEEDED');
  invariant(typeof retry.order_id === 'string' && retry.order_id.length > 0 && order.order_id === retry.order_id && order.subscription_id === subscriptionId && order.customer_id === customerId, 'RETRY_ORDER_IDENTITY');
  invariant(typeof retry.order_payment_attempt_id === 'string' && retry.order_payment_attempt_id.length > 0 && attempts.some(a => a.order_payment_attempt_id === retry.order_payment_attempt_id && a.status === 'succeeded'), 'RETRY_ATTEMPT_NOT_SUCCEEDED');
  assertOneCharge(order, attempts);
}
