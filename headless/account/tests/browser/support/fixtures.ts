// Synthetic fixtures for the LOCAL STATE tests. Every identifier, email, and amount here is made up.
// These tests render the real views with canned data to check frontend states. They are not
// acceptance evidence: nothing here talks to Flint or to Stripe.

import type {
  BuyerAction,
  BuyerCapabilities,
  BuyerCreditNote,
  BuyerFulfillmentEvent,
  BuyerGiftCard,
  BuyerGiftCardTransaction,
  BuyerInvoice,
  BuyerSubscriptionPaymentRetry,
  CustomerAddress,
  CustomerDeletionRequest,
  EmailChangeRequest,
  Fulfillment,
  MoneyValue,
  Order,
  Package,
  PageId,
  PaymentIntent,
  PaymentMethod,
  PaymentState,
  RenderContext,
  ReturnEligibilityCheck,
  ReturnReason,
  ReturnResource,
  Subscription,
} from '../../../src/views/index.ts';

export const ids = {
  order: 'ord_example_001',
  order2: 'ord_example_002',
  invoice: 'inv_example_001',
  returnId: 'ret_example_001',
  subscription: 'sub_example_001',
  method: 'pm_example_001',
  method2: 'pm_example_002',
  address: 'adr_example_001',
  giftCard: 'gc_example_001',
  retry: 'spr_example_001',
  line: 'oli_example_001',
  fulfillment: 'ful_example_001',
};

export function usd(cents: number | string): MoneyValue {
  return { amount: String(cents), currency: 'USD' };
}

const asOf = '2026-10-07T15:04:00Z';

function action(kind: string, is_available: boolean, extra: Partial<BuyerAction> = {}): BuyerAction {
  return { kind, is_available, is_required: false, ...extra };
}

export function context<D>(data: D, overrides: Partial<RenderContext<D>> = {}): RenderContext<D> {
  return {
    storeName: 'Cedar & Stone',
    appOrigin: 'http://localhost:4291',
    storefrontOrigin: 'http://localhost:4100',
    csrf: 'csrf-example-token',
    user: { name: 'Avery Example', email: 'avery@example.test' },
    data,
    notices: [],
    support: { email: 'help@example.test', phone: '+1 512 555 0100', url: 'https://example.test/help' },
    timeZone: 'America/Chicago',
    ...overrides,
  };
}

export function order(overrides: Partial<Order> = {}): Order {
  return {
    order_id: ids.order,
    order_number: '1001',
    created_at: asOf,
    status: 'open',
    payment_status: 'paid',
    refund_status: 'none',
    fulfillment_status: 'fulfilled',
    buyer_actions: [action('start_return', true), action('resend_receipt', true)],
    line_items: [
      {
        order_line_item_id: ids.line,
        name: 'House blend coffee, 12 oz',
        quantity: '2',
        selected_options: [{ option_id: 'opt_1', option_name: 'Grind', option_value_id: 'val_1', value: 'Whole bean' }],
        unit_price_money: usd(1800),
        subtotal_money: usd(3600),
        base_subtotal_money: usd(3600),
        discount_money: usd(0),
        modifier_total_money: usd(0),
        refunded_money: usd(0),
        refunded_quantity: '0',
        tax_money: usd(297),
        total_money: usd(3897),
        version: '1',
      },
    ],
    pricing_amounts: {
      subtotal_money: usd(3600),
      discount_money: usd(0),
      charge_money: usd(900),
      requested_tip_money: usd(0),
      tax_money: usd(297),
      total_money: usd(4797),
    },
    settlement_amounts: {
      balance_money: { amount: '0', currency: 'USD' },
      credit_money: usd(0),
      net_collected_money: usd(4797),
      outstanding_money: usd(0),
      paid_money: usd(4797),
      refunded_money: usd(0),
      settled_tip_money: usd(0),
    },
    tax: { enabled: true, mode: 'automatic', status: 'calculated', taxability_reason: 'standard_rated' },
    delivery_destination: {
      source: 'delivery_selection',
      address: { line1: '100 Example Street', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' },
      recipient: { name: 'Avery Example' },
    },
    ...overrides,
  } as Order;
}

export function card(overrides: Partial<PaymentMethod> = {}): PaymentMethod {
  return {
    payment_method_id: ids.method,
    customer_id: 'cus_example_001',
    status: 'active',
    type: 'card',
    usage: 'off_session',
    card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
    ...overrides,
  } as PaymentMethod;
}

export function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    subscription_id: ids.subscription,
    customer_id: 'cus_example_001',
    status: 'active',
    cancel_at_period_end: false,
    billing_schedule_owner: 'flint',
    billing_interval: 'monthly',
    billing_interval_count: 1,
    current_period_end: '2026-11-01T17:00:00Z',
    next_billing_at: '2026-11-01T17:00:00Z',
    recurring_amount_money: usd(2200),
    subscription_plan: { name: 'Coffee club, monthly', billing_interval: 'monthly', billing_interval_count: 1, currency: 'USD', status: 'active', subscription_plan_id: 'plan_example_001' },
    payment_method: card(),
    line_items: [{ name: 'Coffee club, monthly', quantity: 1, subtotal_money: usd(2200), unit_price_money: usd(2200), base_subtotal_money: usd(2200), modifier_total_money: usd(0) }],
    buyer_actions: [
      action('cancel', true),
      action('pause', true),
      action('resume', false, { unavailable_reason: 'not_in_state' }),
      action('reactivate', false, { unavailable_reason: 'not_in_state' }),
      action('update_payment_method', true),
      action('retry_payment', false, { unavailable_reason: 'not_in_state' }),
    ],
    ...overrides,
  } as Subscription;
}

