// Shapes the views read. They mirror published Flint field names (Order,
// CheckoutSession, OrderPaymentAttempt, BuyerDeliveryQuote, and so on) and list
// only the fields a view uses, so the app can pass the SDK objects through.
// Everything is optional where the Flint schema marks it optional.

export type Money = { amount: string; currency: string };

export type PageId =
  | 'sf-home'
  | 'sf-product'
  | 'sf-cart'
  | 'sf-subscribe'
  | 'sf-checkout'
  | 'sf-complete'
  | 'sign-in'
  | 'sign-up'
  | 'verify-email'
  | 'return-elsewhere'
  | 'not-found'
  | 'error';

export type FieldErrors = Record<string, string>;

export type PageError = {
  kind?: string;
  code?: string;
  message_key?: string;
  request_id?: string;
};

export type PageContext<D = Record<string, unknown>> = {
  storeName: string;
  csrf: string;
  user: { name: string; email: string } | null;
  cartCount: number;
  accountOrigin: string | null;
  appOrigin: string;
  data: D;
  /** Copy keys. `key:value` passes one parameter, for example `email_confirmed_linked:3`. */
  notices: string[];
  error?: PageError;
  /** Optional extras for form pages: values to refill and per-field copy keys. */
  form?: { values?: Record<string, string>; errors?: FieldErrors };
  /** Current path with query, used for the account menu and sign-in links. */
  path?: string;
};

export type FlintImage = { url: string; alt?: string };

export type ProductVariant = {
  variant_id: string;
  name?: string;
  sku?: string;
  available_for_sale?: boolean;
  unit_price_money: Money | null;
  selected_options?: { option_name: string; value: string }[];
  metadata?: Record<string, string>;
};

export type Product = {
  product_id: string;
  name: string;
  description?: string;
  product_type: string;
  available_for_sale?: boolean;
  price_range?: { min_unit_price_money: Money | null; max_unit_price_money: Money | null } | null;
  metadata?: Record<string, string>;
};

export type CatalogItem = { slug: string; product: Product; variants: ProductVariant[] };

export type SubscriptionPlan = {
  subscription_plan_id: string;
  name: string;
  description?: string;
  currency: string;
  billing_interval: string;
  billing_interval_count: number;
  trial_period_days?: number;
  setup_fee_money?: Money | null;
  contract_term_months?: number;
  early_termination_fee_money?: Money | null;
  line_items?: { quantity: number; unit_price_money?: Money | null }[];
};

export type PlanItem = { slug: string; plan: SubscriptionPlan };

export type CartLine = {
  line_id: string;
  quantity: number;
  item: CatalogItem;
  variant: ProductVariant;
};

export type HomeData = {
  products: CatalogItem[];
  plans: PlanItem[];
  cards?: string;
  setupNeeded?: boolean;
  /** Set when the catalog read failed. */
  loadFailed?: boolean;
};

export type ProductData = { item: CatalogItem | null; loadFailed?: boolean };

export type CartData = {
  cart: { cart_id?: string; lines: CartLine[]; subtotal_money: Money | null };
  /** When an open checkout exists and an attempt is in progress, the cart is locked. */
  locked?: boolean;
  checkoutRef?: string | null;
};

export type SubscribeData = { item: PlanItem | null; loadFailed?: boolean };

// ----- Checkout -----

export type Address = {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
};

export type OrderLineItem = {
  order_line_item_id?: string;
  name: string;
  quantity: number;
  unit_price_money: Money | null;
  total_money: Money | null;
  selected_options?: { option_name: string; value: string }[];
  product_id?: string;
  variant_id?: string;
  /** Catalog slug, when the app can resolve one, for the local image. */
  slug?: string;
};

export type PricingAmounts = {
  subtotal_money: Money | null;
  discount_money: Money | null;
  charge_money: Money | null;
  requested_tip_money: Money | null;
  tax_money: Money | null;
  total_money: Money | null;
};

export type SettlementAmounts = {
  outstanding_money: Money | null;
  paid_money?: Money | null;
};

