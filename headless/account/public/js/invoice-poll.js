// @ts-check
// After a payment, the invoice may take a moment to show it. Poll the status route for up to 30 seconds.
import { requestJson, sleep } from './http.js';
import { announce } from './live.js';

const region = document.querySelector('[data-invoice-poll]');
if (region instanceof HTMLElement && region.dataset.url) {
  const url = region.dataset.url;
  const text = region.querySelector('[data-poll-text]');
  const started = Date.now();
  let settled = false;
  while (Date.now() - started < 30000) {
    await sleep(2000);
    let result;
    try {
      result = await requestJson(url);
    } catch {
      continue;
    }
    const invoice = result.body?.invoice;
    if (invoice && (invoice.status === 'paid' || invoice.status === 'partially_paid')) {
      announce('Your payment shows on this invoice.');
      settled = true;
      window.location.assign(window.location.pathname);
      break;
    }
  }
  if (!settled) {
    region.dataset.state = 'still_checking';
    if (text instanceof HTMLElement) {
      text.textContent = "We haven't seen the payment yet. Reload this page in a minute.";
    }
  }
}