export function invoice(overrides: Partial<BuyerInvoice> = {}): BuyerInvoice {
  return {
    invoice_id: ids.invoice,
    invoice_number: 'INV-1001',
    status: 'open',
    is_overdue: false,
    issued_at: '2026-10-01T15:00:00Z',
    due_at: '2026-10-15T15:00:00Z',
    memo: 'Office coffee service, October',
    order_id: ids.order2,
    collection_block_status: 'none',
    late_fees: [],
    credit_money: usd(0),
    currently_due_money: usd(12000),
    outstanding_money: usd(12000),
    paid_money: usd(0),
    refunded_money: usd(0),
    refund_status: 'none',
    version: '1',
    buyer_actions: [action('pay', true, { is_required: true, due_at: '2026-10-15T15:00:00Z' })],
    snapshot: {
      line_items: [
        { invoice_line_item_id: 'ili_1', name: 'Office coffee service, October', quantity: '1', unit_price_money: usd(12000), subtotal_money: usd(12000), total_money: usd(12000), tax_money: usd(0), base_subtotal_money: usd(12000), discount_money: usd(0), modifier_total_money: usd(0) },
      ],
      pricing_amounts: { subtotal_money: usd(12000), discount_money: usd(0), charge_money: usd(0), requested_tip_money: usd(0), tax_money: usd(0), total_money: usd(12000) },
    },
    ...overrides,
  } as BuyerInvoice;
}

export function returnResource(overrides: Partial<ReturnResource> = {}): ReturnResource {
  const zero = usd(0);
  return {
    return_id: ids.returnId,
    return_number: 'R-1001',
    order_id: ids.order,
    status: 'requested',
    decision_status: 'pending',
    merchandise_status: 'awaiting_handoff',
    resolution_status: 'not_selected',
    created_at: asOf,
    updated_at: asOf,
    version: '1',
    metadata: {},
    buyer_actions: [action('withdraw', true), action('ship_items', false, { unavailable_reason: 'not_in_state' }), action('pay_balance', false, { unavailable_reason: 'not_in_state' })],
    supported_actions: ['cancel'],
    completion_blockers: [{ code: 'decision_pending', message: 'Waiting for the store.' }],
    handoff_requirements: [],
    financial_summary: {
      collected_money: zero, credit_money: zero, deduction_money: zero, due_from_buyer_money: zero, due_to_buyer_money: zero, refunded_money: zero,
      replacement_total_money: zero, returned_discount_money: zero, returned_subtotal_money: usd(1800), returned_tax_money: usd(149), returned_total_money: usd(1949),
    },
    line_items: [{ return_line_item_id: 'rli_1', order_line_item_id: ids.line, name: 'House blend coffee, 12 oz', requested_quantity: '1', return_reason_name: 'Changed my mind', status: 'requested' }],
    ...overrides,
  } as unknown as ReturnResource;
}

export function eligibility(): ReturnEligibilityCheck {
  const eligible = { allowed_resolution_types: ['refund'], eligible_quantity: '2', reason: 'eligible_under_policy', reason_message: 'Eligible.', status: 'eligible', expires_at: '2026-11-06T00:00:00Z', policy_adjustment_proposals: [] };
  return {
    evaluated_at: asOf,
    order_id: ids.order,
    status: 'eligible',
    selection: { selection_type: 'all_remaining_fulfilled' },
    policy_evaluation: { line_items: [], reason: 'eligible_under_policy', reason_message: 'Eligible.', status: 'eligible' },
    line_items: [
      { order_line_item_id: ids.line, fulfillment_id: ids.fulfillment, name: 'House blend coffee, 12 oz', is_self_service_enabled: true, eligibility: eligible, suggested_return_reasons: [{ return_reason_id: 'rr_1', handle: 'changed-mind', name: 'Changed my mind', is_note_required: false }, { return_reason_id: 'rr_2', handle: 'damaged', name: 'Arrived damaged', is_note_required: true }], bundle_components: [], modifiers: [], selected_options: [] },
      { order_line_item_id: 'oli_example_002', fulfillment_id: ids.fulfillment, name: 'Stoneware mug', is_self_service_enabled: true, eligibility: { ...eligible, eligible_quantity: '0', status: 'ineligible', reason: 'return_window_expired' }, suggested_return_reasons: [], bundle_components: [], modifiers: [], selected_options: [] },
    ],
  } as unknown as ReturnEligibilityCheck;
}

