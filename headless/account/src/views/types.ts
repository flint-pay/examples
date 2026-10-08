// Render boundary types for the account app.
//
// The backend builds a RenderContext per request and calls renderPage(pageId, context).
// Resource fields use the published @flintpay/node model names exactly. Views read only the
// fields they need, so the backend can pass an SDK response object as returned by `client.me.*`
// or a narrower object with the same field names.

import type {
  BuyerAction,
  BuyerCapabilities,
  BuyerCreditNote,
  BuyerFulfillmentEvent,
  BuyerGiftCard,
  BuyerGiftCardTransaction,
  BuyerInvoice,
  BuyerRefund,
  BuyerSubscriptionPaymentRetry,
  Customer,
  CustomerAddress,
  CustomerDeletionRequest,
  CustomerEmailPreferences,
  EmailChangeRequest,
  EmailPreferenceLink,
  Fulfillment,
  MoneyValue,
  Order,
  OrderPaymentAttempt,
  Package,
  PaymentCollection,
  PaymentIntent,
  PaymentMethod,
  ReturnEligibilityCheck,
  ReturnReason,
  ReturnResource,
  StripeClientSetupStripe,
  StripePaymentClientAction,
  Subscription,
} from '@flintpay/node';

export type {
  BuyerAction,
  BuyerCapabilities,
  BuyerCreditNote,
  BuyerFulfillmentEvent,
  BuyerGiftCard,
  BuyerGiftCardTransaction,
  BuyerInvoice,
  BuyerRefund,
  BuyerSubscriptionPaymentRetry,
  Customer,
  CustomerAddress,
  CustomerDeletionRequest,
  CustomerEmailPreferences,
  EmailChangeRequest,
  EmailPreferenceLink,
  Fulfillment,
  MoneyValue,
  Order,
  OrderPaymentAttempt,
  Package,
  PaymentCollection,
  PaymentIntent,
  PaymentMethod,
  ReturnEligibilityCheck,
  ReturnReason,
  ReturnResource,
  StripeClientSetupStripe,
  StripePaymentClientAction,
  Subscription,
};

// ---------------------------------------------------------------------------
// Shared context
// ---------------------------------------------------------------------------

/** A flash notice. A bare string is a key in copy.notices without parameters. */
export type Notice = string | { key: string; params?: Record<string, string | number> };

export type AppErrorKind =
  | 'validation'
  | 'conflict'
  | 'auth'
  | 'not_found'
  | 'rate_limited'
  | 'unavailable'
  | 'unknown_outcome'
  | 'bug';

/**
 * Page level or form level error. `code` is the Flint error code or a local code. Copy resolves in
 * this order: message_key, lowercased code, kind. `field_errors` maps a form field name to a
 * message key (or lowercased code) and is shown beside that field.
 */
export interface PageError {
  kind: AppErrorKind;
  code?: string;
  message_key?: string;
  request_id?: string;
  field_errors?: Record<string, string>;
}

export interface MerchantSupport {
  email?: string | null;
  phone?: string | null;
  url?: string | null;
}

export interface RenderContext<D = unknown> {
  storeName: string;
  appOrigin: string;
  /** STOREFRONT_ORIGIN. Null hides the Shop link. */
  storefrontOrigin: string | null;
  /** Per session CSRF token. Rendered in every form and in <meta name="csrf-token">. */
  csrf: string;
  user: { name?: string | null; email: string } | null;
  data: D;
  notices: Notice[];
  error?: PageError;
  /** From merchants.get. Shown in the footer and in states that tell the buyer to contact the store. */
  support?: MerchantSupport | null;
  /** True when preflight found customer_account is not merchant_hosted at APP_ORIGIN. */
  setupNeeded?: boolean;
  /** IANA zone used to print timestamps. Defaults to UTC. */
  timeZone?: string;
}

// ---------------------------------------------------------------------------
// Section loading
// ---------------------------------------------------------------------------

/** A section the page loads on its own, so one failing read does not blank the page. */
export type Loaded<T> = { status: 'ok'; value: T } | { status: 'error'; error: PageError };

/** A list read: `items` is the list response `data`; `next_page_token` is the envelope field. */
export interface ListValue<T> {
  items: T[];
  next_page_token?: string | null;
}

// ---------------------------------------------------------------------------
// Identity pages (same data as the storefront identity pages)
// ---------------------------------------------------------------------------

export interface SignInData {
  next: string | null;
  email?: string;
}

export interface SignUpData {
  next: string | null;
  name?: string;
  email?: string;
}

