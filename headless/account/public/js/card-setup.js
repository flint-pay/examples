// @ts-check
// Add a card: POST the setup, mount the Payment Element with the SetupIntent, confirm it in the
// browser with Stripe.js, then wait for the card to be active on the server before using it.
// A card is never treated as usable until the server reports status "active".
import { readBoot, requestJson, sleep } from './http.js';
import { announce } from './live.js';
import { appearance, createStripe, whenStripeReady } from './stripe-loader.js';

const found = document.querySelector('[data-card-setup], [data-card-return]');
const bootData = readBoot('card-setup-boot');
if (found instanceof HTMLElement && bootData) init(found, bootData);

/**
 * @param {HTMLElement} root
 * @param {any} boot
 */
function init(root, boot) {
  const ui = boot.copy.ui;
  const errors = boot.copy.errors;
  const message = root.querySelector('[data-setup-message]');
  const confirming = root.querySelector('[data-setup-confirming]');
  const confirmingText = root.querySelector('[data-setup-confirming-text]');
  const checkWrap = root.querySelector('[data-setup-check]');
  const checkButton = root.querySelector('[data-setup-check-button]');
  const submit = root.querySelector('[data-setup-submit]');
  const blocker = root.querySelector('[data-setup-blocker]');
  const wrap = root.querySelector('[data-setup-wrap]');
  const actions = root.querySelector('[data-setup-actions]');

  /** @param {string} state */
  const setState = (state) => {
    root.dataset.state = state;
    if (state === 'loading' || state === 'confirming') root.setAttribute('aria-busy', 'true');
    else root.removeAttribute('aria-busy');
  };

  /** @param {string} text */
  const showError = (text) => {
    if (message instanceof HTMLElement) {
      message.textContent = text;
      message.hidden = false;
      message.focus();
    }
    announce(text);
  };
  /** An error with nothing to retry on this page: hide the form and say why. */
  const fatal = (/** @type {string} */ text) => {
    if (wrap instanceof HTMLElement) wrap.hidden = true;
    if (actions instanceof HTMLElement) actions.hidden = true;
    setState('setup_failed');
    showError(text);
  };
  const clearError = () => {
    if (message instanceof HTMLElement) {
      message.textContent = '';
      message.hidden = true;
    }
  };

  /** @param {string} id */
  const statusUrl = (id) => boot.endpoints.status.replace('{id}', encodeURIComponent(id));

  /**
   * Polls the card's status every second for up to 30 seconds.
   * @param {string} id
   * @returns {Promise<'active' | 'failed' | 'timeout'>}
   */
  async function waitForActive(id) {
    const started = Date.now();
    const limit = Number(root.dataset.confirmTimeoutMs) || 30000;
    while (Date.now() - started < limit) {
      let result;
      try {
        result = await requestJson(statusUrl(id));
      } catch {
        result = null;
      }
      const status = result?.body?.payment_method?.status;
      if (status === 'active') return 'active';
      if (status === 'failed' || status === 'removed' || status === 'expired') return 'failed';
      await sleep(1000);
    }
    return 'timeout';
  }

  /** @param {string} id */
  async function confirmFlow(id) {
    setState('confirming');
    clearError();
    if (confirming instanceof HTMLElement) confirming.hidden = false;
    if (checkWrap instanceof HTMLElement) checkWrap.hidden = true;
    if (confirmingText instanceof HTMLElement) confirmingText.textContent = ui.confirmingMessage;
    if (wrap instanceof HTMLElement) wrap.hidden = true;
    if (actions instanceof HTMLElement) actions.hidden = true;
    announce(ui.confirmingMessage);
    const outcome = await waitForActive(id);
    if (outcome === 'active') {
      window.location.assign(boot.endpoints.complete);
      return;
    }
    if (outcome === 'failed') {
      if (confirming instanceof HTMLElement) confirming.hidden = true;
      setState('setup_failed');
      showError(`${ui.setupFailed} ${ui.failedCard}`);
      const restart = root.querySelector('[data-setup-restart]');
      if (restart instanceof HTMLElement) restart.hidden = false;
      return;
    }
    if (confirmingText instanceof HTMLElement) confirmingText.textContent = ui.stillConfirming;
    if (checkWrap instanceof HTMLElement) checkWrap.hidden = false;
    announce(ui.stillConfirming);
  }

  if (checkButton instanceof HTMLButtonElement) {
    checkButton.addEventListener('click', () => {
      const id = root.dataset.paymentMethodId ?? boot.payment_method_id;
      if (id) void confirmFlow(id);
    });
  }

  /** The redirect return page: strip Stripe's query parameters, then wait for the card. */
  async function runReturn() {
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
    const id = boot.payment_method_id;
    if (!id) return;
    root.dataset.paymentMethodId = id;
    await confirmFlow(id);
  }

  async function runAdd() {
    setState('loading');
    /** @type {any} */
    let setup;
    try {
      const [, response] = await Promise.all([
        whenStripeReady(),
        requestJson(boot.endpoints.setup, { method: 'POST', body: { return_to: boot.return_to } }),
      ]);
      if (!response.ok) {
        const key = response.body?.error?.message_key ?? (response.body?.error?.code ?? '').toLowerCase();
        fatal(errors[key] ?? errors.payment_method_setup_failed ?? errors.generic_error);
        return;
      }
      setup = response.body;
    } catch (error) {
      fatal(error instanceof Error && error.message.startsWith('stripe') ? errors.stripe_unavailable : errors.generic_error);
      return;
    }

    const stripeGuidance = setup.client_setup?.stripe;
    const paymentMethodId = setup.payment_method?.payment_method_id;
    const clientSecret = stripeGuidance?.setup_intent?.client_secret;
    if (!stripeGuidance || !paymentMethodId || !clientSecret) {
      fatal(errors.payment_method_setup_failed);
      return;
    }
    root.dataset.paymentMethodId = paymentMethodId;
    const stripe = createStripe((/** @type {any} */ (window)).Stripe, stripeGuidance.publishable_key, stripeGuidance.account_id);
    const elements = stripe.elements({ clientSecret, appearance });
    const element = elements.create('payment', { wallets: { applePay: 'never', googlePay: 'never' } });
    let complete = false;
    const refresh = () => {
      if (!(submit instanceof HTMLButtonElement) || !(blocker instanceof HTMLElement)) return;
      const busy = submit.getAttribute('aria-busy') === 'true';
      submit.disabled = !complete || busy;
      blocker.textContent = busy ? '' : complete ? '' : 'Finish entering your card details to continue.';
    };
    element.on('ready', () => {
      setState('adding');
      const mount = root.querySelector('#setup-element');
      if (mount instanceof HTMLElement) mount.classList.remove('skeleton');
      refresh();
    });
    element.on('change', (/** @type {any} */ event) => {
      complete = Boolean(event.complete);
      // Editing the details after an error is a new try.
      if (root.dataset.state === 'setup_failed') setState('adding');
      refresh();
    });
    element.mount('#setup-element');

    if (submit instanceof HTMLButtonElement) {
      submit.addEventListener('click', async () => {
        if (submit.getAttribute('aria-busy') === 'true' || !complete) return;
        submit.setAttribute('aria-busy', 'true');
        clearError();
        refresh();
        const returnUrl = new URL(boot.endpoints.complete, window.location.origin).toString();
        const result = await stripe.confirmSetup({ elements, confirmParams: { return_url: returnUrl }, redirect: 'if_required' });
        if (result.error) {
          submit.removeAttribute('aria-busy');
          // The buyer can fix the details and try again with the same SetupIntent.
          setState('setup_failed');
          showError(result.error.message ?? ui.setupFailed);
          refresh();
          return;
        }
        // Tell the server which card the browser confirmed. It must match the pending card.
        try {
          await requestJson('/payment-methods/new/confirm', { method: 'POST', body: { payment_method_id: paymentMethodId } });
        } catch {
          // The status poll below reads the same card, so a lost reply here is not fatal.
        }
        submit.removeAttribute('aria-busy');
        await confirmFlow(paymentMethodId);
      });
    }
  }

  if (root.hasAttribute('data-card-return')) void runReturn();
  else void runAdd();
}
