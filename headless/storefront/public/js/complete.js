// @ts-check
// Confirmation page: refresh while the payment is still being confirmed and
// send the receipt without leaving the page. Both fall back to plain links
// and forms.

import { $, announce, csrfToken, setBusy } from './dom.js';

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
      const response = await fetch(window.location.href, { headers: { Accept: 'text/html' }, credentials: 'same-origin' });
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

pollWhileConfirming();
wireReceipt();
