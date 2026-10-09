// Local fixtures for frontend state tests. Every id, email, and amount here is a
// made-up placeholder. Nothing in this file is a Flint resource or a credential.

import type { CartData, CatalogItem, CheckoutState, HomeData, Money, Order, PlanItem } from '../../../src/views/types.ts';

export const usd = (amount: number | string | bigint): Money => ({ amount: String(amount), currency: 'USD' });

const variant = (id: string, name: string | undefined, price: number) => ({
  variant_id: id,
  ...(name ? { name } : {}),
  available_for_sale: true,
  unit_price_money: usd(price),
});

export const catalog: CatalogItem[] = [
  { slug: 'house-blend', product: { product_id: 'prod_fixture_1', name: 'House blend coffee, 12 oz', product_type: 'physical', price_range: { min_unit_price_money: usd(1800), max_unit_price_money: usd(1800) } }, variants: [variant('var_fixture_whole', 'Whole bean', 1800), variant('var_fixture_ground', 'Ground', 1800)] },
  { slug: 'stoneware-mug', product: { product_id: 'prod_fixture_2', name: 'Stoneware mug', product_type: 'physical', price_range: { min_unit_price_money: usd(2400), max_unit_price_money: usd(2400) } }, variants: [variant('var_fixture_mug', undefined, 2400)] },
  { slug: 'travel-mug', product: { product_id: 'prod_fixture_3', name: 'Insulated travel mug', product_type: 'physical', price_range: { min_unit_price_money: usd(3800), max_unit_price_money: usd(3800) } }, variants: [variant('var_fixture_travel', undefined, 3800)] },
  { slug: 'pour-over-kit', product: { product_id: 'prod_fixture_4', name: 'Pour-over brewing kit', product_type: 'physical', price_range: { min_unit_price_money: usd(6800), max_unit_price_money: usd(6800) } }, variants: [variant('var_fixture_kit', undefined, 6800)] },
  { slug: 'burr-grinder', product: { product_id: 'prod_fixture_5', name: 'Burr grinder', product_type: 'physical', price_range: { min_unit_price_money: usd(14500), max_unit_price_money: usd(14500) } }, variants: [variant('var_fixture_grinder', undefined, 14500)] },
  { slug: 'brewing-class', product: { product_id: 'prod_fixture_6', name: 'Online brewing class', product_type: 'service', price_range: { min_unit_price_money: usd(3500), max_unit_price_money: usd(3500) } }, variants: [variant('var_fixture_class', undefined, 3500)] },
];

export const plans: PlanItem[] = [
  { slug: 'coffee-club-monthly', plan: { subscription_plan_id: 'plan_fixture_1', name: 'Coffee club, monthly', currency: 'USD', billing_interval: 'month', billing_interval_count: 1, line_items: [{ quantity: 1, unit_price_money: usd(2200) }] } },
  { slug: 'coffee-club-trial', plan: { subscription_plan_id: 'plan_fixture_2', name: 'Coffee club with a 14-day free trial', currency: 'USD', billing_interval: 'month', billing_interval_count: 1, trial_period_days: 14, line_items: [{ quantity: 1, unit_price_money: usd(2200) }] } },
];

export const homeLoaded: HomeData = { products: catalog, plans, cards: 'ready', setupNeeded: false };

export function cartData(lines: { id: string; slug: string; variant: number; quantity: number }[]): CartData {
  let subtotal = 0n;
  const built = lines.map((line) => {
    const item = catalog.find((entry) => entry.slug === line.slug)!;
    const chosen = item.variants[line.variant]!;
    subtotal += BigInt(chosen.unit_price_money!.amount) * BigInt(line.quantity);
    return { line_id: line.id, quantity: line.quantity, item, variant: chosen };
  });
  return { cart: { cart_id: 'cart_fixture', lines: built, subtotal_money: usd(subtotal.toString()) } };
}

