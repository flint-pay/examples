// @ts-check
// Page-wide enhancements: add to cart without a reload, focus on form errors,
// timed re-enable of "Send a new code", busy state on submit, summary panel.

import { $, $$, announce, csrfToken, focusElement, setBusy } from './dom.js';

function enhanceAddToCart() {
  const form = $('form[data-add-to-cart]');
  if (!(form instanceof HTMLFormElement)) return;
  const status = $('[data-add-status]', form);
  form.addEventListener('submit', async (event) => {
    if (!form.reportValidity()) return;
    event.preventDefault();
    const button = $('button[type="submit"]', form);
    setBusy(button, true);
    if (button instanceof HTMLButtonElement) button.disabled = true;
    const data = new FormData(form);
    const body = {
      product_slug: String(data.get('product_slug') ?? ''),
      variant_id: String(data.get('variant_id') ?? ''),
      quantity: Number(data.get('quantity') ?? 1),
    };
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
        body: JSON.stringify(body),
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const type = response.headers.get('content-type') ?? '';
      /** @type {number | null} */
      let count = null;
      let problem = '';
      if (type.includes('json')) {
        const result = /** @type {{ cart?: { lines?: { quantity: number }[] }, cart_count?: number, error?: unknown }} */ (await response.json().catch(() => ({})));
        if (Array.isArray(result.cart?.lines)) count = result.cart.lines.reduce((sum, line) => sum + line.quantity, 0);
        else if (typeof result.cart_count === 'number') count = result.cart_count;
        if (result.error) problem = 'error';
      } else {
        // The server answered with the redirected page. Read the real cart count and any error notice from it.
        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        const badge = doc.querySelector('[data-testid="sf-cart-count"]');
        if (badge) count = Number(badge.getAttribute('data-count'));
        problem = doc.querySelector('.notice-error')?.textContent?.trim() ?? '';
      }
      if (problem || count === null || Number.isNaN(count)) throw new Error('not added');
      const link = $('.nav-cart');
      const badge = $('[data-testid="sf-cart-count"]');
      if (badge) {
        badge.textContent = String(count);
        badge.setAttribute('data-count', String(count));
      }
      link?.setAttribute('aria-label', count === 1 ? (link.getAttribute('data-label-one') ?? '') : (link.getAttribute('data-label-many') ?? '').replace('{count}', String(count)));
      if (status) {
        status.textContent = form.getAttribute('data-added') ?? '';
        status.setAttribute('data-state', 'added');
      }
    } catch {
      // Fall back to the plain form post, which redirects back with a notice.
      form.submit();
      return;
    } finally {
      setBusy(button, false);
      if (button instanceof HTMLButtonElement) button.disabled = false;
    }
  });
}

function focusFirstError() {
  const summary = $('#error-summary') ?? $('#page-error');
  if (summary instanceof HTMLElement) {
    focusElement(summary);
    return;
  }
  const invalid = $('[aria-invalid="true"]');
  if (invalid instanceof HTMLElement) invalid.focus();
}

function enhanceValidation() {
  for (const form of $$('form[data-validate]')) {
    if (!(form instanceof HTMLFormElement)) continue;
    form.addEventListener('submit', (event) => {
      if (form.checkValidity()) return;
      event.preventDefault();
      const first = /** @type {HTMLInputElement | null} */ ($(':invalid', form));
      for (const input of $$('input', form)) {
        if (!(input instanceof HTMLInputElement)) continue;
        input.setAttribute('aria-invalid', input.validity.valid ? 'false' : 'true');
        if (!input.validity.valid) {
          let note = document.getElementById(`${input.id}-client-error`);
          if (!note) {
            note = document.createElement('p');
            note.id = `${input.id}-client-error`;
            note.className = 'field-error';
            input.insertAdjacentElement('afterend', note);
            input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), note.id].filter(Boolean).join(' '));
          }
          note.textContent = input.validationMessage;
        } else {
          document.getElementById(`${input.id}-client-error`)?.remove();
        }
      }
      first?.focus();
    });
  }
}

function enhanceBusySubmit() {
  for (const form of $$('form[data-busy-on-submit]')) {
    form.addEventListener('submit', () => {
      const button = $('button[type="submit"]', form);
      setBusy(button, true);
    });
  }
}

function enhanceResend() {
  for (const form of $$('form[data-resend][data-enable-at]')) {
    const enableAt = Date.parse(form.getAttribute('data-enable-at') ?? '');
    const button = $('button[type="submit"]', form);
    const reason = $('[data-resend-reason]', form);
    if (!(button instanceof HTMLButtonElement) || Number.isNaN(enableAt)) continue;
    const tick = () => {
      const left = Math.ceil((enableAt - Date.now()) / 1000);
      if (left <= 0) {
        button.disabled = false;
        reason?.remove();
        button.removeAttribute('aria-describedby');
        announce(form.getAttribute('data-ready-text') ?? '');
        return;
      }
      if (reason) reason.textContent = (form.getAttribute('data-wait-text') ?? '').replace('{seconds}', String(left));
      window.setTimeout(tick, 1000);
    };
    tick();
  }
}

enhanceAddToCart();
enhanceValidation();
enhanceBusySubmit();
enhanceResend();
focusFirstError();
