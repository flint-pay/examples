// @ts-check
// Pure payment state logic shared by the server renderer (first paint) and the browser module.
// The names match the browser state machine in the spec. `loading` and `submitting` exist only in
// the browser while work is in flight, so they are not derived here.

/**
 * @typedef {import('../../src/views/types.ts').PaymentState} PaymentState
 * @typedef {'unavailable' | 'ready' | 'authenticating' | 'resuming' | 'waiting' | 'bank_processing' | 'declined' | 'pay_remaining' | 'total_changed' | 'affirm_incomplete' | 'recovery' | 'expired' | 'succeeded'} PaymentPhase
 * @typedef {'authenticate' | 'resume' | 'wait' | 'none'} PaymentWork
 */

/**
 * @param {PaymentState} state
 * @returns {boolean}
 */
export function hasPaymentCollection(state) {
  const stripe = state.payment_collection?.stripe;
  const elements = stripe?.elements;
  return Boolean(stripe && elements && elements.mode === 'payment' && stripe.publishable_key && stripe.account_id);
}

/**
 * True when an unfinished leg is an Affirm leg, or when the state does not say which payment
 * option the open leg uses. Affirm is the only method here that leaves the page and comes back,
 * so an open action after a provider return is an unfinished Affirm application.
 * @param {PaymentState} state
 */
export function hasOpenAffirmLeg(state) {
  const open = (state.attempt?.legs ?? []).filter((leg) => leg.status !== 'succeeded');
  if (!open.length) return true;
  return open.some((leg) => leg.payment_option === 'affirm' || !leg.payment_option);
}

/**
 * @param {PaymentState} state
 * @returns {PaymentPhase}
 */
export function derivePhase(state) {
  const next = state.next;
  if (next === 'done') return 'succeeded';
  if (next === 'bank_processing') return 'bank_processing';
  if (state.recovery_mode) return 'recovery';
  if (next === 'authenticate') return state.returned && hasOpenAffirmLeg(state) ? 'affirm_incomplete' : 'authenticating';
  if (next === 'resume') return 'resuming';
  if (next === 'wait') return 'waiting';
  if (next === 'pay_remaining') return 'pay_remaining';
  if (next === 'capture') return 'unavailable';
  if (state.expired && !state.attempt) return 'expired';
  if (!hasPaymentCollection(state)) return 'unavailable';
  if (state.total_changed) return 'total_changed';
  if (state.decline && state.attempt?.status === 'failed') return 'declined';
  return 'ready';
}

/**
 * What the browser has to do next without the buyer. Used in every phase, including recovery.
 * @param {PaymentState} state
 * @returns {PaymentWork}
 */
export function workFor(state) {
  switch (state.next) {
    case 'authenticate':
      return 'authenticate';
    case 'resume':
      return 'resume';
    case 'wait':
      return 'wait';
    default:
      return 'none';
  }
}

/**
 * Phases in which the buyer can submit a new credential.
 * @param {PaymentPhase} phase
 */
export function acceptsNewPayment(phase) {
  return phase === 'ready' || phase === 'declined' || phase === 'pay_remaining' || phase === 'total_changed';
}

/** Payment error codes after which Affirm is removed for the rest of the page view. */
export const AFFIRM_REMOVING_CODES = ['payment_method_declined', 'payment_method_temporarily_unavailable'];

/**
 * @param {PaymentState['decline']} decline
 */
export function shouldDropAffirm(decline) {
  return Boolean(decline && decline.payment_option === 'affirm' && AFFIRM_REMOVING_CODES.includes(decline.code));
}

/**
 * Names the reason the Pay button is disabled, or null when payment can start.
 * @param {{ phase: PaymentPhase, elementsComplete: boolean, usingSaved: boolean, hasSaved: boolean, busy: boolean }} input
 * @returns {'attempt_open' | 'session_not_open' | 'elements_incomplete' | 'unavailable' | null}
 */
export function payBlocker(input) {
  if (input.busy) return 'attempt_open';
  switch (input.phase) {
    case 'expired':
      return 'session_not_open';
    case 'unavailable':
      return 'unavailable';
    case 'ready':
    case 'declined':
    case 'pay_remaining':
    case 'total_changed':
      break;
    default:
      return 'attempt_open';
  }
  if (input.usingSaved && input.hasSaved) return null;
  return input.elementsComplete ? null : 'elements_incomplete';
}
