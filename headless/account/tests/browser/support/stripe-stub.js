// LOCAL TEST DOUBLE for Stripe.js, used only by the local state tests.
// It mimics the small surface this app calls so the page logic can be exercised offline.
// The real Stripe.js and Stripe test mode are only exercised in staging acceptance.
(() => {
  const stub = {
    calls: { stripe: [], elements: [], elementsUpdate: [], create: [], submit: 0, tokens: [], paymentMethods: [], nextActions: [], confirmSetup: [], cleared: 0, mounted: [] },
    config: { wallets: false, tokenError: null, submitError: null, nextActionResult: {}, confirmSetupResult: null },
  };
  window.__stripeStub = stub;

  function makeElement(type, options, owner) {
    const handlers = {};
    const element = {
      type,
      options,
      on(event, fn) {
        (handlers[event] = handlers[event] || []).push(fn);
      },
      emit(event, payload) {
        for (const fn of handlers[event] || []) fn(payload);
      },
      mount(selector) {
        const container = document.querySelector(selector);
        stub.calls.mounted.push({ selector, type });
        if (!container) return;
        if (type === 'payment') {
          container.innerHTML = '<label>Card number (local stub)<input data-testid="stub-card" autocomplete="off"></label>';
          const input = container.querySelector('input');
          input.addEventListener('input', () => element.emit('change', { complete: input.value.length >= 4 }));
          element.input = input;
          setTimeout(() => element.emit('ready', {}), 20);
        } else if (type === 'expressCheckout') {
          if (stub.config.wallets) {
            container.innerHTML = '<button type="button" data-testid="stub-wallet">Wallet (local stub)</button>';
            container.querySelector('button').addEventListener('click', () => element.emit('confirm', {}));
            setTimeout(() => element.emit('ready', { availablePaymentMethods: { applePay: true } }), 20);
          } else {
            setTimeout(() => element.emit('ready', {}), 20);
          }
        }
      },
      clear() {
        stub.calls.cleared += 1;
        if (element.input) {
          element.input.value = '';
          element.emit('change', { complete: false });
        }
      },
      destroy() {},
    };
    owner.elements.push(element);
    return element;
  }

  window.Stripe = function Stripe(key, opts) {
    stub.calls.stripe.push({ key, opts });
    return {
      elements(options) {
        stub.calls.elements.push(options);
        const owner = { elements: [] };
        return {
          create(type, opts2) {
            stub.calls.create.push({ type, opts: opts2 });
            return makeElement(type, opts2, owner);
          },
          update(update) {
            stub.calls.elementsUpdate.push(update);
          },
          async submit() {
            stub.calls.submit += 1;
            return stub.config.submitError ? { error: { message: stub.config.submitError } } : {};
          },
        };
      },
      async createConfirmationToken(args) {
        stub.calls.tokens.push(args.params);
        if (stub.config.tokenError) return { error: { message: stub.config.tokenError } };
        return { confirmationToken: { id: `ctoken_stub_${stub.calls.tokens.length}` } };
      },
      async createPaymentMethod(args) {
        stub.calls.paymentMethods.push(args.params);
        return { paymentMethod: { id: `pm_stub_${stub.calls.paymentMethods.length}` } };
      },
      async handleNextAction(args) {
        stub.calls.nextActions.push(args.clientSecret);
        return stub.config.nextActionResult || {};
      },
      async confirmSetup(args) {
        stub.calls.confirmSetup.push({ returnUrl: args.confirmParams && args.confirmParams.return_url, redirect: args.redirect });
        return stub.config.confirmSetupResult || { setupIntent: { status: 'succeeded' } };
      },
    };
  };
})();
