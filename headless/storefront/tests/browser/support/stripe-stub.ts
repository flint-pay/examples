// LOCAL STATE TEST DOUBLE for https://js.stripe.com/v3/. It replaces the
// provider script inside the browser for the local-state project only, so the
// checkout page can run without network access. It is not Stripe: real card
// entry, 3D Secure, wallets, and Affirm are only checked in staging acceptance.
//
// The "card" is a plain input. Its text picks the behavior the stand-in
// backend reacts to: ok, decline, cvc, 3ds, 3dsfail, unknown, slow, bank,
// changed, affirmdeclined.

import type { Page } from '@playwright/test';

const SCRIPT = `
(() => {
  const record = { calls: [], nextAction: 'ok', elementOptions: [], tokens: [] };
  window.__stripe = record;
  const behavior = () => (document.querySelector('[data-testid="fake-card"]') || {}).value || 'ok';
  function makeElement(type, options, elements) {
    const handlers = {};
    const element = {
      type,
      on(name, cb) { (handlers[name] = handlers[name] || []).push(cb); return element; },
      emit(name, event) { (handlers[name] || []).forEach((cb) => cb(event)); },
      mount(node) {
        element.node = node;
        if (type === 'payment') {
          const input = document.createElement('input');
          input.setAttribute('data-testid', 'fake-card');
          input.setAttribute('aria-label', 'Card number');
          input.setAttribute('autocomplete', 'off');
          input.addEventListener('input', () => element.emit('change', { complete: input.value.length > 0, value: { type: input.value === 'bank' ? 'us_bank_account' : input.value === 'affirm' ? 'affirm' : 'card' } }));
          node.appendChild(input);
          setTimeout(() => element.emit('ready', {}), 20);
        } else if (type === 'expressCheckout') {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = 'Wallet';
          button.setAttribute('data-testid', 'fake-wallet-button');
          button.addEventListener('click', () => {
            let resolved = false;
            element.emit('click', { resolve() { resolved = true; } });
            if (!resolved) return;
            element.emit('confirm', { paymentFailed(arg) { record.calls.push({ name: 'paymentFailed', arg }); } });
          });
          node.appendChild(button);
          setTimeout(() => element.emit('ready', { availablePaymentMethods: window.__walletsAvailable === false ? undefined : { applePay: true, googlePay: false } }), 20);
        } else if (type === 'paymentMethodMessaging') {
          const p = document.createElement('p');
          p.setAttribute('data-testid', 'fake-affirm-messaging');
          p.textContent = 'Pay over time with Affirm';
          node.appendChild(p);
        }
      },
      update(o) { record.calls.push({ name: 'element.update', options: o }); },
      clear() { const input = element.node && element.node.querySelector('input'); if (input) { input.value = ''; element.emit('change', { complete: false, value: { type: 'card' } }); } },
      destroy() { if (element.node) element.node.replaceChildren(); },
    };
    return element;
  }
  window.Stripe = function (key, options) {
    record.calls.push({ name: 'Stripe', key, options });
    return {
      elements(options) {
        record.elementOptions.push(options || {});
        const updates = [];
        const listeners = {};
        const elements = {
          options: Object.assign({}, options),
          create(type, o) { record.calls.push({ name: 'create', type, options: o }); return makeElement(type, o, elements); },
          async submit() { record.calls.push({ name: 'submit' }); return {}; },
          async update(o) { record.calls.push({ name: 'elements.update', options: o }); Object.assign(elements.options, o); setTimeout(() => (listeners['update-end'] || []).forEach((cb) => cb()), 5); },
          on(name, cb) { (listeners[name] = listeners[name] || []).push(cb); },
        };
        return elements;
      },
      // The Elements a token is bound to: Stripe rejects a confirmation whose payment method types differ from them.
      async createConfirmationToken(args) { record.calls.push({ name: 'createConfirmationToken', params: args.params, elements: args.elements.options }); sessionStorage.setItem('__tokenElements', JSON.stringify([...JSON.parse(sessionStorage.getItem('__tokenElements') || '[]'), args.elements.options])); const id = 'ctoken_fake_' + behavior(); record.tokens.push(id); return { confirmationToken: { id } }; },
      async createPaymentMethod(args) { record.calls.push({ name: 'createPaymentMethod', params: args.params }); const id = 'pm_fake_' + behavior(); record.tokens.push(id); return { paymentMethod: { id } }; },
      async handleNextAction(args) { record.calls.push({ name: 'handleNextAction', hasSecret: Boolean(args && args.clientSecret) }); return record.nextAction === 'error' ? { error: { message: 'Authentication failed' } } : {}; },
    };
  };
})();
`;

export async function installStripeStub(page: Page, options: { wallets?: boolean; delayMs?: number } = {}): Promise<void> {
  await page.route('https://js.stripe.com/**', async (route) => {
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: SCRIPT });
  });
  if (options.wallets === false) await page.addInitScript(() => ((window as any).__walletsAvailable = false));
}

/** The Elements options behind each confirmation token, kept across the navigation that follows a payment. */
export async function tokenElements(page: Page): Promise<any[]> {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem('__tokenElements') ?? '[]'));
}

export async function stripeCalls(page: Page): Promise<any[]> {
  return page.evaluate(() => (window as any).__stripe?.calls ?? []);
}
