// @ts-check
// Checkout page controller. The server renders every section from the current
// state. This module saves edits through the app's JSON jobs, swaps the server
// rendered regions after each job, and drives the payment state machine.
// It talks only to this app. Stripe.js is the only third-party script.

import * as logic from './checkout-logic.js';
import { $, $$, announce, csrfToken, focusElement, setBusy } from './dom.js';
import { formatMoney, sameMoney } from './money.js';
import { createStripePayment } from './stripe-payment.js';

/** @typedef {import('../../src/views/types.ts').CheckoutState} CheckoutState */
/** @typedef {import('./money.js').Money} Money */
/** @typedef {{ kind?: string, code?: string, message_key?: string, request_id?: string }} JobError */
/** @typedef {{ ok: boolean, status: number, transport?: boolean, error?: JobError, state?: CheckoutState, next?: string, client_action?: any, pending_action_id?: string }} JobResult */

const bootNode = document.getElementById('checkout-bootstrap');
if (!bootNode) throw new Error('checkout bootstrap missing');
const boot = /** @type {{ ref: string, store: string, state: CheckoutState, messages: Record<string, string>, labels: Record<string, string> }} */ (
  JSON.parse(bootNode.textContent ?? '{}')
);

const REF = boot.ref;
const POLL_START_MS = 500;
const POLL_MAX_MS = 5000;
const POLL_LIMIT_MS = 60_000;
/** Resume requests one recovery run may send. Each replays the same saved request. */
const MAX_RESUME_POSTS = 3;
const SWAP_REGIONS = ['notices', 'summary', 'discount', 'delivery', 'gift-cards', 'tip', 'contact-extra'];

const app = {
  state: boot.state,
  /** The amount the buyer last saw next to the Pay button. */
  approved: /** @type {Money | null} */ (logic.outstandingOf(boot.state)),
  paymentState: /** @type {string} */ ('loading'),
  busy: false,
  flow: /** @type {Awaited<ReturnType<typeof createStripePayment>> | null} */ (null),
  flowKey: '',
  excludeAffirm: logic.affirmShouldBeRemoved(logic.declineCode(boot.state)),
  elementsComplete: false,
  selectedType: 'card',
  /** Pending provider action ids this page already ran, with how many times. */
  handledActions: /** @type {Map<string, number>} */ (new Map()),
  pendingActionId: '',
  generation: 0,
  verifiedEmail: '',
  quoteRetries: 0,
  autoRequoted: '',
  contactDirty: false,
  /** True while a payment is being finished and the order must not change. */
  locked: false,
  /** Message to show once an automatic re-quote finishes. */
  afterQuote: '',
};

// ----- Copy -----

/**
 * @param {string} key
 * @param {Record<string, string | number | undefined>} [params]
 */
function msg(key, params = {}) {
  const template = boot.messages[key] ?? boot.messages.generic_error ?? 'Something went wrong. Try again.';
  return template.replace(/\{(\w+)\}/g, (whole, name) => (params[name] === undefined ? whole : String(params[name])));
}

const KIND_FALLBACK = /** @type {Record<string, string>} */ ({
  rate_limited: 'rate_limited',
  auth: 'session_ended',
  unavailable: 'unavailable',
  unknown_outcome: 'unknown_outcome',
  not_found: 'not_found',
});

/** @param {JobError | undefined} error */
function errorKey(error) {
  if (!error) return 'generic_error';
  for (const candidate of [error.message_key, error.code?.toLowerCase()]) {
    if (candidate && Object.hasOwn(boot.messages, candidate)) return candidate;
  }
  if (error.code?.toLowerCase().startsWith('save_payment_method_')) return 'save_payment_method_failed';
  return (error.kind && KIND_FALLBACK[error.kind]) || 'generic_error';
}

/**
 * @param {JobError | undefined} error
 * @param {string} [fallbackKey]
 */
function errorText(error, fallbackKey) {
  let key = errorKey(error);
  if (key === 'generic_error' && fallbackKey && error?.kind !== 'bug' && error?.kind !== 'unavailable' && error?.kind !== 'rate_limited' && error?.kind !== 'auth') key = fallbackKey;
  const text = msg(key, { store: boot.store });
  return key === 'generic_error' && error?.request_id ? `${text} ${msg('reference_id', { id: error.request_id })}` : text;
}

// ----- Requests -----

/**
 * @param {'GET' | 'POST'} method
 * @param {string} suffix
 * @param {unknown} [body]
 * @returns {Promise<JobResult>}
 */
async function request(method, suffix, body) {
  try {
    /** @type {Record<string, string>} */
    const headers = { Accept: 'application/json', 'X-CSRF-Token': csrfToken() };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const response = await fetch(`/checkout/${encodeURIComponent(REF)}${suffix}`, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      credentials: 'same-origin',
    });
    const json = /** @type {any} */ (await response.json().catch(() => null));
    if (!json) {
      const kind = response.status === 429 ? 'rate_limited' : response.status === 401 ? 'auth' : response.status >= 500 ? 'unknown_outcome' : 'bug';
      return { ok: false, status: response.status, error: { kind, code: `HTTP_${response.status}` } };
    }
    if (typeof json.pending_action_id === 'string') app.pendingActionId = json.pending_action_id;
    if (json.error) return { ok: false, status: response.status, error: json.error, state: json.state, next: json.next, client_action: json.client_action };
    return { ok: response.ok, status: response.status, ...json };
  } catch {
    return { ok: false, status: 0, transport: true, error: { kind: 'unknown_outcome', code: 'NETWORK_ERROR', message_key: 'network_error' } };
  }
}

// ----- Elements of the page -----

const root = /** @type {HTMLElement} */ ($('[data-checkout]'));
const paymentSection = () => $('#payment');
const payForm = () => /** @type {HTMLFormElement | null} */ ($('#pay-form'));
const payButton = () => /** @type {HTMLButtonElement | null} */ ($('#pay-button'));
const blockerNode = () => $('#pay-blocker');
const messageNode = () => $('#payment-message');

/** @param {string} id */
function value(id) {
  const input = document.getElementById(id);
  return input instanceof HTMLInputElement ? input.value.trim() : '';
}

function contact() {
  return { name: value('contact-name'), email: value('contact-email'), phone: value('contact-phone') };
}

// ----- Payment state machine -----

const OPEN_STATES = new Set(['authenticating', 'resuming', 'waiting', 'bank_processing', 'affirm_incomplete', 'submitting']);

/**
 * @param {string} next
 * @param {{ message?: string, focus?: boolean }} [options]
 */
