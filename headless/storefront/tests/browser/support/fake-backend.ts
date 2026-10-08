// LOCAL STATE TEST SERVICE. Not Flint, not the storefront app, and not staging.
//
// This in-memory stand-in answers the checkout JSON jobs with the shapes the
// views and public/js/checkout.js consume, so frontend states can be tested
// without credentials. Passing tests here prove frontend behavior only. They
// say nothing about Flint, Stripe, or the real app. Staging acceptance lives in
// tests/browser/acceptance and runs against the real app and a sandbox.

import type { CheckoutState, Money } from '../../../src/views/types.ts';
import { baseOrder, guidance, scenarioConfig, usd, type FakeConfig, type Scenario } from './fixtures.ts';

type Json = Record<string, any>;
export type Reply = { status: number; body: Json };

const big = (money: Money | null | undefined) => BigInt(money?.amount ?? '0');

function fail(status: number, kind: string, code: string, messageKey: string, state: Json): Reply {
  return { status, body: { error: { kind, code, message_key: messageKey, request_id: 'req_fixture' }, state } };
}

export class FakeCheckout {
  ref: string;
  scenario: Scenario;
  config: FakeConfig;
  order: Json;
  session: Json;
  attempt: Json | null = null;
  notices: string[] = [];
  quote: Json | null = null;
  selection: Json | null = null;
  verification: Json | null = null;
  contactName = '';
  savedMethods: Json[] = [];
  pickupLocations: Json[] | null = null;
  /** An unresolved saved pay request the app must replay. Nothing in the browser can change it. */
  journal: { remaining: number; outcome: 'ok' | 'fail' } | null = null;
  subscription: Json | null = null;
  log: { method: string; path: string; body: unknown }[] = [];
  payCount = 0;
  resumeCount = 0;
  attemptReads = 0;
  staleOnce = false;
  staleServed = false;
  seq = 0;
  giftCode = '';
  discountCode = '';
  tip: Json | null = null;
  totalBump = 0n;
  pendingBehavior = '';
  user: { name: string; email: string } | null = null;

