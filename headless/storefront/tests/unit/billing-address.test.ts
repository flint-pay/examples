import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivePaymentState, serverBlockers, taxLocationState } from '../../public/js/checkout-logic.js';
import { checkoutPage } from '../../src/views/pages/checkout.ts';
import { browserMessages, copy, messages } from '../../src/copy.ts';
import type { CheckoutData, CheckoutState, PageContext } from '../../src/views/types.ts';

const usd = (amount: string) => ({ amount, currency: 'USD' });

function state(over: { tax?: Record<string, unknown> | null; delivery?: boolean; kind?: 'order' | 'subscription'; billing?: Record<string, string> | null; collection?: string } = {}): CheckoutState {
  const tax = over.tax === undefined ? { enabled: true, status: 'requires_location', available_location_inputs: ['provided'] } : over.tax;
  return {
    checkout_ref: 'chk_unit',
    kind: over.kind ?? 'order',
    collection_kind: over.collection ?? 'unavailable',
    session: { status: 'open', delivery_selection_required: over.delivery ?? false },
    order: {
      order_id: 'ord_unit',
      line_items: [{ name: 'Class', quantity: 1, total_money: usd('3500') }],
      pricing_amounts: { subtotal_money: usd('3500'), total_money: usd('3500') },
      settlement_amounts: { outstanding_money: usd('3500') },
      tax,
    },
    billing_address: over.billing ?? null,
    next: 'new_payment',
    notices: [],
    approved_outstanding_money: usd('3500'),
  } as unknown as CheckoutState;
}

function render(current: CheckoutState): string {
  const ctx = { storeName: 'Cedar & Stone', csrf: 'csrf', user: null, cartCount: 0, accountOrigin: null, appOrigin: 'http://localhost', data: { state: current }, notices: [] } as PageContext<CheckoutData>;
  return String(checkoutPage(ctx));
}

test('billing address truth table', () => {
  assert.equal(taxLocationState(state()), 'needed');
  assert.equal(taxLocationState(state({ tax: { enabled: true, status: 'calculated', available_location_inputs: ['provided'], location: { address_source: 'provided' } } })), 'set');
  assert.equal(taxLocationState(state({ tax: { enabled: true, status: 'calculated', available_location_inputs: ['provided'], location: { address_source: 'delivery' } } })), null);
  assert.equal(taxLocationState(state({ tax: { enabled: true, status: 'calculated', available_location_inputs: ['provided'] } })), null);
  // The service stops listing inputs once tax is calculated. A provided location is still the buyer's address.
  assert.equal(taxLocationState(state({ tax: { enabled: true, status: 'calculated', mode: 'automatic', location: { address_source: 'provided', address_type: 'billing_address' } } })), 'set');
  assert.equal(taxLocationState(state({ tax: { enabled: true, status: 'calculated', available_location_inputs: [], location: { address_source: 'provided' } } })), 'set');
  assert.equal(taxLocationState(state({ tax: { enabled: false, status: 'calculated', location: { address_source: 'provided' } } })), null);
  assert.equal(taxLocationState(state({ tax: { enabled: true, status: 'calculated', location: { address_source: 'provided' } }, delivery: true })), null);
  assert.equal(taxLocationState(state({ tax: { enabled: true, status: 'requires_location', available_location_inputs: [] } })), null);
  assert.equal(taxLocationState(state({ tax: { enabled: true, status: 'requires_location' } })), null);
  assert.equal(taxLocationState(state({ tax: { enabled: false, status: 'requires_location', available_location_inputs: ['provided'] } })), null);
  assert.equal(taxLocationState(state({ tax: null })), null);
  assert.equal(taxLocationState(state({ delivery: true })), null, 'physical delivery never asks for a second address');
});

