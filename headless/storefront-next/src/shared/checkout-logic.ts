// Pure checkout state rules. Server components and the checkout client both
// import this file so the first paint and every later update follow the same
// rules. No DOM or Node APIs here.

import { isZero, type Money } from './money.ts';
import type { CheckoutState, DeliveryOption, PickupLocation } from './types.ts';

/**
 * Runs the page's mutations one at a time, in the order they were asked for. The app holds a
 * per-order lock for every mutation, so overlapping requests would only queue there and time out.
 * A job may queue another job but must not wait for it: that job starts only after this one ends.
 */
export function createUiJobQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  const waiting = new Map<string, Promise<void>>();
  function run<T>(job: () => Promise<T> | T): Promise<T> {
    const result = tail.then(job);
    tail = result.catch(() => {});
    return result;
  }
  /**
   * Joins a job with the same key that has not started yet. A job that is already running
   * may have read stale input, so a later call queues one follow-up instead.
   */
  function coalesce(key: string, job: () => Promise<void>): Promise<void> {
    const existing = waiting.get(key);
    if (existing) return existing;
    const result = run(async () => {
      waiting.delete(key);
      await job();
    });
    waiting.set(key, result);
    return result;
  }
  return { run, coalesce };
}

/**
 * Contact edit revisions. A save acknowledges the revision it read, so an edit made while
 * the request was in flight stays dirty and is sent by the next save.
 */
export function createContactEdits() {
  let revision = 0;
  let savedRevision = 0;
  return {
    get dirty() { return revision !== savedRevision; },
    mark() { revision += 1; },
    snapshot() { return revision; },
    acknowledge(saved: number) { if (saved === revision) savedRevision = saved; },
  };
}

/** States the payment region can rest in. `loading`, `submitting`, `total_changed`, and `succeeded` are set only in the browser. */
export type RestingPaymentState =
  | 'unavailable' | 'ready' | 'needs_billing' | 'authenticating' | 'resuming' | 'waiting' | 'bank_processing'
  | 'declined' | 'pay_remaining' | 'affirm_incomplete' | 'recovery' | 'expired' | 'succeeded';
export type PaymentUiState = RestingPaymentState | 'loading' | 'submitting' | 'total_changed';

const EXPIRED_STATUSES = new Set(['expired', 'invalidated', 'closed', 'canceled', 'cancelled']);

export function isExpired(state: CheckoutState): boolean {
  return EXPIRED_STATUSES.has(state.session?.status ?? '');
}

export function outstandingOf(state: CheckoutState): Money | null {
  return state.order?.settlement_amounts?.outstanding_money ?? null;
}

/** What the buyer must provide. The app reports `collection_kind`; the fallback keeps older state shapes working. */
export function collectionKindOf(state: CheckoutState): 'processor' | 'settlement' | 'setup' | 'unavailable' {
  if (state.collection_kind) return state.collection_kind;
  const outstanding = state.order?.settlement_amounts?.outstanding_money ?? null;
  const guidance = state.payment_collection?.stripe ?? state.setup_collection?.stripe;
  if (state.kind === 'subscription') return isZero(outstanding) ? (state.setup_collection?.stripe ? 'setup' : 'unavailable') : guidance ? 'processor' : 'unavailable';
  const estimate = state.order?.gift_card_estimate;
  const giftOnly = (state.order?.gift_cards?.length ?? 0) > 0 && estimate?.can_pay && isZero(estimate.processor_money);
  if (isZero(outstanding) || giftOnly) return 'settlement';
  return guidance ? 'processor' : 'unavailable';
}

/** The amount a payment processor must collect. Gift cards can cover an order entirely, and then no payment form is needed. */
export function processorMoney(state: CheckoutState): Money | null {
  const estimate = state.order?.gift_card_estimate;
  if (state.kind === 'order' && estimate && estimate.can_pay && (state.order.gift_cards?.length ?? 0) > 0 && estimate.processor_money) {
    return estimate.processor_money;
  }
  return outstandingOf(state);
}

