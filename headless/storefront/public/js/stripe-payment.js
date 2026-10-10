// @ts-check
// Stripe.js wrapper for the checkout page. It mounts the Payment Element and,
// when wallets are offered, a separate Express Checkout Element. It creates a
// single-use credential (ConfirmationToken or PaymentMethod) for the app server
// and runs a pending provider action. It never calls Flint.
//
// Stripe.js is loaded by the page with a script tag from js.stripe.com. This
// module does not bundle or self-host it.

/** @typedef {import('./money.js').Money} Money */
/**
 * @typedef {{
 *   publishable_key?: string,
 *   account_id?: string,
 *   return_url?: string,
 *   elements?: {
 *     mode: string, next_step: string, submit_to?: string, payment_method_creation?: string,
 *     payment_method_types: string[], digital_wallets?: string[], amount_money?: Money | null,
 *     payment_method_options?: Record<string, any>,
 *   } | null,
 * }} StripeGuidance
 */
/**
 * @typedef {{
 *   publishable_key: string, account_id: string,
 *   payment_intent?: { client_secret: string, stripe_js_call: string } | null,
 *   setup_intent?: { client_secret: string, stripe_js_call: string } | null,
 * }} ClientAction
 */
/** @typedef {{ kind: 'confirmation_token' | 'payment_method_token', value: string }} Credential */
/** @typedef {{ name: string, email: string, country?: string }} Billing */
/** @typedef {{ name: string, address: { line1?: string, line2?: string, city?: string, state?: string, postal_code?: string, country?: string } } | null} Shipping */

const STRIPE_WAIT_MS = 10_000;

/** @returns {Promise<any>} */
export function whenStripeLoaded() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const factory = /** @type {any} */ (window).Stripe;
      if (factory) return resolve(factory);
      if (Date.now() - started > STRIPE_WAIT_MS) return reject(new Error('stripe_not_loaded'));
      window.setTimeout(check, 50);
    };
    check();
  });
}

/**
 * Runs a pending provider action with no Elements, guidance or card form. Only the action Flint
 * returned is used. Anything but `handle_next_action` is refused without calling Stripe.
 * `invoked` is true once Stripe was called, whether or not it returned an error.
 * @param {ClientAction | null | undefined} action
 * @param {{ onInvoke?: () => void }} [hooks]
 * @returns {Promise<{ invoked: boolean, error?: { message?: string, code?: string } }>}
 */
export async function runClientAction(action, hooks) {
  const call = action?.payment_intent ?? action?.setup_intent;
  if (!action?.publishable_key || !call?.client_secret || call.stripe_js_call !== 'handle_next_action') return { invoked: false, error: { message: 'missing_client_action' } };
  let factory;
  try {
    factory = await whenStripeLoaded();
  } catch {
    return { invoked: false, error: { message: 'stripe_not_loaded' } };
  }
  const client = factory(action.publishable_key, action.account_id ? { stripeAccount: action.account_id } : undefined);
  hooks?.onInvoke?.();
  try {
    const result = await client.handleNextAction({ clientSecret: call.client_secret });
    return result?.error ? { invoked: true, error: result.error } : { invoked: true };
  } catch (error) {
    return { invoked: true, error: { message: String(/** @type {any} */ (error)?.message ?? error) } };
  }
}

/** @param {Money | null | undefined} money */
function minorNumber(money) {
  return money ? Number(money.amount) : 0;
}

/**
 * @param {Record<string, any> | undefined} options
 * @param {boolean} saving
 */
function optionsForSaving(options, saving) {
  /** @type {Record<string, any>} */
  const copy = JSON.parse(JSON.stringify(options ?? {}));
  if (saving) {
    for (const type of ['us_bank_account', 'affirm']) {
      if (copy[type]) copy[type] = { ...copy[type], setup_future_usage: 'none' };
    }
  }
  return copy;
}