export type Order = {
  order_id: string;
  order_number?: string;
  customer_id?: string;
  order_revision?: string | number;
  status?: string;
  payment_status?: string;
  line_items: OrderLineItem[];
  pricing_amounts: PricingAmounts | null;
  settlement_amounts: SettlementAmounts | null;
  charges?: { name: string; applied_money: Money | null }[];
  applied_discounts?: {
    order_discount_id: string;
    customer_facing_name?: string;
    promotion_code?: string;
    applied_money: Money | null;
  }[];
  gift_cards?: { gift_card_id: string; last_characters: string; available_money: Money | null }[];
  gift_card_tender_enabled?: boolean;
  gift_card_estimate?: {
    can_pay: boolean;
    gift_card_money: Money | null;
    processor_money: Money | null;
    gift_cards: { gift_card_id: string; amount_money: Money | null }[];
  } | null;
  gift_card_settlements?: { amount_money: Money | null; last_characters?: string }[];
  payment_intents?: { payment_intent_id: string; status?: string; payment_source?: { type?: string } | null }[];
  tax?: { status: string; enabled: boolean } | null;
  requested_tip?: { percent?: number; amount_money?: Money | null } | null;
  buyer_contact?: { email: string | null; phone: string | null; is_email_cleared?: boolean; is_phone_cleared?: boolean } | null;
  delivery_destination?: {
    address: Address | null;
    recipient?: { name?: string; phone?: string } | null;
  } | null;
  subscription_id?: string;
  subscription_plan?: { name: string } | null;
};

export type CheckoutProblem = { code: string; severity?: string; blocks_completion?: boolean };

export type CheckoutSessionBuyer = {
  status?: string;
  recovery_mode: boolean;
  delivery_selection_required: boolean;
  expires_at?: string;
  buyer_contact?: { email: string | null; phone: string | null; is_email_cleared?: boolean; is_phone_cleared?: boolean } | null;
  customer_prefill?: {
    email?: string;
    shipping_recipient_name?: string;
    shipping_address?: Address | null;
  } | null;
  merchant_support?: { email?: string; phone?: string; url?: string } | null;
  promotion_config?: { codes_enabled?: boolean | null } | null;
  tip?: {
    enabled?: boolean;
    tip_percent_options?: number[];
    is_custom_tip_enabled?: boolean;
  } | null;
  problems?: CheckoutProblem[];
  save_payment_method_offered?: boolean;
  save_payment_method_phone_offered?: boolean;
  save_payment_method_requires_verification?: boolean;
  subscription_terms?: SubscriptionTerms | null;
  payment_method_save?: { status: string; email_confirmation_required: boolean } | null;
};

export type SubscriptionTerms = {
  plan_name: string;
  billing_interval: string;
  billing_interval_count: number;
  recurring_total_money: Money | null;
  trial_period_days?: number;
  contract_term_months?: number;
  early_termination_fee_money?: Money | null;
  setup_fee_money?: Money | null;
};

export type StripeGuidance = {
  stripe?: {
    publishable_key?: string;
    account_id?: string;
    return_url?: string;
    elements?: {
      mode: string;
      next_step: string;
      submit_to: string;
      payment_method_creation: string;
      payment_method_types: string[];
      digital_wallets?: string[];
      amount_money?: Money | null;
      payment_method_options?: Record<string, unknown>;
      selectable_payment_intents?: { payment_intent_id: string; amount_money: Money | null; status: string }[];
    } | null;
  } | null;
};

export type AttemptPaymentIntent = {
  payment_intent_id: string;
  status: string;
  amount_money: Money | null;
  last_payment_error?: { code: string; message?: string } | null;
};

export type PaymentAttempt = {
  status: string;
  is_resumable: boolean;
  mode?: string;
  failure_code?: string | null;
  failure_message?: string;
  expected_outstanding_money?: Money | null;
  payment_intents?: AttemptPaymentIntent[];
  /** Provider ids only. The client secret never appears in this object. */
  pending_actions?: { pending_action_id: string; action_type: string }[];
  /** App-added helper for dedupe: the id of the open pending action. */
  pending_action_id?: string;
};

export type NextStep =
  | 'done'
  | 'pay_remaining'
  | 'new_payment'
  | 'capture'
  | 'authenticate'
  | 'resume'
  | 'wait'
  | 'bank_processing';