export function guidanceOf(state: CheckoutState) {
  return state.payment_collection ?? state.setup_collection ?? null;
}

/** True when the buyer must enter or choose a payment method. Subscriptions always collect a source, including free trials. */
export function needsProcessor(state: CheckoutState): boolean {
  const kind = collectionKindOf(state);
  return kind === 'processor' || kind === 'setup';
}

/** Order with nothing for a processor to collect: discounts or gift cards cover it. */
export function isSettlementOnly(state: CheckoutState): boolean {
  return collectionKindOf(state) === 'settlement';
}

export function buttonKind(state: CheckoutState): 'order' | 'confirm_order' | 'subscription_paid' | 'subscription_trial' {
  if (state.kind === 'subscription') {
    return collectionKindOf(state) === 'setup' || isZero(outstandingOf(state)) ? 'subscription_trial' : 'subscription_paid';
  }
  return collectionKindOf(state) === 'settlement' ? 'confirm_order' : 'order';
}

export function declineCode(state: CheckoutState): string | null {
  const attempt = state.attempt;
  if (!attempt) return null;
  if (attempt.last_payment_error?.code) return attempt.last_payment_error.code;
  for (const intent of attempt.payment_intents ?? []) {
    if (intent.last_payment_error?.code) return intent.last_payment_error.code;
  }
  return null;
}

export function declineMessageCode(state: CheckoutState): string | null {
  const code = declineCode(state);
  if (code !== 'insufficient_funds') return code;
  const failedLegs = (state.attempt?.payment_intents ?? []).filter((leg) => leg.status === 'requires_payment_method' || leg.status === 'failed');
  return failedLegs.length > 0 && failedLegs.every((leg) => legSourceType(state, leg.payment_intent_id) === 'ach_debit')
    ? 'bank_insufficient_funds'
    : code;
}

export function affirmShouldBeRemoved(code: string | null | undefined): boolean {
  return code === 'payment_method_declined' || code === 'payment_method_temporarily_unavailable';
}

/** Payment source type of an attempt leg, read from the order's payment intents. Attempt legs do not carry it themselves. */
export function legSourceType(state: CheckoutState, paymentIntentId: string): string {
  return state.order?.payment_intents?.find((intent) => intent.payment_intent_id === paymentIntentId)?.payment_source?.type ?? '';
}

function hasAffirmAction(state: CheckoutState): boolean {
  return (state.attempt?.payment_intents ?? []).some((leg) => legSourceType(state, leg.payment_intent_id) === 'affirm' && leg.status === 'requires_action');
}

export function derivePaymentState(state: CheckoutState): RestingPaymentState {
  if (isExpired(state)) return 'expired';
  if (state.session.is_in_recovery) return 'recovery';
  const attempt = state.attempt;
  // The app can hold an unresolved payment request before Flint shows any attempt. Treat it as resolving.
  if (!attempt && state.next === 'resume') return 'resuming';
  if (attempt) {
    switch (state.next) {
      case 'done': return 'succeeded';
      case 'bank_processing': return 'bank_processing';
      case 'authenticate': return hasAffirmAction(state) ? 'affirm_incomplete' : 'authenticating';
      case 'resume': return 'resuming';
      case 'wait': return 'waiting';
      case 'capture': return 'unavailable';
      case 'pay_remaining': return 'pay_remaining';
      case 'new_payment':
        if (attempt.status === 'failed' || attempt.last_payment_error) return 'declined';
        break;
      default: break;
    }
  }
  if (taxLocationState(state) === 'needed') return 'needs_billing';
  const collection = collectionKindOf(state);
  if (collection === 'unavailable') return 'unavailable';
  if (needsProcessor(state) && !guidanceOf(state)?.stripe?.elements) return 'unavailable';
  return 'ready';
}