function setPaymentState(next, options = {}) {
  app.paymentState = next;
  const section = paymentSection();
  if (section) section.setAttribute('data-state', next);
  for (const panel of $$('[data-panel]')) panel.toggleAttribute('hidden', panel.getAttribute('data-panel') !== panelFor(next));
  const waitText = $('[data-waiting-text]');
  if (waitText) waitText.textContent = next === 'resuming' ? boot.labels.stateResuming : boot.labels.stateWaiting;
  const form = payForm();
  if (form) form.toggleAttribute('data-locked', OPEN_STATES.has(next));
  lockSections(OPEN_STATES.has(next));
  if (options.message !== undefined) showMessage(options.message, options.focus !== false);
  else if (!['declined', 'pay_remaining', 'total_changed', 'ready'].includes(next)) hideMessage();
  refreshPayControls();
}

/**
 * While a payment is being finished, the order must not change under it. The
 * app rejects cart, delivery, discount, gift card, tip, and contact changes in
 * that window, so the controls are disabled and a note says why.
 * @param {boolean} locked
 */
function lockSections(locked) {
  app.locked = locked;
  root.toggleAttribute('data-resolving', locked);
  $('[data-locked-note]')?.toggleAttribute('hidden', !locked);
  for (const control of $$('.checkout-section:not(.payment-section) :is(input, button, select, textarea)')) {
    if (!(control instanceof HTMLInputElement || control instanceof HTMLButtonElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) continue;
    if (locked && !control.disabled) {
      control.disabled = true;
      control.setAttribute('data-locked-by-payment', '');
    } else if (!locked && control.hasAttribute('data-locked-by-payment')) {
      control.disabled = false;
      control.removeAttribute('data-locked-by-payment');
    }
  }
}

/** @param {string} paymentState */
function panelFor(paymentState) {
  if (paymentState === 'affirm_incomplete') return 'affirm';
  if (paymentState === 'waiting' || paymentState === 'resuming' || paymentState === 'authenticating') return 'waiting';
  if (paymentState === 'bank_processing') return 'bank';
  return '';
}

/**
 * @param {string} text
 * @param {boolean} focus
 */
function showMessage(text, focus = true) {
  const node = messageNode();
  if (!node) return;
  node.textContent = text;
  node.hidden = !text;
  if (text && focus) focusElement(node);
}

function hideMessage() {
  const node = messageNode();
  if (!node) return;
  node.textContent = '';
  node.hidden = true;
  node.removeAttribute('data-code');
}

function needsProcessor() {
  return logic.needsProcessor(app.state);
}

function savedChoice() {
  const checked = $('[data-saved-methods] input[name="payment-source"]:checked');
  return checked instanceof HTMLInputElement && checked.value !== 'new' ? checked.value : null;
}

/** @returns {string[]} */
function currentBlockers() {
  /** @type {string[]} */
  const blockers = [];
  if (!logic.looksLikeEmail(value('contact-email'))) blockers.push('contact_email_missing');
  for (const code of logic.serverBlockers(app.state)) {
    if (code === 'attempt_open' && !OPEN_STATES.has(app.paymentState) && app.paymentState !== 'recovery') continue;
    blockers.push(code);
  }
  if (OPEN_STATES.has(app.paymentState) && !blockers.includes('attempt_open')) blockers.push('attempt_open');
  if (needsProcessor() && !savedChoice() && !app.elementsComplete && !blockers.includes('delivery_selection_missing')) blockers.push('elements_incomplete');
  const priority = ['session_not_open', 'attempt_open', 'contact_email_missing', 'delivery_selection_missing', 'delivery_input_required', 'elements_incomplete'];
  return [...new Set(blockers)].sort((a, b) => priority.indexOf(a) - priority.indexOf(b));
}

function buttonLabel() {
  const outstanding = formatMoney(logic.processorMoney(app.state));
  switch (logic.buttonKind(app.state)) {
    case 'subscription_trial':
      return boot.labels.payTrial;
    case 'subscription_paid':
      return boot.labels.paySubscription.replace('{amount}', outstanding);
    case 'confirm_order':
      return boot.labels.payConfirmOrder;
    default:
      return boot.labels.payOrder.replace('{amount}', outstanding);
  }
}

function refreshPayControls() {
  const button = payButton();
  if (!button) return;
  button.textContent = buttonLabel();
  const blockers = app.paymentState === 'loading' ? ['elements_incomplete'] : currentBlockers();
  const busy = app.paymentState === 'submitting';
  button.disabled = blockers.length > 0 || busy;
  button.setAttribute('aria-busy', busy ? 'true' : 'false');
  const note = blockerNode();
  if (note) {
    const first = blockers[0] ?? '';
    note.setAttribute('data-blocker', first);
    note.textContent = busy || app.paymentState === 'loading' ? '' : first ? msg(first) : '';
  }
  const fields = $('[data-payment-fields]');
  if (fields) fields.toggleAttribute('hidden', !needsProcessor() || savedChoice() !== null);
  const settlement = logic.isSettlementOnly(app.state);
  const settlementNote = $('[data-settlement-note]');
  if (settlementNote) {
    const giftMoney = (app.state.order.gift_cards?.length ?? 0) > 0 ? app.state.order.gift_card_estimate?.gift_card_money : null;
    settlementNote.textContent = giftMoney ? boot.labels.settlementGiftCard.replace('{gift_card_money}', formatMoney(giftMoney)) : boot.labels.settlementDiscount;
    settlementNote.toggleAttribute('hidden', !settlement);
  }
  const split = $('[data-gift-split]');
  if (split) {
    const estimate = app.state.order.gift_card_estimate;
    const show = logic.collectionKindOf(app.state) === 'processor' && (app.state.order.gift_cards?.length ?? 0) > 0 && Boolean(estimate?.can_pay);
    split.textContent = show && estimate ? boot.labels.giftCardSplit.replace('{gift_card_money}', formatMoney(estimate.gift_card_money)).replace('{processor_money}', formatMoney(estimate.processor_money)) : '';
    split.toggleAttribute('hidden', !show);
  }
  $('[data-region="saved-methods"]')?.toggleAttribute('hidden', !needsProcessor());
  paymentSection()?.setAttribute('data-collection', logic.collectionKindOf(app.state));
  const saveBlock = $('[data-save-block]');
  const card = $('#save-card');
  if (saveBlock && card instanceof HTMLInputElement) {
    const allowed = app.selectedType === 'card' && !savedChoice();
    card.disabled = !allowed;
    if (!allowed && card.checked) {
      card.checked = false;
      void app.flow?.setSaving(false);
    }
    saveBlock.toggleAttribute('hidden', savedChoice() !== null);
    $('[data-save-phone]')?.toggleAttribute('hidden', !card.checked);
  }
}

// ----- Applying server state -----

/** @param {CheckoutState} state */
function applyState(state) {
  const previous = app.state;
  app.state = state;
  const outstanding = logic.outstandingOf(state);
  const processor = logic.processorMoney(state);
  if (!sameMoney(processor, logic.processorMoney(previous))) app.flow?.updateAmount(processor);
  app.approved = outstanding;
  const section = paymentSection();
  if (section) section.setAttribute('data-kind', state.kind);
  // When nothing is left for a processor, drop the card form so no entered card is carried over.
  if (!needsProcessor() && app.flow) {
    app.flow.destroy();
    app.flow = null;
    app.flowKey = '';
    app.elementsComplete = false;
    $('#payment-element')?.replaceChildren();
    $('#express-checkout')?.replaceChildren();
    $('#affirm-messaging')?.replaceChildren();
    const card = $('#save-card');
    if (card instanceof HTMLInputElement) card.checked = false;
  }
  refreshPayControls();
  // Removing a gift card can bring the card form back after a settlement-only load.
  if (needsProcessor() && !app.flow && app.paymentState !== 'loading' && !OPEN_STATES.has(app.paymentState)) void mountPayment();
}

/**
 * Replaces the server-rendered regions with the latest page. The payment form
 * and the contact inputs stay in place so typing and Stripe Elements survive.
 * @param {{ focusRegion?: string }} [options]
 */
async function refreshRegions(options = {}) {
  let response;
  try {
    response = await fetch(`/checkout/${encodeURIComponent(REF)}`, { headers: { Accept: 'text/html' }, credentials: 'same-origin' });
  } catch {
    return false;
  }
  if (response.redirected && /\/complete\/?$/.test(new URL(response.url).pathname)) {
    window.location.assign(response.url);
    return true;
  }
  if (!response.ok) return false;
  const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
  const bootNext = doc.getElementById('checkout-bootstrap');
  if (!bootNext) return false;
  /** @type {{ state: CheckoutState }} */
  const next = JSON.parse(bootNext.textContent ?? '{}');
  for (const name of SWAP_REGIONS) {
    const incoming = doc.querySelector(`[data-region="${name}"]`);
    const current = document.querySelector(`[data-region="${name}"]`);
    if (!incoming || !current) {
      if (incoming && !current && name !== 'contact-extra') window.location.reload();
      continue;
    }
    const hadFocus = current.contains(document.activeElement);
    const keepEditing = name === 'delivery' && deliveryEditing(current);
    if (keepEditing && incoming.getAttribute('data-state') === 'idle') continue;
    current.replaceWith(document.importNode(incoming, true));
    if (hadFocus && options.focusRegion !== name) {
      const heading = $(`[data-region="${name}"] h2`);
      if (heading instanceof HTMLElement) focusElement(heading);
    }
  }
  if (options.focusRegion) {
    const target = $(`[data-region="${options.focusRegion}"] [data-autofocus], [data-region="${options.focusRegion}"] h2`);
    if (target instanceof HTMLElement) focusElement(target);
  }
  syncSummaryPanel();
  applyState(next.state);
  wireRegions();
  announce(`${boot.labels.amountDue} ${formatMoney(logic.outstandingOf(app.state))}`);
  maybeAutoRequote();
  return true;
}

/** @param {Element} region */
function deliveryEditing(region) {
  return region.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement;
}

function syncSummaryPanel() {
  const panel = $('[data-summary]');
  if (!(panel instanceof HTMLDetailsElement)) return;
  panel.open = window.matchMedia('(min-width: 1024px)').matches || panel.hasAttribute('data-user-open');
}

// ----- Generic job forms -----

/** @type {Record<string, (form: HTMLFormElement) => unknown>} */
const bodies = {
  contact: () => {
    const c = contact();
    return { name: c.name || undefined, email: c.email || undefined, phone: c.phone || undefined };
  },
  discount: (form) => ({ promotion_code: field(form, 'promotion_code') }),
  'discount-remove': (form) => ({ order_discount_ids: [field(form, 'order_discount_id')] }),
  'delivery-quote': (form) => ({
    destination_address: {
      line1: field(form, 'line1'),
      ...(field(form, 'line2') ? { line2: field(form, 'line2') } : {}),
      city: field(form, 'city'),
      state: field(form, 'state').toUpperCase(),
      postal_code: field(form, 'postal_code'),
      country: field(form, 'country') || 'US',
    },
  }),
  'pickup-locations': (form) => ({ postal_code: field(form, 'postal_code'), country: 'US' }),
  'delivery-select': (form) => {
    const mode = $('[data-delivery-modes] input:checked');
    const shipping = !(mode instanceof HTMLInputElement) || mode.value !== 'pickup';
    const c = contact();
    const name = shipping ? value('ship-name') || c.name : c.name;
    return {
      choices: $$('input[type="radio"]:checked', form).map((input) => ({
        delivery_choice_group_id: input.getAttribute('data-group-id') ?? '',
        delivery_option_id: /** @type {HTMLInputElement} */ (input).value,
      })),
      recipient: { name, ...(c.email ? { email: c.email } : {}), ...(c.phone ? { phone: c.phone } : {}) },
    };
  },
  'gift-card': (form) => ({ gift_card_code: field(form, 'gift_card_code') }),
  'gift-card-remove': () => ({}),
  tip: (form) => {
    const choice = $('input[name="tip"]:checked', form);
    const selected = choice instanceof HTMLInputElement ? choice.value : 'none';
    if (selected === 'none') return { clear: true };
    if (selected === 'custom') return { amount: field(form, 'amount') };
    return { percent: Number(selected) };
  },
  'verification-confirm': (form) => ({ code: field(form, 'code') }),
};

/** @type {Record<string, string>} */
const paths = {
  contact: '/contact',
  discount: '/discount',
  'discount-remove': '/discount/remove',
  'delivery-quote': '/delivery/quote',
  'pickup-locations': '/pickup-locations',
  'delivery-select': '/delivery/select',
  'gift-card': '/gift-card',
  tip: '/tip',
  'verification-confirm': '/verification/confirm',
};

/** @type {Record<string, string>} */
const errorTargets = {
  discount: 'discount',
  'discount-remove': 'discount',
  'delivery-quote': 'delivery',
  'pickup-locations': 'delivery',
  'delivery-select': 'delivery',
  'gift-card': 'gift-card',
  'gift-card-remove': 'gift-card',
  tip: 'tip',
  'verification-confirm': 'verification',
};

/** @type {Record<string, string>} */
const fallbackKeys = {
  discount: 'discount_invalid',
  'discount-remove': 'discount_invalid',
  'gift-card': 'gift_card_unavailable',
  'delivery-quote': 'delivery_service_unavailable',
  'pickup-locations': 'delivery_service_unavailable',
  'delivery-select': 'delivery_service_unavailable',
  tip: 'tip_invalid',
  'verification-confirm': 'returning_code_invalid',
};

/**
 * @param {HTMLFormElement} form
 * @param {string} name
 */
function field(form, name) {
  const input = form.elements.namedItem(name);
  return input instanceof HTMLInputElement ? input.value.trim() : '';
}

/**
 * @param {string} target
 * @param {string} text
 */
function showJobError(target, text) {
  const node = $(`[data-job-error="${target}"]`);
  if (node) {
    node.textContent = text;
    node.toggleAttribute('hidden', !text);
  } else if (text) {
    showMessage(text, false);
  }
}

/**
 * @param {string} kind
 * @param {HTMLFormElement} form
 */
function validateJobForm(kind, form) {
  if (kind === 'discount' && !field(form, 'promotion_code')) return msg('discount_required');
  if (kind === 'gift-card' && !field(form, 'gift_card_code')) return msg('gift_card_required');
  if (kind === 'delivery-quote') {
    for (const name of ['line1', 'city', 'state', 'postal_code']) if (!field(form, name)) return msg('delivery_address_incomplete');
    if (!/^\d{5}(-\d{4})?$/.test(field(form, 'postal_code'))) return msg('delivery_postal_code_required');
  }
  if (kind === 'pickup-locations' && !/^\d{5}(-\d{4})?$/.test(field(form, 'postal_code'))) return msg('delivery_postal_code_required');
  if (kind === 'delivery-select') {
    const groups = new Set($$('fieldset[data-group-id]', form).map((set) => set.getAttribute('data-group-id')));
    const chosen = new Set($$('input[type="radio"]:checked', form).map((input) => input.getAttribute('data-group-id')));
    if (chosen.size < groups.size || chosen.size === 0) return msg('delivery_choice_required');
  }
  if (kind === 'tip') {
    const choice = $('input[name="tip"]:checked', form);
    if (choice instanceof HTMLInputElement && choice.value === 'custom' && !/^\d+(\.\d{1,2})?$/.test(field(form, 'amount'))) return msg('tip_invalid');
  }
  if (kind === 'verification-confirm' && !/^\d{6}$/.test(field(form, 'code'))) return msg('code_required');
  return '';
}

/** @param {SubmitEvent} event */
async function onJobSubmit(event) {
  const target = event.target;
  if (!(target instanceof HTMLFormElement)) return;
  const kind = target.getAttribute('data-job-form');
  if (!kind) return;
  event.preventDefault();
  if (app.locked) {
    // The order is frozen while a payment finishes. Nothing is sent.
    showJobError(errorTargets[kind] ?? 'payment', msg('sections_locked'));
    return;
  }
  if (kind === 'contact') {
    await saveContact();
    return;
  }
  const problem = validateJobForm(kind, target);
  const errorTarget = errorTargets[kind] ?? 'payment';
  if (problem) {
    showJobError(errorTarget, problem);
    const first = $('input:not([type="hidden"]):not([type="radio"])', target);
    if (first instanceof HTMLElement && problem) first.setAttribute('aria-invalid', 'true');
    return;
  }
  showJobError(errorTarget, '');
  const button = /** @type {HTMLElement | null} */ ($('button[type="submit"]', target));
  const path = kind === 'gift-card-remove' ? `/gift-card/${encodeURIComponent(target.action.split('/gift-card/')[1]?.split('/')[0] ?? '')}/remove` : paths[kind];
  if (!path) return;
  setBusy(button, true);
  if (button instanceof HTMLButtonElement) button.disabled = true;
  const body = bodies[kind]?.(target) ?? {};
  const result = await request('POST', path, body);
  setBusy(button, false);
  if (button instanceof HTMLButtonElement) button.disabled = false;
  if (!result.ok) {
    await onJobError(kind, result, target);
    return;
  }
  app.quoteRetries = 0;
  if (kind === 'gift-card') {
    const input = target.elements.namedItem('gift_card_code');
    if (input instanceof HTMLInputElement) input.value = '';
  }
  await refreshRegions({ focusRegion: focusAfter(kind) });
  if (app.afterQuote && (kind === 'delivery-quote' || kind === 'pickup-locations')) {
    showJobError('delivery', app.afterQuote);
    app.afterQuote = '';
  }
  if (kind === 'verification-confirm') await loadSavedMethods();
}

/** @param {string} kind */
function focusAfter(kind) {
  if (kind.startsWith('delivery') || kind === 'pickup-locations') return 'delivery';
  if (kind.startsWith('discount')) return 'discount';
  if (kind.startsWith('gift-card')) return 'gift-cards';
  if (kind === 'tip') return 'tip';
  return undefined;
}

/**
 * @param {string} kind
 * @param {JobResult} result
 * @param {HTMLFormElement} form
 */
async function onJobError(kind, result, form) {
  const code = result.error?.code ?? '';
  const target = errorTargets[kind] ?? 'payment';
  if (result.state) applyState(result.state);
  if (kind === 'gift-card' && result.error?.kind === 'conflict' && errorKey(result.error) === 'generic_error') {
    showJobError(target, msg('gift_card_apply_again'));
    await refreshRegions();
    return;
  }
  if (kind === 'delivery-select' && (code === 'DELIVERY_QUOTE_EXPIRED' || code === 'DELIVERY_QUOTE_STALE' || code === 'DELIVERY_SELECTION_CHANGED')) {
    app.afterQuote = msg('delivery_prices_changed');
    showJobError(target, app.afterQuote);
    await requoteLastAddress();
    return;
  }
  if ((kind === 'delivery-quote' || kind === 'pickup-locations') && code === 'DELIVERY_SERVICE_UNAVAILABLE' && app.quoteRetries < 1) {
    app.quoteRetries += 1;
    showJobError(target, msg('delivery_service_unavailable'));
    await new Promise((resolve) => window.setTimeout(resolve, 2000));
    form.requestSubmit();
    return;
  }
  showJobError(target, errorText(result.error, fallbackKeys[kind]));
}

// ----- Contact -----

async function saveContact() {
  if (!app.contactDirty && app.state.order.buyer_contact?.email) return;
  const c = contact();
  if (c.email && !logic.looksLikeEmail(c.email)) return;
  const result = await request('POST', '/contact', { name: c.name || undefined, email: c.email || undefined, phone: c.phone || undefined });
  if (result.ok) {
    app.contactDirty = false;
    if (result.state) app.state = { ...result.state };
  }
  refreshPayControls();
  maybeStartVerification(c.email);
}

/** @param {string} email */
function maybeStartVerification(email) {
  if (!app.state.session.save_payment_method_requires_verification) return;
  if (!logic.looksLikeEmail(email) || app.verifiedEmail === email.toLowerCase()) return;
  app.verifiedEmail = email.toLowerCase();
  void request('POST', '/verification', { purpose: 'use_saved_payment_methods', channel: 'auto', email }).then((result) => {
    if (result.ok) void refreshRegions();
    // CUSTOMER_VERIFICATION_NOT_SENT and other failures show nothing: this never holds payment.
  });
}

function wireContact() {
  for (const id of ['contact-name', 'contact-email', 'contact-phone']) {
    const input = document.getElementById(id);
    if (!(input instanceof HTMLInputElement) || input.dataset.wired) continue;
    input.dataset.wired = 'true';
    input.addEventListener('input', () => {
      app.contactDirty = true;
      refreshPayControls();
    });
    input.addEventListener('blur', () => {
      if (id === 'contact-email' && input.value && !logic.looksLikeEmail(input.value)) {
        input.setAttribute('aria-invalid', 'true');
        return;
      }
      input.removeAttribute('aria-invalid');
      void saveContact();
    });
  }
}

// ----- Region wiring (re-run after every swap) -----

function wireRegions() {
  wireContact();
  for (const radio of $$('[data-delivery-modes] input[name="delivery-mode"]')) {
    if (!(radio instanceof HTMLInputElement) || radio.dataset.wired) continue;
    radio.dataset.wired = 'true';
    radio.addEventListener('change', () => {
      const mode = radio.value;
      $('[data-region="delivery"]')?.setAttribute('data-mode', mode);
      for (const panel of $$('[data-delivery-panel]')) panel.toggleAttribute('hidden', panel.getAttribute('data-delivery-panel') !== mode);
    });
  }
  for (const button of $$('[data-delivery-change]')) {
    if (!(button instanceof HTMLButtonElement) || button.dataset.wired) continue;
    button.dataset.wired = 'true';
    button.addEventListener('click', () => {
      const edit = document.getElementById('delivery-edit');
      if (!edit) return;
      const open = edit.hasAttribute('hidden');
      edit.toggleAttribute('hidden', !open);
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) $('input:not([type="hidden"])', edit)?.focus();
    });
  }
  for (const form of $$('form[data-job-form="delivery-select"]')) {
    if (!(form instanceof HTMLFormElement) || form.dataset.wired) continue;
    form.dataset.wired = 'true';
    const groups = new Set($$('fieldset[data-group-id]', form).map((set) => set.getAttribute('data-group-id')));
    form.addEventListener('click', (event) => {
      const input = event.target;
      // A pointer click on the only choice group submits. Arrow keys only move the selection.
      if (!form.hasAttribute('data-no-autosubmit') && groups.size === 1 && input instanceof HTMLInputElement && input.type === 'radio' && event.detail > 0) form.requestSubmit();
    });
  }
  for (const link of $$('[data-focus-phone]')) {
    if (!(link instanceof HTMLAnchorElement) || link.dataset.wired) continue;
    link.dataset.wired = 'true';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      document.getElementById('contact-phone')?.focus();
    });
  }
  const tip = $('form[data-job-form="tip"]');
  if (tip instanceof HTMLFormElement && !tip.dataset.wired) {
    tip.dataset.wired = 'true';
    tip.addEventListener('click', (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.name !== 'tip') return;
      $('[data-tip-custom]', tip)?.toggleAttribute('hidden', input.value !== 'custom');
      if (input.value === 'custom') document.getElementById('tip-custom')?.focus();
      else if (event.detail > 0) tip.requestSubmit();
    });
  }
  for (const button of $$('[data-returning-skip]')) {
    if (!(button instanceof HTMLButtonElement) || button.dataset.wired) continue;
    button.dataset.wired = 'true';
    button.addEventListener('click', () => {
      $('[data-region="contact-extra"]')?.replaceChildren();
      document.getElementById('contact-email')?.focus();
    });
  }
  for (const button of $$('[data-returning-email]')) {
    if (!(button instanceof HTMLButtonElement) || button.dataset.wired) continue;
    button.dataset.wired = 'true';
    button.addEventListener('click', async () => {
      setBusy(button, true);
      const result = await request('POST', '/verification', { purpose: 'use_saved_payment_methods', channel: 'email', email: value('contact-email') });
      setBusy(button, false);
      if (result.ok) await refreshRegions();
      else showJobError('verification', errorText(result.error, 'customer_verification_unavailable'));
    });
  }
  for (const radio of $$('[data-saved-methods] input[name="payment-source"]')) {
    if (!(radio instanceof HTMLInputElement) || radio.dataset.wired) continue;
    radio.dataset.wired = 'true';
    radio.addEventListener('change', refreshPayControls);
  }
}