export interface VerifyEmailData {
  next: string | null;
  email: string;
  verification: { status: 'idle' | 'code_sent'; sentAt?: number } | null;
}

// ---------------------------------------------------------------------------
// Account pages
// ---------------------------------------------------------------------------

export interface HomeData {
  orders: Loaded<ListValue<Order>>;
  subscriptions: Loaded<ListValue<Subscription>>;
  invoices: Loaded<ListValue<BuyerInvoice>>;
  returns: Loaded<ListValue<ReturnResource>>;
}

export interface OrdersData {
  orders: Loaded<ListValue<Order>>;
  /** The page_token of the current page, if any. Shows the Newest orders link. */
  page_token?: string | null;
}

export interface OrderData {
  order: Order;
  payments: Loaded<PaymentIntent[]>;
  refunds: Loaded<BuyerRefund[]>;
  fulfillments: Loaded<Fulfillment[]>;
  packages: Loaded<Package[]>;
  /** me.listFulfillmentEvents({ order_id }). Any order; the view sorts newest first. */
  events: Loaded<BuyerFulfillmentEvent[]>;
}

export type OrderReceiptData = Pick<OrderData, 'order' | 'payments' | 'refunds'>;

export interface ReturnStartData {
  order: Pick<Order, 'order_id' | 'order_number'>;
  eligibility: ReturnEligibilityCheck;
  /** Active reasons from returnReasons.list (merchant key). */
  reasons: ReturnReason[];
  /** Submitted raw field values to restore after a validation error. Never secrets. */
  values?: Record<string, string>;
}

export interface ReturnsData {
  returns: Loaded<ListValue<ReturnResource>>;
  page_token?: string | null;
}

export interface ReturnData {
  return: ReturnResource;
  /** me.listPackages filtered to the return. */
  packages: Loaded<Package[]>;
}

export interface InvoicesData {
  invoices: Loaded<ListValue<BuyerInvoice>>;
  page_token?: string | null;
}

export interface InvoiceData {
  invoice: BuyerInvoice;
  credit_notes: Loaded<BuyerCreditNote[]>;
  /**
   * True right after a payment (arriving from the pay return route) while the invoice may not show
   * the payment yet. The page polls GET /invoices/:invoiceId/status.
   */
  awaiting_payment?: boolean;
  /** True while a bank payment for this invoice has not cleared. The backend knows from its payment record. */
  processing?: boolean;
}

export interface SubscriptionsData {
  subscriptions: Loaded<ListValue<Subscription>>;
  page_token?: string | null;
}

export interface SubscriptionData {
  subscription: Subscription;
  /** settings.getEffective customer_account.buyer_capabilities. Null when the read failed. */
  capabilities: BuyerCapabilities | null;
  /** me.listPaymentMethods, for the Change payment method flow. */
  payment_methods: Loaded<PaymentMethod[]>;
  /** Billing history: me.listOrders({ subscription_id }), newest first. */
  billing_history: Loaded<ListValue<Order>>;
  /** The retry named by ?retry=, read with me.getSubscriptionPaymentRetry. */
  retry?: BuyerSubscriptionPaymentRetry | null;
  /** Reopens a dialog after a validation error on its form. */
  dialog?: 'cancel' | 'pause' | 'payment_method' | null;
  /** Raw values to restore after a validation error. */
  values?: Record<string, string>;
}

export interface PaymentMethodsData {
  payment_methods: Loaded<PaymentMethod[]>;
  /** Customer.default_payment_method_id from me.get. */
  default_payment_method_id?: string | null;
}

export interface PaymentMethodNewData {
  /** Validated relative path to return to after the card is active. */
  return_to?: string | null;
}

export interface PaymentMethodReturnData {
  /** The card the user was adding (from pending_cards). Null when nothing is pending. */
  payment_method: PaymentMethod | null;
}

export interface ProfileData {
  customer: Pick<Customer, 'email' | 'name' | 'phone'>;
  values?: Record<string, string>;
}

export interface ProfileEmailData {
  current_email: string;
  /** The pending request, if the user already asked for codes. */
  request: EmailChangeRequest | null;
  new_email?: string;
}

export type ProfilePasswordData = Record<string, never>;

export interface AddressesData {
  addresses: Loaded<ListValue<CustomerAddress>>;
}

export interface AddressFormData {
  mode: 'new' | 'edit';
  address?: CustomerAddress;
  values?: Record<string, string>;
  /** True when no address is saved yet (the first one becomes both defaults). */
  is_first?: boolean;
}

