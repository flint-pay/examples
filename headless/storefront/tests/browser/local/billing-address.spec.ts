// LOCAL STATE TESTS for the billing address a no-delivery checkout asks for so tax can be calculated.
// The service behind these tests is an in-memory stand-in and Stripe.js is a stub. A pass means the
// views and public/js react correctly to the shapes the app sends. It does not prove Flint, Stripe,
// or the real app behave that way.

import { expect, test, type Page } from '@playwright/test';
import { chooseShipping, fillContact, fixtureLog, openCheckout, resetFixtures, typeCard, waitForPayment } from '../support/helpers.ts';

test.beforeEach(async ({ request }) => resetFixtures(request));

async function fillBilling(page: Page, over: { postal?: string; state?: string } = {}) {
  await page.getByTestId('sf-bill-line1').fill('200 Test Avenue');
  await page.getByTestId('sf-bill-city').fill('Austin');
  await page.getByTestId('sf-bill-state').fill(over.state ?? 'tx');
  await page.getByTestId('sf-bill-postal').fill(over.postal ?? '78701');
}

const entries = async (request: Parameters<typeof fixtureLog>[0], scenario: string, path: string) =>
  (await fixtureLog(request, `chk_${scenario}`)).log.filter((entry) => entry.path === path);

test('a service order needing an address shows the form, no card form, and sends no payment on load', async ({ page, request }) => {
  await openCheckout(page, 'taxneeded');
  await waitForPayment(page, 'needs_billing');
  await expect(page.getByTestId('sf-billing')).toHaveAttribute('data-state', 'needed');
  await expect(page.getByRole('heading', { name: 'Billing address' })).toBeVisible();
  await expect(page.getByTestId('sf-payment-needs-billing')).toHaveText('Enter your billing address to see your total and pay.');
  await expect(page.getByTestId('sf-pay-form')).toHaveCount(0);
  await expect(page.getByTestId('sf-unavailable')).toHaveCount(0);
  await expect(page.getByTestId('sf-summary-tax')).toHaveText('Calculated after you enter your billing address');
  await expect(page.getByTestId('sf-summary-tax')).toHaveAttribute('data-state', 'requires_location');
  expect((await fixtureLog(request, 'chk_taxneeded')).payCount).toBe(0);
  expect(await entries(request, 'taxneeded', 'pay')).toHaveLength(0);
});

