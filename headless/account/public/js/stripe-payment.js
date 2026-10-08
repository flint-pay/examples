// @ts-check
// Browser side of an embedded payment for an invoice or a return balance.
//
// The server owns the payment. This module collects a payment source with Stripe.js, hands the
// single-use credential to this app's own routes, and follows the attempt the server reports.
// It never calls Flint and never holds a Flint credential. Provider client secrets only arrive in
// the JSON response of the job that needs them and are used once.
//
// States (data-state on [data-testid="ac-payment"]): loading, unavailable, ready, submitting,
// authenticating, resuming, waiting, bank_processing, declined, pay_remaining, total_changed,
// affirm_incomplete, recovery, expired, succeeded.

import { newActionId, readBoot, requestJson, sleep } from './http.js';
import { announce } from './live.js';
import { formatMoney, stripeAmount } from './money.js';
import { acceptsNewPayment, derivePhase, payBlocker, shouldDropAffirm, workFor } from './payment-phase.js';
import { appearance, createStripe, whenStripeReady } from './stripe-loader.js';

/** @typedef {import('../../src/views/types.ts').PaymentState} PaymentState */
/** @typedef {import('./payment-phase.js').PaymentPhase} PaymentPhase */

const boot = readBoot('payment-boot');
const root = document.querySelector('[data-payment-root]');

if (root instanceof HTMLElement && boot) {
  void run(root, boot);
}

/**
 * @param {HTMLElement} root
 * @param {any} boot
 */