// ----- Saved payment methods -----

/**
 * @param {string} tag
 * @param {Record<string, string>} [attrs]
 * @param {...(Node | string)} children
 */
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, attr] of Object.entries(attrs)) node.setAttribute(name, attr);
  node.append(...children);
  return node;
}

/** @param {{ payment_method_id: string, card?: { brand: string, exp_month: number, exp_year: number, last4: string } | null }[]} methods */
function renderSavedMethods(methods) {
  const region = $('[data-region="saved-methods"]');
  if (!region) return;
  const cards = methods.filter((method) => method.card);
  region.replaceChildren();
  if (!cards.length) return;
  const fieldset = h('fieldset', { class: 'choice-group', 'data-saved-methods': '' }, h('legend', {}, boot.labels.savedLegend));
  cards.forEach((method, index) => {
    const card = /** @type {NonNullable<typeof method.card>} */ (method.card);
    const label = boot.labels.savedMethod
      .replace('{brand}', card.brand.charAt(0).toUpperCase() + card.brand.slice(1))
      .replace('{last4}', card.last4)
      .replace('{month}', String(card.exp_month).padStart(2, '0'))
      .replace('{year}', String(card.exp_year).slice(-2));
    const input = h('input', { type: 'radio', name: 'payment-source', value: method.payment_method_id, 'data-testid': `sf-saved-method-${index}` });
    if (index === 0) input.setAttribute('checked', '');
    fieldset.append(h('label', { class: 'choice' }, input, h('span', {}, label)));
  });
  fieldset.append(h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'payment-source', value: 'new', 'data-testid': 'sf-use-new-method' }), h('span', {}, boot.labels.useNewMethod)));
  region.append(fieldset);
  const first = $('input[checked]', fieldset);
  if (first instanceof HTMLInputElement) first.checked = true;
  wireRegions();
  refreshPayControls();
}

