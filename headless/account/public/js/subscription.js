// @ts-check
// Subscription page: swaps the cancel confirmation text with the chosen timing and follows a
// payment retry until it finishes.
import { announce } from './live.js';
import { requestJson, sleep } from './http.js';

function setupCancelCopy() {
  const form = document.querySelector('[data-cancel-form]');
  if (!(form instanceof HTMLFormElement)) return;
  const copies = form.querySelectorAll('[data-confirm-copy]');
  const apply = () => {
    const chosen = form.querySelector('input[name="cancel_when"]:checked');
    const value = chosen instanceof HTMLInputElement ? chosen.value : 'period_end';
    for (const copy of copies) {
      if (copy instanceof HTMLElement) copy.hidden = copy.dataset.confirmCopy !== (value === 'now' ? 'now' : 'period_end');
    }
  };
  form.addEventListener('change', apply);
  apply();
}

async function followRetry() {
  const region = document.querySelector('[data-retry-poll]');
  if (!(region instanceof HTMLElement)) return;
  const url = region.dataset.pollUrl;
  const text = region.querySelector('[data-retry-text]');
  if (!url || !(text instanceof HTMLElement)) return;
  const started = Date.now();
  while (Date.now() - started < 60000) {
    await sleep(2000);
    let result;
    try {
      result = await requestJson(url);
    } catch {
      continue;
    }
    const status = result.body?.retry?.status;
    if (status === 'succeeded' || status === 'failed') {
      announce(status === 'succeeded' ? 'Payment received. Your subscription is active again.' : 'The retry did not work.');
      // The server renders the final state and the refreshed subscription.
      window.location.reload();
      return;
    }
  }
  text.textContent = region.dataset.stillWorking ?? text.textContent;
}

/** Shows "starting" the moment the buyer asks for a retry, before the page reloads with its status. */
function setupRetryStart() {
  const form = document.querySelector('[data-retry-form]');
  const region = document.querySelector('[data-testid="ac-retry-status"]');
  if (!(form instanceof HTMLFormElement) || !(region instanceof HTMLElement) || region.dataset.state !== 'idle') return;
  form.addEventListener('submit', (event) => {
    if (event.defaultPrevented) return;
    const text = region.querySelector('[data-retry-text]');
    region.hidden = false;
    region.dataset.state = 'starting';
    if (text instanceof HTMLElement) text.textContent = region.dataset.startingText ?? '';
    announce(region.dataset.startingText ?? '');
  });
}

setupCancelCopy();
setupRetryStart();
void followRetry();
