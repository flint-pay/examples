// @ts-check
// Pure checkout state and job coordination. The server views and public/js/checkout.js both
// import this file so the first paint and every later update follow the same
// rules. No DOM or Node APIs here.

import { isZero } from './money.js';

/** @typedef {import('../../src/views/types.ts').CheckoutState} CheckoutState */
/** @typedef {import('../../src/views/types.ts').Money} Money */

/**
 * Runs the page's mutations one at a time, in the order they were asked for. The app holds a
 * per-order lock for every mutation, so overlapping requests would only queue there and time out.
 * A job may queue another job but must not wait for it: that job starts only after this one ends.
 */
export function createUiJobQueue() {
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();
  /** @type {Map<string, Promise<void>>} */
  const waiting = new Map();
  /**
   * @template T
   * @param {() => Promise<T> | T} job
   * @returns {Promise<T>}
   */
  function run(job) {
    const result = tail.then(job);
    tail = result.catch(() => {});
    return result;
  }
  /**
   * Joins a job with the same key that has not started yet. A job that is already running
   * may have read stale input, so a later call queues one follow-up instead.
   * @param {string} key
   * @param {() => Promise<void>} job
   * @returns {Promise<void>}
   */
  function coalesce(key, job) {
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
    /** @param {number} saved */
    acknowledge(saved) { if (saved === revision) savedRevision = saved; },
  };
}

/**
 * States the payment region can rest in. `loading`, `submitting`,
 * `total_changed`, and `succeeded` are transient and only set in the browser.
 * @typedef {'unavailable'|'ready'|'needs_billing'|'authenticating'|'resuming'|'waiting'|'bank_processing'|'declined'|'pay_remaining'|'affirm_incomplete'|'recovery'|'expired'|'succeeded'} RestingPaymentState
 */

const EXPIRED_STATUSES = new Set(['expired', 'invalidated', 'closed', 'canceled', 'cancelled']);

/** @param {CheckoutState} state */
export function isExpired(state) {
  return EXPIRED_STATUSES.has(state.session?.status ?? '');
}

/** @param {CheckoutState} state @returns {Money | null} */
export function outstandingOf(state) {
  return state.order?.settlement_amounts?.outstanding_money ?? null;
}

/**
 * What the buyer must provide. The app reports `collection_kind`; the fallback
 * derivation keeps older state shapes working.
 * @param {CheckoutState} state
 * @returns {'processor'|'settlement'|'setup'|'unavailable'}
 */
export function collectionKindOf(state) {
  if (state.collection_kind) return state.collection_kind;
  const outstanding = state.order?.settlement_amounts?.outstanding_money ?? null;
  const guidance = state.payment_collection?.stripe ?? state.setup_collection?.stripe;
  if (state.kind === 'subscription') return isZero(outstanding) ? (state.setup_collection?.stripe ? 'setup' : 'unavailable') : guidance ? 'processor' : 'unavailable';
  const estimate = state.order?.gift_card_estimate;
  const giftOnly = (state.order?.gift_cards?.length ?? 0) > 0 && estimate?.can_pay && isZero(estimate.processor_money);
  if (isZero(outstanding) || giftOnly) return 'settlement';
  return guidance ? 'processor' : 'unavailable';
}

/**
 * The amount a payment processor must collect. Gift cards can cover an order
 * entirely, and then no payment form is needed.
 * @param {CheckoutState} state @returns {Money | null}
 */
export function processorMoney(state) {
  const estimate = state.order?.gift_card_estimate;
  if (state.kind === 'order' && estimate && estimate.can_pay && (state.order.gift_cards?.length ?? 0) > 0 && estimate.processor_money) {
    return estimate.processor_money;
  }
  return outstandingOf(state);
}

/** @param {CheckoutState} state */
export function guidanceOf(state) {
  return state.payment_collection ?? state.setup_collection ?? null;
}

/**
 * True when the buyer must enter or choose a payment method.
 * Subscriptions always collect a source, including free trials (setup).
 * @param {CheckoutState} state
 */