test('billing needed blocks payment and is not a closed checkout', () => {
  const needed = state();
  assert.equal(derivePaymentState(needed), 'needs_billing');
  assert.deepEqual(serverBlockers(needed), ['billing_address_missing']);
  assert.deepEqual(serverBlockers(state({ delivery: true })).includes('billing_address_missing'), false);
  const ready = state({ tax: { enabled: true, status: 'calculated', available_location_inputs: ['provided'], location: { address_source: 'provided' } }, collection: 'processor' });
  assert.notEqual(derivePaymentState(ready), 'needs_billing');
  assert.equal(serverBlockers(ready).includes('billing_address_missing'), false);
});

test('the page asks for the address and holds back the pay form while it is needed', () => {
  const page = render(state());
  assert.match(page, /data-testid="sf-billing"[^>]*data-state="needed"/);
  assert.match(page, /data-job-form="billing-address"/);
  assert.match(page, /action="\/checkout\/chk_unit\/billing-address"/);
  assert.match(page, /data-testid="sf-payment-needs-billing"/);
  assert.match(page, /Enter your billing address to see your total and pay\./);
  assert.match(page, /Calculated after you enter your billing address/);
  assert.doesNotMatch(page, /data-testid="sf-pay-form"/);
  assert.doesNotMatch(page, /data-testid="sf-unavailable"/);
  for (const word of ['tax location', 'address_type', 'provided']) assert.doesNotMatch(page.replace(/<script[\s\S]*?<\/script>/g, ''), new RegExp(word, 'i'));
});

test('a provided address is shown with a Change control and prefills the form', () => {
  const page = render(state({
    tax: { enabled: true, status: 'calculated', available_location_inputs: ['provided'], location: { address_source: 'provided', address_type: 'billing_address' } },
    billing: { line1: '1 Cedar St', city: 'Austin', state: 'TX', postal_code: '78701' },
    collection: 'processor',
  }));
  assert.match(page, /data-testid="sf-billing"[^>]*data-state="set"/);
  assert.match(page, /data-testid="sf-billing-selected"/);
  assert.match(page, /data-billing-change aria-expanded="false" aria-controls="billing-edit"/);
  assert.match(page, /id="billing-edit" hidden/);
  assert.match(page, /value="1 Cedar St"/);
  assert.doesNotMatch(page, /sf-payment-needs-billing/);
});

test('a provided address is shown for editing when the service lists no inputs', () => {
  const page = render(state({
    tax: { enabled: true, status: 'calculated', location: { address_source: 'provided', address_type: 'billing_address' } },
    billing: { line1: '1 Cedar St', city: 'Austin', state: 'TX', postal_code: '78701' },
    collection: 'processor',
  }));
  assert.match(page, /data-testid="sf-billing"[^>]*data-state="set"/);
  assert.match(page, /data-billing-change/);
});

test('shipping checkouts and checkouts with tax already placed render an empty billing region', () => {
  for (const current of [state({ delivery: true }), state({ tax: { enabled: true, status: 'calculated', available_location_inputs: ['provided'] }, collection: 'processor' })]) {
    const page = render(current);
    assert.match(page, /<div data-region="billing"><\/div>/);
    assert.doesNotMatch(page, /data-job-form="billing-address"/);
  }
});

test('billing copy has the agreed words, reaches the browser, and has no dashes', () => {
  const keys = ['billing_address_needed', 'billing_address_incomplete', 'billing_postal_code_required', 'billing_address_missing'] as const;
  for (const key of keys) {
    assert.ok(messages[key], key);
    assert.equal(browserMessages[key], messages[key]);
    assert.doesNotMatch(messages[key], /[\u2013\u2014]|--/);
  }
  assert.equal(messages.billing_address_missing, 'Enter your billing address to continue.');
  assert.equal(copy.checkout.billingHeading, 'Billing address');
  assert.equal(copy.checkout.saveBillingAddress, 'Save address');
  assert.equal(copy.checkout.taxPendingBilling, 'Calculated after you enter your billing address');
});
