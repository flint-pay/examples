// The checkout page's controller. It owns the payment state machine, the job queue, the Stripe form,
// and the gift card check, and publishes an immutable snapshot that React renders. It talks only to
// this app; Stripe.js is the only third-party script.

import * as logic from '@/shared/checkout-logic.ts';
import { copy, errorKey as copyErrorKey, hasMessage, message } from '@/shared/copy.ts';
import { formatMoney, sameMoney, type Money } from '@/shared/money.ts';
import type { CheckoutState, GiftChallengeView, SavedMethod } from '@/shared/types.ts';
import { createStripePayment, runClientAction, type ClientAction, type Credential, type StripePayment } from '@/client/stripe-payment.ts';
import { mountChallengeFrame, type FrameEvent } from '@/client/gift-challenge.ts';
import { checkoutRequest, type JobError, type JobResult } from './api.ts';

const POLL_START_MS = 500;
const POLL_MAX_MS = 5000;
const POLL_LIMIT_MS = 60_000;
/** Resume requests one recovery run may send. Each replays the same saved request. */
const MAX_RESUME_POSTS = 3;
const OPEN_STATES = new Set(['authenticating', 'resuming', 'waiting', 'bank_processing', 'affirm_incomplete', 'submitting']);
const GIFT_ACTIVE = new Set(['loading', 'slow', 'checking', 'failed', 'expired']);

export type GiftChallengeBoot = { origin: string; slow_after_ms: number; max_mounts: number };
export type MessageTone = 'error' | 'warning' | 'info';
export type JobTarget = 'discount' | 'delivery' | 'billing' | 'gift-card' | 'tip' | 'verification' | 'payment';
export type JobKind = 'discount' | 'discount-remove' | 'delivery-quote' | 'billing-address' | 'pickup-locations' | 'delivery-select' | 'gift-card' | 'gift-card-remove' | 'tip' | 'verification-confirm';
export type GiftState = 'none' | 'loading' | 'slow' | 'checking' | 'failed' | 'expired' | 'unavailable' | 'origin_required' | 'unconfirmed';

export type Snapshot = {
  state: CheckoutState;
  paymentState: string;
  message: { text: string; tone: MessageTone; code?: string; focus: number } | null;
  checkAgain: boolean;
  locked: boolean;
  jobErrors: Partial<Record<JobTarget, string>>;
  queued: Partial<Record<JobKind, number>>;
  contact: { name: string; email: string; phone: string };
  emailInvalid: boolean;
  gift: { state: GiftState; code: string };
  savedMethods: SavedMethod[];
  savedChoice: string | null;
  elementsComplete: boolean;
  elementsReady: boolean;
  selectedType: string;
  walletsAvailable: boolean;
  saveCard: boolean;
  savePhone: string;
  affirmCountry: string;
  affirmPostal: string;
  verificationSkipped: string;
  announcement: string;
  deliveryOpen: number;
  giftCodeReset: number;
};

const ERROR_TARGETS: Record<JobKind, JobTarget> = {
  discount: 'discount', 'discount-remove': 'discount', 'delivery-quote': 'delivery', 'billing-address': 'billing', 'pickup-locations': 'delivery',
  'delivery-select': 'delivery', 'gift-card': 'gift-card', 'gift-card-remove': 'gift-card', tip: 'tip', 'verification-confirm': 'verification',
};
const FALLBACK_KEYS: Partial<Record<JobKind, string>> = {
  discount: 'discount_invalid', 'discount-remove': 'discount_invalid', 'gift-card': 'gift_card_unavailable', 'delivery-quote': 'delivery_service_unavailable',
  'pickup-locations': 'delivery_service_unavailable', 'delivery-select': 'delivery_service_unavailable', tip: 'tip_invalid', 'verification-confirm': 'returning_code_invalid',
};
const PATHS: Record<Exclude<JobKind, 'gift-card-remove'>, string> = {
  discount: '/discount', 'discount-remove': '/discount/remove', 'delivery-quote': '/delivery/quote', 'billing-address': '/billing-address',
  'pickup-locations': '/pickup-locations', 'delivery-select': '/delivery/select', 'gift-card': '/gift-card', tip: '/tip', 'verification-confirm': '/verification/confirm',
};

/** What the delivery section can submit again on its own: the last address or ZIP code the buyer entered. */
export type DeliveryForms = { mode: () => 'ship' | 'pickup'; ship: () => unknown | null; pickup: () => unknown | null };

export class CheckoutController {
  readonly ref: string;
  readonly csrf: string;
  readonly store: string;
  readonly giftBoot?: GiftChallengeBoot;
  private snap: Snapshot;
  private listeners = new Set<() => void>();
  private uiJobs = logic.createUiJobQueue();
  private contactEdits = logic.createContactEdits();
  private started = false;
  // Payment form and flow
  private flow: StripePayment | null = null;
  private flowKey = '';
  private flowElements = '';
  private mounting: Promise<void> | null = null;
  private collecting = false;
  private busy = false;
  private excludeAffirm: boolean;
  private approved: Money | null;
  private handledActions = new Map<string, number>();
  private pendingActionId = '';
  private generation = 0;
  private verifiedEmail = '';
  private quoteRetries = 0;
  private autoRequoted = '';
  private paysSent = 0;
  private afterQuote = '';
  private announceTimer = 0;
  // Gift card check
  private gift = { mounts: 0, view: null as GiftChallengeView | null, held: null as GiftChallengeView | null, frame: null as { unmount(): void } | null, generation: 0 };
  deliveryForms: DeliveryForms | null = null;

  constructor(init: { ref: string; csrf: string; store: string; state: CheckoutState; giftChallenge?: GiftChallengeBoot; contact: { name: string; email: string; phone: string } }) {
    this.ref = init.ref;
    this.csrf = init.csrf;
    this.store = init.store;
    this.giftBoot = init.giftChallenge;
    this.approved = logic.outstandingOf(init.state);
    this.excludeAffirm = logic.affirmShouldBeRemoved(logic.declineCode(init.state));
    this.snap = {
      state: init.state, paymentState: 'loading', message: null, checkAgain: false, locked: false, jobErrors: {}, queued: {},
      contact: init.contact, emailInvalid: false, gift: { state: 'none', code: '' }, savedMethods: [], savedChoice: null,
      elementsComplete: false, elementsReady: false, selectedType: 'card', walletsAvailable: false, saveCard: false, savePhone: '',
      affirmCountry: '', affirmPostal: '', verificationSkipped: '', announcement: '', deliveryOpen: 0, giftCodeReset: 0,
    };
  }