export interface GiftCardsData {
  gift_cards: Loaded<ListValue<BuyerGiftCard>>;
}

export interface GiftCardAddData {
  tab?: 'code' | 'link';
}

export interface GiftCardData {
  /** Null when me.getGiftCard returned 404 (for example the card's code changed). */
  gift_card: BuyerGiftCard | null;
  transactions: Loaded<BuyerGiftCardTransaction[]>;
}

export interface EmailPreferencesData {
  signed_in: boolean;
  /** me.getEmailPreferences. Only for signed-in users. */
  preferences?: CustomerEmailPreferences | null;
  /** Set when me.getEmailPreferences failed (CUSTOMER_EMAIL_REQUIRED has its own copy). */
  preferences_error?: PageError | null;
}

export interface PrivacyData {
  requests: Loaded<CustomerDeletionRequest[]>;
}

export interface LinkPurchasesData {
  state: 'idle' | 'code_sent' | 'done';
  email: string;
  sentAt?: number;
  linked_order_count?: number;
}

export type NotFoundData = Record<string, never>;
export type ErrorPageData = Record<string, never>;

// ---------------------------------------------------------------------------
// Embedded payment (invoice and return balance)
// ---------------------------------------------------------------------------

export type PaymentSurfaceKind = 'invoice' | 'return';

/** The engine's nextStep result, with the bank_processing refinement. */
export type PaymentNext =
  | 'done'
  | 'pay_remaining'
  | 'new_payment'
  | 'capture'
  | 'authenticate'
  | 'resume'
  | 'wait'
  | 'bank_processing';

export type PaymentLegStatus = 'succeeded' | 'failed' | 'open';

/** Buyer-safe attempt projection. Provider client secrets never appear here. */
export interface PaymentAttemptView
  extends Pick<
    OrderPaymentAttempt,
    | 'order_payment_attempt_id'
    | 'status'
    | 'is_resumable'
    | 'mode'
    | 'failure_code'
    | 'failure_message'
    | 'expected_outstanding_money'
  > {
  legs?: Array<{
    payment_intent_id: string;
    status: PaymentLegStatus;
    amount_money: MoneyValue;
    /** Selected payment option of the leg: card, ach_debit, affirm, apple_pay, google_pay. */
    payment_option?: string;
  }>;
}

export interface PaymentOrderView {
  order_number?: Order['order_number'];
  line_items: Order['line_items'];
  pricing_amounts: Order['pricing_amounts'];
  settlement_amounts: Order['settlement_amounts'];
  return_credit_settlements?: Order['return_credit_settlements'];
  charges?: Order['charges'];
}

/**
 * The full buyer-safe payment projection returned by every payment job and used for the first
 * render. It never carries a Flint credential, a checkout session ID, or a provider client secret.
 */
export interface PaymentState {
  order: PaymentOrderView;
  /** order.payment_collection exactly as returned. Null when the order has no collection guidance. */
  payment_collection: PaymentCollection | null;
  /** order.setup_collection exactly as returned. Not expected for invoices or returns. */
  setup_collection?: PaymentCollection | null;
  attempt: PaymentAttemptView | null;
  next: PaymentNext;
  /** The outstanding amount the buyer is shown. The browser sends it back as approved_outstanding_money. */
  approved_outstanding_money: MoneyValue;
  /** Deduplication key for the pending action while next is authenticate. */
  pending_action_id?: string;
  /** The decline to explain when the last attempt failed. */
  decline?: { code: string; payment_option?: string } | null;
  /** Saved cards from paymentMethods.list with checkout auth. */
  saved_methods?: PaymentMethod[];
  /** Shipping name and address for Affirm when the order ships. */
  shipping?: {
    name?: string;
    address: { line1?: string; line2?: string; city?: string; state?: string; postal_code?: string; country: string };
  } | null;
  /** Session expired during an attempt. Only resume and reads are allowed. */
  recovery_mode?: boolean;
  /** Session ended with no attempt to recover. */
  expired?: boolean;
  /** True on the response to a pay call that found a different outstanding amount. */
  total_changed?: boolean;
  /** True when the state was read on the provider return route. */
  returned?: boolean;
  /** Copy keys for banners (total_changed, finishing_payment, still_confirming, checkout_expired, payments_unavailable, affirm_incomplete). */
  notices?: string[];
}

export interface PaymentJobError {
  kind: AppErrorKind;
  code?: string;
  message_key?: string;
  request_id?: string;
}

