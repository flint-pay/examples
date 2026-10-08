// @ts-check
// Gift card verification frame. When Flint asks for a check before it looks up a gift card code,
// the app's own response carries a one-time frame address. This module shows that frame and
// listens for its answer. It never talks to Flint. The frame's proof goes straight to this app's
// own challenge route, once, and is kept nowhere else.
//
// The frame address is trusted only when it has the exact shape of a Flint challenge page on the
// challenge origin the server put on the page. An answer is trusted only when it comes from this
// frame's window, from that origin, for the checkout this page shows (checked through a tag, so
// the page never holds the checkout session ID).

const TAG_PREFIX = 'flint-examples.gift-challenge.v1\n';
const PATH_SHAPE = /^\/gift-card-challenge\/[A-Za-z0-9_.-]{1,256}$/;
const PROOF_SHAPE = /^[\x21-\x7E]{1,2048}$/;
const COMPLETED = 'flint.gift_card_challenge.completed';
const FAILED = 'flint.gift_card_challenge.failed';
/** Answers checked at the same time. Anything past this is dropped. */
const MAX_PENDING = 8;
/** Largest delay a browser timer accepts. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * @typedef {{ challenge_id: string, url: string, session_tag: string, reason: 'proof_required' | 'proof_rejected', expires_in_seconds: number }} GiftChallengeView
 * @typedef {{ origin: string, slow_after_ms: number, title: string, testid?: string }} FrameConfig
 * @typedef {{ kind: 'completed', proof: string } | { kind: 'failed', reason: 'verification_failed' | 'unavailable' } | { kind: 'expired' } | { kind: 'slow' }} FrameEvent
 */

/**
 * True when `raw` is exactly one Flint challenge page address on the expected origin.
 * Rejects every form the URL parser would rewrite, credentials, queries, and fragments.
 * @param {unknown} raw
 * @param {unknown} origin
 * @returns {boolean}
 */
export function isTrustedChallengeUrl(raw, origin) {
  if (typeof raw !== 'string' || raw.length > 2048 || typeof origin !== 'string' || !origin) return false;
  if (raw.includes('?') || raw.includes('#')) return false;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.href === raw &&
    url.protocol === 'https:' &&
    url.origin === origin &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    PATH_SHAPE.test(url.pathname)
  );
}

/** @param {Uint8Array} bytes */
function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The tag the server computed for this challenge: a SHA-256 digest that ties the challenge to the
 * checkout session without putting the session ID in the page.
 * @param {string} challengeId
 * @param {string} checkoutSessionId
 * @returns {Promise<string>}
 */
export async function sessionTagFor(challengeId, checkoutSessionId) {
  const data = new TextEncoder().encode(`${TAG_PREFIX}${challengeId}\n${checkoutSessionId}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64url(new Uint8Array(digest));
}

/**
 * Shows one challenge frame inside `host` and reports what happens to it. Every mount has its own
 * context. Nothing is shared between mounts.
 * @param {HTMLElement} host
 * @param {GiftChallengeView} view
 * @param {FrameConfig} config
 * @param {(event: FrameEvent) => void} onEvent
 * @returns {{ unmount(): void }}
 */
export function mountChallengeFrame(host, view, config, onEvent) {
  const none = { unmount() {} };
  const lifetime = Number(view.expires_in_seconds) * 1000;
  const usable =
    isTrustedChallengeUrl(view.url, config.origin) &&
    typeof view.challenge_id === 'string' &&
    typeof view.session_tag === 'string' &&
    Number.isFinite(lifetime) &&
    lifetime > 0 &&
    typeof globalThis.crypto?.subtle?.digest === 'function';
  if (!usable) {
    queueMicrotask(() => onEvent({ kind: 'failed', reason: 'unavailable' }));
    return none;
  }

  const frame = document.createElement('iframe');
  frame.className = 'gift-challenge-frame';
  frame.title = config.title;
  frame.referrerPolicy = 'no-referrer';
  frame.loading = 'eager';
  if (config.testid) frame.setAttribute('data-testid', config.testid);
  frame.src = view.url;
  host.append(frame);
  const frameWindow = frame.contentWindow;
  if (!frameWindow) {
    frame.remove();
    queueMicrotask(() => onEvent({ kind: 'failed', reason: 'unavailable' }));
    return none;
  }

  const context = {
    frameWindow,
    origin: config.origin,
    challengeId: view.challenge_id,
    sessionTag: view.session_tag,
    settled: false,
    pending: 0,
    queue: /** @type {Promise<void>} */ (Promise.resolve()),
  };
  /** @type {number | undefined} */
  let slowTimer;
  /** @type {number | undefined} */
  let expiryTimer;

  function unmount() {
    context.settled = true;
    window.removeEventListener('message', onMessage);
    window.clearTimeout(slowTimer);
    window.clearTimeout(expiryTimer);
    frame.remove();
  }

  /** @param {MessageEvent} event */
  function onMessage(event) {
    if (context.settled) return;
    if (event.source !== context.frameWindow) return;
    if (event.origin !== context.origin) return;
    const data = event.data;
    if (typeof data !== 'object' || data === null || Array.isArray(data) || typeof data.type !== 'string') return;
    // Flint may add message types. Unknown ones are ignored without ending the check.
    if (data.type !== COMPLETED && data.type !== FAILED) return;
    if (typeof data.checkout_session_id !== 'string' || data.checkout_session_id.length < 1 || data.checkout_session_id.length > 255) return;
    const completed = data.type === COMPLETED;
    if (completed) {
      // The expiry time is Flint's to judge. It only has to be a readable time here.
      if (typeof data.proof !== 'string' || !PROOF_SHAPE.test(data.proof)) return;
      if (typeof data.expires_at !== 'string' || !Number.isFinite(Date.parse(data.expires_at))) return;
    } else if (typeof data.reason !== 'string') {
      return;
    }
    if (context.pending >= MAX_PENDING) return;
    const sessionId = data.checkout_session_id;
    const proof = completed ? data.proof : '';
    const reason = completed ? '' : data.reason;
    context.pending += 1;
    context.queue = context.queue.then(async () => {
      try {
        if (context.settled) return;
        const tag = await sessionTagFor(context.challengeId, sessionId);
        if (context.settled || tag !== context.sessionTag) return;
        context.settled = true;
        unmount();
        if (completed) onEvent({ kind: 'completed', proof });
        else onEvent({ kind: 'failed', reason: reason === 'verification_failed' ? 'verification_failed' : 'unavailable' });
      } catch {
        /* an answer that cannot be checked is ignored */
      } finally {
        context.pending -= 1;
      }
    });
  }

  window.addEventListener('message', onMessage);
  slowTimer = window.setTimeout(() => {
    if (!context.settled) onEvent({ kind: 'slow' });
  }, Math.min(Math.max(Number(config.slow_after_ms) || 60_000, 0), MAX_TIMER_MS));
  expiryTimer = window.setTimeout(() => {
    if (context.settled) return;
    unmount();
    onEvent({ kind: 'expired' });
  }, Math.min(lifetime, MAX_TIMER_MS));

  return { unmount };
}