/** Saved cards are listed for a signed-in buyer whose order is bound to a customer, and after a confirmed code. */
async function loadSavedMethods() {
  if (app.state.kind !== 'order') return;
  const result = await request('GET', '/saved-methods');
  const methods = /** @type {any} */ (result.state)?.saved_methods;
  if (result.ok && Array.isArray(methods)) renderSavedMethods(methods);
}

async function requoteLastAddress() {
  const pickup = $('[data-region="delivery"]')?.getAttribute('data-mode') === 'pickup';
  const form = $(pickup ? 'form[data-job-form="pickup-locations"]' : 'form[data-job-form="delivery-quote"]');
  if (form instanceof HTMLFormElement) {
    form.requestSubmit();
    return;
  }
  await refreshRegions();
}

function maybeAutoRequote() {
  const section = $('[data-region="delivery"]');
  if (!section || section.getAttribute('data-auto-requote') !== 'true') return;
  const key = section.querySelector('[data-testid="sf-delivery-selected"]')?.getAttribute('data-selection-id') ?? 'none';
  if (app.autoRequoted === key) return;
  app.autoRequoted = key;
  const pickup = section.getAttribute('data-mode') === 'pickup';
  const form = $(pickup ? 'form[data-job-form="pickup-locations"]' : 'form[data-job-form="delivery-quote"]', section);
  const required = pickup ? ['postal_code'] : ['line1', 'city', 'postal_code'];
  if (form instanceof HTMLFormElement && required.every((name) => field(form, name))) form.requestSubmit();
}

