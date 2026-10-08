// @ts-check
// Gift cards on an invoice or exchange payment page. This module applies a code through the app's
// own route and runs the verification Flint can ask for before it looks a code up. It never calls
// Flint. The verification frame address arrives only in the answer to one Apply, and the frame's
// proof goes to the app's challenge route once and is kept nowhere else.
//
// States (data-challenge-state on [data-gift-pay]): none, loading, slow, checking, failed, expired,
// and the terminal unavailable, origin_required, and unconfirmed.

import { mountChallengeFrame } from './gift-challenge.js';
import { newActionId, readBoot, requestJson } from './http.js';

/** @typedef {import('../../src/views/types.ts').GiftPayBoot} GiftPayBoot */
/** @typedef {import('../../src/views/types.ts').GiftChallengeView} GiftChallengeView */

const ACTIVE = new Set(['loading', 'slow', 'checking', 'failed', 'expired']);
/** Payment page states in which the amounts are fixed and gift cards can no longer change. */
const PAYMENT_BUSY = new Set(['submitting', 'authenticating', 'resuming', 'waiting', 'bank_processing', 'affirm_incomplete', 'recovery', 'succeeded']);
/** Messages that mean the order changed under the buyer. */
const APPLY_AGAIN = new Set(['GIFT_CHALLENGE_SESSION_CHANGED', 'GIFT_CHALLENGE_CODE_CHANGED', 'GIFT_CHALLENGE_ORDER_CHANGED', 'ORDER_CHANGED_REFRESH_REQUIRED', 'GIFT_CARDS_NOT_EDITABLE', 'ACTION_BODY_MISMATCH']);

const boot = /** @type {GiftPayBoot | null} */ (readBoot('gift-pay-boot'));
const section = document.querySelector('[data-gift-pay]');
if (boot && section instanceof HTMLElement) start(section, boot);

/**
 * @param {HTMLElement} section
 * @param {GiftPayBoot} boot
 */