export function needsProcessor(state) {
  const kind = collectionKindOf(state);
  return kind === 'processor' || kind === 'setup';
}

/**
 * Order with nothing for a processor to collect: discounts or gift cards cover it.
 * @param {CheckoutState} state
 */
export function isSettlementOnly(state) {
  return collectionKindOf(state) === 'settlement';
}

/**
 * @param {CheckoutState} state
 * @returns {'order'|'confirm_order'|'subscription_paid'|'subscription_trial'}
 */
export function buttonKind(state) {
  if (state.kind === 'subscription') {
    return collectionKindOf(state) === 'setup' || isZero(outstandingOf(state)) ? 'subscription_trial' : 'subscription_paid';
  }
  return collectionKindOf(state) === 'settlement' ? 'confirm_order' : 'order';
}

/** @param {CheckoutState} state */
export function declineCode(state) {
  const attempt = state.attempt;
  if (!attempt) return null;
  if (attempt.failure_code) return String(attempt.failure_code);
  for (const intent of attempt.payment_intents ?? []) {
    if (intent.last_payment_error?.code) return intent.last_payment_error.code;
  }
  return null;
}

/** @param {string | null | undefined} code */
export function affirmShouldBeRemoved(code) {
  return code === 'payment_method_declined' || code === 'payment_method_temporarily_unavailable';
}

/**
 * Payment source type of an attempt leg, read from the order's payment intents
 * and matched by payment intent id. Attempt legs do not carry it themselves.
 * @param {CheckoutState} state
 * @param {string} paymentIntentId
 */
export function legSourceType(state, paymentIntentId) {
  return state.order?.payment_intents?.find((intent) => intent.payment_intent_id === paymentIntentId)?.payment_source?.type ?? '';
}

/** @param {CheckoutState} state */
function hasAffirmAction(state) {
  return (state.attempt?.payment_intents ?? []).some((leg) => legSourceType(state, leg.payment_intent_id) === 'affirm' && leg.status === 'requires_action');
}

/**
 * @param {CheckoutState} state
 * @returns {RestingPaymentState}
 */
export function derivePaymentState(state) {
  if (isExpired(state)) return 'expired';
  if (state.session.recovery_mode) return 'recovery';
  const attempt = state.attempt;
  // The app can hold an unresolved payment request before Flint shows any attempt. Treat it as resolving.
  if (!attempt && state.next === 'resume') return 'resuming';
  if (attempt) {
    switch (state.next) {
      case 'done':
        return 'succeeded';
      case 'bank_processing':
        return 'bank_processing';
      case 'authenticate':
        return hasAffirmAction(state) ? 'affirm_incomplete' : 'authenticating';
      case 'resume':
        return 'resuming';
      case 'wait':
        return 'waiting';
      case 'capture':
        return 'unavailable';
      case 'pay_remaining':
        return 'pay_remaining';
      case 'new_payment':
        if (attempt.status === 'failed' || attempt.failure_code) return 'declined';
        break;
      default:
        break;
    }
  }
  if (taxLocationState(state) === 'needed') return 'needs_billing';
  const collection = collectionKindOf(state);
  if (collection === 'unavailable') return 'unavailable';
  if (needsProcessor(state) && !guidanceOf(state)?.stripe?.elements) return 'unavailable';
  return 'ready';
}

/** @param {RestingPaymentState | 'loading' | 'submitting' | 'total_changed'} paymentState */
export function attemptIsOpen(paymentState) {
  return ['authenticating', 'resuming', 'waiting', 'bank_processing', 'affirm_incomplete'].includes(paymentState);
}

// ----- Delivery -----

/** @param {CheckoutState} state */
export function showDelivery(state) {
  return state.kind === 'order' && Boolean(state.session.delivery_selection_required || state.delivery_selection || state.delivery_quote);
}

/** @param {CheckoutState} state */
function selectionStale(state) {
  const problems = state.session.problems ?? [];
  if (problems.some((problem) => problem.code === 'delivery_selection_stale')) return true;
  return ['stale', 'expired', 'superseded', 'revoked'].includes(state.delivery_quote?.status ?? '') && !state.delivery_selection;
}