// ----- Payment flow -----

function shippingForAffirm() {
  const selection = app.state.delivery_selection;
  const address = selection?.destination_address;
  if (!address || !selection) return null;
  const name = selection.recipient?.name || value('contact-name');
  return {
    name,
    address: { line1: address.line1, line2: address.line2, city: address.city, state: address.state, postal_code: address.postal_code, country: address.country ?? 'US' },
  };
}

async function mountPayment() {
  const guidanceSource = logic.guidanceOf(app.state)?.stripe;
  const paymentNode = document.getElementById('payment-element');
  if (!needsProcessor() || !guidanceSource || !paymentNode) {
    setPaymentState(logic.derivePaymentState(app.state) === 'ready' ? 'ready' : logic.derivePaymentState(app.state));
    return;
  }
  const key = JSON.stringify([guidanceSource.publishable_key, guidanceSource.account_id, guidanceSource.elements?.mode, guidanceSource.elements?.payment_method_types, app.excludeAffirm]);
  if (app.flow && app.flowKey === key) return;
  app.flow?.destroy();
  app.flow = null;
  paymentNode.replaceChildren();
  $('#express-checkout')?.replaceChildren();
  $('#affirm-messaging')?.replaceChildren();
  setPaymentState('loading');
  try {
    app.flow = await createStripePayment({
      guidance: guidanceSource,
      kind: app.state.kind,
      saveOffered: Boolean($('#save-card')),
      excludeAffirm: app.excludeAffirm,
      amount: logic.processorMoney(app.state),
      mounts: {
        payment: paymentNode,
        wallets: document.getElementById('express-checkout'),
        walletsRegion: document.getElementById('wallets'),
        messaging: document.getElementById('affirm-messaging'),
      },
      onChange: ({ complete, type }) => {
        app.elementsComplete = complete;
        app.selectedType = type;
        refreshPayControls();
      },
      onReady: () => {
        $('[data-skeleton]')?.setAttribute('hidden', '');
        if (app.paymentState === 'loading') setPaymentState(initialRestingState());
      },
      onWalletClick: () => {
        const blockers = currentBlockers().filter((code) => code !== 'elements_incomplete');
        if (blockers.length) {
          showMessage(msg(blockers[0]), true);
          return false;
        }
        return true;
      },
      onWalletConfirm: async (event, makeCredential) => {
        const made = await makeCredential();
        if (made.error || !made.credential) {
          event.paymentFailed?.({ reason: 'fail' });
          showMessage(made.error?.message || msg('stripe_error_generic'), true);
          return;
        }
        const ok = await payWith(made.credential);
        if (!ok) event.paymentFailed?.({ reason: 'fail' });
      },
      getBilling: () => ({ name: value('contact-name'), email: value('contact-email') }),
      getShipping: shippingForAffirm,
    });
    app.flowKey = key;
  } catch (error) {
    const missing = error instanceof Error && error.message === 'stripe_not_loaded';
    setPaymentState('unavailable', { message: missing ? msg('stripe_not_loaded') : msg('payments_unavailable', { store: boot.store }) });
  }
}

