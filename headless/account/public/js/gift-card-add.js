// @ts-check
// Add a gift card: tabs for code or link, and link parsing in the page. The link itself is never
// fetched or sent. Only the grant ID and token go in the POST body, and the field is cleared.
import { parseGiftCardLink } from './gift-link.js';
import { readBoot } from './http.js';
import { announce } from './live.js';

const root = document.querySelector('[data-gift-add]');
const boot = readBoot('gift-add-boot');
if (root instanceof HTMLElement) {
  const tabs = Array.from(root.querySelectorAll('[role="tab"]')).filter((el) => el instanceof HTMLElement);
  const panels = Array.from(root.querySelectorAll('[role="tabpanel"]')).filter((el) => el instanceof HTMLElement);

  /** @param {string} name */
  const select = (name) => {
    root.dataset.state = name;
    for (const tab of tabs) {
      const active = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    for (const panel of panels) panel.hidden = panel.dataset.panel !== name;
  };
  for (const tab of tabs) {
    tab.addEventListener('click', () => select(tab.dataset.tab ?? 'code'));
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') return;
      event.preventDefault();
      const index = tabs.indexOf(tab);
      const next =
        event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      const target = tabs[next];
      if (target) {
        select(target.dataset.tab ?? 'code');
        target.focus();
      }
    });
  }
  select(root.dataset.state === 'link' ? 'link' : 'code');

  const form = root.querySelector('[data-gift-link-form]');
  if (form instanceof HTMLFormElement) {
    const input = form.querySelector('[data-link-input]');
    const grant = form.querySelector('[data-link-grant]');
    const token = form.querySelector('[data-link-token]');
    const error = form.querySelector('[data-link-error]');
    const message = boot?.copy?.ui?.linkUnreadable ?? 'Paste the full link from the gift card email, or enter the code instead.';
    form.addEventListener('submit', (event) => {
      if (!(input instanceof HTMLInputElement) || !(grant instanceof HTMLInputElement) || !(token instanceof HTMLInputElement)) return;
      const parsed = parseGiftCardLink(input.value);
      if (!parsed) {
        event.preventDefault();
        if (error instanceof HTMLElement) {
          error.textContent = message;
          error.hidden = false;
        }
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', 'gift-link-hint gift-link-error');
        input.focus();
        announce(message);
        return;
      }
      grant.value = parsed.grantId;
      token.value = parsed.token;
      // The visible field has no name, so it is never sent. Clear it so the link does not linger.
      input.value = '';
    });
  }
}