/** Response of POST submit, POST resume, GET attempt. */
export type PaymentJobResponse =
  | { state: PaymentState; next: PaymentNext; client_action?: StripePaymentClientAction }
  | { error: PaymentJobError; state?: PaymentState; next?: PaymentNext };

export interface InvoicePaySummary {
  invoice: Pick<
    BuyerInvoice,
    'invoice_id' | 'invoice_number' | 'due_at' | 'status' | 'is_overdue' | 'currently_due_money' | 'outstanding_money' | 'memo'
  >;
}

export interface ReturnPaySummary {
  return: Pick<ReturnResource, 'return_id' | 'return_number' | 'financial_summary'>;
}

/**
 * The launch result. surface_conflict is CHECKOUT_SURFACE_CHANGE_NOT_ALLOWED and
 * collection_in_progress is ORDER_COLLECTION_IN_PROGRESS. `nothing_due` is never rendered:
 * the backend redirects (303) to the resource page.
 */
export type PaymentLaunch = 'ready' | 'surface_conflict' | 'collection_in_progress';

export interface PaymentPageData {
  surface: PaymentSurfaceKind;
  /** invoice_id or return_id. */
  resource_id: string;
  buyer: { name?: string | null; email: string };
  summary: InvoicePaySummary | ReturnPaySummary;
  launch: PaymentLaunch;
  /** Null when launch is not ready. */
  state: PaymentState | null;
  /** True on the provider return route (/pay/return). */
  returned?: boolean;
}

/** Request body of POST submit. */
export interface PaymentSubmitRequest {
  /** Omitted only when the order needs no new credential. */
  credential?: {
    kind: 'confirmation_token' | 'payment_method_token' | 'saved_payment_method';
    value: string;
  };
  approved_outstanding_money: MoneyValue;
}

/** Response of POST /payment-methods/new/setup. */
export interface CardSetupResponse {
  payment_method: Pick<PaymentMethod, 'payment_method_id' | 'status'>;
  client_setup: { stripe: StripeClientSetupStripe };
}

// ---------------------------------------------------------------------------
// Page registry
// ---------------------------------------------------------------------------

export interface PageDataMap {
  'sign-in': SignInData;
  'sign-up': SignUpData;
  'verify-email': VerifyEmailData;
  'not-found': NotFoundData;
  error: ErrorPageData;
  'ac-home': HomeData;
  'ac-orders': OrdersData;
  'ac-order': OrderData;
  'ac-order-receipt': OrderReceiptData;
  'ac-return-start': ReturnStartData;
  'ac-returns': ReturnsData;
  'ac-return': ReturnData;
  'ac-return-pay': PaymentPageData;
  'ac-invoices': InvoicesData;
  'ac-invoice': InvoiceData;
  'ac-invoice-pay': PaymentPageData;
  'ac-subscriptions': SubscriptionsData;
  'ac-subscription': SubscriptionData;
  'ac-payment-methods': PaymentMethodsData;
  'ac-payment-method-new': PaymentMethodNewData;
  'ac-payment-method-return': PaymentMethodReturnData;
  'ac-profile': ProfileData;
  'ac-profile-email': ProfileEmailData;
  'ac-profile-password': ProfilePasswordData;
  'ac-addresses': AddressesData;
  'ac-address-form': AddressFormData;
  'ac-gift-cards': GiftCardsData;
  'ac-gift-card-add': GiftCardAddData;
  'ac-gift-card': GiftCardData;
  'ac-email-preferences': EmailPreferencesData;
  'ac-privacy': PrivacyData;
  'ac-link-purchases': LinkPurchasesData;
}

export type PageId = keyof PageDataMap;

export const PAGE_IDS = [
  'sign-in',
  'sign-up',
  'verify-email',
  'not-found',
  'error',
  'ac-home',
  'ac-orders',
  'ac-order',
  'ac-order-receipt',
  'ac-return-start',
  'ac-returns',
  'ac-return',
  'ac-return-pay',
  'ac-invoices',
  'ac-invoice',
  'ac-invoice-pay',
  'ac-subscriptions',
  'ac-subscription',
  'ac-payment-methods',
  'ac-payment-method-new',
  'ac-payment-method-return',
  'ac-profile',
  'ac-profile-email',
  'ac-profile-password',
  'ac-addresses',
  'ac-address-form',
  'ac-gift-cards',
  'ac-gift-card-add',
  'ac-gift-card',
  'ac-email-preferences',
  'ac-privacy',
  'ac-link-purchases',
] as const satisfies readonly PageId[];