  // ----- Store plumbing -----

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.snap;
  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const listener of this.listeners) listener();
  }
  get state() { return this.snap.state; }

  private msg(key: string, params: Record<string, string | number | undefined> = {}) {
    return message(hasMessage(key) ? key : 'generic_error', { store: this.store, ...params });
  }
  private errorKey(error: JobError | undefined) {
    if (!error) return 'generic_error';
    return copyErrorKey(error);
  }
  private errorText(error: JobError | undefined, fallbackKey?: string) {
    let key = this.errorKey(error);
    if (key === 'generic_error' && fallbackKey && !['bug', 'unavailable', 'rate_limited', 'auth'].includes(error?.kind ?? '')) key = fallbackKey;
    const text = this.msg(key);
    return key === 'generic_error' && error?.request_id ? `${text} ${this.msg('reference_id', { id: error.request_id })}` : text;
  }
  private request(method: 'GET' | 'POST', suffix: string, body?: unknown) {
    return checkoutRequest(this.ref, this.csrf, method, suffix, body).then((result) => {
      if (typeof result.pending_action_id === 'string') this.pendingActionId = result.pending_action_id;
      return result;
    });
  }
  announce(text: string) {
    window.clearTimeout(this.announceTimer);
    this.set({ announcement: '' });
    this.announceTimer = window.setTimeout(() => this.set({ announcement: text }), 60);
  }
  focus(id: string) {
    window.setTimeout(() => {
      const node = document.getElementById(id);
      if (!node) return;
      if (!node.hasAttribute('tabindex') && !(node instanceof HTMLInputElement || node instanceof HTMLButtonElement)) node.setAttribute('tabindex', '-1');
      node.focus({ preventScroll: false });
    }, 0);
  }
  private goComplete() {
    window.location.assign(`/checkout/${encodeURIComponent(this.ref)}/complete`);
  }

  // ----- Contact -----

  setContact(field: 'name' | 'email' | 'phone', value: string) {
    this.contactEdits.mark();
    this.set({ contact: { ...this.snap.contact, [field]: value }, ...(field === 'email' ? { emailInvalid: false } : {}) });
  }
  blurContact(field: 'name' | 'email' | 'phone') {
    const email = this.snap.contact.email;
    if (field === 'email' && email && !logic.looksLikeEmail(email)) {
      this.set({ emailInvalid: true });
      return;
    }
    void this.saveContact();
  }
  async saveContact() {
    await this.uiJobs.coalesce('contact', async () => {
      if (!this.contactEdits.dirty && this.state.order.buyer_contact?.email) return;
      const c = this.snap.contact;
      if (c.email && !logic.looksLikeEmail(c.email)) return;
      const revision = this.contactEdits.snapshot();
      const result = await this.request('POST', '/contact', { name: c.name || undefined, email: c.email || undefined, phone: c.phone || undefined });
      if (result.ok) {
        this.contactEdits.acknowledge(revision);
        if (result.state) this.set({ state: result.state });
      }
      this.maybeStartVerification(c.email);
    });
  }
  private async saveContactIfDirty() {
    if (this.contactEdits.dirty) await this.saveContact();
  }
  private maybeStartVerification(email: string) {
    if (!this.state.session.save_payment_method_requires_verification) return;
    const key = email.toLowerCase();
    if (!logic.looksLikeEmail(email) || this.verifiedEmail === key) return;
    this.verifiedEmail = key;
    void this.uiJobs.run(async () => {
      // This waited behind other jobs. If the buyer changed the email or started paying, it is dropped,
      // and a later save of the same email may start it again.
      if (this.snap.contact.email.trim().toLowerCase() !== key || this.snap.locked || this.busy) {
        if (this.verifiedEmail === key) this.verifiedEmail = '';
        return;
      }
      const result = await this.request('POST', '/verification', { purpose: 'use_saved_payment_methods', channel: 'auto', email });
      if (result.ok) await this.reload();
      // CUSTOMER_VERIFICATION_NOT_SENT and other failures show nothing: this never holds payment.
    });
  }
  skipVerification() {
    const v = this.state.verification;
    this.set({ verificationSkipped: v ? `${v.purpose}:${v.delivery_channel}:${v.masked_email ?? v.phone_last_digits ?? ''}` : 'skipped' });
    this.focus('contact-email');
  }
  async emailCodeInstead() {
    await this.uiJobs.run(async () => {
      // The email is read at its turn, after the contact save that leaving the field queued.
      const result = await this.request('POST', '/verification', { purpose: 'use_saved_payment_methods', channel: 'email', email: this.snap.contact.email.trim() });
      if (result.ok) await this.reload();
      else this.showJobError('verification', this.errorText(result.error, 'customer_verification_unavailable'));
    });
  }

  // ----- Payment state machine -----

  private setPaymentState(next: string, options: { message?: string; focus?: boolean; tone?: MessageTone; code?: string } = {}) {
    const locked = OPEN_STATES.has(next);
    // A check that is still open ends silently so its controls can be locked with the rest.
    if (locked && GIFT_ACTIVE.has(this.snap.gift.state)) this.leaveGift('none');
    let messagePatch: Partial<Snapshot> = {};
    if (options.message !== undefined) {
      const tone = options.tone ?? (['waiting', 'resuming', 'recovery', 'affirm_incomplete', 'authenticating'].includes(next) ? 'info' : next === 'total_changed' ? 'warning' : 'error');
      messagePatch = { message: options.message ? { text: options.message, tone, code: options.code, focus: options.focus !== false ? Date.now() : 0 } : null };
    } else if (!['declined', 'pay_remaining', 'total_changed', 'ready'].includes(next)) {
      messagePatch = { message: null };
    }
    this.set({ paymentState: next, locked, ...messagePatch });
    if (messagePatch.message && options.focus !== false) this.focus('payment-message');
  }

  needsProcessor() { return logic.needsProcessor(this.state); }

  affirmActive() { return this.needsProcessor() && !this.snap.savedChoice && this.snap.selectedType === 'affirm'; }
  /** The billing country Affirm gets: the saved billing address first, then the buyer's choice. */
  affirmCountry() {
    const saved = logic.buyerBillingCountry(this.state);
    if (saved) return saved;
    return this.snap.affirmCountry === 'US' ? 'US' : '';
  }
  /** The billing postal code Affirm gets: the saved billing address first, then the buyer's valid entry. */
  affirmPostalCode() {
    const saved = logic.buyerBillingPostalCode(this.state);
    if (saved) return saved;
    const typed = this.snap.affirmPostal.trim();
    return logic.US_POSTAL_CODE.test(typed) ? typed : '';
  }
  /** The postal field is asked for only when Affirm is active, no postal code is saved, and the country can be US. */
  affirmPostalShown() {
    const saved = logic.buyerBillingCountry(this.state);
    return this.affirmActive() && !logic.buyerBillingPostalCode(this.state) && (!saved || saved === 'US') && this.snap.affirmCountry !== 'other';
  }
  affirmCountryShown() { return this.affirmActive() && !logic.buyerBillingCountry(this.state); }

  blockers(): string[] {
    if (this.snap.paymentState === 'loading') return ['elements_incomplete'];
    const blockers: string[] = [];
    if (!logic.looksLikeEmail(this.snap.contact.email)) blockers.push('contact_email_missing');
    for (const code of logic.serverBlockers(this.state)) {
      if (code === 'attempt_open' && !OPEN_STATES.has(this.snap.paymentState) && this.snap.paymentState !== 'recovery') continue;
      blockers.push(code);
    }
    if (OPEN_STATES.has(this.snap.paymentState) && !blockers.includes('attempt_open')) blockers.push('attempt_open');
    if (this.needsProcessor() && !this.snap.savedChoice && !this.snap.elementsComplete && !blockers.includes('delivery_selection_missing')) blockers.push('elements_incomplete');
    if (this.affirmActive()) {
      const saved = logic.buyerBillingCountry(this.state);
      if (saved && saved !== 'US') blockers.push('billing_country_unsupported');
      else if (!this.affirmCountry()) blockers.push(this.snap.affirmCountry === 'other' ? 'billing_country_unsupported' : 'billing_country_missing');
      else if (!this.affirmPostalCode()) blockers.push(this.snap.affirmPostal.trim() ? 'billing_postal_code_required' : 'billing_postal_code_missing');
    }
    return [...new Set(blockers)].sort((a, b) => logic.BLOCKER_PRIORITY.indexOf(a) - logic.BLOCKER_PRIORITY.indexOf(b));
  }
  blockerText(code: string) { return this.msg(code); }

  setAffirmCountry(value: string) { this.set({ affirmCountry: value }); }
  setAffirmPostal(value: string) { this.set({ affirmPostal: value }); }
  setSavePhone(value: string) { this.set({ savePhone: value }); }
  async setSaveCard(value: boolean) {
    this.set({ saveCard: value });
    await this.flow?.setSaving(value);
  }
  saveAllowed() { return this.snap.selectedType === 'card' && !this.snap.savedChoice; }
  setSavedChoice(value: string) {
    this.set({ savedChoice: value === 'new' ? null : value });
    this.enforceSaveAllowed();
  }
  private enforceSaveAllowed() {
    if (!this.saveAllowed() && this.snap.saveCard) {
      this.set({ saveCard: false });
      void this.flow?.setSaving(false);
    }
  }

  // ----- Applying server state -----

  private applyState(state: CheckoutState) {
    const previous = this.state;
    const processor = logic.processorMoney(state);
    this.set({ state });
    // Elements fix their payment method types when created. When the current guidance differs, for example after a
    // gift card leaves only a card remainder, the form is rebuilt instead of updated. A payment being collected keeps
    // its form, and `totalChanged` rebuilds it afterwards.
    const rebuild = Boolean(this.flow) && this.needsProcessor() && this.elementsKeyOf(state) !== this.flowElements && !this.flowInUse();
    if (rebuild) this.dropFlow();
    else if (!sameMoney(processor, logic.processorMoney(previous))) this.flow?.updateAmount(processor);
    this.approved = logic.outstandingOf(state);
    // When nothing is left for a processor, drop the card form so no entered card is carried over.
    if (!this.needsProcessor() && this.flow) {
      this.dropFlow();
      this.set({ saveCard: false });
    }
    // Removing a gift card can bring the card form back after a settlement-only load.
    if (this.needsProcessor() && !this.flow && this.paymentNode() && this.snap.paymentState !== 'loading' && !OPEN_STATES.has(this.snap.paymentState)) void this.mountPayment({ quiet: rebuild });
  }

  /** Reads the checkout again and shows it. A paid checkout goes to its confirmation. */
  async reload(options: { announcePrefix?: string } = {}) {
    const result = await this.request('GET', '/state');
    if (!result.ok || !result.state) return false;
    if (['paid', 'partially_paid'].includes(result.state.session.status ?? '')) {
      this.goComplete();
      return true;
    }
    this.applyState(result.state);
    this.afterRefresh(options.announcePrefix);
    return true;
  }
  private afterRefresh(announcePrefix?: string) {
    const due = `${copy.checkout.amountDue} ${formatMoney(logic.outstandingOf(this.state))}`;
    this.announce(announcePrefix ? `${announcePrefix} ${due}` : due);
  }

  private flowInUse() { return this.busy || this.collecting || OPEN_STATES.has(this.snap.paymentState); }

  private dropFlow() {
    this.flow?.destroy();
    this.flow = null;
    this.flowKey = '';
    this.flowElements = '';
    for (const id of ['payment-element', 'express-checkout', 'affirm-messaging']) document.getElementById(id)?.replaceChildren();
    this.set({ elementsComplete: false, elementsReady: false, selectedType: 'card', walletsAvailable: false });
  }

  /** The guidance Elements are built from. The return address is left out because it is read when a credential is made. */
  private elementsKeyOf(state: CheckoutState) {
    const source = logic.guidanceOf(state)?.stripe;
    const elements = source?.elements;
    if (!source || !elements) return '';
    return JSON.stringify([source.publishable_key, source.account_id, elements.mode, elements.next_step, elements.payment_method_types, elements.payment_method_options, elements.digital_wallets]);
  }

  // ----- Jobs -----

  showJobError(target: JobTarget, text: string) {
    if (target === 'payment') {
      if (text) this.set({ message: { text, tone: 'error', focus: 0 } });
      return;
    }
    this.set({ jobErrors: { ...this.snap.jobErrors, [target]: text } });
  }
  isQueued(kind: JobKind) { return (this.snap.queued[kind] ?? 0) > 0; }

  /** Sends one section change through the queue. Section components validate their own fields first. */
  async job(kind: JobKind, body: unknown, options: { path?: string; onDone?: () => void } = {}) {
    const target = ERROR_TARGETS[kind];
    if (this.snap.locked) {
      // The order is frozen while a payment finishes. Nothing is sent.
      this.showJobError(target, this.msg('sections_locked'));
      return;
    }
    if (kind === 'gift-card') {
      // Apply is off while a check is open. A new Apply starts clean after a terminal state.
      if (GIFT_ACTIVE.has(this.snap.gift.state)) return;
      this.setGift('none');
    }
    this.showJobError(target, '');
    const path = options.path ?? (kind === 'gift-card-remove' ? '' : PATHS[kind]);
    if (!path) return;
    this.set({ queued: { ...this.snap.queued, [kind]: (this.snap.queued[kind] ?? 0) + 1 } });
    const paysSent = this.paysSent;
    try {
      await this.uiJobs.run(() => this.runJob(kind, path, body, paysSent, options.onDone));
    } finally {
      const left = (this.snap.queued[kind] ?? 1) - 1;
      const queued = { ...this.snap.queued };
      if (left > 0) queued[kind] = left;
      else delete queued[kind];
      this.set({ queued });
    }
  }

  /** Runs inside the queue, so it must not wait for another queued job. */
  private async runJob(kind: JobKind, path: string, body: unknown, paysSent: number, onDone?: () => void) {
    let result: JobResult;
    do {
      if (this.snap.locked && this.paysSent !== paysSent) {
        this.showJobError(ERROR_TARGETS[kind], this.msg('sections_locked'));
        return;
      }
      result = await this.request('POST', path, body);
    } while (!result.ok && (await this.onJobError(kind, result)) === 'retry');
    if (!result.ok) return;
    this.quoteRetries = 0;
    if (kind === 'gift-card' && result.gift_challenge) {
      // A check comes first. The code stays in the field and the order is unchanged.
      if (result.state) this.applyState(result.state);
      this.beginGiftChallenge(result.gift_challenge, (body as { gift_card_code: string }).gift_card_code);
      return;
    }
    if (result.state) {
      if (['paid', 'partially_paid'].includes(result.state.session.status ?? '')) {
        this.goComplete();
        return;
      }
      this.applyState(result.state);
    }
    onDone?.();
    if (kind === 'gift-card') this.set({ giftCodeReset: this.snap.giftCodeReset + 1 });
    this.afterRefresh(kind === 'gift-card' ? this.msg('gift_card_applied') : undefined);
    if (this.afterQuote && (kind === 'delivery-quote' || kind === 'pickup-locations')) {
      this.showJobError('delivery', this.afterQuote);
      this.afterQuote = '';
    }
    if (kind === 'verification-confirm') await this.loadSavedMethods();
    const focus = kind.startsWith('delivery') || kind === 'pickup-locations' ? 'delivery-title' : kind === 'billing-address' ? 'billing-title' : kind.startsWith('discount') ? 'discount-title' : kind.startsWith('gift-card') ? 'gift-title' : kind === 'tip' ? 'tip-title' : '';
    if (focus && kind !== 'delivery-quote' && kind !== 'pickup-locations' && kind !== 'tip') this.focus(focus);
    if (kind === 'delivery-select') this.set({ deliveryOpen: 0 });
  }

  /** @returns `retry` to send the same request again within the same job. */
  private async onJobError(kind: JobKind, result: JobResult): Promise<'retry' | void> {
    const code = result.error?.code ?? '';
    const target = ERROR_TARGETS[kind];
    if (result.state) this.applyState(result.state);
    if (kind === 'gift-card' && code === 'GIFT_CARD_CHALLENGE_ORIGIN_REQUIRED') {
      // The app replaced the checkout session so codes can be checked. The code stays in the field.
      await this.endGiftChallenge('origin_required', { refresh: true, text: this.msg('gift_challenge_origin_required') });
      return;
    }
    if (kind === 'gift-card' && code === 'GIFT_CARD_CHALLENGE_UNAVAILABLE') {
      await this.endGiftChallenge('unavailable', { text: this.msg('gift_card_challenge_required') });
      return;
    }
    if (kind === 'gift-card' && result.error?.kind === 'conflict' && this.errorKey(result.error) === 'generic_error') {
      this.showJobError(target, this.msg('gift_card_apply_again'));
      await this.reload();
      return;
    }
    if (kind === 'delivery-select' && ['DELIVERY_QUOTE_EXPIRED', 'DELIVERY_QUOTE_STALE', 'DELIVERY_SELECTION_CHANGED'].includes(code)) {
      this.afterQuote = this.msg('delivery_prices_changed');
      this.showJobError(target, this.afterQuote);
      this.requoteLastAddress();
      return;
    }
    if ((kind === 'delivery-quote' || kind === 'pickup-locations') && code === 'DELIVERY_SERVICE_UNAVAILABLE' && this.quoteRetries < 1) {
      this.quoteRetries += 1;
      this.showJobError(target, this.msg('delivery_service_unavailable'));
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      this.showJobError(target, '');
      return 'retry';
    }
    this.showJobError(target, this.errorText(result.error, FALLBACK_KEYS[kind]));
  }

  private requoteLastAddress() {
    const forms = this.deliveryForms;
    const pickup = forms?.mode() === 'pickup';
    const body = pickup ? forms?.pickup() : forms?.ship();
    if (body) {
      void this.job(pickup ? 'pickup-locations' : 'delivery-quote', body);
      return;
    }
    void this.reload();
  }

  /** A stale delivery choice is quoted again once per selection, with the address already on the page. */
  maybeAutoRequote() {
    if (logic.deliveryState(this.state) !== 'stale' || !this.deliveryForms) return;
    const key = this.state.delivery_selection?.delivery_selection_id ?? 'none';
    if (this.autoRequoted === key) return;
    this.autoRequoted = key;
    const pickup = this.deliveryForms.mode() === 'pickup';
    const body = pickup ? this.deliveryForms.pickup() : this.deliveryForms.ship();
    if (body) void this.job(pickup ? 'pickup-locations' : 'delivery-quote', body);
  }

  openDelivery() { this.set({ deliveryOpen: Date.now() }); }

  // ----- Saved payment methods -----

  private async loadSavedMethods() {
    if (this.state.kind !== 'order') return;
    const result = await this.request('GET', '/saved-methods');
    const methods = result.state?.saved_methods;
    if (result.ok && Array.isArray(methods)) {
      const cards = methods.filter((method) => method.card);
      this.set({ savedMethods: cards, savedChoice: cards[0]?.payment_method_id ?? null });
      this.enforceSaveAllowed();
    }
  }

  // ----- Gift card check -----

  private setGift(state: GiftState, code = this.snap.gift.code) {
    this.set({ gift: { state, code } });
  }
  giftMaxMounts() { return this.giftBoot?.max_mounts ?? 3; }
  giftActive() { return GIFT_ACTIVE.has(this.snap.gift.state); }

  private mountGiftFrame() {
    this.gift.frame?.unmount();
    this.gift.frame = null;
    this.gift.generation += 1;
    const generation = this.gift.generation;
    // The host renders once the check becomes active, so the frame mounts after that commit.
    window.setTimeout(() => {
      if (generation !== this.gift.generation) return;
      const host = document.getElementById('gift-challenge-host');
      const view = this.gift.view;
      const config = this.giftBoot;
      if (!host || !view || !config) {
        void this.endGiftChallenge('unavailable', { text: this.msg('gift_card_challenge_required') });
        return;
      }
      host.replaceChildren();
      this.gift.frame = mountChallengeFrame(host, view, { origin: config.origin, slow_after_ms: config.slow_after_ms, title: this.msg('gift_challenge_frame_title'), testid: 'sf-gift-challenge-frame' }, (event) => {
        if (generation === this.gift.generation) this.onGiftFrameEvent(event);
      });
    }, 0);
  }

  private beginGiftChallenge(view: GiftChallengeView, code: string) {
    this.gift.view = view;
    this.gift.held = null;
    this.gift.mounts = 1;
    this.setGift('loading', code);
    this.mountGiftFrame();
    this.focus('gift-challenge-intro');
  }

  private onGiftFrameEvent(event: FrameEvent) {
    switch (event.kind) {
      case 'slow':
        if (this.snap.gift.state === 'loading') this.setGift('slow');
        break;
      case 'completed':
        void this.submitGiftProof(event.proof);
        break;
      case 'failed':
        if (event.reason === 'verification_failed' && this.gift.mounts < this.giftMaxMounts()) {
          this.setGift('failed');
          this.focus('gift-challenge-message');
        } else {
          // Either the frame cannot run, or this was the last frame the check allows.
          void this.endGiftChallenge('unavailable', { text: this.msg('gift_card_challenge_required') });
        }
        break;
      case 'expired':
        this.setGift('expired');
        this.focus('gift-challenge-message');
        break;
    }
  }

  /** Sends the proof to this app once. The proof is a parameter and a request body, nothing else. */
  private async submitGiftProof(proof: string) {
    const view = this.gift.view;
    const code = this.snap.gift.code;
    this.gift.frame = null;
    // A payment still waiting for earlier jobs yields to this check.
    if (this.snap.locked && this.snap.paymentState !== 'submitting') {
      this.leaveGift('none');
      return;
    }
    if (!view || !code) {
      await this.endGiftChallenge('unavailable', { text: this.msg('gift_card_challenge_required') });
      return;
    }
    this.setGift('checking');
    this.focus('gift-challenge-intro');
    const generation = this.gift.generation;
    // A check that ended while this waited for its turn sends nothing.
    const result = await this.uiJobs.run(() => (generation === this.gift.generation ? this.request('POST', '/gift-card/challenge', { challenge_id: view.challenge_id, gift_card_code: code, proof }) : null));
    if (!result || generation !== this.gift.generation) return;
    await this.onGiftProofResult(result);
  }

  private async onGiftProofResult(result: JobResult) {
    if (result.state) this.applyState(result.state);
    if (result.ok && result.gift_challenge) {
      // The proof was rejected and a fresh check came back. Try again uses it without another Apply.
      this.gift.held = result.gift_challenge;
      this.setGift('expired');
      this.focus('gift-challenge-message');
      return;
    }
    if (result.ok) {
      this.leaveGift('none');
      this.set({ giftCodeReset: this.snap.giftCodeReset + 1 });
      this.afterRefresh(this.msg('gift_card_applied'));
      this.focus('gift-title');
      return;
    }
    const error = result.error;
    const code = error?.code ?? '';
    if (code === 'GIFT_CHALLENGE_EXPIRED') {
      this.gift.held = null;
      this.setGift('expired');
      this.focus('gift-challenge-message');
    } else if (code === 'GIFT_CARD_CHALLENGE_ORIGIN_REQUIRED') {
      await this.endGiftChallenge('origin_required', { refresh: true, text: this.msg('gift_challenge_origin_required') });
    } else if (code === 'GIFT_CARD_CHALLENGE_UNAVAILABLE') {
      await this.endGiftChallenge('unavailable', { text: this.msg('gift_card_challenge_required') });
    } else if (result.transport || error?.kind === 'unknown_outcome') {
      // The proof is never sent again. The next Apply of the same code settles what happened.
      await this.endGiftChallenge('unconfirmed', { text: this.msg('gift_challenge_unconfirmed') });
    } else if (result.status === 429 || error?.kind === 'rate_limited') {
      await this.endGiftChallenge('none', { text: this.msg('rate_limited') });
    } else if (['GIFT_CHALLENGE_SESSION_CHANGED', 'GIFT_CHALLENGE_CODE_CHANGED', 'GIFT_CHALLENGE_ORDER_CHANGED', 'ORDER_CHANGED_REFRESH_REQUIRED'].includes(code) || (error?.kind === 'conflict' && this.errorKey(error) === 'generic_error')) {
      await this.endGiftChallenge('none', { refresh: true, text: this.msg('gift_card_apply_again') });
    } else {
      await this.endGiftChallenge('none', { text: this.errorText(error, 'gift_card_unavailable') });
    }
  }

  /** Removes the frame and returns the section to a resting state. The code field keeps its text. */
  private leaveGift(next: GiftState) {
    this.gift.generation += 1;
    this.gift.frame?.unmount();
    this.gift.frame = null;
    this.gift.view = null;
    this.gift.held = null;
    this.gift.mounts = 0;
    this.set({ gift: { state: next, code: '' } });
    document.getElementById('gift-challenge-host')?.replaceChildren();
  }

  private async endGiftChallenge(next: GiftState, options: { text?: string; refresh?: boolean } = {}) {
    this.leaveGift(next);
    if (options.refresh) await this.reload();
    this.showJobError('gift-card', options.text ?? '');
    this.focus('gift-card-code');
  }

  retryGiftChallenge(resubmit: () => void) {
    const state = this.snap.gift.state;
    if (state === 'slow' || state === 'failed') {
      if (this.gift.mounts >= this.giftMaxMounts()) {
        void this.endGiftChallenge('unavailable', { text: this.msg('gift_card_challenge_required') });
        return;
      }
      this.gift.mounts += 1;
      this.setGift('loading');
      this.mountGiftFrame();
      this.focus('gift-challenge-intro');
    } else if (state === 'expired') {
      const held = this.gift.held;
      if (held) {
        this.beginGiftChallenge(held, this.snap.gift.code);
        return;
      }
      // Apply the same code again. This starts a new check and drops the old one.
      this.leaveGift('none');
      resubmit();
    }
  }

  cancelGiftChallenge() {
    if (!GIFT_ACTIVE.has(this.snap.gift.state) || this.snap.gift.state === 'checking') return;
    void this.endGiftChallenge('none');
  }

  // ----- Payment form -----

  private paymentNode() { return document.getElementById('payment-element'); }

  private shippingForAffirm() {
    const selection = this.state.delivery_selection;
    const address = selection?.destination_address;
    if (!address || !selection) return null;
    return {
      name: selection.recipient?.name || this.snap.contact.name.trim(),
      address: { line1: address.line1, line2: address.line2, city: address.city, state: address.state, postal_code: address.postal_code, country: address.country ?? 'US' },
    };
  }

  /** Mounts the card form for the current guidance, or keeps the one that already matches. Mounts run one at a time. */
  mountPayment(options: { quiet?: boolean } = {}): Promise<void> {
    const run = (this.mounting ?? Promise.resolve()).then(() => this.mountOnce(options));
    this.mounting = run;
    void run.finally(() => {
      if (this.mounting === run) this.mounting = null;
    });
    return run;
  }

  private async mountOnce(options: { quiet?: boolean }): Promise<void> {
    const source = logic.guidanceOf(this.state)?.stripe;
    const paymentNode = this.paymentNode();
    if (!this.needsProcessor() || !source || !paymentNode) {
      const derived = logic.derivePaymentState(this.state);
      this.setPaymentState(derived === 'ready' ? 'ready' : derived);
      return;
    }
    const elementsKey = this.elementsKeyOf(this.state);
    const key = JSON.stringify([elementsKey, source.return_url, this.excludeAffirm]);
    if (this.flow && this.flowKey === key) return;
    this.dropFlow();
    if (!options.quiet) this.setPaymentState('loading');
    const amount = logic.processorMoney(this.state);
    try {
      this.flow = await createStripePayment({
        guidance: source,
        kind: this.state.kind,
        saveOffered: this.saveOffered(),
        excludeAffirm: this.excludeAffirm,
        amount,
        mounts: { payment: paymentNode, wallets: document.getElementById('express-checkout'), messaging: document.getElementById('affirm-messaging') },
        onWalletsAvailable: (available) => this.set({ walletsAvailable: available }),
        onChange: ({ complete, type }) => {
          this.set({ elementsComplete: complete, selectedType: type });
          this.enforceSaveAllowed();
        },
        onReady: () => {
          this.set({ elementsReady: true });
          if (this.snap.paymentState === 'loading') this.setPaymentState(this.initialRestingState());
        },
        onWalletClick: () => {
          const blockers = this.blockers().filter((code) => !['elements_incomplete', 'billing_country_missing', 'billing_country_unsupported', 'billing_postal_code_missing', 'billing_postal_code_required'].includes(code));
          if (blockers.length) {
            this.set({ message: { text: this.msg(blockers[0]!), tone: 'error', focus: Date.now() } });
            this.focus('payment-message');
            return false;
          }
          return true;
        },
        onWalletConfirm: async (event, makeCredential) => {
          if (this.busy) {
            event.paymentFailed?.({ reason: 'fail' });
            return;
          }
          // Like Pay: show progress and lock the order before the token and the request, whatever way they end.
          this.busy = true;
          this.collecting = true;
          this.setPaymentState('submitting', { message: '' });
          try {
            const made = await makeCredential();
            if (made.error || !made.credential) {
              event.paymentFailed?.({ reason: 'fail' });
              this.setPaymentState('ready', { message: made.error?.message || this.msg('stripe_error_generic') });
              return;
            }
            const ok = await this.payWith(made.credential);
            if (!ok) event.paymentFailed?.({ reason: 'fail' });
          } catch {
            event.paymentFailed?.({ reason: 'fail' });
            if (this.snap.paymentState === 'submitting') this.setPaymentState('ready', { message: this.msg('stripe_error_generic') });
          } finally {
            this.collecting = false;
            this.busy = false;
          }
        },
        getBilling: () => ({ name: this.snap.contact.name.trim(), email: this.snap.contact.email.trim(), country: this.affirmCountry(), postal_code: this.affirmPostalCode() }),
        getShipping: () => this.shippingForAffirm(),
      });
      this.flowKey = key;
      this.flowElements = elementsKey;
      // The order can change while Stripe.js loads, and then the guidance read at the start is out of date.
      if (!this.needsProcessor()) {
        this.dropFlow();
        this.setPaymentState(logic.derivePaymentState(this.state));
        return;
      }
      if (this.elementsKeyOf(this.state) !== elementsKey) {
        await this.mountOnce({ quiet: options.quiet });
        return;
      }
      const now = logic.processorMoney(this.state);
      if (!sameMoney(now, amount)) this.flow.updateAmount(now);
      if (this.snap.saveCard && this.saveAllowed()) await this.flow.setSaving(true);
    } catch (error) {
      const missing = error instanceof Error && error.message === 'stripe_not_loaded';
      console.error('The payment form did not load.', error);
      this.setPaymentState('unavailable', { message: missing ? this.msg('stripe_not_loaded') : this.msg('payments_unavailable') });
    }
  }

  saveOffered() {
    return this.state.kind === 'order' && this.state.session.save_payment_method_offered === true && this.needsProcessor();
  }

  private initialRestingState() {
    const derived = logic.derivePaymentState(this.state);
    return derived === 'ready' || derived === 'declined' || derived === 'pay_remaining' ? derived : 'ready';
  }

  /** The payment form appeared after the page loaded, for example once a billing address unlocked tax. */
  onPaymentFormMounted() {
    if (!this.started) return;
    if (this.needsProcessor() && !this.flow && !OPEN_STATES.has(this.snap.paymentState)) void this.mountPayment();
    else if (!this.needsProcessor() && this.snap.paymentState === 'loading') this.setPaymentState(logic.derivePaymentState(this.state));
  }
  onPaymentFormUnmounted() {
    if (this.flow && !this.flowInUse()) this.dropFlow();
  }

  /** Credential from the saved list, the form, or none for settlement-only orders. */
  private async collectCredential(): Promise<{ credential?: { kind: string; value: string }; error?: { message?: string } }> {
    if (!this.needsProcessor()) return {};
    const saved = this.snap.savedChoice;
    if (saved) return { credential: { kind: 'saved_payment_method', value: saved } };
    if (!this.flow) return { error: { message: this.msg('payments_unavailable') } };
    return this.flow.createCredential();
  }

  /** The amounts the buyer sees next to the Pay button. Pressing Pay or confirming a wallet approves them. */
  private approvalOf() {
    const order = this.state.order;
    const giftCards = (order.gift_cards?.length ?? 0) > 0;
    return {
      approved_outstanding_money: this.approved,
      approved_collection_kind: logic.collectionKindOf(this.state),
      ...(giftCards && order.order_revision !== undefined ? { approved_order_revision: String(order.order_revision) } : {}),
      ...(giftCards && order.gift_card_estimate?.gift_card_money ? { approved_gift_card_money: order.gift_card_estimate.gift_card_money } : {}),
    } as { approved_outstanding_money: Money | null; approved_collection_kind: string; approved_order_revision?: string; approved_gift_card_money?: Money | null };
  }

  private async payWith(credential: { kind: string; value: string } | Credential | null, approval = this.approvalOf()): Promise<boolean> {
    const c = this.snap.contact;
    const saving = this.snap.saveCard && this.saveAllowed() && this.saveOffered();
    const body = {
      ...(credential ? { credential } : {}),
      ...approval,
      buyer_contact: { email: c.email.trim(), ...(c.phone.trim() ? { phone: c.phone.trim() } : {}) },
      ...(saving ? { save_payment_method: true, ...(this.snap.savePhone.trim() ? { save_payment_method_phone: this.snap.savePhone.trim() } : {}) } : {}),
    };
    // Edits submitted before Pay reach the app first. Only the request is queued: recovery reads and resumes are not.
    const outcome = await this.uiJobs.run<JobResult | 'check_open' | 'total_changed' | 'gift_changed'>(async () => {
      // One of those edits started a gift card check. It needs the buyer, so this payment waits for another press.
      if (GIFT_ACTIVE.has(this.snap.gift.state)) return 'check_open';
      // One of them changed what the buyer approved. Ask for a fresh press instead of paying a different amount.
      const now = this.approvalOf();
      if (!sameMoney(now.approved_outstanding_money, approval.approved_outstanding_money) || now.approved_collection_kind !== approval.approved_collection_kind) return 'total_changed';
      if (now.approved_order_revision !== approval.approved_order_revision || !sameMoney(now.approved_gift_card_money ?? null, approval.approved_gift_card_money ?? null)) return 'gift_changed';
      this.paysSent += 1;
      return this.request('POST', '/pay', body);
    });
    if (outcome === 'check_open') {
      this.setPaymentState('ready', { message: '', focus: false });
      return false;
    }
    if (outcome === 'total_changed' || outcome === 'gift_changed') return this.totalChanged(outcome === 'gift_changed');
    return this.handlePayResult(outcome);
  }

  async pay() {
    if (this.busy) return;
    if (this.blockers().length) return;
    this.busy = true;
    const approval = this.approvalOf();
    this.setPaymentState('submitting', { message: '' });
    try {
      await this.saveContactIfDirty();
      const collected = await this.collectCredential();
      if (collected.error) {
        this.setPaymentState('ready', { message: collected.error.message || this.msg('stripe_error_generic') });
        return;
      }
      await this.payWith(collected.credential ?? null, approval);
    } finally {
      this.busy = false;
    }
  }

  private async handlePayResult(result: JobResult): Promise<boolean> {
    if (!result.ok) return this.handlePayError(result);
    if (result.state) this.applyState(result.state);
    await this.advance(result.next ?? logic.derivePaymentState(this.state), result.client_action);
    return true;
  }

  private isUncertain(result: JobResult) {
    const code = result.error?.code ?? '';
    // The app answers CHECKOUT_PAYMENT_RESOLVING when another request holds this order's lock. Nothing was decided, so keep checking.
    return Boolean(result.transport) || result.error?.kind === 'unknown_outcome' || ['IDEMPOTENCY_KEY_IN_PROGRESS', 'PAYMENT_ATTEMPT_STILL_PROCESSING', 'CHECKOUT_PAYMENT_RESOLVING'].includes(code);
  }

  private async handlePayError(result: JobResult): Promise<boolean> {
    const error = result.error;
    const code = error?.code ?? '';
    if (result.state) this.applyState(result.state);
    if (this.isUncertain(result)) {
      this.set({ message: { text: this.msg('finishing_payment'), tone: 'info', focus: 0 } });
      // The app may already hold a saved request to replay, so ask what to do next instead of assuming a read.
      await this.recoverOutcome(result.next === 'resume' || result.state?.next === 'resume' ? 'resume' : 'read');
      return true;
    }
    switch (code) {
      case 'ORDER_CHANGED_REFRESH_REQUIRED':
      case 'EXPECTED_AMOUNT_REQUIRED':
        return this.totalChanged(error?.message_key === 'gift_card_changed' || error?.message_key === 'gift_card_allocation_changed', error?.message_key === 'tax_updated' ? 'tax_updated' : undefined);
      case 'FULFILLMENT_SELECTION_REQUIRED':
      case 'DELIVERY_RECIPIENT_REQUIRED':
        await this.reload();
        this.openDelivery();
        this.focus('delivery-title');
        this.setPaymentState('ready', { message: this.msg('delivery_selection_required'), focus: false });
        return false;
      case 'ORDER_PAYMENT_ATTEMPT_ACTIVE':
      case 'PAYMENT_ATTEMPT_NOT_RESUMABLE': {
        const read = await this.request('GET', '/attempt');
        if (read.ok) {
          if (read.state) this.applyState(read.state);
          await this.advance(read.next ?? 'wait', read.client_action);
          return true;
        }
        break;
      }
      case 'CHECKOUT_RECOVERY_RESTRICTED':
        this.setPaymentState('recovery', { message: this.msg('finishing_payment') });
        await this.recoverOutcome('read');
        return true;
      case 'INVALID_CHECKOUT_SESSION':
      case 'CHECKOUT_SESSION_NOT_OPEN':
        // The page route starts a replacement session or shows the expired state.
        window.location.reload();
        return false;
      case 'PAYMENT_SOURCE_UNAVAILABLE':
        this.flow?.clearPayment();
        break;
      default:
        break;
    }
    if (code.startsWith('SAVE_PAYMENT_METHOD_')) {
      this.set({ saveCard: false });
      await this.flow?.setSaving(false);
    }
    if (code === 'PAYMENT_ACTION_WINDOW_TOO_SHORT' || code === 'PAYMENT_METHOD_DECLINED') this.excludeAffirm = code === 'PAYMENT_METHOD_DECLINED';
    this.setPaymentState('ready', { message: this.errorText(error) });
    return false;
  }

  /** A refreshed order can rotate the return address while the Elements stay the same; the open form takes it in place. */
  private carryReturnUrl() {
    const source = logic.guidanceOf(this.state)?.stripe;
    if (!this.flow || !source || !this.needsProcessor() || this.elementsKeyOf(this.state) !== this.flowElements) return;
    this.flow.setReturnUrl(source.return_url);
    this.flowKey = JSON.stringify([this.flowElements, source.return_url, (JSON.parse(this.flowKey || '[]') as unknown[])[2] ?? this.excludeAffirm]);
  }

  /** Shows the new amount and waits for a fresh press of Pay. */
  private async totalChanged(giftChanged: boolean, messageKey?: string): Promise<false> {
    await this.reload();
    this.approved = logic.outstandingOf(this.state);
    this.carryReturnUrl();
    // The refresh cannot mount while the payment is submitting, so a new processor balance brings the card form back here.
    if (this.needsProcessor() && (!this.flow || this.elementsKeyOf(this.state) !== this.flowElements) && this.paymentNode() && this.snap.paymentState !== 'loading') {
      await this.mountPayment();
      if (this.snap.paymentState === 'unavailable') return false;
    }
    this.flow?.updateAmount(logic.processorMoney(this.state));
    this.setPaymentState('total_changed', { message: giftChanged ? this.msg('gift_card_changed') : this.msg(messageKey ?? 'total_changed', { amount: formatMoney(this.approved) }) });
    return false;
  }

  private async advance(next: string, clientAction: ClientAction | undefined) {
    switch (next) {
      case 'done':
        this.setPaymentState('succeeded');
        this.goComplete();
        return;
      case 'bank_processing':
        this.setPaymentState('bank_processing');
        this.goComplete();
        return;
      case 'authenticate':
        await this.authenticate(clientAction);
        return;
      case 'resume':
        await this.recoverOutcome('resume');
        return;
      case 'wait':
        await this.recoverOutcome('read');
        return;
      case 'pay_remaining':
        this.flow?.clearPayment();
        this.setPaymentState('pay_remaining', { message: this.msg('pay_remaining', { paid: formatMoney(this.state.order.settlement_amounts?.paid_money), remaining: formatMoney(logic.outstandingOf(this.state)) }) });
        return;
      case 'new_payment': {
        const code = logic.declineCode(this.state);
        this.flow?.clearPayment();
        if (logic.affirmShouldBeRemoved(code)) this.excludeAffirm = true;
        // A page that opened straight into recovery has no card form yet. Mount it before offering a new payment.
        await this.mountPayment();
        this.setPaymentState('declined', { message: this.msg(logic.declineKey(logic.declineMessageCode(this.state))), code: code ?? '' });
        return;
      }
      default:
        this.setPaymentState('unavailable', { message: this.msg('bug_checkout') });
    }
  }

  private async authenticate(clientAction: ClientAction | undefined) {
    this.setPaymentState('authenticating', { message: '' });
    let action = clientAction;
    if (!action) {
      const read = await this.request('GET', '/attempt');
      if (!read.ok) {
        await this.recoverOutcome('read');
        return;
      }
      if (read.state) this.applyState(read.state);
      if (read.next !== 'authenticate') {
        await this.advance(read.next ?? 'wait', undefined);
        return;
      }
      action = read.client_action;
    }
    const dedupeKey = this.pendingActionId || this.state.attempt?.pending_actions?.[0]?.pending_action_id || '';
    const seen = dedupeKey ? (this.handledActions.get(dedupeKey) ?? 0) : 0;
    if (seen > 0) {
      // This action already ran in this page. Ask once more, then wait for the real outcome.
      if (seen === 1) {
        this.handledActions.set(dedupeKey, 2);
        await this.recoverOutcome('resume');
      } else {
        await this.recoverOutcome('read');
      }
      return;
    }
    // The card form's guidance is cleared while an action is pending, so Stripe runs it without Elements.
    const run = await runClientAction(action, { onInvoke: () => { if (dedupeKey) this.handledActions.set(dedupeKey, 1); } });
    if (!run.invoked) {
      // Nothing ran, so the action is not marked as seen and a reload tries it again. No more requests.
      this.setPaymentState('unavailable', { message: this.msg('bug_checkout') });
      return;
    }
    // Resume whether or not the provider call returned an error: Flint decides the outcome.
    await this.recoverOutcome('resume');
  }

  /**
   * The one recovery loop for a payment whose outcome is not known yet. `resume` sends an empty
   * `POST /resume`; the app replays its saved request and key, so a retry cannot create a second
   * charge. `read` only reads the attempt. Both are bounded, and the buyer gets Check again after.
   */
  private async recoverOutcome(first: 'resume' | 'read') {
    const generation = ++this.generation;
    this.set({ checkAgain: false });
    const started = Date.now();
    let delay = POLL_START_MS;
    let posts = 0;
    let step = first;
    while (generation === this.generation) {
      let result: JobResult;
      if (step === 'resume') {
        posts += 1;
        this.setPaymentState('resuming', { message: '' });
        result = await this.request('POST', '/resume', {});
      } else {
        this.setPaymentState('waiting', { message: '' });
        result = await this.request('GET', '/attempt');
      }
      if (generation !== this.generation) return;
      if (result.ok) {
        if (result.state) this.applyState(result.state);
        const next = result.next ?? 'wait';
        if (next !== 'resume' && next !== 'wait') {
          await this.advance(next, result.client_action);
          return;
        }
        step = next === 'resume' ? 'resume' : 'read';
      } else if (!this.isUncertain(result)) {
        await this.handlePayError(result);
        return;
      }
      const spent = Date.now() - started >= POLL_LIMIT_MS;
      // A resume that keeps answering resume will not change by reading, so stop sending after the cap.
      const capped = step === 'resume' && posts >= MAX_RESUME_POSTS;
      if (spent || capped) {
        this.setPaymentState('waiting', { message: this.msg('still_confirming'), focus: false, tone: 'warning' });
        this.set({ checkAgain: true });
        this.announce(this.msg('still_confirming'));
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, delay));
      delay = Math.min(POLL_MAX_MS, Math.round(delay * 1.5));
    }
  }

  checkAgain() {
    return this.recoverOutcome(this.state.next === 'resume' ? 'resume' : 'read');
  }

  async continueAffirm() {
    const read = await this.request('GET', '/attempt');
    if (!read.ok) {
      this.set({ message: { text: this.errorText(read.error), tone: 'error', focus: Date.now() } });
      this.focus('payment-message');
      return;
    }
    if (read.state) this.applyState(read.state);
    if (read.next === 'authenticate') {
      this.handledActions.clear();
      await this.authenticate(read.client_action);
    } else {
      await this.advance(read.next ?? 'wait', read.client_action);
    }
  }

  async payAnotherWay() {
    const result = await this.uiJobs.run(() => this.request('POST', '/cancel-attempt', {}));
    if (!result.ok) {
      this.set({ message: { text: this.errorText(result.error), tone: 'error', focus: Date.now() } });
      this.focus('payment-message');
      return;
    }
    this.excludeAffirm = false;
    if (result.state) this.applyState(result.state);
    await this.reload();
    await this.mountPayment();
    this.setPaymentState('ready', { message: '', focus: false });
    this.focus('payment-title');
  }

  // ----- Boot -----

  async start() {
    if (this.started) return;
    this.started = true;
    void this.uiJobs.run(() => this.request('POST', '/timezone', { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
    const resting = logic.derivePaymentState(this.state);
    const declineText = () => this.msg(logic.declineKey(logic.declineMessageCode(this.state)));
    switch (resting) {
      case 'ready':
      case 'declined':
      case 'pay_remaining': {
        await this.mountPayment();
        const message = resting === 'declined' ? declineText() : resting === 'pay_remaining' ? this.msg('pay_remaining', { paid: formatMoney(this.state.order.settlement_amounts?.paid_money), remaining: formatMoney(logic.outstandingOf(this.state)) }) : undefined;
        if (!this.needsProcessor()) this.setPaymentState(resting, message ? { message, focus: false, code: logic.declineCode(this.state) ?? '' } : {});
        else if (resting !== 'ready' && ['loading', 'ready', 'declined', 'pay_remaining'].includes(this.snap.paymentState)) this.setPaymentState(resting, { message, focus: false, code: logic.declineCode(this.state) ?? '' });
        else if (this.snap.paymentState === 'loading' && this.snap.elementsReady) this.setPaymentState(resting);
        break;
      }
      case 'authenticating':
        await this.authenticate(undefined);
        break;
      case 'resuming':
        // The app holds an unresolved payment request, possibly with no attempt yet. No form work is needed.
        await this.recoverOutcome('resume');
        break;
      case 'waiting':
        await this.recoverOutcome('read');
        break;
      case 'bank_processing':
        this.setPaymentState('bank_processing');
        this.goComplete();
        break;
      case 'affirm_incomplete':
        await this.mountPayment();
        this.setPaymentState('affirm_incomplete', { message: this.msg('affirm_incomplete'), focus: false });
        break;
      case 'recovery':
        this.setPaymentState('recovery', { message: this.msg('finishing_payment'), focus: false });
        await this.recoverOutcome('read');
        break;
      case 'succeeded':
        this.goComplete();
        break;
      default:
        this.setPaymentState(resting);
    }
    this.maybeAutoRequote();
    if (this.state.order.customer_id && resting !== 'expired') void this.loadSavedMethods();
  }

  private detachTimer = 0;
  /** React may unmount and remount in development. The controller stops only if the page really goes away. */
  attach() {
    window.clearTimeout(this.detachTimer);
  }
  detach() {
    this.detachTimer = window.setTimeout(() => this.destroy(), 0);
  }

  destroy() {
    this.generation += 1;
    this.leaveGift('none');
    this.flow?.destroy();
    this.flow = null;
  }
}
