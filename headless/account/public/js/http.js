// @ts-check
// Same-origin JSON helpers. The browser only talks to this app, never to Flint.

/** @returns {string} */
export function csrfToken() {
  const meta = document.querySelector('meta[name="csrf-token"]');
  return meta instanceof HTMLMetaElement ? meta.content : '';
}

/**
 * @typedef {{ ok: boolean, status: number, body: any }} JsonResult
 */

/**
 * @param {string} url
 * @param {{ method?: string, body?: unknown, headers?: Record<string, string>, signal?: AbortSignal }} [options]
 * @returns {Promise<JsonResult>}
 */
export async function requestJson(url, options = {}) {
  const method = options.method ?? 'GET';
  /** @type {Record<string, string>} */
  const headers = { Accept: 'application/json', ...options.headers };
  /** @type {RequestInit} */
  const init = { method, headers, credentials: 'same-origin', cache: 'no-store', signal: options.signal };
  if (method !== 'GET') {
    headers['X-CSRF-Token'] = csrfToken();
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
  }
  const response = await fetch(url, init);
  /** @type {any} */
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { ok: response.ok, status: response.status, body };
}

/**
 * A fresh id for one logical action. Retries of the same action reuse it.
 * @returns {string}
 */
export function newActionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Reads the JSON a module embedded in the page.
 * @param {string} id
 * @returns {any}
 */
export function readBoot(id) {
  const node = document.getElementById(id);
  if (!node) return null;
  try {
    return JSON.parse(node.textContent ?? 'null');
  } catch {
    return null;
  }
}