/** @returns {string} */
function initialRestingState() {
  const derived = logic.derivePaymentState(app.state);
  return derived === 'ready' || derived === 'declined' || derived === 'pay_remaining' ? derived : 'ready';
}

/**
 * Credential from saved list, form, or none for settlement-only orders.
 * @returns {Promise<{ credential?: { kind: string, value: string }, error?: { message?: string } }>}
 */
async function collectCredential() {
  if (!needsProcessor()) return {};
  const saved = savedChoice();
  if (saved) return { credential: { kind: 'saved_payment_method', value: saved } };
  if (!app.flow) return { error: { message: msg('payments_unavailable', { store: boot.store }) } };
  return app.flow.createCredential();
}

/**
 * @param {{ kind: string, value: string } | null} credential
 * @returns {Promise<boolean>} true when the job was accepted
 */
async function payWith(credential) {
  const c = contact();
  const order = app.state.order;
  const giftCards = (order.gift_cards?.length ?? 0) > 0;
  const body = {
    ...(credential ? { credential } : {}),
    approved_outstanding_money: app.approved,
    approved_collection_kind: logic.collectionKindOf(app.state),
    ...(giftCards && order.order_revision !== undefined ? { approved_order_revision: String(order.order_revision) } : {}),
    ...(giftCards && order.gift_card_estimate?.gift_card_money ? { approved_gift_card_money: order.gift_card_estimate.gift_card_money } : {}),
    buyer_contact: { email: c.email, ...(c.phone ? { phone: c.phone } : {}) },
    ...(($('#save-card') instanceof HTMLInputElement && /** @type {HTMLInputElement} */ ($('#save-card')).checked && !/** @type {HTMLInputElement} */ ($('#save-card')).disabled)
      ? { save_payment_method: true, ...(value('save-phone') ? { save_payment_method_phone: value('save-phone') } : {}) }
      : {}),
  };
  const result = await request('POST', '/pay', body);
  return handlePayResult(result);
}

/** @param {Event} event */
async function onPay(event) {
  event.preventDefault();
  if (app.busy) return;
  const blockers = currentBlockers();
  if (blockers.length) {
    refreshPayControls();
    return;
  }
  app.busy = true;
  setPaymentState('submitting', { message: '' });
  try {
    await saveContactIfDirty();
    const collected = await collectCredential();
    if (collected.error) {
      setPaymentState('ready', { message: collected.error.message || msg('stripe_error_generic') });
      return;
    }
    await payWith(collected.credential ?? null);
  } finally {
    app.busy = false;
  }
}

async function saveContactIfDirty() {
  if (app.contactDirty) await saveContact();
}

/**
 * @param {JobResult} result
 * @returns {Promise<boolean>}
 */
async function handlePayResult(result) {
  if (!result.ok) return handlePayError(result);
  if (result.state) applyState(result.state);
  await advance(result.next ?? logic.derivePaymentState(app.state), result.client_action);
  return true;
}

/**
 * @param {JobResult} result
 * @returns {Promise<boolean>}
 */