test('saving the address does not pay, brings in the card form with the new totals, and the card pays', async ({ page, request }) => {
  await openCheckout(page, 'taxneeded');
  await waitForPayment(page, 'needs_billing');
  await fillBilling(page);
  await page.getByTestId('sf-billing-save').click();
  await waitForPayment(page, 'ready');
  await expect(page.getByTestId('sf-pay-form')).toBeVisible();
  // 3500 plus 8.25% tax
  await expect(page.getByTestId('sf-summary-tax')).toHaveAttribute('data-amount-minor', '288');
  await expect(page.getByTestId('sf-summary-total')).toHaveAttribute('data-amount-minor', '3788');
  await expect(page.getByTestId('sf-pay-button')).toHaveText('Pay $37.88');
  await expect(page.getByTestId('sf-billing')).toHaveAttribute('data-state', 'set');
  await expect(page.getByTestId('sf-billing-selected')).toContainText('200 Test Avenue');
  expect(await entries(request, 'taxneeded', 'pay')).toHaveLength(0);
  const saved = await entries(request, 'taxneeded', 'billing-address');
  expect(saved).toHaveLength(1);
  expect(saved[0]!.body).toEqual({ line1: '200 Test Avenue', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' });
  await fillContact(page);
  await typeCard(page, 'ok');
  await page.getByTestId('sf-pay-button').click();
  await expect(page).toHaveURL(/complete$/);
  const pays = await entries(request, 'taxneeded', 'pay');
  expect(pays).toHaveLength(1);
  expect(pays[0]!.body.approved_outstanding_money.amount).toBe('3788');
});

test('an incomplete or bad address is stopped in the browser with an alert and sends nothing', async ({ page, request }) => {
  await openCheckout(page, 'taxneeded');
  await waitForPayment(page, 'needs_billing');
  await page.getByTestId('sf-billing-save').click();
  const error = page.locator('[data-job-error="billing"]');
  await expect(error).toHaveText('Enter your full billing address.');
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(page.getByTestId('sf-bill-line1')).toHaveAttribute('aria-invalid', 'true');
  await fillBilling(page, { postal: '787' });
  await page.getByTestId('sf-billing-save').click();
  await expect(error).toHaveText('Enter a 5-digit postal code.');
  expect(await entries(request, 'taxneeded', 'billing-address')).toHaveLength(0);
});

test('an error from the service shows next to the form, keeps the entries, and leaves payment closed', async ({ page, request }) => {
  await openCheckout(page, 'taxneeded');
  await waitForPayment(page, 'needs_billing');
  await fillBilling(page, { postal: '00000' });
  await page.getByTestId('sf-billing-save').click();
  await expect(page.locator('[data-job-error="billing"]')).toBeVisible();
  await expect(page.getByTestId('sf-bill-postal')).toHaveValue('00000');
  await expect(page.getByTestId('sf-pay-form')).toHaveCount(0);
  await expect(page.getByTestId('sf-billing-save')).toBeEnabled();
  const sent = await entries(request, 'taxneeded', 'billing-address');
  expect(sent).toHaveLength(1);
  expect(sent[0]!.body.postal_code).toBe('00000');
});

test('a provided address can be changed, and the new total is what the card pays', async ({ page, request }) => {
  await openCheckout(page, 'taxset');
  await waitForPayment(page, 'ready');
  await expect(page.getByTestId('sf-billing')).toHaveAttribute('data-state', 'set');
  await expect(page.getByTestId('sf-billing-selected')).toContainText('1 Cedar St');
  await expect(page.getByTestId('sf-summary-total')).toHaveAttribute('data-amount-minor', '3788');
  const change = page.getByRole('button', { name: 'Change' });
  await expect(change).toHaveAttribute('aria-expanded', 'false');
  await change.click();
  await expect(change).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('sf-bill-line1')).toBeFocused();
  await expect(page.getByTestId('sf-bill-city')).toHaveValue('Austin');
  await page.getByTestId('sf-bill-state').fill('ca');
  await page.getByTestId('sf-billing-save').click();
  await expect(page.getByTestId('sf-summary-total')).toHaveAttribute('data-amount-minor', '3832');
  await expect(page.getByTestId('sf-pay-button')).toHaveText('Pay $38.32');
  await expect(page.getByTestId('sf-pay-form')).toBeVisible();
  await fillContact(page);
  await typeCard(page, 'ok');
  await page.getByTestId('sf-pay-button').click();
  await expect(page).toHaveURL(/complete$/);
  const pays = await entries(request, 'taxset', 'pay');
  expect(pays).toHaveLength(1);
  expect(pays[0]!.body.approved_outstanding_money.amount).toBe('3832');
});

test('a physical shipping order has no billing form and keeps delivery-based tax', async ({ page, request }) => {
  await openCheckout(page, 'card');
  await waitForPayment(page, 'ready');
  await expect(page.getByTestId('sf-billing')).toHaveCount(0);
  await expect(page.locator('[data-job-form="billing-address"]')).toHaveCount(0);
  await expect(page.getByTestId('sf-summary-tax')).toHaveAttribute('data-state', 'requires_location');
  await expect(page.getByTestId('sf-summary-tax')).toHaveText('Calculated after you choose delivery');
  await chooseShipping(page);
  await page.getByTestId('sf-delivery-option-0').check();
  await expect(page.getByTestId('sf-delivery')).toHaveAttribute('data-state', 'selected');
  await expect(page.getByTestId('sf-summary-tax')).not.toHaveAttribute('data-state', 'requires_location');
  await expect(page.getByTestId('sf-billing')).toHaveCount(0);
  expect(await entries(request, 'card', 'billing-address')).toHaveLength(0);
});

test('a zero-trial subscription still sets up the card after the address, and one without the need is unchanged', async ({ page, request }) => {
  await openCheckout(page, 'subtrialtax');
  await waitForPayment(page, 'needs_billing');
  await expect(page.getByTestId('sf-pay-form')).toHaveCount(0);
  await fillBilling(page);
  await page.getByTestId('sf-billing-save').click();
  await waitForPayment(page, 'ready');
  await expect(page.getByTestId('sf-pay-button')).toHaveText('Start free trial');
  await fillContact(page);
  await typeCard(page, 'ok');
  await page.getByTestId('sf-pay-button').click();
  await expect(page.getByTestId('sf-complete-status')).toHaveText('Your free trial has started');
  const pays = await entries(request, 'subtrialtax', 'pay');
  expect(pays).toHaveLength(1);
  expect(pays[0]!.body.approved_collection_kind).toBe('setup');

  await openCheckout(page, 'subtrial');
  await waitForPayment(page, 'ready');
  await expect(page.getByTestId('sf-billing')).toHaveCount(0);
});

test('a gift card still pays the revision it was shown after the address changes the total', async ({ page, request }) => {
  await openCheckout(page, 'taxset');
  await waitForPayment(page, 'ready');
  await page.getByTestId('sf-gift-card-code').fill('GOODCARD');
  await page.getByTestId('sf-gift-card-apply').click();
  await expect(page.getByTestId('sf-gift-card-applied-0')).toBeVisible();
  await page.getByRole('button', { name: 'Change' }).click();
  await page.getByTestId('sf-bill-state').fill('ca');
  await page.getByTestId('sf-billing-save').click();
  await expect(page.getByTestId('sf-summary-total')).toHaveAttribute('data-amount-minor', '3832');
  await fillContact(page);
  await typeCard(page, 'ok');
  await page.getByTestId('sf-pay-button').click();
  await expect(page).toHaveURL(/complete$/);
  const pays = await entries(request, 'taxset', 'pay');
  expect(pays).toHaveLength(1);
  expect(pays[0]!.body.approved_order_revision).toBe('4');
});

test('the service lists no address inputs once tax is calculated, and the saved address is still shown after a reload', async ({ page }) => {
  await openCheckout(page, 'taxset');
  await waitForPayment(page, 'ready');
  const state = await page.evaluate(() => JSON.parse(document.getElementById('checkout-bootstrap')!.textContent!).state.order.tax);
  expect(state.available_location_inputs).toBeUndefined();
  await expect(page.getByTestId('sf-billing')).toHaveAttribute('data-state', 'set');
  await page.reload();
  await waitForPayment(page, 'ready');
  await expect(page.getByTestId('sf-billing')).toHaveAttribute('data-state', 'set');
  await expect(page.getByTestId('sf-billing-selected')).toContainText('1 Cedar St');
});

test('a bad postal code marks and focuses only that field, and the mark clears when it is corrected', async ({ page, request }) => {
  await openCheckout(page, 'taxneeded');
  await waitForPayment(page, 'needs_billing');
  await fillBilling(page, { postal: '787' });
  await page.getByTestId('sf-bill-postal').press('Enter');
  await expect(page.locator('[data-job-error="billing"]')).toHaveText('Enter a 5-digit postal code.');
  await expect(page.getByTestId('sf-bill-postal')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('sf-bill-postal')).toBeFocused();
  for (const id of ['sf-bill-line1', 'sf-bill-city', 'sf-bill-state']) await expect(page.getByTestId(id)).not.toHaveAttribute('aria-invalid', 'true');
  await page.getByTestId('sf-bill-postal').fill('78701');
  await expect(page.getByTestId('sf-bill-postal')).not.toHaveAttribute('aria-invalid', 'true');
  expect(await entries(request, 'taxneeded', 'billing-address')).toHaveLength(0);
  // A missing later field is the one flagged, not the first.
  await page.getByTestId('sf-bill-city').fill('');
  await page.getByTestId('sf-billing-save').click();
  await expect(page.getByTestId('sf-bill-city')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('sf-bill-city')).toBeFocused();
  await expect(page.getByTestId('sf-bill-line1')).not.toHaveAttribute('aria-invalid', 'true');
});

test('after the first saved address reloads the page, focus returns to the billing heading once', async ({ page }) => {
  await openCheckout(page, 'taxneeded');
  await waitForPayment(page, 'needs_billing');
  await fillBilling(page);
  await page.getByTestId('sf-bill-postal').press('Enter');
  await waitForPayment(page, 'ready');
  await expect(page.locator('#billing-title')).toBeFocused();
  await page.reload();
  await waitForPayment(page, 'ready');
  await expect(page.locator('#billing-title')).not.toBeFocused();
});

test('a saved address whose refresh cannot be read tells the buyer instead of leaving the old form', async ({ page, request }) => {
  await openCheckout(page, 'taxneeded');
  await waitForPayment(page, 'needs_billing');
  // The page refresh asks for exactly text/html; the first load did not go through this route.
  await page.route('**/checkout/chk_taxneeded', (route) => (route.request().headers().accept === 'text/html' ? route.abort('failed') : route.continue()));
  await fillBilling(page);
  await page.getByTestId('sf-billing-save').click();
  await expect(page.locator('[data-job-error="billing"]')).toHaveText("We couldn't reach the store. Check your connection, then try again.");
  await expect(page.getByTestId('sf-pay-form')).toHaveCount(0);
  await expect(page.getByTestId('sf-billing-save')).toBeEnabled();
  expect(await entries(request, 'taxneeded', 'billing-address')).toHaveLength(1);
  expect(await entries(request, 'taxneeded', 'pay')).toHaveLength(0);
});
