// @ts-check
// Email preferences. A link from an email carries its token in the URL fragment. The fragment is
// removed from the address bar right away and the token lives only in this module's memory.
import { readBoot, requestJson } from './http.js';
import { announce } from './live.js';

const root = document.querySelector('[data-email-preferences]');
const boot = readBoot('prefs-boot');

/** @returns {string | null} */
function takeToken() {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  const token = new URLSearchParams(hash).get('flint_email_preference_token');
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return token && token.length <= 8192 ? token : null;
}

if (root instanceof HTMLElement && boot) {
  const ui = boot.copy.ui;
  /** @type {string | null} */
  let token = takeToken();
  const panel = root.querySelector('[data-mode="token"]');
  const signedIn = root.querySelector('[data-mode="signed-in"]');
  const views = new Map();
  for (const view of root.querySelectorAll('[data-token-view]')) {
    if (view instanceof HTMLElement) views.set(view.dataset.tokenView, view);
  }

  /** @param {string} name */
  const show = (name) => {
    for (const [key, view] of views) view.hidden = key !== name;
    root.dataset.state = `token-${name}`;
  };

  /** @param {string | undefined} preference */
  const labelFor = (preference) => ui.labels[preference ?? ''] ?? ui.labels.other;
  /** @param {string} template @param {Record<string, string>} params */
  const fill = (template, params) => template.replace(/\{(\w+)\}/g, (m, key) => params[key] ?? m);

  /** @param {any} link */
  const finishWith = (link) => {
    const label = labelFor(link?.email_preference ?? link?.preference);
    const done = views.get('done')?.querySelector('[data-done-text]');
    if (done instanceof HTMLElement) done.textContent = fill(ui.done, { label });
    show('done');
    announce(fill(ui.done, { label }));
  };

  const start = async () => {
    if (!token) {
      if (signedIn instanceof HTMLElement && !signedIn.hidden) return; // plain signed-in preferences
      if (panel instanceof HTMLElement) panel.hidden = false;
      show('missing');
      return;
    }
    if (signedIn instanceof HTMLElement) signedIn.hidden = true;
    if (panel instanceof HTMLElement) panel.hidden = false;
    show('lookup');
    let result;
    try {
      result = await requestJson(boot.endpoints.lookup, { method: 'POST', body: { token } });
    } catch {
      show('retry');
      return;
    }
    const link = result.body?.link;
    if (!result.ok || !link) {
      if (result.body?.error?.code === 'EMAIL_PREFERENCE_LINK_INVALID' || result.status === 404) {
        token = null;
        show('invalid');
      } else {
        show('retry');
      }
      return;
    }
    const label = labelFor(link.email_preference ?? link.preference);
    if (link.enabled === false) {
      const done = views.get('done')?.querySelector('[data-done-text]');
      if (done instanceof HTMLElement) done.textContent = fill(ui.alreadyOff, { email: link.email, label });
      show('done');
      token = null;
      return;
    }
    const text = views.get('confirm')?.querySelector('[data-confirm-text]');
    if (text instanceof HTMLElement) text.textContent = fill(ui.confirmQuestion, { email: link.email, label });
    show('confirm');
  };

  const button = root.querySelector('[data-unsubscribe-button]');
  if (button instanceof HTMLButtonElement) {
    button.addEventListener('click', async () => {
      if (!token || button.getAttribute('aria-busy') === 'true') return;
      button.setAttribute('aria-busy', 'true');
      button.disabled = true;
      let result;
      try {
        result = await requestJson(boot.endpoints.unsubscribe, { method: 'POST', body: { token } });
      } catch {
        result = null;
      }
      button.removeAttribute('aria-busy');
      button.disabled = false;
      if (result?.ok && result.body?.link) {
        token = null;
        finishWith(result.body.link);
      } else if (result && (result.body?.error?.code === 'EMAIL_PREFERENCE_LINK_INVALID' || result.status === 404)) {
        token = null;
        show('invalid');
      } else {
        const retry = views.get('retry');
        if (retry) retry.hidden = false;
        announce(ui.retry);
      }
    });
  }

  void start();
}