async function handlePayError(result) {
  const error = result.error;
  const code = error?.code ?? '';
  if (result.state) applyState(result.state);
  if (isUncertain(result)) {
    showMessage(msg('finishing_payment'), false);
    // The app may already hold a saved request to replay, so ask what to do next instead of assuming a read.
    await recoverOutcome(result.next === 'resume' || result.state?.next === 'resume' ? 'resume' : 'read');
    return true;
  }
  switch (code) {
    case 'ORDER_CHANGED_REFRESH_REQUIRED':
    case 'EXPECTED_AMOUNT_REQUIRED': {
      await refreshRegions();
      app.approved = logic.outstandingOf(app.state);
      app.flow?.updateAmount(logic.processorMoney(app.state));
      const giftChanged = error?.message_key === 'gift_card_changed' || error?.message_key === 'gift_card_allocation_changed';
      setPaymentState('total_changed', { message: giftChanged ? msg('gift_card_changed') : msg('total_changed', { amount: formatMoney(app.approved) }) });
      return false;
    }
    case 'FULFILLMENT_SELECTION_REQUIRED':
    case 'DELIVERY_RECIPIENT_REQUIRED': {
      await refreshRegions({ focusRegion: 'delivery' });
      document.getElementById('delivery-edit')?.removeAttribute('hidden');
      setPaymentState('ready', { message: msg('delivery_selection_required'), focus: false });
      return false;
    }
    case 'ORDER_PAYMENT_ATTEMPT_ACTIVE':
    case 'PAYMENT_ATTEMPT_NOT_RESUMABLE': {
      const read = await request('GET', '/attempt');
      if (read.ok) {
        if (read.state) applyState(read.state);
        await advance(read.next ?? 'wait', read.client_action);
        return true;
      }
      break;
    }
    case 'CHECKOUT_RECOVERY_RESTRICTED':
      setPaymentState('recovery', { message: msg('finishing_payment') });
      await recover();
      return true;
    case 'INVALID_CHECKOUT_SESSION':
    case 'CHECKOUT_SESSION_NOT_OPEN':
      // The page route bootstraps a replacement session or renders the expired state.
      window.location.reload();
      return false;
    case 'PAYMENT_SOURCE_UNAVAILABLE':
      app.flow?.clearPayment();
      break;
    default:
      break;
  }
  if (code.startsWith('SAVE_PAYMENT_METHOD_')) {
    const card = $('#save-card');
    if (card instanceof HTMLInputElement) card.checked = false;
    await app.flow?.setSaving(false);
  }
  if (code === 'PAYMENT_ACTION_WINDOW_TOO_SHORT' || code === 'PAYMENT_METHOD_DECLINED') {
    app.excludeAffirm = code === 'PAYMENT_METHOD_DECLINED';
  }
  setPaymentState('ready', { message: errorText(error) });
  return false;
}

/**
 * @param {string} next
 * @param {any} clientAction
 */
async function advance(next, clientAction) {
  switch (next) {
    case 'done':
      setPaymentState('succeeded');
      window.location.assign(`/checkout/${encodeURIComponent(REF)}/complete`);
      return;
    case 'bank_processing':
      setPaymentState('bank_processing');
      window.location.assign(`/checkout/${encodeURIComponent(REF)}/complete`);
      return;
    case 'authenticate':
      await authenticate(clientAction);
      return;
    case 'resume':
      await recoverOutcome('resume');
      return;
    case 'wait':
      await recoverOutcome('read');
      return;
    case 'pay_remaining':
      app.flow?.clearPayment();
      setPaymentState('pay_remaining', {
        message: msg('pay_remaining', { paid: formatMoney(app.state.order.settlement_amounts?.paid_money), remaining: formatMoney(logic.outstandingOf(app.state)) }),
      });
      return;
    case 'new_payment': {
      const code = logic.declineCode(app.state);
      app.flow?.clearPayment();
      if (logic.affirmShouldBeRemoved(code)) app.excludeAffirm = true;
      // A page that opened straight into recovery has no card form yet. Mount it before offering a new payment.
      await mountPayment();
      messageNode()?.setAttribute('data-code', code ?? '');
      setPaymentState('declined', { message: declineText(code) });
      return;
    }
    default:
      setPaymentState('unavailable', { message: msg('bug_checkout', { store: boot.store }) });
  }
}

/** @param {string | null} code */
function declineText(code) {
  const key = (code ?? '').toLowerCase();
  const known = [
    'incorrect_cvc', 'expired_card', 'payment_method_unavailable', 'processing_error', 'payment_method_temporarily_unavailable',
    'authentication_required', 'payment_not_completed', 'payment_action_expired', 'payment_method_declined', 'bank_account_closed',
    'bank_account_not_found', 'bank_debit_not_authorized', 'bank_account_restricted', 'bank_debit_limit_exceeded',
  ];
  return msg(known.includes(key) ? key : 'decline_default');
}

/** @param {any} clientAction */
async function authenticate(clientAction) {
  setPaymentState('authenticating', { message: '' });
  let action = clientAction;
  if (!action) {
    const read = await request('GET', '/attempt');
    if (!read.ok) {
      await recoverOutcome('read');
      return;
    }
    if (read.state) applyState(read.state);
    if (read.next !== 'authenticate') {
      await advance(read.next ?? 'wait', undefined);
      return;
    }
    action = read.client_action;
  }
  const dedupeKey = app.pendingActionId || app.state.attempt?.pending_actions?.[0]?.pending_action_id || '';
  const seen = dedupeKey ? (app.handledActions.get(dedupeKey) ?? 0) : 0;
  if (seen > 0) {
    // This action already ran in this page. Ask Flint once more, then wait for the real outcome.
    if (seen === 1) {
      app.handledActions.set(dedupeKey, 2);
      await recoverOutcome('resume');
    } else {
      await recoverOutcome('read');
    }
    return;
  }
  if (dedupeKey) app.handledActions.set(dedupeKey, 1);
  if (!action || !app.flow) {
    if (!app.flow) await mountPayment();
  }
  if (!action || !app.flow) {
    await recoverOutcome('read');
    return;
  }
  await app.flow.handleNextAction(action);
  // Resume whether or not the provider call returned an error: Flint decides the outcome.
  await recoverOutcome('resume');
}

/**
 * True when the answer does not tell us the outcome: a lost response, a server
 * still working, or an idempotent job already in progress.
 * @param {JobResult} result
 */
function isUncertain(result) {
  const code = result.error?.code ?? '';
  return Boolean(result.transport) || result.error?.kind === 'unknown_outcome' || code === 'IDEMPOTENCY_KEY_IN_PROGRESS' || code === 'PAYMENT_ATTEMPT_STILL_PROCESSING';
}

