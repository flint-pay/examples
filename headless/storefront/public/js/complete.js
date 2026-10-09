// @ts-check
// Confirmation page: refresh while the payment is still being confirmed,
// send the receipt without leaving the page, and confirm a saved card with a
// code. The first two fall back to plain links and forms.

import { $, $$, announce, csrfToken, focusElement, setBusy } from './dom.js';

const messagesNode = document.getElementById('complete-messages');
const messages = /** @type {Record<string, string>} */ (messagesNode ? JSON.parse(messagesNode.textContent ?? '{}') : {});

function pollWhileConfirming() {
  const region = $('[data-poll]');
  if (!region) return;
  const interval = Number(region.getAttribute('data-poll-interval') ?? 2000);
  const max = Number(region.getAttribute('data-poll-max') ?? 60000);
  const started = Date.now();
  const tick = async () => {
    if (Date.now() - started >= max) {
      announce(messages.still_confirming ?? 'Still confirming your payment. Use Check again.');
      return;
    }
    try {
      const response = await fetch(window.location.href, { headers: { Accept: 'text/html' }, credentials: 'same-origin', redirect: 'manual' });
      if (response.type === 'opaqueredirect') {
        // The trial never started. Reload so the route sets its notice and sends the buyer back to checkout.
        window.location.reload();
        return;
      }
      if (response.ok) {
        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        const heading = doc.getElementById('complete-title');
        if (heading && heading.getAttribute('data-status') !== 'confirming') {
          // Payment is no longer pending. Load the final page so every script and region matches.
          window.location.reload();
          return;
        }
      }
    } catch {
      // Keep trying until the limit. Check again stays available as a link.
    }
    window.setTimeout(tick, interval);
  };
  window.setTimeout(tick, interval);
}

function wireReceipt() {
  const form = $('form[data-receipt-form]');
  if (!(form instanceof HTMLFormElement)) return;
  const status = $('[data-receipt-status]', form);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button[type="submit"]', form);
    setBusy(button, true);
    if (button instanceof HTMLButtonElement) button.disabled = true;
    let text = messages.generic_error ?? 'Something went wrong on our side. Try again.';
    let ok = false;
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
        body: '{}',
        credentials: 'same-origin',
      });
      const json = /** @type {any} */ (await response.json().catch(() => null));
      if (json && !json.error && response.ok) {
        ok = true;
        text = messages.receipt_sent ?? 'We emailed your receipt.';
      } else if (json?.error) {
        const key = [json.error.message_key, json.error.code?.toLowerCase()].find((candidate) => candidate && messages[candidate]);
        text = (key && messages[key]) || (json.error.kind === 'rate_limited' ? messages.receipt_recently_sent : text) || text;
      }
    } catch {
      text = messages.network_error ?? text;
    }
    if (status) {
      status.textContent = text;
      status.setAttribute('data-state', ok ? 'sent' : 'error');
      status.setAttribute('role', ok ? 'status' : 'alert');
    }
    setBusy(button, false);
    if (button instanceof HTMLButtonElement) button.disabled = false;
  });
}

/**
 * A card saved with a phone number stays pending until the buyer enters a code sent after payment.
 * The page asks for that first text once per checkout, then offers buttons for the rest.
 */
