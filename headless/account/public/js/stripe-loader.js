// @ts-check
// Stripe.js is loaded from Stripe by a script tag in the page head. This module only waits for it.
// Nothing here talks to Flint.

/**
 * Resolves with the Stripe global once the provider script has loaded.
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
export function whenStripeReady(timeoutMs = 20000) {
  const win = /** @type {any} */ (window);
  if (typeof win.Stripe === 'function') return Promise.resolve(win.Stripe);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    // Poll: a load or error may have happened before this module ran, and polling covers both.
    const check = () => {
      if (typeof win.Stripe === 'function') resolve(win.Stripe);
      else if (document.documentElement.dataset.stripeFailed === 'true') reject(new Error('stripe_blocked'));
      else if (Date.now() - started > timeoutMs) reject(new Error('stripe_timeout'));
      else window.setTimeout(check, 50);
    };
    check();
  });
}

/**
 * @param {any} StripeFactory
 * @param {string} publishableKey
 * @param {string | undefined} accountId
 * @returns {any}
 */
export function createStripe(StripeFactory, publishableKey, accountId) {
  return accountId ? StripeFactory(publishableKey, { stripeAccount: accountId }) : StripeFactory(publishableKey);
}

/** Appearance for Stripe's frames, matched to this app's palette. */
export const appearance = {
  theme: 'stripe',
  variables: {
    colorPrimary: '#1f5c45',
    colorText: '#1d1b16',
    colorDanger: '#a3262a',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    borderRadius: '4px',
    spacingUnit: '4px',
  },
};