/**
 * The one recovery loop for a payment whose outcome is not known yet.
 *
 * `resume` means the app holds an unresolved payment request (even with no
 * attempt yet) or Flint exposes a resumable attempt. The loop then sends
 * `POST /resume` with an empty body. The app replays its saved original request
 * and key. This page never builds a new credential or approval for recovery, so
 * a retry cannot create a second charge.
 *
 * `wait` means a known open attempt that nothing can resume. The loop reads it
 * with `GET /attempt`, which never changes anything.
 *
 * Both are bounded: at most MAX_RESUME_POSTS resume requests and POLL_LIMIT_MS
 * of waiting per run, with backoff between steps. When the budget runs out the
 * buyer sees "still confirming" and a Check again button. Check again starts a
 * new bounded run. There is no direct resume -> resume recursion.
 *
 * @param {'resume' | 'read'} first
 */
async function recoverOutcome(first) {
  const generation = ++app.generation;
  const check = $('[data-check-again]');
  check?.setAttribute('hidden', '');
  const started = Date.now();
  let delay = POLL_START_MS;
  let posts = 0;
  /** @type {'resume' | 'read'} */
  let step = first;
  while (generation === app.generation) {
    /** @type {JobResult} */
    let result;
    if (step === 'resume') {
      posts += 1;
      setPaymentState('resuming', { message: '' });
      result = await request('POST', '/resume', {});
    } else {
      setPaymentState('waiting', { message: '' });
      result = await request('GET', '/attempt');
    }
    if (generation !== app.generation) return;
    if (result.ok) {
      if (result.state) applyState(result.state);
      const next = result.next ?? 'wait';
      if (next !== 'resume' && next !== 'wait') {
        await advance(next, result.client_action);
        return;
      }
      step = next === 'resume' ? 'resume' : 'read';
    } else if (!isUncertain(result)) {
      await handlePayError(result);
      return;
    }
    const spent = Date.now() - started >= POLL_LIMIT_MS;
    // A resume that keeps answering resume will not change by reading, so stop sending after the cap.
    const capped = step === 'resume' && posts >= MAX_RESUME_POSTS;
    if (spent || capped) {
      setPaymentState('waiting', { message: msg('still_confirming'), focus: false });
      check?.removeAttribute('hidden');
      announce(msg('still_confirming'));
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, delay));
    delay = Math.min(POLL_MAX_MS, Math.round(delay * 1.5));
  }
}

/** Starts a bounded run from what the app last said should happen next. */
function checkAgain() {
  return recoverOutcome(app.state.next === 'resume' ? 'resume' : 'read');
}

async function recover() {
  await recoverOutcome('read');
}

// ----- Affirm incomplete -----

async function continueAffirm() {
  const read = await request('GET', '/attempt');
  if (!read.ok) {
    showMessage(errorText(read.error), true);
    return;
  }
  if (read.state) applyState(read.state);
  if (read.next === 'authenticate') {
    app.handledActions.clear();
    if (!app.flow) await mountPayment();
    await authenticate(read.client_action);
  } else {
    await advance(read.next ?? 'wait', read.client_action);
  }
}

async function cancelAttemptAndPayAnotherWay() {
  const result = await request('POST', '/cancel-attempt', {});
  if (!result.ok) {
    showMessage(errorText(result.error), true);
    return;
  }
  app.excludeAffirm = false;
  if (result.state) applyState(result.state);
  await refreshRegions();
  await mountPayment();
  setPaymentState('ready', { message: '', focus: false });
  focusElement(document.getElementById('payment-title'));
}

// ----- Boot -----

function wireStatic() {
  const form = payForm();
  form?.addEventListener('submit', onPay);
  document.addEventListener('submit', onJobSubmit);
  const card = $('#save-card');
  card?.addEventListener('change', async () => {
    if (card instanceof HTMLInputElement) {
      $('[data-save-phone]')?.toggleAttribute('hidden', !card.checked);
      refreshPayControls();
      await app.flow?.setSaving(card.checked);
    }
  });
  $('[data-check-again]')?.addEventListener('click', () => void checkAgain());
  $('[data-affirm-continue]')?.addEventListener('click', () => void continueAffirm());
  const dialog = document.getElementById('affirm-dialog');
  const another = $('[data-pay-another-way]');
  if (dialog instanceof HTMLDialogElement && another instanceof HTMLElement) {
    another.addEventListener('click', () => dialog.showModal());
    dialog.addEventListener('close', () => {
      if (dialog.returnValue === 'confirm') void cancelAttemptAndPayAnotherWay();
      else another.focus();
    });
  } else {
    another?.addEventListener('click', () => void cancelAttemptAndPayAnotherWay());
  }
  const panel = $('[data-summary]');
  if (panel instanceof HTMLDetailsElement) {
    panel.addEventListener('toggle', () => {
      if (!window.matchMedia('(min-width: 1024px)').matches) panel.toggleAttribute('data-user-open', panel.open);
    });
  }
  window.matchMedia('(min-width: 1024px)').addEventListener('change', syncSummaryPanel);
}

async function start() {
  root.setAttribute('data-js', 'ready');
  syncSummaryPanel();
  wireStatic();
  wireRegions();
  void request('POST', '/timezone', { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const resting = logic.derivePaymentState(app.state);
  switch (resting) {
    case 'ready':
    case 'declined':
    case 'pay_remaining': {
      if (resting === 'declined') messageNode()?.setAttribute('data-code', logic.declineCode(app.state) ?? '');
      await mountPayment();
      if (!needsProcessor()) setPaymentState(resting);
      else if (app.paymentState === 'loading') setPaymentState(resting);
      else if (resting !== 'ready' && app.paymentState === 'ready') setPaymentState(resting, { focus: false, message: resting === 'declined' ? declineText(logic.declineCode(app.state)) : $('#payment-message')?.textContent ?? '' });
      break;
    }
    case 'authenticating':
      await mountPayment();
      await authenticate(undefined);
      break;
    case 'resuming':
      // The app holds an unresolved payment request, possibly with no attempt yet. No form work is needed.
      await recoverOutcome('resume');
      break;
    case 'waiting':
      await recoverOutcome('read');
      break;
    case 'bank_processing':
      setPaymentState('bank_processing');
      window.location.assign(`/checkout/${encodeURIComponent(REF)}/complete`);
      break;
    case 'affirm_incomplete':
      await mountPayment();
      setPaymentState('affirm_incomplete', { message: msg('affirm_incomplete'), focus: false });
      break;
    case 'recovery':
      setPaymentState('recovery', { message: msg('finishing_payment'), focus: false });
      await recover();
      break;
    case 'succeeded':
      window.location.assign(`/checkout/${encodeURIComponent(REF)}/complete`);
      break;
    default:
      setPaymentState(resting);
  }
  maybeAutoRequote();
  if (app.state.order.customer_id && resting !== 'expired') void loadSavedMethods();
}

start();