export function attemptIsOpen(paymentState: string): boolean {
  return ['authenticating', 'resuming', 'waiting', 'bank_processing', 'affirm_incomplete'].includes(paymentState);
}

// ----- Delivery -----

export function showDelivery(state: CheckoutState): boolean {
  return state.kind === 'order' && Boolean(state.session.delivery_selection_required || state.delivery_selection || state.delivery_quote);
}

function selectionStale(state: CheckoutState): boolean {
  const problems = state.session.problems ?? [];
  if (problems.some((problem) => problem.code === 'delivery_selection_stale')) return true;
  return ['stale', 'expired', 'superseded', 'revoked'].includes(state.delivery_quote?.status ?? '') && !state.delivery_selection;
}

export function isPickupType(item: { type?: string }): boolean {
  return item.type === 'pickup';
}

export function pickupOptions(state: CheckoutState): PickupLocation[] {
  if (Array.isArray(state.pickup_locations)) {
    return [...state.pickup_locations].filter((item) => item.availability_status !== 'unavailable').sort((a, b) => (a.display_position ?? 0) - (b.display_position ?? 0));
  }
  return (state.delivery_quote?.choice_groups ?? []).flatMap((group) =>
    group.options.filter(isPickupType).map((option: DeliveryOption) => ({ ...option, delivery_choice_group_id: group.delivery_choice_group_id, availability_status: group.availability_status })),
  );
}

/** True when the last pickup search found no location that can fill the cart. */
export function pickupNoneNearby(state: CheckoutState): boolean {
  if (state.delivery_quote || state.delivery_selection || !state.pickup_search) return false;
  return pickupOptions(state).length === 0;
}

export type DeliveryStateName = 'idle' | 'options' | 'needs_input' | 'unavailable' | 'stale' | 'selected' | 'none_nearby';

export function deliveryState(state: CheckoutState): DeliveryStateName | null {
  if (!showDelivery(state)) return null;
  const selection = state.delivery_selection;
  const quote = state.delivery_quote;
  const problems = state.session.problems ?? [];
  if (selection) {
    if (problems.some((problem) => problem.code === 'delivery_selection_stale')) return 'stale';
    if (selection.input_requirements?.length) return 'needs_input';
    return 'selected';
  }
  if (!quote && state.pickup_search) return pickupNoneNearby(state) ? 'none_nearby' : 'options';
  if (quote) {
    if (selectionStale(state)) return 'stale';
    const groups = quote.choice_groups ?? [];
    if (groups.length > 0 && groups.every((group) => group.availability_status === 'unavailable')) return 'unavailable';
    if (groups.some((group) => group.availability_status === 'needs_input') || (quote.input_requirements?.length ?? 0) > 0) return 'needs_input';
    return 'options';
  }
  return 'idle';
}

export function deliveryMode(state: CheckoutState): 'ship' | 'pickup' {
  const choice = state.delivery_selection?.choices?.[0];
  if (choice) return isPickupType(choice) ? 'pickup' : 'ship';
  const quote = state.delivery_quote;
  if (!quote && state.pickup_search) return 'pickup';
  if (quote) {
    if (quote.destination_address?.line1) return 'ship';
    const types = new Set(quote.choice_groups.flatMap((group) => group.method_types));
    if (types.size === 1 && types.has('pickup')) return 'pickup';
  }
  return 'ship';
}

/** Modes to offer. Both before a quote; afterward only types the quote reports. */
export function deliveryModes(state: CheckoutState): ('ship' | 'pickup')[] {
  const quote = state.delivery_quote;
  const types = new Set((quote?.choice_groups ?? []).flatMap((group) => group.method_types ?? []));
  if (!types.size) return ['ship', 'pickup'];
  const modes: ('ship' | 'pickup')[] = [];
  if ([...types].some((type) => type !== 'pickup')) modes.push('ship');
  if (types.has('pickup')) modes.push('pickup');
  return modes.length ? modes : ['ship', 'pickup'];
}

// ----- Billing address for tax -----

