// @ts-check
// Runs the pending action the server hands this page for a payment. The server projects it as a
// closed union on `type`:
//
//   { type: 'url', url, expiresAt }          open the Flint-hosted page as a top-level redirect
//   { type: 'stripe', stripe, expiresAt }    run Stripe.js handleNextAction with the client secret
//
// The page branches on `type` and never guesses the variant from which fields are present. An
// unknown type, a missing field, or an action past its expiry is not opened. Nothing here logs the
// client secret or writes it to the page.

/**
 * @typedef {{
 *   status: 'redirected' | 'stripe' | 'expired' | 'unsupported' | 'unavailable',
 *   error?: { message?: string, code?: string },
 * }} ActionOutcome
 */

/**
 * True when the action's own expiry has passed. A missing or unreadable expiry is not treated as
 * expired: the server decides, and the resume that follows reads the true outcome.
 * @param {{ expiresAt?: unknown } | null | undefined} action
 * @param {number} [now]
 */
export function isActionExpired(action, now = Date.now()) {
  if (!action || typeof action.expiresAt !== 'string') return false;
  const at = Date.parse(action.expiresAt);
  return Number.isFinite(at) && at <= now;
}

/**
 * Only an http or https address is followed, so a malformed or script address never navigates.
 * @param {unknown} value
 * @returns {string | null}
 */
export function redirectTarget(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * @param {any} action
 * @param {{
 *   loadStripe: (publishableKey: string, accountId: string | undefined) => Promise<any>,
 *   navigate: (url: string) => void,
 *   now?: number,
 *   onInvoke?: () => void,
 * }} deps
 * @returns {Promise<ActionOutcome>}
 */
export async function runClientAction(action, deps) {
  if (!action || typeof action !== 'object') return { status: 'unsupported' };
  if (isActionExpired(action, deps.now)) return { status: 'expired' };
  if (action.type === 'url') {
    const target = redirectTarget(action.url);
    if (!target) return { status: 'unsupported' };
    deps.onInvoke?.();
    deps.navigate(target);
    return { status: 'redirected' };
  }
  if (action.type === 'stripe') {
    const stripe = action.stripe;
    const call = stripe?.payment_intent ?? stripe?.setup_intent;
    if (!stripe?.publishable_key || !call?.client_secret || call.stripe_js_call !== 'handle_next_action') return { status: 'unsupported' };
    let client;
    try {
      client = await deps.loadStripe(stripe.publishable_key, stripe.account_id ?? undefined);
    } catch {
      return { status: 'unavailable' };
    }
    deps.onInvoke?.();
    try {
      const result = await client.handleNextAction({ clientSecret: call.client_secret });
      return result?.error ? { status: 'stripe', error: { message: result.error.message, code: result.error.code } } : { status: 'stripe' };
    } catch (error) {
      return { status: 'stripe', error: { message: String(/** @type {any} */ (error)?.message ?? error) } };
    }
  }
  return { status: 'unsupported' };
}