export type DeliveryOption = {
  delivery_option_id?: string;
  delivery_method_id: string;
  name: string;
  description?: string;
  type: string;
  amount_money: Money | null;
  arrival_estimate?: { earliest_date: string; latest_date: string; timezone?: string } | null;
  pickup?: {
    pickup_mode?: string;
    location?: { location_id: string; name: string; address?: Address | null; instructions?: string } | null;
  } | null;
  recommended?: boolean;
  recipient_requirements?: { field: string; required: boolean }[];
};

export type DeliveryChoiceGroup = {
  delivery_choice_group_id: string;
  availability_status: string;
  evaluation_status?: string;
  method_types: string[];
  line_items?: { name?: string }[];
  options: DeliveryOption[];
  input_requirements: { delivery_input_requirement_id?: string; field_path: string; purpose?: string }[];
  address_advisories?: unknown[];
};

export type PickupLocation = DeliveryOption & {
  delivery_choice_group_id: string;
  availability_status?: string;
  display_position?: number;
  input_requirements?: { field_path: string; purpose?: string }[];
  expires_at?: string;
};

export type DeliveryQuote = {
  delivery_quote_id: string;
  status?: string;
  evaluation_status?: string;
  expires_at?: string;
  buyer_reasons?: string[];
  selection_required?: boolean;
  destination_address?: Address | null;
  buyer_location?: { type: string; address?: Address | null } | null;
  choice_groups: DeliveryChoiceGroup[];
  input_requirements?: { field_path: string; purpose?: string }[];
};

export type DeliverySelection = {
  delivery_selection_id: string;
  status?: string;
  amount_money: Money | null;
  destination_address?: Address | null;
  recipient?: { name?: string; email?: string; phone?: string } | null;
  input_requirements: { field_path: string; purpose?: string }[];
  choices: {
    delivery_choice_group_id: string;
    delivery_option_id: string;
    name: string;
    type: string;
    amount_money: Money | null;
    total_money?: Money | null;
    arrival_estimate?: { earliest_date: string; latest_date: string } | null;
    pickup?: { location?: { name: string; address?: Address | null; instructions?: string } | null } | null;
  }[];
};

export type SavedMethod = {
  payment_method_id: string;
  type?: string;
  card?: { brand: string; exp_month: number; exp_year: number; last4: string; wallet?: string } | null;
};

export type CheckoutVerification = {
  status: 'code_sent';
  delivery_channel?: string;
  masked_email?: string;
  phone_last_digits?: string;
};

export type CheckoutSubscription = {
  subscription_id: string;
  status: string;
  trial_end?: string;
  next_billing_at?: string;
  recurring_amount_money?: Money | null;
  subscription_plan?: { name: string } | null;
  payment_method?: { card?: { brand: string; last4: string } | null } | null;
};

export type CollectionKind = 'processor' | 'settlement' | 'setup' | 'unavailable';

export type CheckoutState = {
  checkout_ref: string;
  kind: 'order' | 'subscription';
  /** What the app will ask the buyer for: a payment source, nothing (settlement), or a setup source. */
  collection_kind?: CollectionKind;
  /** Name the app keeps outside Flint for delivery and billing. */
  contact_name?: string;
  session: CheckoutSessionBuyer;
  order: Order;
  attempt?: PaymentAttempt | null;
  next: NextStep;
  payment_collection?: StripeGuidance | null;
  setup_collection?: StripeGuidance | null;
  delivery_quote?: DeliveryQuote | null;
  delivery_selection?: DeliverySelection | null;
  /** Pickup options projected from the quote, in display order, with their group and availability. */
  pickup_locations?: PickupLocation[] | null;
  saved_methods?: SavedMethod[] | null;
  verification?: CheckoutVerification | null;
  subscription?: CheckoutSubscription | null;
  notices: string[];
  approved_outstanding_money: Money | null;
  /** Optional app-owned buyer details the server keeps outside Flint. */
  buyer?: { name?: string; email_locked?: boolean; signed_in_email?: string } | null;
};

export type CheckoutData = { state: CheckoutState };

export type CompleteData = {
  state: CheckoutState;
  paidSignal?: boolean;
  accountUrl?: string | null;
};

export type IdentityData = {
  next?: string;
  email?: string;
  verification?: { status: 'idle' | 'code_sent'; sentAt?: number | string } | null;
};