export type Scenario =
  | 'card' | 'pickup' | 'service' | 'subtrial' | 'subpaid' | 'gift' | 'expired' | 'recovery' | 'unavailable'
  | 'authenticating' | 'waiting' | 'bank' | 'affirm' | 'declined' | 'remaining' | 'paid' | 'bankdone' | 'signedin' | 'returning' | 'wallet' | 'lostresume' | 'stuckresume' | 'resumefail'
  | 'subtrialdeclined' | 'subtrialwaiting'
  | 'taxneeded' | 'taxset' | 'subtrialtax'
  | 'guestsave' | 'guestemail' | 'guestnotext' | 'guestsaved' | 'guestexpired' | 'guestleft';

const STRIPE = { publishable_key: 'pk_test_fixture', account_id: 'acct_fixture' };

function guidance(mode: 'payment' | 'setup', amount: Money, extra: Record<string, unknown> = {}, relay = 0) {
  return {
    stripe: {
      ...STRIPE,
      return_url: relay ? `https://relay.example.test/payment-returns/fixture-${relay}` : 'https://relay.example.test/payment-returns/fixture',
      elements: {
        mode,
        next_step: mode === 'setup' ? 'collect_setup_payment_source' : 'create_confirmation_token',
        submit_to: mode === 'setup' ? 'pay_order' : 'pay_order',
        payment_method_creation: 'manual',
        payment_method_types: ['card', 'affirm', 'us_bank_account'],
        digital_wallets: [],
        amount_money: amount,
        ...extra,
      },
    },
  };
}

export function lineFor(slug: string, variantIndex: number, quantity: number, id: string) {
  const item = catalog.find((entry) => entry.slug === slug)!;
  const chosen = item.variants[variantIndex]!;
  return {
    order_line_item_id: id,
    name: item.product.name,
    quantity,
    unit_price_money: chosen.unit_price_money,
    total_money: usd(BigInt(chosen.unit_price_money!.amount) * BigInt(quantity)),
    selected_options: item.variants.length > 1 ? [{ option_name: 'Grind', value: chosen.name ?? '' }] : [],
    slug,
  };
}

export type FakeConfig = {
  lines: ReturnType<typeof lineFor>[];
  needsDelivery: boolean;
  kind: 'order' | 'subscription';
  trial: boolean;
};

export function baseOrder(config: FakeConfig): Order {
  return {
    order_id: 'ord_fixture_1',
    order_number: 'CS-1001',
    customer_id: undefined,
    order_revision: '3',
    status: 'open',
    payment_status: 'unpaid',
    line_items: config.lines,
    pricing_amounts: null,
    settlement_amounts: null,
    charges: [],
    applied_discounts: [],
    gift_cards: [],
    gift_card_estimate: null,
    tax: { status: config.needsDelivery ? 'requires_location' : 'calculated', enabled: true },
    requested_tip: null,
    buyer_contact: { email: null, phone: null },
    delivery_destination: null,
  } as unknown as Order;
}

export function scenarioConfig(scenario: Scenario): FakeConfig {
  switch (scenario) {
    case 'service':
    case 'taxneeded':
    case 'taxset':
      return { lines: [lineFor('brewing-class', 0, 1, 'li_1')], needsDelivery: false, kind: 'order', trial: false };
    case 'subtrial':
    case 'subtrialtax':
    case 'subtrialdeclined':
    case 'subtrialwaiting':
      return { lines: [], needsDelivery: false, kind: 'subscription', trial: true };
    case 'subpaid':
      return { lines: [], needsDelivery: false, kind: 'subscription', trial: false };
    case 'pickup':
    case 'affirm':
      return { lines: [lineFor('pour-over-kit', 0, 1, 'li_1')], needsDelivery: true, kind: 'order', trial: false };
    default:
      return { lines: [lineFor('house-blend', 0, 2, 'li_1'), lineFor('stoneware-mug', 0, 1, 'li_2')], needsDelivery: true, kind: 'order', trial: false };
  }
}

export { guidance, STRIPE };
export type { CheckoutState };
