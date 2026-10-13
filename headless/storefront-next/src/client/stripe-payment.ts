// Stripe.js wrapper for the checkout page. It mounts the Payment Element and,
// when wallets are offered, a separate Express Checkout Element. It creates a
// single-use credential (ConfirmationToken or PaymentMethod) for the app server
// and runs a pending provider action. It never calls Flint.
//
// Stripe.js loads from js.stripe.com/v3, the version Flint's Elements guidance is written for. Newer
// pinned releases, which `loadStripe` from @stripe/stripe-js 10 loads, reject `paymentMethodTypes`.
// The package is used for its types only. Nothing is bundled or self-hosted.

import type { Stripe, StripeConstructor, StripeElements } from '@stripe/stripe-js';
import type { Money } from '../shared/money.ts';
import type { StripeGuidance } from '../shared/types.ts';

export type StripeInfo = NonNullable<StripeGuidance['stripe']>;
export type ClientAction = {
  publishable_key: string;
  account_id?: string;
  payment_intent?: { client_secret: string; stripe_js_call: string } | null;
  setup_intent?: { client_secret: string; stripe_js_call: string } | null;
};
export type Credential = { kind: 'confirmation_token' | 'payment_method_token'; value: string };
export type Billing = { name: string; email: string; country?: string; postal_code?: string };
export type Shipping = { name: string; address: { line1?: string; line2?: string; city?: string; state?: string; postal_code?: string; country?: string } } | null;
type StripeError = { message?: string; code?: string };
type MadeCredential = { credential?: Credential; error?: StripeError };

const STRIPE_JS = 'https://js.stripe.com/v3/';
const STRIPE_WAIT_MS = 10_000;
const stripes = new Map<string, Stripe>();

/** Adds the Stripe.js script once and waits for it. A blocked or slow script fails after 10 seconds. */
function whenStripeLoaded(): Promise<StripeConstructor> {
  const ready = () => (window as unknown as { Stripe?: StripeConstructor }).Stripe;
  if (!document.querySelector(`script[src="${STRIPE_JS}"]`)) {
    const script = document.createElement('script');
    script.src = STRIPE_JS;
    script.async = true;
    document.head.append(script);
  }
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const factory = ready();
      if (factory) return resolve(factory);
      if (Date.now() - started > STRIPE_WAIT_MS) return reject(new Error('stripe_not_loaded'));
      window.setTimeout(check, 50);
    };
    check();
  });
}

/** One Stripe.js instance per publishable key and connected account. */
async function stripeFor(publishableKey: string, accountId?: string): Promise<Stripe> {
  const key = `${publishableKey}:${accountId ?? ''}`;
  let stripe = stripes.get(key);
  if (!stripe) {
    const factory = await whenStripeLoaded();
    stripe = factory(publishableKey, accountId ? { stripeAccount: accountId } : undefined);
    stripes.set(key, stripe);
  }
  return stripe;
}

/**
 * Runs a pending provider action with no Elements, guidance or card form. Only the action Flint
 * returned is used. Anything but `handle_next_action` is refused without calling Stripe.
 * `invoked` is true once Stripe was called, whether or not it returned an error.
 */
export async function runClientAction(action: ClientAction | null | undefined, hooks?: { onInvoke?: () => void }): Promise<{ invoked: boolean; error?: StripeError }> {
  const call = action?.payment_intent ?? action?.setup_intent;
  if (!action?.publishable_key || !call?.client_secret || call.stripe_js_call !== 'handle_next_action') return { invoked: false, error: { message: 'missing_client_action' } };
  let client: Stripe;
  try {
    client = await stripeFor(action.publishable_key, action.account_id);
  } catch {
    return { invoked: false, error: { message: 'stripe_not_loaded' } };
  }
  hooks?.onInvoke?.();
  try {
    const result = await client.handleNextAction({ clientSecret: call.client_secret });
    return result?.error ? { invoked: true, error: result.error } : { invoked: true };
  } catch (error) {
    return { invoked: true, error: { message: String((error as Error)?.message ?? error) } };
  }
}

function minorNumber(money: Money | null | undefined): number {
  return money ? Number(money.amount) : 0;
}

function optionsForSaving(options: Record<string, unknown> | undefined, saving: boolean): Record<string, Record<string, unknown>> {
  const copy = JSON.parse(JSON.stringify(options ?? {})) as Record<string, Record<string, unknown>>;
  if (saving) {
    for (const type of ['us_bank_account', 'affirm']) {
      if (copy[type]) copy[type] = { ...copy[type], setup_future_usage: 'none' };
    }
  }
  return copy;
}