async function run(root, boot) {
  const copy = boot.copy;
  const ui = copy.ui;
  const endpoints = boot.endpoints;
  const surface = boot.surface;

  /** @param {string} selector */
  const find = (selector) => root.querySelector(selector);
  const banner = find('[data-payment-banner]');
  const messageBox = find('[data-payment-message]');
  const staticUnavailable = find('[data-payment-static]');
  const staticExpired = find('[data-payment-expired]');
  const progress = find('[data-payment-progress]');
  const progressText = find('[data-payment-progress-text]');
  const checkWrap = find('[data-payment-check]');
  const checkButton = find('[data-payment-check-button]');
  const remainingBox = find('[data-payment-remaining]');
  const savedBox = find('[data-saved-methods]');
  const savedList = find('[data-saved-list]');
  const walletsBox = find('[data-wallets]');
  const elementWrap = find('[data-element-wrap]');
  const elementMount = find('#payment-element');
  const affirmBox = find('[data-affirm-actions]');
  const affirmContinue = find('[data-affirm-continue]');
  const affirmOther = find('[data-pay-another-way]');
  const payActions = find('[data-pay-actions]');
  const payButton = find('[data-pay-button]');
  const blockerText = find('[data-pay-blocker]');

  /** @type {PaymentState} */
  let state = boot.state;
  /** @type {'idle' | 'submitting' | 'authenticating' | 'resuming' | 'waiting'} */
  let local = 'idle';
  let elementsComplete = false;
  let usingSaved = false;
  /** @type {string | null} */
  let selectedSaved = null;
  let dropAffirm = false;
  let stillConfirming = false;
  /** @type {any} */
  let StripeFactory = null;
  /** @type {any} */
  let stripe = null;
  /** @type {any} */
  let elements = null;
  /** @type {any} */
  let paymentElement = null;
  /** @type {any} */
  let expressElements = null;
  let mountedKey = '';
  /** @type {number | null} */
  let lastElementsAmount = null;
  const handledActions = new Set();

  const money = (/** @type {any} */ value) => formatMoney(value);
  const label = () => (surface === 'invoice' ? ui.payInvoice : ui.payReturn).replace('{amount}', money(state.approved_outstanding_money));

  /** @param {string | undefined} code @param {string | undefined} kind */
  const errorText = (code, kind) => {
    const keys = [code?.toLowerCase(), kind, 'generic_error'];
    for (const key of keys) {
      if (key && copy.errors[key]) return String(copy.errors[key]).replace('{amount}', money(state.approved_outstanding_money));
    }
    return copy.errors.generic_error;
  };

  /** @returns {PaymentPhase | 'loading' | 'submitting'} */
  const currentPhase = () => {
    if (local === 'submitting') return 'submitting';
    if (local === 'authenticating') return 'authenticating';
    if (local === 'resuming') return 'resuming';
    if (local === 'waiting') return derivePhase(state) === 'recovery' ? 'recovery' : 'waiting';
    return derivePhase(state);
  };

  // ---- Messages ----------------------------------------------------------

  /** @param {string} text @param {boolean} [focus] */
  const showMessage = (text, focus = true) => {
    if (!(messageBox instanceof HTMLElement)) return;
    messageBox.textContent = text;
    messageBox.hidden = false;
    if (focus) messageBox.focus();
  };
  const clearMessage = () => {
    if (messageBox instanceof HTMLElement) {
      messageBox.textContent = '';
      messageBox.hidden = true;
    }
  };
  /** @param {string} text */
  const showBanner = (text) => {
    if (!(banner instanceof HTMLElement)) return;
    banner.textContent = text;
    banner.hidden = !text;
    if (text) announce(text);
  };

  // ---- Amounts -----------------------------------------------------------

  const amountSelectors = ['[data-testid="ac-invoice-pay-amount"]', '[data-testid="ac-return-pay-amount"]'];
  function paintAmounts() {
    const amount = state.approved_outstanding_money;
    for (const selector of amountSelectors) {
      const node = document.querySelector(selector);
      if (node instanceof HTMLElement) {
        node.textContent = money(amount);
        node.dataset.amountMinor = amount.amount;
        node.dataset.currency = amount.currency;
      }
    }
    for (const node of document.querySelectorAll('.pay-summary summary .money')) {
      if (node instanceof HTMLElement) {
        node.textContent = money(amount);
        node.dataset.amountMinor = amount.amount;
        node.dataset.currency = amount.currency;
      }
    }
    if (payButton instanceof HTMLButtonElement) payButton.textContent = label();
    const value = stripeAmount(amount);
    if (value !== null && value !== lastElementsAmount && elements) {
      lastElementsAmount = value;
      elements.update({ amount: value });
      expressElements?.update({ amount: value });
    }
  }

  // ---- Rendering ---------------------------------------------------------

  function renderSaved() {
    if (!(savedBox instanceof HTMLElement) || !(savedList instanceof HTMLElement)) return;
    const methods = (state.saved_methods ?? []).filter((method) => method.status === 'active');
    savedBox.hidden = methods.length === 0 || !acceptsNewPayment(derivePhase(state));
    if (methods.length === 0) {
      usingSaved = false;
      selectedSaved = null;
      return;
    }
    const signature = methods.map((m) => m.payment_method_id).join(',');
    if (savedList.dataset.signature === signature) return;
    savedList.dataset.signature = signature;
    savedList.textContent = '';
    methods.forEach((method, index) => {
      const row = document.createElement('div');
      row.className = 'saved-option';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'payment_choice';
      input.id = `choice-${index}`;
      input.value = method.payment_method_id;
      input.dataset.testid = `ac-saved-method-${index + 1}`;
      input.setAttribute('data-testid', `ac-saved-method-${index + 1}`);
      const text = document.createElement('label');
      text.htmlFor = input.id;
      text.textContent = /** @type {any} */ (method).label ?? 'Saved card';
      row.append(input, text);
      savedList.append(row);
    });
  }

  function onChoiceChange() {
    const chosen = root.querySelector('input[name="payment_choice"]:checked');
    const value = chosen instanceof HTMLInputElement ? chosen.value : 'new';
    usingSaved = value !== 'new';
    selectedSaved = usingSaved ? value : null;
    if (elementWrap instanceof HTMLElement) elementWrap.hidden = usingSaved;
    render();
  }

  function blockerMessage() {
    const phase = currentPhase();
    const reason = payBlocker({
      phase: phase === 'loading' || phase === 'submitting' ? 'authenticating' : phase,
      elementsComplete,
      usingSaved,
      hasSaved: Boolean(selectedSaved),
      busy: local !== 'idle',
    });
    switch (reason) {
      case 'elements_incomplete':
        return ui.blockerElements;
      case 'attempt_open':
        return phase === 'loading' ? ui.loading : ui.blockerAttempt;
      case 'session_not_open':
        return ui.blockerSession;
      default:
        return '';
    }
  }

  function render() {
    const phase = currentPhase();
    root.dataset.state = phase;
    root.dataset.phase = derivePhase(state);
    if (phase === 'loading') root.setAttribute('aria-busy', 'true');
    else root.removeAttribute('aria-busy');

    const accepting = acceptsNewPayment(derivePhase(state)) && local === 'idle';
    const showForm = acceptsNewPayment(derivePhase(state)) && (local === 'idle' || local === 'submitting');
    const working = ['authenticating', 'resuming', 'waiting', 'recovery'].includes(phase) || local !== 'idle';

    if (staticUnavailable instanceof HTMLElement) staticUnavailable.hidden = phase !== 'unavailable';
    if (staticExpired instanceof HTMLElement) staticExpired.hidden = phase !== 'expired';
    if (elementWrap instanceof HTMLElement) elementWrap.hidden = !showForm || usingSaved;
    if (walletsBox instanceof HTMLElement && !showForm) walletsBox.hidden = true;
    if (payActions instanceof HTMLElement) payActions.hidden = !showForm;
    if (affirmBox instanceof HTMLElement) affirmBox.hidden = phase !== 'affirm_incomplete';
    if (savedBox instanceof HTMLElement && !showForm) savedBox.hidden = true;

    if (progress instanceof HTMLElement) {
      const text =
        phase === 'authenticating'
          ? ui.authenticating
          : phase === 'resuming' || phase === 'recovery'
            ? ui.resuming
            : phase === 'waiting'
              ? stillConfirming
                ? ui.stillConfirming
                : ui.waiting
              : phase === 'bank_processing'
                ? ui.bankProcessing
                : phase === 'succeeded'
                  ? ui.succeededOpening
                  : '';
      progress.hidden = !text;
      if (progressText instanceof HTMLElement) progressText.textContent = text;
      if (checkWrap instanceof HTMLElement) checkWrap.hidden = !(stillConfirming && phase === 'waiting');
    }

    if (remainingBox instanceof HTMLElement) {
      const legs = state.attempt?.legs ?? [];
      if (phase === 'pay_remaining') {
        const paid = legs.filter((leg) => leg.status === 'succeeded');
        const failed = legs.filter((leg) => leg.status === 'failed');
        const sum = (/** @type {any[]} */ items) =>
          items.length ? { amount: String(items.reduce((total, leg) => total + BigInt(leg.amount_money.amount), 0n)), currency: items[0].amount_money.currency } : null;
        const lines = [];
        const paidSum = sum(paid);
        const failedSum = sum(failed);
        if (paidSum) lines.push(ui.payRemainingSucceeded.replace('{amount}', money(paidSum)));
        if (failedSum) lines.push(ui.payRemainingFailed.replace('{amount}', money(failedSum)));
        lines.push(ui.payRemainingNext.replace('{amount}', money(state.approved_outstanding_money)));
        remainingBox.textContent = '';
        const title = document.createElement('p');
        title.className = 'alert-title';
        title.textContent = ui.payRemainingTitle;
        remainingBox.append(title);
        for (const line of lines) {
          const p = document.createElement('p');
          p.textContent = line;
          remainingBox.append(p);
        }
        remainingBox.hidden = false;
      } else {
        remainingBox.hidden = true;
      }
    }

    if (payButton instanceof HTMLButtonElement) {
      payButton.textContent = label();
      const blocked = Boolean(blockerMessage()) || !accepting;
      payButton.disabled = blocked;
      if (local === 'submitting') payButton.setAttribute('aria-busy', 'true');
      else payButton.removeAttribute('aria-busy');
    }
    if (blockerText instanceof HTMLElement) blockerText.textContent = working && !showForm ? '' : blockerMessage();
    paintAmounts();
    renderSaved();
  }

  // ---- Elements ----------------------------------------------------------

  /** @param {any} guidance */
  function elementsKey(guidance) {
    return JSON.stringify([guidance.publishable_key, guidance.account_id, guidance.elements.payment_method_types, dropAffirm, guidance.elements.payment_method_options]);
  }

  /** @returns {{ name?: string, email?: string }} */
  function billing() {
    const out = {};
    if (boot.buyer?.name) /** @type {any} */ (out).name = boot.buyer.name;
    if (boot.buyer?.email) /** @type {any} */ (out).email = boot.buyer.email;
    return out;
  }

  async function mountElements() {
    const guidance = state.payment_collection?.stripe;
    if (!guidance || !guidance.elements || !guidance.publishable_key) return false;
    const key = elementsKey(guidance);
    if (mountedKey === key && paymentElement) return true;
    const amount = stripeAmount(state.approved_outstanding_money);
    if (amount === null) return false;
    try {
      StripeFactory = StripeFactory ?? (await whenStripeReady());
    } catch {
      return false;
    }
    teardownElements();
    stripe = createStripe(StripeFactory, guidance.publishable_key, guidance.account_id);
    const types = guidance.elements.payment_method_types.filter(
      (/** @type {string} */ type) => !['apple_pay', 'google_pay'].includes(type) && !(dropAffirm && type === 'affirm'),
    );
    const options = {
      mode: 'payment',
      amount,
      currency: state.approved_outstanding_money.currency.toLowerCase(),
      paymentMethodCreation: 'manual',
      paymentMethodTypes: types,
      appearance,
      ...(guidance.elements.payment_method_options ? { paymentMethodOptions: guidance.elements.payment_method_options } : {}),
    };
    elements = stripe.elements(options);
    lastElementsAmount = amount;
    const who = billing();
    paymentElement = elements.create('payment', {
      wallets: { applePay: 'never', googlePay: 'never' },
      fields: { billingDetails: { name: who.name ? 'never' : 'auto', email: who.email ? 'never' : 'auto' } },
    });
    elementsComplete = false;
    const ready = new Promise((resolve) => {
      paymentElement.on('ready', () => resolve(true));
      window.setTimeout(() => resolve(false), 15000);
    });
    paymentElement.on('change', (/** @type {any} */ event) => {
      elementsComplete = Boolean(event.complete);
      render();
    });
    paymentElement.mount('#payment-element');
    mountedKey = key;
    const isReady = await ready;
    if (elementMount instanceof HTMLElement) elementMount.classList.remove('skeleton');
    mountWallets(guidance, amount);
    return Boolean(isReady);
  }

  /** @param {any} guidance @param {number} amount */
  function mountWallets(guidance, amount) {
    const wallets = guidance.elements.digital_wallets ?? [];
    if (!wallets.length || !stripe || !(walletsBox instanceof HTMLElement)) return;
    try {
      expressElements = stripe.elements({
        mode: 'payment',
        amount,
        currency: state.approved_outstanding_money.currency.toLowerCase(),
        paymentMethodCreation: 'manual',
        appearance,
      });
      const express = expressElements.create('expressCheckout', {
        paymentMethods: { applePay: wallets.includes('apple_pay') ? 'auto' : 'never', googlePay: wallets.includes('google_pay') ? 'auto' : 'never', link: 'never', amazonPay: 'never', paypal: 'never' },
      });
      express.on('ready', (/** @type {any} */ event) => {
        const available = event?.availablePaymentMethods;
        const any = available && Object.values(available).some(Boolean);
        walletsBox.hidden = !any || !acceptsNewPayment(derivePhase(state));
      });
      express.on('click', (/** @type {any} */ event) => event.resolve());
      express.on('confirm', () => {
        void pay('wallet');
      });
      express.mount('#express-checkout-element');
    } catch {
      walletsBox.hidden = true; // A wallet that cannot start leaves the card form usable.
    }
  }

  function teardownElements() {
    try {
      paymentElement?.destroy();
    } catch {
      /* already gone */
    }
    paymentElement = null;
    elements = null;
    expressElements = null;
    mountedKey = '';
  }

  // ---- Server calls ------------------------------------------------------

  /** @param {any} result */
  function readJob(result) {
    const body = result.body ?? {};
    if (body.state) state = { ...body.state, next: body.next ?? body.state.next };
    return body;
  }

  /**
   * POST with the same body and action ID for lost responses. Never changes intent.
   * @param {string} url @param {unknown} body @param {string | undefined} actionId
   */
  async function post(url, body, actionId) {
    /** @type {Record<string, string>} */
    const headers = actionId ? { 'X-Action-ID': actionId } : {};
    const waits = [500, 1000, 2000];
    for (let attempt = 0; ; attempt += 1) {
      let result = null;
      try {
        result = await requestJson(url, { method: 'POST', body, headers });
      } catch {
        result = null;
      }
      const unknown = !result || result.status >= 500 || result.body?.error?.kind === 'unknown_outcome';
      if (!unknown || attempt >= waits.length) return result;
      await sleep(waits[attempt] ?? 2000);
    }
  }

  async function readAttempt() {
    try {
      const result = await requestJson(endpoints.attempt);
      return result.ok || result.body?.state ? readJob(result) : null;
    } catch {
      return null;
    }
  }

  // ---- The driver --------------------------------------------------------

  /** @param {any} job */
  function finish(job) {
    void job;
    local = 'idle';
    render();
  }

  function complete() {
    local = 'idle';
    stillConfirming = false;
    render();
    window.location.assign(endpoints.complete);
  }

  /**
   * Follows the attempt from whatever the server reported until a stable, buyer-facing state.
   * @param {any} job
   */
  async function drive(job) {
    for (let guard = 0; guard < 12; guard += 1) {
      const next = state.next;
      if (next === 'done' || next === 'bank_processing') {
        complete();
        return;
      }
      const work = workFor(state);
      if (work === 'authenticate') {
        let clientAction = job?.client_action;
        if (!clientAction) {
          // After a reload the secret is not in the page. Ask the server for the pending action.
          local = 'authenticating';
          render();
          const fresh = await readAttempt();
          clientAction = fresh?.client_action;
          job = fresh;
          if (state.next !== 'authenticate') continue;
        }
        if (derivePhase(state) === 'affirm_incomplete' && !clientAction) {
          local = 'idle';
          render();
          return;
        }
        if (derivePhase(state) === 'affirm_incomplete') {
          // The buyer chooses: continue with Affirm or pay another way.
          local = 'idle';
          pendingAffirmAction = clientAction;
          presentIdle();
          return;
        }
        await runAction(clientAction);
        local = 'resuming';
        render();
        const resumed = await post(endpoints.resume, {}, newActionId());
        job = resumed ? readJob(resumed) : await readAttempt();
        if (resumed?.body?.error && !resumed.body.state) {
          showMessage(errorText(resumed.body.error.code, resumed.body.error.kind));
          local = 'waiting';
          await waitLoop();
          return;
        }
        continue;
      }
      if (work === 'resume') {
        local = 'resuming';
        render();
        const resumed = await post(endpoints.resume, {}, newActionId());
        job = resumed ? readJob(resumed) : await readAttempt();
        continue;
      }
      if (work === 'wait') {
        local = 'waiting';
        render();
        await waitLoop();
        return;
      }
      break;
    }
    local = 'idle';
    stillConfirming = false;
    // The attempt ended in a state that takes a new payment, but the form was never mounted
    // because the page opened in the middle of the attempt.
    if (acceptsNewPayment(derivePhase(state)) && !paymentElement) {
      const mounted = await mountElements();
      if (!mounted) state = { ...state, payment_collection: null };
    }
    presentIdle();
  }

  /** @type {any} */
  let pendingAffirmAction = null;

  /** @param {any} clientAction */
  async function runAction(clientAction) {
    const pendingId = state.pending_action_id;
    if (pendingId && handledActions.has(pendingId)) return;
    if (pendingId) handledActions.add(pendingId);
    local = 'authenticating';
    render();
    try {
      StripeFactory = StripeFactory ?? (await whenStripeReady());
      const authority = clientAction?.payment_intent;
      if (!authority?.client_secret) return;
      const sameAccount =
        stripe && state.payment_collection?.stripe?.publishable_key === clientAction.publishable_key && state.payment_collection?.stripe?.account_id === clientAction.account_id;
      const actionStripe = sameAccount ? stripe : createStripe(StripeFactory, clientAction.publishable_key, clientAction.account_id);
      // Resume follows whether or not Stripe reports an error. The server decides the outcome.
      await actionStripe.handleNextAction({ clientSecret: authority.client_secret });
    } catch {
      /* the resume that follows reads the true outcome */
    }
  }

  async function waitLoop() {
    const stillAfter = Number(root.dataset.stillAfterMs) || 60000;
    const started = Date.now();
    let delay = 500;
    stillConfirming = false;
    render();
    while (true) {
      const job = await readAttempt();
      if (job) {
        if (state.next !== 'wait') {
          local = 'idle';
          stillConfirming = false;
          await drive(job);
          return;
        }
      }
      if (Date.now() - started > stillAfter && !stillConfirming) {
        stillConfirming = true;
        render();
        showBanner(ui.stillConfirming);
        return; // The buyer chooses "Check again". No new payment is offered.
      }
      await sleep(delay);
      delay = Math.min(5000, Math.round(delay * 1.5));
    }
  }

  function presentIdle() {
    const phase = derivePhase(state);
    clearMessage();
    showBanner('');
    for (const key of state.notices ?? []) {
      if (key === 'total_changed') showBanner(ui.totalChangedBanner.replace('{amount}', money(state.approved_outstanding_money)));
      else if (key === 'still_confirming') showBanner(ui.stillConfirming);
    }
    if (phase === 'declined') {
      showMessage(copy.declines[state.decline?.code ?? ''] ?? copy.declines.default);
      if (shouldDropAffirm(state.decline)) dropAffirm = true;
      try {
        paymentElement?.clear();
      } catch {
        /* nothing to clear */
      }
      if (dropAffirm) {
        mountedKey = '';
        void mountElements().then(render);
      }
    } else if (phase === 'total_changed') {
      showBanner(ui.totalChangedBanner.replace('{amount}', money(state.approved_outstanding_money)));
    } else if (phase === 'expired') {
      showBanner(ui.expired);
    } else if (phase === 'affirm_incomplete') {
      showBanner(ui.affirmIncomplete);
    }
    render();
  }

  // ---- Paying ------------------------------------------------------------

  /** @param {'card' | 'wallet'} source */
  async function pay(source) {
    if (local !== 'idle') return;
    if (source === 'card' && blockerMessage()) return;
    local = 'submitting';
    clearMessage();
    showBanner('');
    render();
    const actionId = newActionId();
    try {
      /** @type {{ kind: string, value: string } | undefined} */
      let credential;
      if (source === 'card' && usingSaved && selectedSaved) {
        credential = { kind: 'saved_payment_method', value: selectedSaved };
      } else {
        const target = source === 'wallet' ? expressElements : elements;
        const submitted = await target.submit();
        if (submitted?.error) {
          local = 'idle';
          showMessage(submitted.error.message ?? ui.blockerElements);
          render();
          return;
        }
        const guidance = state.payment_collection?.stripe;
        const who = billing();
        /** @type {any} */
        const params = { payment_method_data: { billing_details: who } };
        if (guidance?.return_url) params.return_url = guidance.return_url;
        if (state.shipping && state.shipping.address) {
          params.shipping = { name: state.shipping.name ?? who.name ?? '', address: state.shipping.address };
        }
        if (guidance?.elements?.next_step === 'collect_payment_source') {
          const created = await stripe.createPaymentMethod({ elements: target, params: { billing_details: who } });
          if (created.error || !created.paymentMethod) throw new Error(created.error?.message ?? 'payment_method');
          credential = { kind: 'payment_method_token', value: created.paymentMethod.id };
        } else {
          const created = await stripe.createConfirmationToken({ elements: target, params });
          if (created.error || !created.confirmationToken) {
            local = 'idle';
            showMessage(created.error?.message ?? ui.blockerElements);
            render();
            return;
          }
          credential = { kind: 'confirmation_token', value: created.confirmationToken.id };
        }
      }
      const approved = state.approved_outstanding_money;
      const result = await post(endpoints.submit, { credential, approved_outstanding_money: approved }, actionId);
      await afterSubmit(result);
    } catch (error) {
      local = 'idle';
      showMessage(error instanceof Error && error.message && error.message !== 'payment_method' ? error.message : copy.errors.generic_error);
      render();
    }
  }

  /** @param {any} result */
  async function afterSubmit(result) {
    if (!result) {
      // The response never arrived. Reconcile with the server before anything else.
      local = 'waiting';
      showBanner(ui.waiting);
      const job = await readAttempt();
      if (job) await drive(job);
      else await waitLoop();
      return;
    }
    const job = readJob(result);
    const error = job.error;
    if (error) {
      if (error.kind === 'unknown_outcome') {
        local = 'waiting';
        render();
        await waitLoop();
        return;
      }
      if (state.total_changed || error.code === 'ORDER_CHANGED_REFRESH_REQUIRED') {
        local = 'idle';
        presentIdle();
        return;
      }
      if (state.next === 'new_payment' || state.next === 'pay_remaining') {
        local = 'idle';
        showMessage(errorText(error.code, error.kind));
        render();
        return;
      }
    }
    await drive(job);
    if (error && local === 'idle') showMessage(errorText(error.code, error.kind));
    finish(job);
  }

  // ---- Wiring ------------------------------------------------------------

  if (payButton instanceof HTMLButtonElement) {
    payButton.addEventListener('click', () => void pay('card'));
  }
  root.addEventListener('change', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.name === 'payment_choice') onChoiceChange();
  });
  if (checkButton instanceof HTMLButtonElement) {
    checkButton.addEventListener('click', () => {
      stillConfirming = false;
      showBanner('');
      local = 'waiting';
      void waitLoop();
    });
  }
  if (affirmContinue instanceof HTMLButtonElement) {
    affirmContinue.addEventListener('click', async () => {
      const action = pendingAffirmAction;
      pendingAffirmAction = null;
      local = 'authenticating';
      render();
      handledActions.clear();
      await runAction(action ?? (await readAttempt())?.client_action);
      local = 'resuming';
      render();
      const resumed = await post(endpoints.resume, {}, newActionId());
      await drive(resumed ? readJob(resumed) : await readAttempt());
    });
  }
  if (affirmOther instanceof HTMLButtonElement) {
    affirmOther.addEventListener('click', async () => {
      local = 'resuming';
      render();
      const result = await post(endpoints.cancel_attempt, {}, undefined);
      if (result) readJob(result);
      local = 'idle';
      pendingAffirmAction = null;
      presentIdle();
    });
  }

  // ---- Start -------------------------------------------------------------

  render();
  const first = derivePhase(state);
  if (first === 'unavailable' || first === 'expired') {
    render();
    return;
  }
  if (acceptsNewPayment(first)) {
    const ok = await mountElements();
    if (!ok) {
      state = { ...state, payment_collection: null };
      root.dataset.state = 'unavailable';
      if (staticUnavailable instanceof HTMLElement) staticUnavailable.hidden = false;
      showMessage(copy.errors.stripe_unavailable, false);
      render();
      return;
    }
    presentIdle();
    return;
  }
  // The page loaded in the middle of an attempt (reload, provider return, recovery).
  const fresh = await readAttempt();
  await drive(fresh ?? { client_action: undefined });
}