/**
 * @param {{
 *   guidance: StripeGuidance,
 *   kind: 'order' | 'subscription',
 *   saveOffered: boolean,
 *   excludeAffirm: boolean,
 *   amount: Money | null,
 *   mounts: { payment: HTMLElement, wallets: HTMLElement | null, walletsRegion: HTMLElement | null, messaging: HTMLElement | null },
 *   onChange: (change: { complete: boolean, type: string }) => void,
 *   onReady: () => void,
 *   onWalletClick: () => boolean,
 *   onWalletConfirm: (event: any, makeCredential: () => Promise<{ credential?: Credential, error?: { message: string } }>) => Promise<void>,
 *   getBilling: () => Billing,
 *   getShipping: () => Shipping,
 * }} options
 */
export async function createStripePayment(options) {
  const factory = await whenStripeLoaded();
  const stripeInfo = options.guidance;
  const guidance = stripeInfo.elements;
  if (!stripeInfo.publishable_key || !guidance) throw new Error('payment_guidance_missing');
  /** @type {any} */
  let stripe = factory(stripeInfo.publishable_key, stripeInfo.account_id ? { stripeAccount: stripeInfo.account_id } : undefined);
  const currency = (options.amount?.currency ?? guidance.amount_money?.currency ?? 'usd').toLowerCase();
  const setupMode = guidance.mode === 'setup';
  const subscription = options.kind === 'subscription';
  let saving = false;
  let amountMinor = minorNumber(options.amount ?? guidance.amount_money);
  const types = guidance.payment_method_types.filter((type) => !(options.excludeAffirm && type === 'affirm'));

  /** @param {boolean} withTypes */
  const baseOptions = (withTypes) => {
    /** @type {Record<string, any>} */
    const base = {
      mode: guidance.mode,
      currency,
      paymentMethodCreation: 'manual',
      appearance: { theme: 'stripe', variables: { colorPrimary: '#1f5a3d', colorText: '#1d1b16', fontFamily: 'system-ui, sans-serif', borderRadius: '4px' } },
    };
    if (!setupMode) base.amount = amountMinor;
    if (subscription) base.setupFutureUsage = 'off_session';
    if (withTypes) {
      base.paymentMethodTypes = types;
      if (guidance.payment_method_options) base.paymentMethodOptions = optionsForSaving(guidance.payment_method_options, false);
    }
    return base;
  };

  const paymentElements = stripe.elements(baseOptions(true));
  const paymentElement = paymentElements.create('payment', {
    wallets: { applePay: 'never', googlePay: 'never' },
    ...(options.saveOffered ? { terms: { card: 'never' } } : {}),
    fields: { billingDetails: { name: 'never', email: 'never' } },
    defaultValues: { billingDetails: { name: options.getBilling().name, email: options.getBilling().email } },
  });
  let complete = false;
  let selectedType = 'card';
  paymentElement.on('change', (/** @type {any} */ event) => {
    complete = Boolean(event.complete);
    selectedType = event.value?.type ?? selectedType;
    options.onChange({ complete, type: selectedType });
  });
  paymentElement.on('ready', () => options.onReady());
  paymentElement.mount(options.mounts.payment);

  /** @type {any} */
  let walletElements = null;
  /** @type {any} */
  let walletElement = null;
  const wallets = (guidance.digital_wallets ?? []).filter(Boolean);
  if (wallets.length && options.mounts.wallets && options.mounts.walletsRegion) {
    try {
      walletElements = stripe.elements({ ...baseOptions(false), ...(subscription ? {} : {}) });
      walletElement = walletElements.create('expressCheckout', {
        paymentMethods: { applePay: 'auto', googlePay: 'auto', link: 'never', amazonPay: 'never', paypal: 'never' },
        buttonHeight: 44,
      });
      walletElement.on('ready', (/** @type {any} */ event) => {
        const available = event?.availablePaymentMethods;
        if (available && (available.applePay || available.googlePay)) options.mounts.walletsRegion?.removeAttribute('hidden');
      });
      walletElement.on('click', (/** @type {any} */ event) => {
        if (options.onWalletClick()) event.resolve({});
      });
      walletElement.on('confirm', (/** @type {any} */ event) =>
        options.onWalletConfirm(event, async () => {
          const submit = await walletElements.submit();
          if (submit?.error) return { error: submit.error };
          return makeToken(walletElements, 'wallet');
        }),
      );
      walletElement.mount(options.mounts.wallets);
    } catch {
      // Wallets are optional. The card form stays usable.
      walletElement = null;
    }
  }

  /** @type {any} */
  let messaging = null;
  if (options.mounts.messaging && types.includes('affirm') && !setupMode && currency === 'usd') {
    try {
      messaging = stripe.elements().create('paymentMethodMessaging', { amount: amountMinor, currency: 'USD', paymentMethodTypes: ['affirm'], countryCode: 'US' });
      messaging.mount(options.mounts.messaging);
    } catch {
      messaging = null;
    }
  }

  /**
   * @param {any} elements
   * @param {'card' | 'wallet'} source
   * @returns {Promise<{ credential?: Credential, error?: { message: string, code?: string } }>}
   */
  async function makeToken(elements, source) {
    const billing = options.getBilling();
    /** @type {Record<string, any>} */
    const billingDetails = { name: billing.name, email: billing.email };
    // Affirm needs the billing country. The Payment Element keeps its own country field, so only Affirm sends one.
    if (source === 'card' && selectedType === 'affirm' && billing.country) billingDetails.address = { country: billing.country };
    if (guidance?.next_step === 'create_confirmation_token') {
      /** @type {Record<string, any>} */
      const params = { payment_method_data: { billing_details: billingDetails } };
      if (stripeInfo.return_url) params.return_url = stripeInfo.return_url;
      const shipping = options.getShipping();
      if (shipping) params.shipping = shipping;
      const result = await stripe.createConfirmationToken({ elements, params });
      if (result.error) return { error: result.error };
      return { credential: { kind: 'confirmation_token', value: result.confirmationToken.id } };
    }
    const result = await stripe.createPaymentMethod({ elements, params: { billing_details: billingDetails } });
    if (result.error) return { error: result.error };
    void source;
    return { credential: { kind: 'payment_method_token', value: result.paymentMethod.id } };
  }

  return {
    /** Collects and tokenizes the typed payment details. */
    async createCredential() {
      const submit = await paymentElements.submit();
      if (submit?.error) return { error: submit.error };
      return makeToken(paymentElements, 'card');
    },

    isComplete: () => complete,
    selectedType: () => selectedType,

    /** @param {boolean} value */
    async setSaving(value) {
      saving = value;
      /** @type {Record<string, any>} */
      const update = { setupFutureUsage: value ? 'on_session' : null };
      if (guidance.payment_method_options) update.paymentMethodOptions = optionsForSaving(guidance.payment_method_options, value);
      const finished = new Promise((resolve) => {
        paymentElements.on?.('update-end', resolve);
        window.setTimeout(resolve, 3000);
      });
      try {
        await paymentElements.update(update);
        await finished;
      } catch {
        // The next token request reports the real problem if the update failed.
      }
    },

    isSaving: () => saving,

    /** @param {Money | null} money */
    updateAmount(money) {
      if (setupMode || !money || Number(money.amount) <= 0) return;
      amountMinor = minorNumber(money);
      paymentElements.update({ amount: amountMinor });
      walletElements?.update({ amount: amountMinor });
      messaging?.update({ amount: amountMinor });
    },

    clearPayment() {
      try {
        paymentElement.clear();
      } catch {
        // clear() is not available on every Stripe.js build.
      }
      complete = false;
      options.onChange({ complete: false, type: selectedType });
    },

    /**
     * Runs the pending provider action. A new Stripe instance is used when the
     * action names a different publishable key or connected account.
     * @param {ClientAction} action
     * @returns {Promise<{ error?: { message?: string, code?: string } }>}
     */
    async handleNextAction(action) {
      const run = await runClientAction(action);
      return run.error ? { error: run.error } : {};
    },

    destroy() {
      for (const element of [paymentElement, walletElement, messaging]) {
        try {
          element?.destroy();
        } catch {
          // Already gone.
        }
      }
      stripe = null;
    },
  };
}
