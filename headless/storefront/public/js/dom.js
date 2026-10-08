// @ts-check
// Small DOM helpers shared by the page scripts.

/**
 * @template {Element} [T=HTMLElement]
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {T | null}
 */
export function $(selector, root = document) {
  return /** @type {T | null} */ (root.querySelector(selector));
}

/**
 * @template {Element} [T=HTMLElement]
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {T[]}
 */
export function $$(selector, root = document) {
  return /** @type {T[]} */ ([...root.querySelectorAll(selector)]);
}

let liveTimer = 0;

/**
 * Announces text through the page's single polite live region.
 * @param {string} text
 */
export function announce(text) {
  const region = document.getElementById('live-region');
  if (!region) return;
  region.textContent = '';
  window.clearTimeout(liveTimer);
  liveTimer = window.setTimeout(() => {
    region.textContent = text;
  }, 60);
}

/**
 * Marks a button busy without changing its label.
 * @param {HTMLElement | null} button
 * @param {boolean} busy
 */
export function setBusy(button, busy) {
  if (!button) return;
  button.setAttribute('aria-busy', busy ? 'true' : 'false');
  if (button instanceof HTMLButtonElement) button.classList.toggle('is-busy', busy);
}

/** @returns {string} */
export function csrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ?? '';
}

/**
 * Moves focus to an element that is not normally focusable.
 * @param {HTMLElement | null} element
 */
export function focusElement(element) {
  if (!element) return;
  if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1');
  element.focus({ preventScroll: false });
}