function wireSaveCard() {
  const panel = $('[data-save-card]');
  const ref = panel?.getAttribute('data-checkout-ref');
  if (!panel || !ref) return;
  const root = /** @type {HTMLElement} */ (panel);
  const base = `/checkout/${encodeURIComponent(ref)}`;
  const status = $('[data-save-card-status]', root);
  const autoKey = `save-card-auto:${ref}`;
  const focusKey = `save-card-focus:${ref}`;
  const code = $('#save-card-code', root);
  const remember = (/** @type {string} */ key, /** @type {boolean} */ on) => {
    try {
      if (on) window.sessionStorage.setItem(key, '1');
      else window.sessionStorage.removeItem(key);
    } catch {
      // Private browsing can refuse storage. The buttons still work.
    }
  };
  const remembered = (/** @type {string} */ key) => {
    try {
      return window.sessionStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  };
  const show = (/** @type {string} */ text, /** @type {'info' | 'error'} */ kind) => {
    if (!status) return;
    status.textContent = text;
    status.setAttribute('data-state', kind);
    status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  };
  const buttons = () => $$('button', root).filter((button) => button instanceof HTMLButtonElement);
  const lock = (/** @type {boolean} */ busy) => buttons().forEach((button) => {
    if (button instanceof HTMLButtonElement) button.disabled = busy;
  });
  /** @param {string} path @param {Record<string, string>} body */
  async function post(path, body) {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
    const json = /** @type {any} */ (await response.json().catch(() => null));
    return { ok: Boolean(json && !json.error && response.ok), error: json?.error ?? null };
  }
  /** Shows what went wrong and returns true when the page should reload instead. */
  function explain(/** @type {any} */ error, /** @type {boolean} */ quiet) {
    const generic = messages.generic_error ?? 'Something went wrong on our side. Try again.';
    const code = String(error?.code ?? '');
    if (code === 'PAYMENT_METHOD_SAVE_NOT_PENDING') return true;
    if (code === 'CUSTOMER_VERIFICATION_TEXT_UNAVAILABLE') {
      // Texting is not possible now. Make the emailed code the main choice.
      $$('[data-save-send="sms"]', root).forEach((button) => button.setAttribute('hidden', ''));
      $$('[data-save-send="email"]', root).forEach((button) => button.classList.remove('button-quiet'));
      show(messages.text_unavailable ?? generic, 'info');
    } else if (code === 'PAYMENT_METHOD_SAVE_EMAIL_UNAVAILABLE') {
      $$('[data-save-send="email"]', root).forEach((button) => button.setAttribute('hidden', ''));
      show(messages.email_unavailable ?? generic, quiet ? 'info' : 'error');
    } else if (code === 'CUSTOMER_VERIFICATION_CODE_INVALID') {
      show(messages.code_invalid ?? generic, 'error');
      const input = $('#save-card-code', root);
      input?.setAttribute('aria-invalid', 'true');
      input?.focus();
    } else if (code === 'PAYMENT_METHOD_SAVE_CODE_LIMIT_REACHED' || error?.kind === 'rate_limited') {
      show(messages.rate_limited ?? generic, 'error');
    } else if (code === 'PAYMENT_METHOD_SAVE_NOT_READY') {
      show(messages.not_ready ?? generic, 'info');
    } else {
      show(generic, quiet ? 'info' : 'error');
    }
    return false;
  }
  /** @param {'sms' | 'email'} channel @param {boolean} quiet */
  async function send(channel, quiet) {
    lock(true);
    let reload = false;
    try {
      const result = await post('/verification', { purpose: 'confirm_saved_payment_method', channel });
      if (result.ok) {
        remember(focusKey, true);
        reload = true;
      } else {
        reload = explain(result.error, quiet);
      }
    } catch {
      show(messages.network_error ?? 'We couldn’t reach the store. Try again.', quiet ? 'info' : 'error');
    }
    if (reload) window.location.reload();
    else lock(false);
  }

  $$('[data-save-send]', root).forEach((button) => {
    button.addEventListener('click', () => {
      setBusy(button, true);
      void send(button.getAttribute('data-save-send') === 'email' ? 'email' : 'sms', false).finally(() => setBusy(button, false));
    });
  });

  const form = $('form[data-save-card-form]', root);
  if (form instanceof HTMLFormElement) {
    if (remembered(focusKey)) {
      remember(focusKey, false);
      focusElement(code);
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const value = code instanceof HTMLInputElement ? code.value.trim() : '';
      code?.removeAttribute('aria-invalid');
      if (!/^\d{6}$/.test(value)) {
        explain({ code: 'CUSTOMER_VERIFICATION_CODE_INVALID' }, false);
        return;
      }
      const submit = $('button[type="submit"]', form);
      setBusy(submit, true);
      lock(true);
      let reload = false;
      try {
        const result = await post('/verification/confirm', { code: value });
        reload = result.ok || explain(result.error, false);
      } catch {
        show(messages.network_error ?? 'We couldn’t reach the store. Try again.', 'error');
      }
      if (reload) window.location.reload();
      else {
        lock(false);
        setBusy(submit, false);
      }
    });
  }

  if (root.getAttribute('data-auto-send') === 'sms' && !remembered(autoKey)) {
    remember(autoKey, true);
    void send('sms', true);
  }
}

pollWhileConfirming();
wireReceipt();
wireSaveCard();