// The Elements appearance follows the store's design tokens in globals.css.
const appearance = {
  theme: 'stripe' as const,
  variables: {
    colorPrimary: '#1f5a3d',
    colorText: '#1d1b16',
    colorTextSecondary: '#5c564b',
    colorBackground: '#fffdf9',
    colorDanger: '#9a2517',
    fontFamily: 'Inter, system-ui, sans-serif',
    borderRadius: '10px',
    spacingUnit: '4px',
  },
  rules: {
    '.Input': { border: '1px solid #d6cdbd', boxShadow: 'none' },
    '.Input:focus': { border: '1px solid #1f5a3d', boxShadow: '0 0 0 3px rgba(31, 90, 61, 0.18)' },
    '.Tab': { border: '1px solid #d6cdbd', boxShadow: 'none' },
    '.Tab--selected': { borderColor: '#1f5a3d', boxShadow: '0 0 0 1px #1f5a3d' },
  },
};

export type StripePayment = Awaited<ReturnType<typeof createStripePayment>>;

export async function createStripePayment(options: {
  guidance: StripeInfo;
  kind: 'order' | 'subscription';
  saveOffered: boolean;
  excludeAffirm: boolean;
  amount: Money | null;
  mounts: { payment: HTMLElement; wallets: HTMLElement | null; messaging: HTMLElement | null };
  onWalletsAvailable: (available: boolean) => void;
  onChange: (change: { complete: boolean; type: string }) => void;
  onReady: () => void;
  onWalletClick: () => boolean;
  onWalletConfirm: (event: { paymentFailed?: (reason: { reason: string }) => void }, makeCredential: () => Promise<MadeCredential>) => Promise<void>;
  getBilling: () => Billing;
  getShipping: () => Shipping;
}) {
  const stripeInfo = options.guidance;
  const guidance = stripeInfo.elements;
  // The return address rotates when the order is refreshed, so it is read when a credential is made.
  let returnUrl = stripeInfo.return_url;
  if (!stripeInfo.publishable_key || !guidance) throw new Error('payment_guidance_missing');
  let stripe: Stripe | null = await stripeFor(stripeInfo.publishable_key, stripeInfo.account_id);
  const currency = (options.amount?.currency ?? guidance.amount_money?.currency ?? 'usd').toLowerCase();
  const setupMode = guidance.mode === 'setup';
  const subscription = options.kind === 'subscription';
  let saving = false;
  let amountMinor = minorNumber(options.amount ?? guidance.amount_money);
  const types = guidance.payment_method_types.filter((type) => !(options.excludeAffirm && type === 'affirm'));

  // The Payment and Express Checkout Elements share one explicit method selection. Stripe rejects wallet
  // tokens from Elements that use automatic methods when the backend lists its allowed methods.
  const baseOptions = () => {
    const base: Record<string, unknown> = { mode: guidance.mode, currency, paymentMethodCreation: 'manual', appearance };
    if (!setupMode) base.amount = amountMinor;
    if (subscription) base.setupFutureUsage = 'off_session';
    base.paymentMethodTypes = types;
    if (guidance.payment_method_options) base.paymentMethodOptions = optionsForSaving(guidance.payment_method_options, false);
    return base;
  };

  // Stripe's option types do not model every guidance field Flint returns, so options are built loosely.
  const paymentElements = stripe.elements(baseOptions() as never) as StripeElements;
  const paymentElement = paymentElements.create('payment', {
    wallets: { applePay: 'never', googlePay: 'never' },
    ...(options.saveOffered ? { terms: { card: 'never' } } : {}),
    fields: { billingDetails: { name: 'never', email: 'never' } },
    defaultValues: { billingDetails: { name: options.getBilling().name, email: options.getBilling().email } },
  } as never);
  let complete = false;
  let selectedType = 'card';
  paymentElement.on('change', (event: { complete?: boolean; value?: { type?: string } }) => {
    complete = Boolean(event.complete);
    selectedType = event.value?.type ?? selectedType;
    options.onChange({ complete, type: selectedType });
  });
  paymentElement.on('ready', () => options.onReady());
  paymentElement.mount(options.mounts.payment);

  let walletElements: StripeElements | null = null;
  let walletElement: { destroy(): void } | null = null;
  const wallets = (guidance.digital_wallets ?? []).filter(Boolean);
  if (wallets.length && options.mounts.wallets) {
    try {
      walletElements = stripe.elements(baseOptions() as never) as StripeElements;
      const express = walletElements.create('expressCheckout', {
        paymentMethods: { applePay: 'auto', googlePay: 'auto', link: 'never', amazonPay: 'never', paypal: 'never' },
        buttonHeight: 48,
      } as never);
      express.on('ready', (event: { availablePaymentMethods?: { applePay?: boolean; googlePay?: boolean } }) => {
        const available = event?.availablePaymentMethods;
        options.onWalletsAvailable(Boolean(available && (available.applePay || available.googlePay)));
      });
      express.on('click', (event: { resolve: (value: object) => void }) => {
        if (options.onWalletClick()) event.resolve({});
      });
      express.on('confirm', ((event: { paymentFailed?: (reason: { reason: string }) => void }) =>
        options.onWalletConfirm(event, async () => {
          const submit = await walletElements!.submit();
          if (submit?.error) return { error: submit.error };
          return makeToken(walletElements!, 'wallet');
        })) as never,
      );
      express.mount(options.mounts.wallets);
      walletElement = express;
    } catch {
      // Wallets are optional. The card form stays usable.
      walletElement = null;
    }
  }

  type Messaging = { update(options: object): void; destroy(): void };
  let messaging: Messaging | null = null;
  if (options.mounts.messaging && types.includes('affirm') && !setupMode && currency === 'usd') {
    try {
      const element = stripe.elements().create('paymentMethodMessaging', { amount: amountMinor, currency: 'USD', paymentMethodTypes: ['affirm'], countryCode: 'US' } as never);
      element.mount(options.mounts.messaging);
      messaging = element as unknown as Messaging;
    } catch {
      messaging = null;
    }
  }

  async function makeToken(elements: StripeElements, source: 'card' | 'wallet'): Promise<MadeCredential> {
    const billing = options.getBilling();
    const billingDetails: Record<string, unknown> = { name: billing.name, email: billing.email };
    // Affirm needs the billing country and postal code. The Payment Element keeps its own address fields, so only Affirm sends them.
    if (source === 'card' && selectedType === 'affirm' && (billing.country || billing.postal_code)) {
      const address: Record<string, string> = {};
      if (billing.country) address.country = billing.country;
      if (billing.postal_code) address.postal_code = billing.postal_code;
      billingDetails.address = address;
    }
    if (guidance?.next_step === 'create_confirmation_token') {
      const params: Record<string, unknown> = { payment_method_data: { billing_details: billingDetails } };
      if (returnUrl) params.return_url = returnUrl;
      const shipping = options.getShipping();
      if (shipping) params.shipping = shipping;
      const result = await stripe!.createConfirmationToken({ elements, params } as never);
      if (result.error) return { error: result.error };
      return { credential: { kind: 'confirmation_token', value: result.confirmationToken.id } };
    }
    const result = await stripe!.createPaymentMethod({ elements, params: { billing_details: billingDetails } } as never);
    if (result.error) return { error: result.error };
    return { credential: { kind: 'payment_method_token', value: result.paymentMethod.id } };
  }

  return {
    /** Collects and tokenizes the typed payment details. */
    async createCredential(): Promise<MadeCredential> {
      const submit = await paymentElements.submit();
      if (submit?.error) return { error: submit.error };
      return makeToken(paymentElements, 'card');
    },
    setReturnUrl(value: string | undefined) {
      returnUrl = value;
    },
    isComplete: () => complete,
    selectedType: () => selectedType,
    async setSaving(value: boolean) {
      saving = value;
      const update: Record<string, unknown> = { setupFutureUsage: value ? 'on_session' : null };
      if (guidance.payment_method_options) update.paymentMethodOptions = optionsForSaving(guidance.payment_method_options, value);
      const finished = new Promise((resolve) => {
        (paymentElements as unknown as { on?: (name: string, handler: () => void) => void }).on?.('update-end', () => resolve(undefined));
        setTimeout(resolve, 3000);
      });
      try {
        paymentElements.update(update as never);
        await finished;
      } catch {
        // The next token request reports the real problem if the update failed.
      }
    },
    isSaving: () => saving,
    updateAmount(money: Money | null) {
      if (setupMode || !money || Number(money.amount) <= 0) return;
      amountMinor = minorNumber(money);
      paymentElements.update({ amount: amountMinor } as never);
      walletElements?.update({ amount: amountMinor } as never);
      messaging?.update({ amount: amountMinor });
    },
    clearPayment() {
      try {
        (paymentElement as unknown as { clear(): void }).clear();
      } catch {
        // clear() is not available on every Stripe.js build.
      }
      complete = false;
      options.onChange({ complete: false, type: selectedType });
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
