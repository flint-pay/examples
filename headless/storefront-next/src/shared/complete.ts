import type { CheckoutState } from './types.ts';

export type CompleteState = 'paid' | 'bank_processing' | 'subscription_active' | 'subscription_trialing' | 'confirming' | 'partially_paid';

export function deriveCompleteState(state: CheckoutState): CompleteState {
  if (state.kind === 'subscription') {
    const status = state.subscription?.status;
    if (!status) return 'confirming';
    return status === 'trialing' ? 'subscription_trialing' : 'subscription_active';
  }
  if (state.next === 'bank_processing') return 'bank_processing';
  const paymentStatus = state.order.payment_status;
  if (paymentStatus === 'paid') return 'paid';
  if (paymentStatus === 'partially_paid') return 'partially_paid';
  return 'confirming';
}

/**
 * A $0 trial is paid from creation, so a missing subscription with nothing in flight means the card
 * setup never ran. `next` is `new_payment` only when no attempt is open and none has an unknown outcome.
 */
export function trialSetupNotStarted(state: CheckoutState): boolean {
  return state.kind === 'subscription'
    && !state.order.subscription_id
    && BigInt(state.order.settlement_amounts?.outstanding_money?.amount ?? '1') === 0n
    && state.next === 'new_payment'
    && !['paid', 'partially_paid'].includes(state.session.status ?? '');
}