function start(section, boot) {
  const copy = boot.copy;
  const endpoints = boot.endpoints;
  /** @param {string} selector */
  const find = (selector) => section.querySelector(selector);
  const form = find('[data-gift-apply-form]');
  const input = form?.querySelector('input[name="gift_card_code"]') ?? null;
  const applyButton = form?.querySelector('button[type="submit"]') ?? null;
  const errorLine = find('[data-gift-error]');
  const reloadNote = find('[data-gift-reload]');
  /** The server-rendered note that an apply or remove has an unknown outcome. */
  const notice = find('[data-gift-unconfirmed]');
  const recheck = find('.gift-recheck');
  const panel = find('[data-gift-challenge]');
  const paymentRoot = document.querySelector('[data-payment-root]');

  const gift = {
    state: 'none',
    mounts: 0,
    /** @type {GiftChallengeView | null} */
    view: null,
    /** A fresh challenge Flint sent back after it rejected a proof. Try again uses it without a request. */
    held: /** @type {GiftChallengeView | null} */ (null),
    frame: /** @type {{ unmount(): void } | null} */ (null),
    /** Changes whenever a frame is mounted or the check ends, so a late answer for an old one is dropped. */
    generation: 0,
    locked: false,
    applying: false,
    /** The action ID and code of an Apply whose outcome is unknown. The next Apply of the same code reuses the ID. */
    unknown: /** @type {{ code: string, id: string } | null} */ (null),
    /** The action ID of the Apply that started the open check. */
    action: /** @type {{ code: string, id: string } | null} */ (null),
  };

  // ---- Outcomes -------------------------------------------------------------

  /**
   * True when the app's own answer never arrived or cannot be read, so the change may have happened:
   * a failed request, an answer the app marked unknown_outcome, or a server error that is not the
   * app's JSON (a proxy's 502 or 503 page). requestJson returns a null body for those pages.
   * @param {Awaited<ReturnType<typeof requestJson>> | null} result
   */
  function isUnknown(result) {
    if (!result) return true;
    if (result.body?.error?.kind === 'unknown_outcome') return true;
    return result.status >= 500 && (result.body === null || typeof result.body !== 'object');
  }

  // ---- Copy -----------------------------------------------------------------

  /** @param {{ message_key?: string, code?: string, kind?: string } | undefined} error */
  function errorText(error) {
    for (const key of [error?.message_key, error?.code?.toLowerCase(), error?.kind]) {
      if (key && Object.hasOwn(copy, key)) return String(copy[key]);
    }
    return String(copy.generic_error);
  }

  // ---- Rendering ------------------------------------------------------------

  /** @param {string} text @param {{ reload?: boolean }} [options] */
  function setError(text, options = {}) {
    if (errorLine instanceof HTMLElement) {
      errorLine.textContent = text;
      errorLine.hidden = !text;
      if (input instanceof HTMLInputElement) {
        // The field keeps pointing at the recovery notice, when there is one, as well as its error.
        const described = [notice instanceof HTMLElement ? notice.id : '', text && errorLine.id ? errorLine.id : ''].filter(Boolean).join(' ');
        if (described) input.setAttribute('aria-describedby', described);
        else input.removeAttribute('aria-describedby');
      }
    }
    if (reloadNote instanceof HTMLElement) reloadNote.hidden = !(text && options.reload);
  }

  /** Makes the page match `gift.state`. */
  function render() {
    const active = ACTIVE.has(gift.state);
    section.setAttribute('data-challenge-state', gift.state);
    if (panel instanceof HTMLElement) {
      panel.hidden = !active;
      panel.setAttribute('data-state', active ? gift.state : 'none');
      const status = panel.querySelector('[data-gift-challenge-status]');
      if (status instanceof HTMLElement) status.textContent = gift.state === 'slow' ? String(copy.challengeSlow) : gift.state === 'checking' ? String(copy.challengeChecking) : '';
      const alert = panel.querySelector('[data-gift-challenge-message]');
      if (alert instanceof HTMLElement) {
        const text = gift.state === 'failed' ? String(copy.challengeFailed) : gift.state === 'expired' ? String(copy.gift_challenge_expired) : '';
        alert.textContent = text;
        alert.hidden = !text;
      }
      panel.querySelector('[data-gift-challenge-retry]')?.toggleAttribute('hidden', !['slow', 'failed', 'expired'].includes(gift.state));
      panel.querySelector('[data-gift-challenge-cancel]')?.toggleAttribute('hidden', !active || gift.state === 'checking');
      panel.querySelector('[data-gift-challenge-host]')?.toggleAttribute('hidden', gift.state !== 'loading' && gift.state !== 'slow');
    }
    if (input instanceof HTMLInputElement) {
      input.readOnly = active;
      if (active) input.setAttribute('aria-readonly', 'true');
      else input.removeAttribute('aria-readonly');
    }
    if (applyButton instanceof HTMLButtonElement) {
      applyButton.disabled = active || gift.locked || gift.applying;
      if (gift.state === 'checking' || gift.applying) applyButton.setAttribute('aria-busy', 'true');
      else applyButton.removeAttribute('aria-busy');
    }
    for (const remove of section.querySelectorAll('.gift-applied form button')) {
      if (remove instanceof HTMLButtonElement) remove.disabled = gift.locked || gift.state === 'checking';
    }
  }

  // ---- The check ------------------------------------------------------------

  function mountFrame() {
    gift.frame?.unmount();
    gift.frame = null;
    gift.generation += 1;
    const generation = gift.generation;
    const host = panel?.querySelector('[data-gift-challenge-host]');
    const view = gift.view;
    if (!(host instanceof HTMLElement) || !view || !boot.challenge.origin) {
      endCheck('unavailable', { text: String(copy.gift_card_challenge_required) });
      return;
    }
    host.replaceChildren();
    gift.frame = mountChallengeFrame(
      host,
      view,
      { origin: boot.challenge.origin, slow_after_ms: boot.challenge.slow_after_ms, title: String(copy.challengeFrameTitle), testid: 'ac-gift-challenge-frame' },
      (event) => {
        if (generation === gift.generation) onFrameEvent(event);
      },
    );
  }

  /** @param {GiftChallengeView} view */
  function beginCheck(view) {
    gift.view = view;
    gift.held = null;
    gift.mounts = 1;
    gift.state = 'loading';
    render();
    mountFrame();
    focusIntro();
  }

  function focusIntro() {
    const intro = document.getElementById('gift-challenge-intro');
    if (intro instanceof HTMLElement) intro.focus();
  }

  function focusMessage() {
    const alert = panel?.querySelector('[data-gift-challenge-message]');
    if (alert instanceof HTMLElement) alert.focus();
  }

  /** @param {import('./gift-challenge.js').FrameEvent} event */
  function onFrameEvent(event) {
    switch (event.kind) {
      case 'slow':
        if (gift.state === 'loading') {
          gift.state = 'slow';
          render();
        }
        break;
      case 'completed':
        void submitProof(event.proof);
        break;
      case 'failed':
        if (event.reason === 'verification_failed' && gift.mounts < boot.challenge.max_mounts) {
          gift.state = 'failed';
          render();
          focusMessage();
        } else {
          // Either the frame cannot run, or this was the last frame the check allows. Try again could
          // only lead here, so end now. The cap counts mounts, not failures.
          endCheck('unavailable', { text: String(copy.gift_card_challenge_required) });
        }
        break;
      case 'expired':
        gift.state = 'expired';
        render();
        focusMessage();
        break;
    }
  }

  /**
   * Sends the proof to this app once. The proof is a parameter and a request body, nothing else.
   * @param {string} proof
   */
  async function submitProof(proof) {
    const view = gift.view;
    const code = input instanceof HTMLInputElement ? input.value.trim() : '';
    gift.frame = null;
    if (!view || !code) {
      endCheck('unavailable', { text: String(copy.gift_card_challenge_required) });
      return;
    }
    gift.state = 'checking';
    render();
    // The frame is gone. Keep focus on the instruction if it was inside the frame.
    if (!document.activeElement || document.activeElement === document.body) focusIntro();
    const generation = gift.generation;
    /** @type {Awaited<ReturnType<typeof requestJson>> | null} */
    let result = null;
    try {
      result = await requestJson(endpoints.challenge, { method: 'POST', body: { challenge_id: view.challenge_id, gift_card_code: code, proof } });
    } catch {
      result = null;
    }
    if (generation !== gift.generation) return;
    onProofResult(result, code);
  }

  /**
   * @param {Awaited<ReturnType<typeof requestJson>> | null} result
   * @param {string} code
   */
  function onProofResult(result, code) {
    const body = result?.body ?? {};
    if (result?.ok && body.gift_challenge) {
      // Flint rejected the proof and sent a fresh check. Try again uses it without another Apply.
      gift.held = body.gift_challenge;
      gift.state = 'expired';
      render();
      focusMessage();
      return;
    }
    if (result?.ok) {
      leave('none');
      goToPage(body.redirect);
      return;
    }
    const error = body.error;
    const errorCode = error?.code ?? '';
    if (errorCode === 'GIFT_CHALLENGE_EXPIRED') {
      gift.held = null;
      gift.state = 'expired';
      render();
      focusMessage();
    } else if (errorCode === 'GIFT_CARD_CHALLENGE_ORIGIN_REQUIRED') {
      endCheck('origin_required', { text: String(copy.gift_challenge_origin_required), reload: true });
    } else if (errorCode === 'GIFT_CARD_CHALLENGE_UNAVAILABLE') {
      endCheck('unavailable', { text: String(copy.gift_card_challenge_required) });
    } else if (isUnknown(result)) {
      // The proof is never sent again. The next Apply of the same code reuses the first Apply's ID.
      if (gift.action && gift.action.code === code) gift.unknown = gift.action;
      endCheck('unconfirmed', { text: String(copy.gift_challenge_unconfirmed) });
    } else if (result?.status === 429 || error?.kind === 'rate_limited') {
      endCheck('none', { text: String(copy.rate_limited) });
    } else if (APPLY_AGAIN.has(errorCode)) {
      endCheck('none', { text: String(copy.gift_card_apply_again_pay) });
    } else {
      endCheck('none', { text: errorText(error) });
    }
  }

  /**
   * Removes the frame and returns the section to a resting state. The code field stays as it is.
   * @param {'none' | 'unavailable' | 'origin_required' | 'unconfirmed'} next
   */
  function leave(next) {
    gift.generation += 1;
    gift.frame?.unmount();
    gift.frame = null;
    gift.view = null;
    gift.held = null;
    gift.mounts = 0;
    gift.state = next;
    render();
    panel?.querySelector('[data-gift-challenge-host]')?.replaceChildren();
  }

  /**
   * Ends the check, shows the line, and returns to the field.
   * @param {'none' | 'unavailable' | 'origin_required' | 'unconfirmed'} next
   * @param {{ text?: string, reload?: boolean }} [options]
   */
  function endCheck(next, options = {}) {
    leave(next);
    setError(options.text ?? '', { reload: options.reload });
    if (input instanceof HTMLInputElement) input.focus();
  }

  function retry() {
    const state = gift.state;
    if (state === 'slow' || state === 'failed') {
      // Reached from slow at the cap. A failed frame at the cap has already ended the check.
      if (gift.mounts >= boot.challenge.max_mounts) {
        endCheck('unavailable', { text: String(copy.gift_card_challenge_required) });
        return;
      }
      gift.mounts += 1;
      gift.state = 'loading';
      render();
      mountFrame();
      focusIntro();
    } else if (state === 'expired') {
      const held = gift.held;
      if (held) {
        beginCheck(held);
        return;
      }
      // Apply the same code again. This starts a new check and drops the old one.
      leave('none');
      void apply();
    }
  }

  function cancel() {
    if (!ACTIVE.has(gift.state) || gift.state === 'checking') return;
    endCheck('none');
  }

  // ---- Apply ----------------------------------------------------------------

  /** @param {unknown} redirect */
  function goToPage(redirect) {
    const target = typeof redirect === 'string' && redirect.startsWith(endpoints.page) ? redirect : endpoints.page;
    window.location.assign(target);
  }

  async function apply() {
    if (!(input instanceof HTMLInputElement) || ACTIVE.has(gift.state) || gift.locked || gift.applying) return;
    gift.state = 'none';
    setError('');
    const code = input.value.trim();
    if (!code) {
      render();
      setError(String(copy.gift_card_code_required));
      input.focus();
      return;
    }
    // An Apply whose outcome is unknown keeps its action ID until a definite outcome, so Apply of the
    // same code replays the original journal key. Another code, an empty field, or a rate limit leaves
    // that record alone.
    const reuse = gift.unknown && gift.unknown.code === code ? gift.unknown : null;
    const action = reuse ?? { code, id: newActionId() };
    gift.applying = true;
    render();
    /** @type {Awaited<ReturnType<typeof requestJson>> | null} */
    let result = null;
    try {
      result = await requestJson(endpoints.apply, { method: 'POST', body: { gift_card_code: code }, headers: { 'X-Action-ID': action.id } });
    } catch {
      result = null;
    }
    gift.applying = false;
    render();
    const body = result?.body ?? {};
    if (result?.ok) {
      // A redirect or a new check is a definite answer to the earlier Apply of this code.
      if (reuse) gift.unknown = null;
      if (body.gift_challenge) {
        gift.action = action;
        beginCheck(body.gift_challenge);
      } else {
        goToPage(body.redirect);
      }
      return;
    }
    const error = body.error;
    const errorCode = error?.code ?? '';
    const unknown = isUnknown(result);
    // Answers that never reached the payment engine (rate limit, session, token) settle nothing.
    const settled = !unknown && result !== null && ![401, 403, 429].includes(result.status);
    if (unknown) gift.unknown = action;
    else if (reuse && settled) gift.unknown = null;
    if (errorCode === 'GIFT_CARD_CHALLENGE_ORIGIN_REQUIRED') endCheck('origin_required', { text: String(copy.gift_challenge_origin_required), reload: true });
    else if (errorCode === 'GIFT_CARD_CHALLENGE_UNAVAILABLE') endCheck('unavailable', { text: String(copy.gift_card_challenge_required) });
    else if (unknown) endCheck('unconfirmed', { text: String(copy.gift_challenge_unconfirmed) });
    else if (result?.status === 429 || error?.kind === 'rate_limited') endCheck('none', { text: String(copy.rate_limited) });
    else endCheck('none', { text: errorText(error) });
  }

  // ---- Wiring ---------------------------------------------------------------

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    void apply();
  });
  section.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-gift-challenge-retry]')) retry();
    else if (target.closest('[data-gift-challenge-cancel]')) cancel();
  });
  section.addEventListener('keydown', (event) => {
    const target = event.target;
    if (event.key !== 'Escape' || !(target instanceof Element) || !target.closest('[data-gift-challenge]')) return;
    if (!ACTIVE.has(gift.state) || gift.state === 'checking') return;
    event.preventDefault();
    cancel();
  });

  // Once a payment is under way the amounts are fixed. An open check ends silently and the controls lock.
  if (paymentRoot instanceof HTMLElement) {
    const sync = () => {
      const locked = PAYMENT_BUSY.has(paymentRoot.dataset.state ?? '');
      if (locked === gift.locked) return;
      gift.locked = locked;
      if (locked && ACTIVE.has(gift.state)) leave('none');
      render();
    };
    new MutationObserver(sync).observe(paymentRoot, { attributes: true, attributeFilter: ['data-state'] });
    sync();
  }

  // Check again is a plain form post. Once it is sent a second activation does nothing.
  if (recheck instanceof HTMLFormElement) {
    let sent = false;
    recheck.addEventListener('submit', (event) => {
      if (sent) {
        event.preventDefault();
        return;
      }
      sent = true;
      const button = recheck.querySelector('button');
      if (button instanceof HTMLButtonElement) {
        button.setAttribute('aria-disabled', 'true');
        button.disabled = true;
      }
    });
  }

  // After an apply or a remove the page reloads with a notice. Move focus to it. Without one, the
  // recovery note takes focus so a buyer who reloaded hears what is unresolved.
  const flash = document.querySelector('[data-notice="gift_card_applied"], [data-notice="gift_card_removed"]');
  if (flash instanceof HTMLElement) {
    flash.tabIndex = -1;
    flash.focus();
  } else if (notice instanceof HTMLElement) {
    notice.focus();
  }
  render();
}