/**
 * Whether the page asks for a full US billing address so tax can be calculated. Only checkouts
 * with no delivery step ask. `needed` blocks payment. `set` means the buyer provided the order's
 * tax location, so they can change it.
 */
export function taxLocationState(state: CheckoutState): 'needed' | 'set' | null {
  if (showDelivery(state)) return null;
  const tax = state.order?.tax;
  if (tax?.enabled !== true) return null;
  if (tax.status === 'requires_location') return (tax.available_location_inputs ?? []).includes('provided') ? 'needed' : null;
  if (tax.location?.address_source === 'provided') return 'set';
  return null;
}

// ----- Tip -----

export const TIP_PERCENTS = [10, 15, 20] as const;

export function tipVisible(state: CheckoutState): boolean {
  if (state.kind !== 'order') return false;
  if (state.session.tip && state.session.tip.enabled === false) return false;
  return (state.delivery_selection?.choices ?? []).some(isPickupType);
}

/** The tip the buyer asked for, which settles when the order is paid. */
export function requestedTip(state: CheckoutState) {
  return state.order.tips?.find((tip) => tip.status === 'requested');
}

export function tipChoice(state: CheckoutState): 'none' | '10' | '15' | '20' | 'custom' {
  const tip = requestedTip(state);
  if (tip?.percent !== undefined && tip.percent !== null) {
    const asString = String(tip.percent);
    if (asString === '10' || asString === '15' || asString === '20') return asString;
    return 'custom';
  }
  if (tip?.amount_money) return 'custom';
  return 'none';
}

// ----- Pay blockers -----

/** Blockers the server state can already prove. The client adds `contact_email_missing` and `elements_incomplete` from the live form. */
export function serverBlockers(state: CheckoutState): string[] {
  const blockers: string[] = [];
  const paymentState = derivePaymentState(state);
  if (paymentState === 'expired' || paymentState === 'unavailable') blockers.push('session_not_open');
  if (taxLocationState(state) === 'needed') blockers.push('billing_address_missing');
  if (attemptIsOpen(paymentState) || paymentState === 'recovery') blockers.push('attempt_open');
  const delivery = deliveryState(state);
  if (delivery !== null) {
    if (!state.delivery_selection) blockers.push('delivery_selection_missing');
    else if (state.delivery_selection.input_requirements?.length) blockers.push('delivery_input_required');
  }
  return blockers;
}

export const BLOCKER_PRIORITY = [
  'session_not_open', 'attempt_open', 'contact_email_missing', 'billing_address_missing', 'billing_country_missing',
  'billing_country_unsupported', 'billing_postal_code_missing', 'billing_postal_code_required', 'delivery_selection_missing',
  'delivery_input_required', 'elements_incomplete',
];

/** The country of the billing address the buyer saved. The tax location and the delivery address never stand in for it. */
export function buyerBillingCountry(state: CheckoutState): string {
  return state.billing_address?.country ?? '';
}

/** The postal code of the billing address the buyer saved. */
export function buyerBillingPostalCode(state: CheckoutState): string {
  return state.billing_address?.postal_code ?? '';
}

export function looksLikeEmail(value: unknown): boolean {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export const US_POSTAL_CODE = /^\d{5}(-\d{4})?$/;

export const DECLINE_KEYS = new Set([
  'incorrect_cvc', 'expired_card', 'payment_method_unavailable', 'processing_error', 'payment_method_temporarily_unavailable',
  'authentication_required', 'payment_not_completed', 'payment_action_expired', 'payment_method_declined', 'bank_account_closed',
  'bank_account_not_found', 'insufficient_funds', 'bank_insufficient_funds', 'bank_debit_not_authorized', 'bank_account_restricted', 'bank_debit_limit_exceeded',
]);

export function declineKey(code: string | null | undefined): string {
  const key = (code ?? '').toLowerCase();
  return DECLINE_KEYS.has(key) ? key : 'decline_default';
}