/** @param {CheckoutState} state */
export function pickupOptions(state) {
  if (Array.isArray(state.pickup_locations)) {
    return [...state.pickup_locations].filter((item) => item.availability_status !== 'unavailable').sort((a, b) => (a.display_position ?? 0) - (b.display_position ?? 0));
  }
  return (state.delivery_quote?.choice_groups ?? []).flatMap((group) => group.options.filter(isPickupType).map((option) => ({ ...option, delivery_choice_group_id: group.delivery_choice_group_id, availability_status: group.availability_status })));
}

/**
 * True when the last pickup search found no location that can fill the cart.
 * @param {CheckoutState} state
 */
export function pickupNoneNearby(state) {
  if (state.delivery_quote || state.delivery_selection || !state.pickup_search) return false;
  return pickupOptions(state).length === 0;
}

/**
 * @param {CheckoutState} state
 * @returns {'idle'|'options'|'needs_input'|'unavailable'|'stale'|'selected'|'none_nearby'|null}
 */
export function deliveryState(state) {
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

/** @param {{ type?: string }} item */
export function isPickupType(item) {
  return item.type === 'pickup';
}

/**
 * @param {CheckoutState} state
 * @returns {'ship'|'pickup'}
 */
export function deliveryMode(state) {
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

/**
 * Modes to offer. Both before a quote; afterward only types the quote reports.
 * @param {CheckoutState} state
 * @returns {('ship'|'pickup')[]}
 */
export function deliveryModes(state) {
  const quote = state.delivery_quote;
  const types = new Set((quote?.choice_groups ?? []).flatMap((group) => group.method_types ?? []));
  if (!types.size) return ['ship', 'pickup'];
  /** @type {('ship'|'pickup')[]} */
  const modes = [];
  if ([...types].some((type) => type !== 'pickup')) modes.push('ship');
  if (types.has('pickup')) modes.push('pickup');
  return modes.length ? modes : ['ship', 'pickup'];
}

// ----- Billing address for tax -----

/**
 * Whether the page asks for a full US billing address so tax can be calculated. Only checkouts
 * with no delivery step ask. `needed` means tax requires a location and lists `provided` as an
 * input; it blocks payment. `set` means the order's location came from the buyer
 * (`location.address_source === 'provided'`) so they can change it. The server stops listing
 * inputs once tax is calculated, so `set` does not depend on `available_location_inputs`.
 * @param {CheckoutState} state
 * @returns {'needed'|'set'|null}
 */
export function taxLocationState(state) {
  if (showDelivery(state)) return null;
  const tax = state.order?.tax;
  if (tax?.enabled !== true) return null;
  if (tax.status === 'requires_location') return (tax.available_location_inputs ?? []).includes('provided') ? 'needed' : null;
  if (tax.location?.address_source === 'provided') return 'set';
  return null;
}

// ----- Tip -----

export const TIP_PERCENTS = [10, 15, 20];

/** @param {CheckoutState} state */
export function tipVisible(state) {
  if (state.kind !== 'order') return false;
  if (state.session.tip && state.session.tip.enabled === false) return false;
  return (state.delivery_selection?.choices ?? []).some(isPickupType);
}

/**
 * @param {CheckoutState} state
 * @returns {'none'|'10'|'15'|'20'|'custom'}
 */
export function tipChoice(state) {
  const tip = state.order.requested_tip;
  if (tip?.percent !== undefined && tip.percent !== null) {
    const asString = String(tip.percent);
    if (asString === '10' || asString === '15' || asString === '20') return asString;
    return 'custom';
  }
  if (tip?.amount_money) return 'custom';
  return 'none';
}

// ----- Pay blockers -----

/**
 * Blockers the server state can already prove. The browser adds
 * `contact_email_missing` and `elements_incomplete` from the live form.
 * @param {CheckoutState} state
 * @returns {string[]}
 */
export function serverBlockers(state) {
  /** @type {string[]} */
  const blockers = [];
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

/** @param {unknown} value @returns {boolean} */
export function looksLikeEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