export const reasons: ReturnReason[] = [
  { return_reason_id: 'rr_1', handle: 'changed-mind', name: 'Changed my mind', is_note_required: false, status: 'active' } as ReturnReason,
  { return_reason_id: 'rr_2', handle: 'damaged', name: 'Arrived damaged', is_note_required: true, status: 'active' } as ReturnReason,
];

export const address: CustomerAddress = {
  customer_address_id: ids.address,
  customer_id: 'cus_example_001',
  recipient_name: 'Avery Example',
  label: 'Home',
  address: { line1: '100 Example Street', line2: 'Unit 4', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' },
  is_default_shipping: true,
  is_default_billing: false,
  phone: '+15125550100',
  created_at: asOf,
  updated_at: asOf,
};

export const giftCard: BuyerGiftCard = {
  gift_card_id: ids.giftCard,
  merchant_id: 'mer_example_001',
  last_characters: 'WXYZ',
  currency: 'USD',
  status: 'active',
  balance_money: usd(2500),
  reserved_money: usd(500),
  available_money: usd(2000),
  last_loaded_at: asOf,
  last_redeemed_at: null,
  created_at: asOf,
  updated_at: asOf,
  version: '1',
};

export const giftTransactions: BuyerGiftCardTransaction[] = [
  { gift_card_id: ids.giftCard, gift_card_transaction_id: 'gct_2', sequence: '2', transaction_type: 'redeem', amount_money: { amount: '-500', currency: 'USD' }, balance_before_money: usd(3000), balance_after_money: usd(2500), posted_at: '2026-10-05T12:00:00Z' },
  { gift_card_id: ids.giftCard, gift_card_transaction_id: 'gct_1', sequence: '1', transaction_type: 'load', amount_money: usd(3000), balance_before_money: usd(0), balance_after_money: usd(3000), posted_at: '2026-10-01T12:00:00Z' },
];

export const events: BuyerFulfillmentEvent[] = [
  { fulfillment_event_id: 'fe_1', fulfillment_id: ids.fulfillment, order_id: ids.order, event_type: 'shipped', current_status: 'shipped', occurred_at: '2026-10-03T14:00:00Z', created_at: '2026-10-03T14:00:00Z', location_description: 'Austin, TX' },
  { fulfillment_event_id: 'fe_3', fulfillment_id: ids.fulfillment, order_id: ids.order, event_type: 'delivered', current_status: 'delivered', occurred_at: '2026-10-06T10:30:00Z', created_at: '2026-10-06T10:30:00Z', location_description: 'Front door' },
  { fulfillment_event_id: 'fe_2', fulfillment_id: ids.fulfillment, order_id: ids.order, event_type: 'in_transit', current_status: 'in_transit', occurred_at: '2026-10-04T09:00:00Z', created_at: '2026-10-04T09:00:00Z', location_description: 'Dallas, TX' },
];

export const packages: Package[] = [
  { package_id: 'pkg_example_001', shipment_id: 'shp_1', fulfillment_id: ids.fulfillment, order_id: ids.order, carrier: 'usps', tracking_number: '9400EXAMPLE0001', tracking_url: 'https://carrier.example.test/track/9400EXAMPLE0001', status: 'delivered' } as Package,
];

export const fulfillments: Fulfillment[] = [
  { fulfillment_id: ids.fulfillment, order_id: ids.order, type: 'shipment', status: 'completed', request_status: 'accepted', line_items: [], supported_actions: [], version: '1' } as unknown as Fulfillment,
];

export const payments: PaymentIntent[] = [
  { payment_intent_id: 'pi_example_001', status: 'succeeded', amount_money: usd(4797), selected_payment_option: 'card', payment_source: { type: 'card', card: { brand: 'visa', last4: '4242' } }, created_at: asOf } as unknown as PaymentIntent,
];

export const capabilities: BuyerCapabilities = {
  cancellation_timing: 'buyer_chooses',
  pause: { enabled: true, max_cycles: 3 },
  cancellation_reasons: ['too_expensive', 'unused', 'switched_service', 'other'],
  retention_offer: { kind: 'pause_instead', pause_cycles: 1 },
};

export function retry(overrides: Partial<BuyerSubscriptionPaymentRetry> = {}): BuyerSubscriptionPaymentRetry {
  return {
    subscription_payment_retry_id: ids.retry,
    subscription_id: ids.subscription,
    status: 'processing',
    created_at: asOf,
    updated_at: asOf,
    ...overrides,
  };
}

export const emailRequest: EmailChangeRequest = {
  email_change_request_id: 'ecr_example_001',
  customer_id: 'cus_example_001',
  new_email: 'avery.new@example.test',
  confirmed: false,
  current_email_confirmation_required: true,
  created_at: asOf,
  expires_at: '2026-10-07T16:04:00Z',
};

export const deletionRequests: CustomerDeletionRequest[] = [
  { customer_deletion_request_id: 'cdr_1', customer_id: 'cus_example_001', status: 'pending_review', requested_at: asOf, retention_policy: 'standard' },
];

// ---------------------------------------------------------------------------
// Payment state
// ---------------------------------------------------------------------------

export function paymentState(overrides: Partial<PaymentState> = {}): PaymentState {
  return {
    order: {
      order_number: '2001',
      line_items: order({ order_number: '2001' }).line_items,
      pricing_amounts: { subtotal_money: usd(12000), discount_money: usd(0), charge_money: usd(0), requested_tip_money: usd(0), tax_money: usd(0), total_money: usd(12000) },
      settlement_amounts: {
        balance_money: usd(12000), credit_money: usd(0), net_collected_money: usd(0), outstanding_money: usd(12000), paid_money: usd(0), refunded_money: usd(0), settled_tip_money: usd(0),
      },
    },
    payment_collection: {
      stripe: {
        account_id: 'acct_example_001',
        publishable_key: 'pk_test_example_001',
        return_url: 'http://localhost:4291/payment-returns/example',
        elements: {
          amount_money: usd(12000),
          digital_wallets: [],
          mode: 'payment',
          next_step: 'create_confirmation_token',
          payment_method_creation: 'manual',
          payment_method_types: ['card'],
          submit_to: 'pay_order',
        },
      },
    },
    attempt: null,
    next: 'new_payment',
    approved_outstanding_money: usd(12000),
    decline: null,
    saved_methods: [],
    recovery_mode: false,
    expired: false,
    total_changed: false,
    returned: false,
    notices: [],
    ...overrides,
  };
}

export function paymentPage(
  surface: 'invoice' | 'return',
  state: PaymentState | null,
  extra: { launch?: 'ready' | 'surface_conflict' | 'collection_in_progress'; returned?: boolean } = {},
) {
  const resourceId = surface === 'invoice' ? ids.invoice : ids.returnId;
  const summary =
    surface === 'invoice'
      ? { invoice: { invoice_id: ids.invoice, invoice_number: 'INV-1001', due_at: '2026-10-15T15:00:00Z', status: 'open', is_overdue: false, currently_due_money: usd(12000), outstanding_money: usd(12000) } }
      : { return: { return_id: ids.returnId, return_number: 'R-1001', financial_summary: returnResource().financial_summary } };
  return context({
    surface,
    resource_id: resourceId,
    buyer: { name: 'Avery Example', email: 'avery@example.test' },
    summary,
    launch: extra.launch ?? 'ready',
    state,
    returned: extra.returned ?? false,
  });
}

export function attempt(status: string, overrides: Record<string, unknown> = {}): PaymentState['attempt'] {
  return {
    order_payment_attempt_id: 'opa_example_001',
    status,
    is_resumable: status === 'requires_retry',
    mode: 'payment',
    expected_outstanding_money: usd(12000),
    ...overrides,
  } as PaymentState['attempt'];
}

// ---------------------------------------------------------------------------
// Pages by id and variant (used by the harness and the tests)
// ---------------------------------------------------------------------------

const loadedList = <T>(items: T[], next_page_token?: string) => ({ status: 'ok' as const, value: { items, next_page_token } });
const failed = (request_id = 'req_example_001') => ({ status: 'error' as const, error: { kind: 'unavailable' as const, request_id } });

export type Variant = string;

export function pageContext(pageId: PageId, variant: Variant = 'default'): RenderContext<any> {
  switch (pageId) {
    case 'sign-in':
      return context({ next: '/orders' }, { user: null, error: variant === 'error' ? { kind: 'validation', code: 'INVALID_LOGIN', message_key: 'invalid_login' } : undefined });
    case 'sign-up':
      return context({ next: null }, { user: null, error: variant === 'error' ? { kind: 'conflict', code: 'EMAIL_ALREADY_USED', message_key: 'email_already_used' } : undefined });
    case 'verify-email':
      return context(
        { next: '/', email: 'avery@example.test', verification: variant === 'sent' ? { status: 'code_sent', sentAt: Date.now() } : { status: 'idle' } },
        { error: variant === 'invalid' ? { kind: 'validation', code: 'CUSTOMER_VERIFICATION_CODE_INVALID', message_key: 'customer_verification_code_invalid' } : undefined },
      );
    case 'not-found':
      return context({}, { error: { kind: 'not_found', request_id: 'req_example_404' } });
    case 'error':
      return context({}, { error: { kind: 'bug', code: 'UNKNOWN_ERROR', request_id: 'req_example_500' } });
    case 'ac-home': {
      if (variant === 'new_account') return context({ orders: loadedList([]), subscriptions: loadedList([]), invoices: loadedList([]), returns: loadedList([]) });
      if (variant === 'section_error') return context({ orders: failed(), subscriptions: loadedList([subscription()]), invoices: loadedList([invoice()]), returns: loadedList([]) });
      if (variant === 'nothing_needed') return context({ orders: loadedList([order()]), subscriptions: loadedList([subscription()]), invoices: loadedList([invoice({ status: 'paid', buyer_actions: [action('pay', false, { unavailable_reason: 'not_in_state' })] })]), returns: loadedList([]) });
      const pastDue = subscription({ status: 'past_due', buyer_actions: [action('cancel', true), action('pause', false), action('resume', false), action('reactivate', false), action('update_payment_method', true, { is_required: true, due_at: '2026-10-20T00:00:00Z' }), action('retry_payment', true, { is_required: true })] });
      const needsBalance = returnResource({ status: 'open', buyer_actions: [action('withdraw', false), action('ship_items', true, { is_required: true, due_at: '2026-10-30T00:00:00Z' }), action('pay_balance', true, { is_required: true })] });
      return context(
        { orders: loadedList([order(), order({ order_id: ids.order2, order_number: '1002' }), order({ order_id: 'ord_example_003', order_number: '1003', payment_status: 'unpaid', fulfillment_status: 'not_fulfilled' })]), subscriptions: loadedList([pastDue]), invoices: loadedList([invoice()]), returns: loadedList([needsBalance]) },
        { notices: variant === 'notice' ? ['not_in_account'] : variant === 'wrong_environment' ? ['wrong_environment'] : [], setupNeeded: variant === 'setup_needed' },
      );
    }
    case 'ac-orders':
      if (variant === 'empty') return context({ orders: loadedList([]) });
      if (variant === 'error') return context({ orders: failed() });
      return context({ orders: loadedList([order(), order({ order_id: ids.order2, order_number: '1002', payment_status: 'unpaid', fulfillment_status: 'not_fulfilled' })], variant === 'paged' ? 'next_example' : 'next_example'), page_token: variant === 'paged' ? 'page_example' : undefined });
    case 'ac-order': {
      if (variant === 'processing') return context({ order: order({ payment_status: 'unpaid', fulfillment_status: 'not_fulfilled' }), payments: { status: 'ok', value: [{ ...payments[0], status: 'processing', payment_source: { type: 'ach_debit', ach_debit: { last4: '6789' } } } as unknown as PaymentIntent] }, refunds: { status: 'ok', value: [] }, fulfillments: { status: 'ok', value: [] }, packages: { status: 'ok', value: [] }, events: { status: 'ok', value: [] } });
      if (variant === 'no_delivery') return context({ order: order({ fulfillment_status: 'not_fulfilled' }), payments: { status: 'ok', value: payments }, refunds: { status: 'ok', value: [] }, fulfillments: { status: 'ok', value: fulfillments }, packages: { status: 'ok', value: [] }, events: { status: 'ok', value: [] } });
      if (variant === 'window_closed') return context({ order: order({ buyer_actions: [action('start_return', false, { unavailable_reason: 'window_closed' }), action('resend_receipt', true)] }), payments: { status: 'ok', value: payments }, refunds: { status: 'ok', value: [] }, fulfillments: { status: 'ok', value: fulfillments }, packages: { status: 'ok', value: packages }, events: { status: 'ok', value: events } });
      if (variant === 'errors') return context({ order: order(), payments: failed(), refunds: failed(), fulfillments: failed(), packages: failed(), events: failed() });
      return context({ order: order(), payments: { status: 'ok', value: payments }, refunds: { status: 'ok', value: [{ amount_money: usd(500), created_at: '2026-10-06T00:00:00Z' } as never] }, fulfillments: { status: 'ok', value: fulfillments }, packages: { status: 'ok', value: packages }, events: { status: 'ok', value: events } }, { notices: variant === 'receipt' ? [{ key: 'receipt_sent', params: { email: 'avery@example.test' } }] : [] });
    }
    case 'ac-order-receipt':
      return context({ order: order(), payments: { status: 'ok', value: payments }, refunds: { status: 'ok', value: [] } });
    case 'ac-return-start':
      if (variant === 'nothing') return context({ order: { order_id: ids.order, order_number: '1001' }, eligibility: { ...eligibility(), line_items: eligibility().line_items.slice(1) }, reasons });
      return context({ order: { order_id: ids.order, order_number: '1001' }, eligibility: eligibility(), reasons }, { error: variant === 'error' ? { kind: 'validation', code: 'RETURN_SELECTION_REQUIRED', message_key: 'return_selection_required' } : undefined });
    case 'ac-returns':
      if (variant === 'empty') return context({ returns: loadedList([]) });
      if (variant === 'error') return context({ returns: failed() });
      return context({ returns: loadedList([returnResource(), returnResource({ return_id: 'ret_example_002', return_number: 'R-1002', status: 'completed' })]) });
    case 'ac-return': {
      const base = { packages: { status: 'ok' as const, value: [{ ...packages[0], label_url: 'https://carrier.example.test/label/abc' } as Package] } };
      if (variant === 'approved') return context({ return: returnResource({ status: 'open', decision_status: 'approved', completion_blockers: [{ code: 'handoff_pending', message: 'x' }], handoff_requirements: [{ destination: { destination_type: 'location', name: 'Cedar & Stone Roastery', address: { line1: '400 Congress Ave', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' } }, expires_at: '2026-10-30T00:00:00Z', instructions: 'Pack the items in their original bag.', line_items: [], status: 'pending' } as never] }), ...base });
      if (variant === 'awaiting_payment') return context({ return: returnResource({ status: 'open', decision_status: 'approved', buyer_actions: [action('withdraw', false), action('ship_items', false), action('pay_balance', true, { is_required: true })], completion_blockers: [{ code: 'resolution_requires_action', message: 'x' }], financial_summary: { ...returnResource().financial_summary, due_from_buyer_money: usd(2000), replacement_total_money: usd(3800), credit_money: usd(1800) } }), ...base });
      if (variant === 'completed') return context({ return: returnResource({ status: 'completed', completion_blockers: [], buyer_actions: [action('withdraw', false), action('ship_items', false), action('pay_balance', false)] }), ...base });
      if (variant === 'canceled') return context({ return: returnResource({ status: 'canceled', completion_blockers: [], buyer_actions: [action('withdraw', false), action('ship_items', false), action('pay_balance', false)] }), ...base });
      return context({ return: returnResource(), ...base });
    }
    case 'ac-invoices':
      if (variant === 'empty') return context({ invoices: loadedList([]) });
      if (variant === 'error') return context({ invoices: failed() });
      return context({ invoices: loadedList([invoice(), invoice({ invoice_id: 'inv_example_002', invoice_number: 'INV-1002', status: 'paid', outstanding_money: usd(0), paid_money: usd(5000), buyer_actions: [] })]) });
    case 'ac-invoice': {
      const credit: BuyerCreditNote[] = [{ credit_note_id: 'cn_example_001', credit_note_number: 'CN-1001', invoice_id: ids.invoice, total_money: usd(1000), refunded_money: usd(0), pending_refund_money: usd(0), status: 'issued', issued_at: asOf, reason: 'goodwill', credit_note_lines: [] } as unknown as BuyerCreditNote];
      const base = { credit_notes: { status: 'ok' as const, value: [] as BuyerCreditNote[] } };
      if (variant === 'overdue') return context({ invoice: invoice({ is_overdue: true }), ...base });
      if (variant === 'processing') return context({ invoice: invoice(), processing: true, ...base }, { notices: ['invoice_payment_processing'] });
      if (variant === 'paid') return context({ invoice: invoice({ status: 'paid', outstanding_money: usd(0), currently_due_money: usd(0), paid_money: usd(12000), buyer_actions: [action('pay', false, { unavailable_reason: 'not_in_state' })] }), credit_notes: { status: 'ok', value: credit } });
      if (variant === 'closed') return context({ invoice: invoice({ status: 'void', outstanding_money: usd(0), currently_due_money: usd(0), buyer_actions: [action('pay', false, { unavailable_reason: 'not_in_state' })] }), ...base });
      if (variant === 'awaiting') return context({ invoice: invoice({ buyer_actions: [action('pay', false)] }), awaiting_payment: true, ...base }, { notices: ['invoice_payment_received'] });
      return context({ invoice: invoice(), credit_notes: { status: 'ok', value: credit } });
    }
    case 'ac-invoice-pay':
    case 'ac-return-pay':
      return paymentPageVariant(pageId === 'ac-invoice-pay' ? 'invoice' : 'return', variant);
    case 'ac-subscriptions':
      if (variant === 'empty') return context({ subscriptions: loadedList([]) });
      if (variant === 'error') return context({ subscriptions: failed() });
      return context({ subscriptions: loadedList([subscription(), subscription({ subscription_id: 'sub_example_002', status: 'canceled', cancel_at_period_end: false, buyer_actions: [] })]) });
    case 'ac-subscription': {
      const base = { capabilities, payment_methods: { status: 'ok' as const, value: [card(), card({ payment_method_id: ids.method2, usage: 'on_session', card: { brand: 'mastercard', last4: '4444', exp_month: 1, exp_year: 2031 } } as never)] }, billing_history: loadedList([order({ order_number: '1001' })]) };
      if (variant === 'past_due')
        return context({ subscription: subscription({ status: 'past_due', buyer_actions: [action('cancel', true), action('pause', false, { unavailable_reason: 'not_in_state' }), action('resume', false), action('reactivate', false), action('update_payment_method', true, { is_required: true }), action('retry_payment', true, { is_required: true })] }), ...base });
      if (variant === 'retrying') return context({ subscription: subscription({ status: 'past_due', buyer_actions: [action('retry_payment', false), action('update_payment_method', true)] }), retry: retry({ status: 'processing' }), ...base });
      if (variant === 'retry_failed') return context({ subscription: subscription({ status: 'past_due', buyer_actions: [action('retry_payment', true), action('update_payment_method', true)] }), retry: retry({ status: 'failed', failure: { code: 'card_declined', message: 'Your card was declined.' } }), ...base });
      if (variant === 'retry_succeeded') return context({ subscription: subscription(), retry: retry({ status: 'succeeded' }), ...base });
      if (variant === 'scheduled_cancel') return context({ subscription: subscription({ cancel_at_period_end: true, buyer_actions: [action('cancel', false), action('pause', false), action('resume', false), action('reactivate', true), action('update_payment_method', true), action('retry_payment', false)] }), ...base });
      if (variant === 'paused') return context({ subscription: subscription({ status: 'paused', buyer_actions: [action('cancel', true), action('pause', false), action('resume', true), action('reactivate', false), action('update_payment_method', true), action('retry_payment', false)] }), ...base });
      if (variant === 'store_policy') return context({ subscription: subscription({ buyer_actions: [action('cancel', true), action('pause', false, { unavailable_reason: 'store_policy' }), action('resume', false), action('reactivate', false), action('update_payment_method', true), action('retry_payment', false)] }), ...base });
      if (variant === 'cancel_error') return context({ subscription: subscription(), ...base, dialog: 'cancel' }, { error: { kind: 'validation', code: 'CANCELLATION_REASON_NOT_OFFERED', message_key: 'cancellation_reason_not_offered', field_errors: { reason: 'cancellation_reason_not_offered' } } });
      if (variant === 'end_of_period') return context({ subscription: subscription(), ...base, capabilities: { ...capabilities, cancellation_timing: 'end_of_period', cancellation_reasons: [] } });
      return context({ subscription: subscription(), ...base });
    }
    case 'ac-payment-methods':
      if (variant === 'empty') return context({ payment_methods: { status: 'ok', value: [] }, default_payment_method_id: null });
      if (variant === 'error') return context({ payment_methods: failed(), default_payment_method_id: null });
      return context({ payment_methods: { status: 'ok', value: [card(), card({ payment_method_id: ids.method2, usage: 'on_session', status: 'pending' })] }, default_payment_method_id: ids.method });
    case 'ac-payment-method-new':
      return context({ return_to: variant === 'subscription' ? `/subscriptions/${ids.subscription}` : '/payment-methods' });
    case 'ac-payment-method-return':
      if (variant === 'nothing') return context({ payment_method: null });
      if (variant === 'failed') return context({ payment_method: card({ status: 'failed' }) });
      return context({ payment_method: card({ status: 'pending' }) });
    case 'ac-profile':
      return context({ customer: { email: 'avery@example.test', name: 'Avery Example', phone: '+15125550100' } }, { error: variant === 'error' ? { kind: 'validation', code: 'INVALID_INPUT', message_key: 'invalid_input', field_errors: { name: 'name_required' } } : undefined });
    case 'ac-profile-email':
      if (variant === 'codes') return context({ current_email: 'avery@example.test', request: emailRequest });
      return context({ current_email: 'avery@example.test', request: null });
    case 'ac-profile-password':
      return context({}, { error: variant === 'error' ? { kind: 'validation', code: 'CURRENT_PASSWORD_INCORRECT', message_key: 'current_password_incorrect' } : undefined });
    case 'ac-addresses':
      if (variant === 'empty') return context({ addresses: loadedList([]) });
      if (variant === 'error') return context({ addresses: failed() });
      return context({ addresses: loadedList([address, { ...address, customer_address_id: 'adr_example_002', label: 'Office', is_default_shipping: false, is_default_billing: true }]) });
    case 'ac-address-form':
      if (variant === 'edit') return context({ mode: 'edit', address });
      return context({ mode: 'new', is_first: variant === 'first' });
    case 'ac-gift-cards':
      if (variant === 'empty') return context({ gift_cards: loadedList([]) });
      if (variant === 'error') return context({ gift_cards: failed() });
      return context({ gift_cards: loadedList([giftCard]) });
    case 'ac-gift-card-add':
      return context({ tab: variant === 'link' ? 'link' : 'code' }, { error: variant === 'invalid' ? { kind: 'validation', code: 'GIFT_CARD_INVALID', message_key: 'gift_card_invalid' } : undefined });
    case 'ac-gift-card':
      if (variant === 'missing') return context({ gift_card: null, transactions: { status: 'ok', value: [] } });
      return context({ gift_card: giftCard, transactions: { status: 'ok', value: giftTransactions } });
    case 'ac-email-preferences':
      if (variant === 'signed_in') return context({ signed_in: true, preferences: { customer_id: 'cus_example_001', shipping_updates: true, checkout_reminders: false } });
      if (variant === 'no_email') return context({ signed_in: true, preferences: null, preferences_error: { kind: 'validation', code: 'CUSTOMER_EMAIL_REQUIRED' } });
      return context({ signed_in: false }, { user: null });
    case 'ac-privacy':
      if (variant === 'empty') return context({ requests: { status: 'ok', value: [] } });
      return context({ requests: { status: 'ok', value: [...deletionRequests, { ...deletionRequests[0], customer_deletion_request_id: 'cdr_2', status: 'rejected' } as CustomerDeletionRequest] } });
    case 'ac-link-purchases':
      if (variant === 'sent') return context({ state: 'code_sent', email: 'avery@example.test', sentAt: Date.now() });
      if (variant === 'done') return context({ state: 'done', email: 'avery@example.test', linked_order_count: 2 });
      if (variant === 'none') return context({ state: 'done', email: 'avery@example.test', linked_order_count: 0 });
      return context({ state: 'idle', email: 'avery@example.test' });
    default: {
      const never: never = pageId;
      throw new Error(`No fixture for ${String(never)}`);
    }
  }
}

function withTypes(types: string[], wallets: string[] = []): PaymentState['payment_collection'] {
  const base = paymentState().payment_collection;
  const stripe = base?.stripe;
  if (!stripe?.elements) return base;
  return { stripe: { ...stripe, elements: { ...stripe.elements, payment_method_types: types, digital_wallets: wallets } } };
}

function paymentPageVariant(surface: 'invoice' | 'return', variant: Variant) {
  const affirmLeg = { payment_intent_id: 'pi_example_aff', status: 'open' as const, amount_money: usd(12000), payment_option: 'affirm' };
  switch (variant) {
    case 'declined':
      return paymentPage(surface, paymentState({ attempt: attempt('failed', { failure_code: 'incorrect_cvc' }), decline: { code: 'incorrect_cvc' } }));
    case 'saved':
      return paymentPage(surface, paymentState({ saved_methods: [card(), card({ payment_method_id: ids.method2, card: { brand: 'mastercard', last4: '4444', exp_month: 1, exp_year: 2031 } } as never)] }));
    case 'surface_conflict':
      return paymentPage(surface, null, { launch: 'surface_conflict' });
    case 'collection_in_progress':
      return paymentPage(surface, null, { launch: 'collection_in_progress' });
    case 'unavailable':
      return paymentPage(surface, paymentState({ payment_collection: null }));
    case 'expired':
      return paymentPage(surface, paymentState({ expired: true }));
    case 'waiting':
      return paymentPage(surface, paymentState({ next: 'wait', attempt: attempt('processing') }));
    case 'recovery':
      return paymentPage(surface, paymentState({ next: 'resume', attempt: attempt('requires_retry'), recovery_mode: true }));
    case 'authenticate':
      return paymentPage(surface, paymentState({ next: 'authenticate', attempt: attempt('requires_action'), pending_action_id: 'pa_example_001' }));
    case 'affirm_incomplete':
      return paymentPage(surface, paymentState({ next: 'authenticate', attempt: attempt('requires_action', { legs: [affirmLeg] }), pending_action_id: 'pa_example_aff', returned: true }), { returned: true });
    case 'pay_remaining':
      return paymentPage(surface, paymentState({ next: 'pay_remaining', attempt: attempt('partially_succeeded', { legs: [{ payment_intent_id: 'pi_1', status: 'succeeded', amount_money: usd(5000) }, { payment_intent_id: 'pi_2', status: 'failed', amount_money: usd(7000) }] }), approved_outstanding_money: usd(7000) }));
    case 'bank_processing':
      return paymentPage(surface, paymentState({ next: 'bank_processing', attempt: attempt('processing') }));
    case 'with_affirm':
      return paymentPage(surface, paymentState({ payment_collection: withTypes(['card', 'affirm']) }));
    case 'wallets':
      return paymentPage(surface, paymentState({ payment_collection: withTypes(['card'], ['apple_pay', 'google_pay']) }));
    case 'total_changed':
      return paymentPage(surface, paymentState({ total_changed: true, approved_outstanding_money: usd(13000), notices: ['total_changed'] }));
    default:
      return paymentPage(surface, paymentState());
  }
}

export const allPageIds: PageId[] = [
  'sign-in', 'sign-up', 'verify-email', 'not-found', 'error', 'ac-home', 'ac-orders', 'ac-order', 'ac-order-receipt', 'ac-return-start', 'ac-returns', 'ac-return',
  'ac-return-pay', 'ac-invoices', 'ac-invoice', 'ac-invoice-pay', 'ac-subscriptions', 'ac-subscription', 'ac-payment-methods', 'ac-payment-method-new',
  'ac-payment-method-return', 'ac-profile', 'ac-profile-email', 'ac-profile-password', 'ac-addresses', 'ac-address-form', 'ac-gift-cards', 'ac-gift-card-add',
  'ac-gift-card', 'ac-email-preferences', 'ac-privacy', 'ac-link-purchases',
];