  constructor(ref: string) {
    this.ref = ref;
    this.scenario = (ref.replace(/^chk_/, '') as Scenario) || 'card';
    this.config = scenarioConfig(this.scenario);
    this.order = baseOrder(this.config);
    this.session = {
      status: 'open',
      recovery_mode: false,
      delivery_selection_required: this.config.needsDelivery,
      merchant_support: { email: 'support@example.test', phone: '555-0100', url: 'https://example.test/help' },
      promotion_config: { codes_enabled: true },
      save_payment_method_offered: ['card', 'signedin', 'returning'].includes(this.scenario) || this.scenario === 'pickup',
      save_payment_method_phone_offered: false,
      save_payment_method_requires_verification: this.scenario === 'returning',
      problems: [],
    };
    if (this.config.kind === 'subscription') {
      this.order.line_items = [
        { order_line_item_id: 'li_sub', name: 'Coffee club', quantity: 1, unit_price_money: usd(2200), total_money: usd(2200), slug: undefined },
      ];
      this.session.subscription_terms = {
        plan_name: this.config.trial ? 'Coffee club with a 14-day free trial' : 'Coffee club, monthly',
        billing_interval: 'month',
        billing_interval_count: 1,
        recurring_total_money: usd(2200),
        ...(this.config.trial ? { trial_period_days: 14 } : {}),
      };
    }
    if (this.scenario === 'signedin') {
      this.order.customer_id = 'cus_fixture_1';
      this.user = { name: 'Test Buyer', email: 'buyer@example.test' };
      this.savedMethods = [{ payment_method_id: 'pm_fixture_visa', type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2028 } }];
    }
    this.recalc();
    this.initScenario();
    this.recalc();
  }

  private initScenario() {
    const s = this.scenario;
    const stripePending = (kind: 'payment_intent' | 'setup_intent') => ({
      pending_action_id: 'pa_fixture_1',
      action_type: 'handle_next_action',
      client_action: { stripe: { publishable_key: 'pk_test_fixture', account_id: 'acct_fixture', [kind]: { client_secret: 'pi_fixture_secret_fixture', stripe_js_call: 'handle_next_action' } } },
    });
    if (s === 'expired') this.session.status = 'expired';
    if (s === 'recovery') {
      this.session.recovery_mode = true;
      this.attempt = this.makeAttempt('requires_action', { is_resumable: true, pending_actions: [stripePending('payment_intent')] });
      this.pendingBehavior = '3ds';
    }
    if (s === 'authenticating') {
      this.attempt = this.makeAttempt('requires_action', { is_resumable: true, pending_actions: [stripePending('payment_intent')] });
      this.pendingBehavior = '3ds';
    }
    if (s === 'lostresume') this.journal = { remaining: 2, outcome: 'ok' };
    if (s === 'resumefail') this.journal = { remaining: 1, outcome: 'fail' };
    if (s === 'stuckresume') this.journal = { remaining: Number.POSITIVE_INFINITY, outcome: 'ok' };
    if (s === 'waiting') {
      this.attempt = this.makeAttempt('processing', { is_resumable: false });
      this.pendingBehavior = 'slow';
    }
    if (s === 'bank') this.attempt = this.makeAttempt('processing', { is_resumable: false, selected: 'ach_debit' });
    if (s === 'affirm') {
      this.attempt = this.makeAttempt('requires_action', { is_resumable: true, selected: 'affirm', pending_actions: [stripePending('payment_intent')] });
      this.notices.push('affirm_incomplete');
      this.pendingBehavior = 'affirm';
    }
    if (s === 'declined') this.attempt = this.makeAttempt('failed', { is_resumable: false, failure_code: 'incorrect_cvc' });
    if (s === 'remaining') this.attempt = this.makeAttempt('partially_succeeded', { is_resumable: false });
    if (s === 'paid') this.markPaid();
    if (s === 'bankdone') this.attempt = this.makeAttempt('processing', { is_resumable: false, selected: 'ach_debit' });
    if (s === 'returning') this.session.save_payment_method_requires_verification = true;
    if (s === 'unavailable') this.session.unavailable = true;
  }

  private makeAttempt(status: string, extra: Json = {}): Json {
    this.seq += 1;
    // Attempt legs carry no source type. The order's payment intents do, matched by id.
    this.order.payment_intents = extra.selected ? [{ payment_intent_id: `pi_fixture_${this.seq}`, status, payment_source: { type: extra.selected } }] : [];
    return {
      order_payment_attempt_id: `opa_fixture_${this.seq}`,
      status,
      mode: 'payment',
      is_resumable: false,
      expected_outstanding_money: this.order.settlement_amounts?.outstanding_money ?? usd(0),
      failure_code: extra.failure_code,
      pending_actions: extra.pending_actions,
      payment_intents: [
        {
          payment_intent_id: `pi_fixture_${this.seq}`,
          status: status === 'failed' ? 'requires_payment_method' : status,
          amount_money: this.order.settlement_amounts?.outstanding_money ?? usd(0),
          last_payment_error: extra.failure_code ? { code: extra.failure_code, message: 'fixture' } : undefined,
        },
      ],
      ...extra,
    };
  }

  private markPaid() {
    this.order.payment_status = 'paid';
    this.order.status = 'paid';
    this.session.status = 'paid';
    const total = this.order.pricing_amounts?.total_money ?? usd(0);
    this.order.settlement_amounts = { outstanding_money: usd(0), paid_money: total };
    this.attempt = this.makeAttempt('succeeded', { is_resumable: false });
    const gift = this.order.gift_card_estimate;
    this.order.gift_card_settlements = gift ? [{ amount_money: gift.gift_card_money, last_characters: '4821' }] : [];
    if (this.config.kind === 'subscription') {
      this.subscription = {
        subscription_id: 'sub_fixture_1',
        status: this.config.trial ? 'trialing' : 'active',
        trial_end: '2026-10-21',
        next_billing_at: '2026-10-21',
        recurring_amount_money: usd(2200),
        subscription_plan: { name: this.session.subscription_terms.plan_name },
        payment_method: { card: { brand: 'visa', last4: '4242' } },
      };
    }
  }

  // ----- Totals -----

  recalc() {
    const o = this.order;
    let subtotal = 0n;
    for (const line of o.line_items) subtotal += big(line.total_money);
    let discount = 0n;
    o.applied_discounts = [];
    if (this.discountCode) {
      discount = this.discountCode === 'FREE100' ? subtotal : (subtotal * 10n) / 100n;
      o.applied_discounts = [{ order_discount_id: 'disc_fixture_1', customer_facing_name: '10 percent off', promotion_code: this.discountCode, applied_money: usd(discount) }];
    }
    const charge = this.selection ? big(this.selection.amount_money) : 0n;
    o.charges = this.selection && charge > 0n ? [{ name: 'Standard shipping', applied_money: usd(charge) }] : [];
    const base = subtotal - discount;
    let tipMoney = 0n;
    if (this.tip?.percent) tipMoney = (base * BigInt(this.tip.percent)) / 100n;
    if (this.tip?.amount_money) tipMoney = big(this.tip.amount_money);
    o.requested_tip = this.tip;
    const needsLocation = this.config.needsDelivery && !this.selection;
    const taxable = base + charge;
    const tax = needsLocation || this.config.kind === 'subscription' ? 0n : (taxable * 825n) / 10000n;
    o.tax = { status: needsLocation ? 'requires_location' : 'calculated', enabled: true };
    let total = base + charge + tipMoney + tax + this.totalBump;
    if (this.config.kind === 'subscription' && this.config.trial) total = 0n;
    o.pricing_amounts = {
      subtotal_money: usd(subtotal),
      discount_money: usd(discount),
      charge_money: usd(charge),
      requested_tip_money: usd(tipMoney),
      tax_money: usd(tax),
      total_money: usd(total),
    };
    if (this.order.payment_status !== 'paid') {
      o.settlement_amounts = { outstanding_money: usd(total), paid_money: usd(this.scenario === 'remaining' ? 1000 : 0) };
      if (this.scenario === 'remaining' && this.attempt?.status === 'partially_succeeded') o.settlement_amounts = { outstanding_money: usd(total - 1000n), paid_money: usd(1000) };
    }
    if (this.giftCode) {
      const available = this.giftCode === 'FULLCARD' ? total : 2500n;
      const applied = available > total ? total : available;
      o.gift_cards = [{ gift_card_id: 'gc_fixture_1', last_characters: '4821', available_money: usd(available) }];
      o.gift_card_estimate = { can_pay: true, gift_card_money: usd(applied), processor_money: usd(total - applied), gift_cards: [{ gift_card_id: 'gc_fixture_1', amount_money: usd(applied) }] };
    } else {
      o.gift_cards = [];
      o.gift_card_estimate = null;
    }
    o.order_revision = String(Number(o.order_revision ?? 3) + 0);
  }

  // ----- Projection -----

  collectionKind(): string {
    const outstanding = big(this.order.settlement_amounts.outstanding_money);
    if (this.config.kind === 'subscription') return outstanding === 0n ? 'setup' : 'processor';
    if (this.scenario === 'unavailable') return 'unavailable';
    const est = this.order.gift_card_estimate;
    if (outstanding === 0n || (this.order.gift_cards.length && est?.can_pay && big(est.processor_money) === 0n)) return 'settlement';
    return 'processor';
  }

  nextStep(): string {
    // An unresolved saved request takes precedence, even before any attempt exists.
    if (this.journal) return 'resume';
    const a = this.attempt;
    if (!a) return 'new_payment';
    if (a.status === 'succeeded') return 'done';
    if (a.status === 'partially_succeeded') return 'pay_remaining';
    if (['failed', 'canceled', 'expired'].includes(a.status)) return 'new_payment';
    if (a.status === 'requires_action') return 'authenticate';
    if (a.status === 'processing' && !a.is_resumable && a.payment_intents?.some((leg: Json) => this.order.payment_intents?.some((pi: Json) => pi.payment_intent_id === leg.payment_intent_id && pi.payment_source?.type === 'ach_debit'))) return 'bank_processing';
    return a.is_resumable ? 'resume' : 'wait';
  }

  project(): CheckoutState {
    const kind = this.collectionKind();
    const money = (this.order.settlement_amounts as Json).outstanding_money;
    const guide = kind === 'setup' ? undefined : kind === 'settlement' || kind === 'unavailable' ? undefined : guidance('payment', usd(big(this.order.gift_card_estimate?.processor_money ?? money)), this.scenario === 'wallet' ? { digital_wallets: ['apple_pay', 'google_pay'] } : {});
    const setupGuide = kind === 'setup' ? guidance('setup', usd(0)) : undefined;
    return {
      checkout_ref: this.ref,
      kind: this.config.kind,
      collection_kind: kind,
      contact_name: this.contactName || undefined,
      session: JSON.parse(JSON.stringify(this.session)),
      order: JSON.parse(JSON.stringify(this.order)),
      attempt: this.attempt ? JSON.parse(JSON.stringify(this.attempt)) : undefined,
      next: this.nextStep(),
      payment_collection: guide,
      setup_collection: setupGuide,
      delivery_quote: this.quote,
      delivery_selection: this.selection,
      pickup_locations: this.pickupLocations,
      verification: this.verification,
      notices: [...this.notices],
      approved_outstanding_money: money,
    } as unknown as CheckoutState;
  }

  // ----- Jobs -----

  private ok(): Reply {
    return { status: 200, body: { state: this.project() } };
  }

  private paymentReply(extra: Json = {}): Reply {
    const attempt = this.attempt;
    const pending = attempt?.status === 'requires_action' ? attempt.pending_actions?.[0] : undefined;
    return {
      status: 200,
      body: { state: this.project(), next: this.nextStep(), client_action: pending?.client_action?.stripe, pending_action_id: pending?.pending_action_id, ...extra },
    };
  }

  handle(method: string, name: string, body: Json): Reply {
    this.log.push({ method, path: name, body: sanitizeBody(body) });
    const locked = this.journal !== null || (this.attempt && ['requires_action', 'processing', 'requires_retry'].includes(this.attempt.status));
    const mutating = ['contact', 'discount', 'discount/remove', 'delivery/quote', 'pickup-locations', 'delivery/select', 'gift-card', 'tip'].includes(name) || name.startsWith('gift-card/');
    if (mutating && name !== 'contact' && locked) return fail(409, 'conflict', 'PAYMENT_ATTEMPT_IN_PROGRESS', 'payment_attempt_in_progress', this.project());
    switch (name) {
      case 'contact':
        return this.contact(body);
      case 'timezone':
        return this.ok();
      case 'verification':
        this.verification = { status: 'code_sent', delivery_channel: body.channel === 'email' ? 'email' : 'sms', masked_email: 'b***@example.test', phone_last_digits: '0100' };
        return this.ok();
      case 'verification/confirm':
        if (String(body.code) !== '123456') return fail(400, 'validation', 'CUSTOMER_VERIFICATION_CODE_INVALID', 'customer_verification_code_invalid', this.project());
        this.verification = null;
        this.order.customer_id = 'cus_fixture_2';
        this.savedMethods = [{ payment_method_id: 'pm_fixture_mc', type: 'card', card: { brand: 'mastercard', last4: '4444', exp_month: 3, exp_year: 2029 } }];
        return this.ok();
      case 'discount':
        return this.discount(body);
      case 'discount/remove':
        this.discountCode = '';
        this.releaseSelection();
        this.recalc();
        return this.ok();
      case 'delivery/quote':
        return this.deliveryQuote(body, false);
      case 'pickup-locations':
        return this.deliveryQuote(body, true);
      case 'delivery/select':
        return this.deliverySelect(body);
      case 'gift-card':
        return this.giftCard(body);
      case 'tip':
        return this.tipJob(body);
      case 'saved-methods':
        return { status: 200, body: { state: { ...this.project(), saved_methods: this.savedMethods } } };
      case 'pay':
        return this.pay(body);
      case 'resume':
        return this.resume();
      case 'attempt':
        return this.readAttempt();
      case 'cancel-attempt':
        this.attempt = this.makeAttempt('canceled', { is_resumable: false });
        this.notices = this.notices.filter((key) => key !== 'affirm_incomplete');
        return this.paymentReply();
      case 'receipt':
        return { status: 200, body: { state: this.project() } };
      default:
        if (name.startsWith('gift-card/')) {
          this.giftCode = '';
          this.recalc();
          return this.ok();
        }
        return fail(404, 'not_found', 'NOT_FOUND', 'not_found', this.project());
    }
  }

  private contact(body: Json): Reply {
    if (body.name) this.contactName = String(body.name);
    this.order.buyer_contact = { email: body.email ?? this.order.buyer_contact?.email ?? null, phone: body.phone ?? this.order.buyer_contact?.phone ?? null };
    return this.ok();
  }

  private releaseSelection() {
    if (this.selection) {
      this.selection = null;
      this.session.delivery_selection_required = true;
      this.quote = null;
      if (!this.notices.includes('delivery_released')) this.notices.push('delivery_released');
    }
  }

  private discount(body: Json): Reply {
    const code = String(body.promotion_code).toUpperCase();
    if (!['WELCOME10', 'FREE100'].includes(code)) return fail(400, 'validation', 'PROMOTION_CODE_INVALID', 'promotion_code_invalid', this.project());
    this.discountCode = code;
    this.releaseSelection();
    this.recalc();
    return this.ok();
  }

  private deliveryQuote(body: Json, pickup: boolean): Reply {
    const postal = String(pickup ? body.postal_code : body.destination_address?.postal_code ?? '');
    const group = (options: Json[], availability: string) => ({
      delivery_choice_group_id: 'grp_fixture_1',
      availability_status: availability,
      evaluation_status: 'complete',
      method_types: pickup ? ['pickup'] : ['shipment', 'pickup'],
      options,
      input_requirements: [],
    });
    const ship = {
      delivery_option_id: 'opt_ship_std',
      delivery_method_id: 'dm_ship',
      name: 'Standard shipping',
      type: 'shipment',
      amount_money: usd(900),
      arrival_estimate: { earliest_date: '2026-10-12', latest_date: '2026-10-15' },
    };
    const pick = {
      delivery_option_id: 'opt_pickup',
      delivery_method_id: 'dm_pickup',
      name: 'Pickup at the roastery',
      type: 'pickup',
      amount_money: usd(0),
      pickup: { pickup_mode: 'in_store', location: { location_id: 'loc_fixture', name: 'Cedar & Stone Roastery', address: { line1: '400 Congress Ave', city: 'Austin', state: 'TX', postal_code: '78701' }, instructions: 'Ask at the counter.' } },
    };
    const unavailable = postal === '99999' && !pickup;
    const noneNearby = pickup && postal === '99999';
    if (!pickup && body.destination_address?.line1 === 'Stale St' && !this.staleServed) {
      this.staleOnce = true;
      this.staleServed = true;
    }
    this.quote = {
      delivery_quote_id: `dq_fixture_${++this.seq}`,
      status: 'open',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      buyer_reasons: unavailable ? ['This address is outside the delivery area.'] : noneNearby ? ['no_pickup_location_nearby'] : [],
      selection_required: true,
      ...(pickup ? { buyer_location: { type: 'address', address: { postal_code: postal, country: 'US' } } } : { destination_address: body.destination_address }),
      choice_groups: [unavailable ? group([], 'unavailable') : noneNearby ? group([], 'ready') : group(pickup ? [pick] : [ship], 'ready')],
      input_requirements: [],
    };
    this.pickupLocations = pickup && !noneNearby ? [{ ...pick, delivery_choice_group_id: 'grp_fixture_1', availability_status: 'ready', display_position: 0 }] : null;
    return this.ok();
  }

  private deliverySelect(body: Json): Reply {
    if (!this.quote) return fail(409, 'conflict', 'DELIVERY_QUOTE_STALE', 'delivery_quote_stale', this.project());
    if (this.staleOnce) {
      this.staleOnce = false;
      return fail(409, 'conflict', 'DELIVERY_QUOTE_STALE', 'delivery_quote_stale', this.project());
    }
    const picked = body.choices?.[0];
    const options: Json[] = this.quote.choice_groups.flatMap((g: Json) => g.options);
    const option = options.find((o) => o.delivery_option_id === picked?.delivery_option_id);
    if (!option) return fail(400, 'validation', 'INVALID_DELIVERY_SELECTION', 'invalid_delivery_selection', this.project());
    const needsPhone = this.quote.destination_address?.state === 'NY' && !body.recipient?.phone;
    this.selection = {
      delivery_selection_id: `dsel_fixture_${++this.seq}`,
      status: 'active',
      amount_money: option.amount_money,
      destination_address: this.quote.destination_address,
      recipient: body.recipient,
      input_requirements: needsPhone ? [{ field_path: 'recipient.phone', purpose: 'recipient_phone' }] : [],
      choices: [{ delivery_choice_group_id: picked.delivery_choice_group_id, delivery_option_id: option.delivery_option_id, name: option.name, type: option.type, amount_money: option.amount_money, arrival_estimate: option.arrival_estimate, pickup: option.pickup }],
    };
    this.quote = null;
    this.order.delivery_destination = option.type === 'pickup' ? null : { address: this.selection.destination_address, recipient: { name: body.recipient?.name } };
    this.recalc();
    return this.ok();
  }

  private giftCard(body: Json): Reply {
    const code = String(body.gift_card_code).toUpperCase();
    if (code === 'CHALLENGE') return fail(403, 'validation', 'GIFT_CARD_CHALLENGE_REQUIRED', 'gift_card_challenge_required', this.project());
    if (!['GOODCARD', 'FULLCARD'].includes(code)) return fail(404, 'validation', 'GIFT_CARD_UNAVAILABLE', 'gift_card_unavailable', this.project());
    this.giftCode = code;
    this.recalc();
    return this.ok();
  }

  private tipJob(body: Json): Reply {
    if (body.clear) this.tip = null;
    else if (body.percent !== undefined) this.tip = { percent: Number(body.percent) };
    else if (/^\d+(\.\d{1,2})?$/.test(String(body.amount))) this.tip = { amount_money: usd(Math.round(Number(body.amount) * 100)) };
    else return fail(400, 'validation', 'INVALID_TIP', 'invalid_tip', this.project());
    this.recalc();
    return this.ok();
  }

  // ----- Payment -----

  private behaviorOf(body: Json): string {
    const value = String(body.credential?.value ?? '');
    const match = /_fake_(\w+)$/.exec(value);
    return match?.[1] ?? (body.credential?.kind === 'saved_payment_method' ? 'ok' : 'ok');
  }

  private pay(body: Json): Reply {
    this.payCount += 1;
    // No new payment while a saved request is unresolved. Only POST /resume may continue it.
    if (this.journal) return fail(409, 'conflict', 'CHECKOUT_PAYMENT_RESOLVING', 'checkout_payment_resolving', this.project());
    const kind = this.collectionKind();
    if (body.approved_collection_kind !== kind) return fail(400, 'validation', 'INVALID_PAYMENT_APPROVAL', 'invalid_payment_approval', this.project());
    const outstanding = this.order.settlement_amounts.outstanding_money as Money;
    if (!body.approved_outstanding_money || body.approved_outstanding_money.amount !== outstanding.amount) {
      return this.paymentReply({ error: { kind: 'conflict', code: 'ORDER_CHANGED_REFRESH_REQUIRED', message_key: 'total_changed', request_id: 'req_fixture' } });
    }
    if (this.order.gift_cards.length && (String(body.approved_order_revision) !== String(this.order.order_revision) || !body.approved_gift_card_money)) {
      return this.paymentReply({ error: { kind: 'conflict', code: 'ORDER_CHANGED_REFRESH_REQUIRED', message_key: 'gift_card_changed', request_id: 'req_fixture' } });
    }
    if (this.session.delivery_selection_required && !this.selection) return fail(409, 'conflict', 'FULFILLMENT_SELECTION_REQUIRED', 'fulfillment_selection_required', this.project());
    if (this.attempt && ['requires_action', 'processing', 'requires_retry'].includes(this.attempt.status)) return fail(409, 'conflict', 'ORDER_PAYMENT_ATTEMPT_ACTIVE', 'order_payment_attempt_active', this.project());
    const behavior = kind === 'settlement' ? 'ok' : this.behaviorOf(body);
    if (body.save_payment_method) this.log.push({ method: 'POST', path: 'pay:save', body: { save: true } });
    switch (behavior) {
      case 'changed':
        this.totalBump += 100n;
        this.recalc();
        return this.paymentReply({ error: { kind: 'conflict', code: 'ORDER_CHANGED_REFRESH_REQUIRED', message_key: 'total_changed', request_id: 'req_fixture' } });
      case 'decline':
        this.attempt = this.makeAttempt('failed', { failure_code: 'card_declined' });
        return this.paymentReply();
      case 'cvc':
        this.attempt = this.makeAttempt('failed', { failure_code: 'incorrect_cvc' });
        return this.paymentReply();
      case 'affirmdeclined':
        this.attempt = this.makeAttempt('failed', { failure_code: 'payment_method_declined', selected: 'affirm' });
        return this.paymentReply();
      case '3ds':
      case '3dsfail':
        this.pendingBehavior = behavior;
        this.attempt = this.makeAttempt('requires_action', {
          is_resumable: true,
          pending_actions: [{ pending_action_id: `pa_fixture_${++this.seq}`, action_type: 'handle_next_action', client_action: { stripe: { publishable_key: 'pk_test_fixture', account_id: 'acct_fixture', payment_intent: { client_secret: 'pi_fixture_secret_fixture', stripe_js_call: 'handle_next_action' } } } }],
        });
        return this.paymentReply();
      case 'lostsend':
        // Several sends had unknown outcomes and Flint shows no attempt yet: the app answers resume.
        this.journal = { remaining: 2, outcome: 'ok' };
        return this.paymentReply();
      case 'unknown':
      case 'slow':
        this.pendingBehavior = behavior;
        this.attemptReads = 0;
        this.attempt = this.makeAttempt('processing', { is_resumable: false });
        return this.paymentReply();
      case 'bank':
        this.attempt = this.makeAttempt('processing', { is_resumable: false, selected: 'ach_debit' });
        return this.paymentReply();
      default:
        this.markPaid();
        return this.paymentReply();
    }
  }

  private resume(): Reply {
    this.resumeCount += 1;
    if (this.journal) {
      // Replays the saved original request. The browser sends nothing new.
      this.journal.remaining -= 1;
      if (this.journal.remaining <= 0) {
        const outcome = this.journal.outcome;
        this.journal = null;
        if (outcome === 'ok') this.markPaid();
        else this.attempt = this.makeAttempt('failed', { failure_code: 'card_declined' });
      }
      return this.paymentReply();
    }
    if (!this.attempt || this.attempt.status !== 'requires_action') return this.paymentReply();
    if (this.pendingBehavior === '3dsfail') this.attempt = this.makeAttempt('failed', { failure_code: 'authentication_required' });
    else if (this.pendingBehavior === 'affirm') {
      this.attempt = this.makeAttempt('requires_action', {
        is_resumable: true,
        selected: 'affirm',
        pending_actions: [{ pending_action_id: `pa_fixture_${++this.seq}`, action_type: 'handle_next_action', client_action: { stripe: { publishable_key: 'pk_test_fixture', account_id: 'acct_fixture', payment_intent: { client_secret: 'pi_fixture_secret_fixture', stripe_js_call: 'handle_next_action' } } } }],
      });
    } else this.markPaid();
    return this.paymentReply();
  }

  private readAttempt(): Reply {
    this.attemptReads += 1;
    if (this.attempt?.status === 'processing' && this.nextStep() !== 'bank_processing') {
      const needed = this.pendingBehavior === 'slow' ? 1000 : 2;
      if (this.attemptReads >= needed) this.markPaid();
    }
    return this.paymentReply();
  }
}

function sanitizeBody(body: Json): unknown {
  const clone: Json = JSON.parse(JSON.stringify(body ?? {}));
  if (clone.gift_card_code) clone.gift_card_code = '[code]';
  if (clone.code) clone.code = '[code]';
  return clone;
}
