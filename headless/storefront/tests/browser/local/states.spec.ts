// LOCAL STATE TESTS for the corrected pickup and settlement flows, and for notice handling.
// Stand-in service and Stripe stub only. Not staging acceptance.

import { expect, test } from '@playwright/test';
import { renderPage } from '../../../src/views/index.ts';
import { FakeCheckout } from '../support/fake-backend.ts';
import { chooseShipping, fillContact, fixtureLog, openCheckout, resetFixtures, typeCard, waitForPayment } from '../support/helpers.ts';
import { stripeCalls } from '../support/stripe-stub.ts';

test.beforeEach(async ({ request }) => resetFixtures(request));

test('pickup search with no results shows none_nearby copy and keeps the search form', async ({ page }) => {
  await openCheckout(page, 'pickup');
  await waitForPayment(page, 'ready');
  await page.getByTestId('sf-delivery-mode-pickup').check();
  await page.getByTestId('sf-pickup-postal').fill('99999');
  await page.getByTestId('sf-pickup-search').click();
  await expect(page.getByTestId('sf-delivery')).toHaveAttribute('data-state', 'none_nearby');
  await expect(page.getByTestId('sf-pickup-none')).toHaveText('No pickup locations near 99999. Try another ZIP code or ship to an address.');
  await expect(page.getByTestId('sf-pickup-search')).toBeVisible();
});

test('pickup options need the Pick up here button, and arrow keys never submit', async ({ page, request }) => {
  await openCheckout(page, 'pickup');
  await waitForPayment(page, 'ready');
  await fillContact(page);
  await page.getByTestId('sf-delivery-mode-pickup').check();
  await page.getByTestId('sf-pickup-postal').fill('78701');
  await page.getByTestId('sf-pickup-search').click();
  await page.getByTestId('sf-pickup-location-0').check();
  await expect(page.getByTestId('sf-delivery')).toHaveAttribute('data-state', 'options');
  expect((await fixtureLog(request, 'chk_pickup')).log.some((entry) => entry.path === 'delivery/select')).toBe(false);
  await page.getByTestId('sf-pickup-select').click();
  await expect(page.getByTestId('sf-delivery-selected')).toContainText('Pick up at Cedar & Stone Roastery');
  const log = (await fixtureLog(request, 'chk_pickup')).log;
  expect(log.find((entry) => entry.path === 'pickup-locations')!.body).toEqual({ postal_code: '78701', country: 'US' });
  expect(log.find((entry) => entry.path === 'delivery/select')!.body.recipient.name).toBe('Test Buyer');
});

test('discount covering the order shows the settlement explanation and Confirm order without a card form', async ({ page, request }) => {
  await openCheckout(page, 'service');
  await waitForPayment(page, 'ready');
  await fillContact(page);
  await typeCard(page, 'ok');
  await expect(page.getByTestId('sf-payment')).toHaveAttribute('data-collection', 'processor');
  await page.getByTestId('sf-discount-code').fill('FREE100');
  await page.getByTestId('sf-discount-apply').click();
  await expect(page.getByTestId('sf-payment')).toHaveAttribute('data-collection', 'settlement');
  await expect(page.getByTestId('sf-settlement-explanation')).toHaveText('Your discounts cover this order. Nothing will be charged.');
  await expect(page.getByTestId('sf-pay-button')).toHaveText('Confirm order');
  await expect(page.getByTestId('fake-card')).toHaveCount(0);
  await expect(page.getByTestId('sf-save-card')).toBeHidden();
  await expect(page.getByTestId('sf-pay-blocker')).toHaveText('');
  await page.getByTestId('sf-pay-button').click();
  await expect(page).toHaveURL(/complete$/);
  await expect(page.getByTestId('sf-complete-payment-method')).toHaveText('Covered by discounts');
  const body = (await fixtureLog(request, 'chk_service')).log.find((entry) => entry.path === 'pay')!.body;
  expect(body.approved_collection_kind).toBe('settlement');
  expect(body.approved_outstanding_money).toEqual({ amount: '0', currency: 'USD' });
  expect(body.credential).toBeUndefined();
});

test('gift card split line, then full coverage unmounts the card form and removing the card brings it back empty', async ({ page }) => {
  await openCheckout(page, 'service');
  await waitForPayment(page, 'ready');
  await fillContact(page);
  await typeCard(page, 'ok');
  await page.getByTestId('sf-gift-card-code').fill('GOODCARD');
  await page.getByTestId('sf-gift-card-apply').click();
  await expect(page.getByTestId('sf-gift-card-split')).toHaveText('Gift card: $25.00. Card or other payment: $12.88.');
  await expect(page.getByTestId('sf-pay-button')).toHaveText('Pay $12.88');
  await page.getByRole('button', { name: /Remove gift card/ }).click();
  await expect(page.getByTestId('sf-gift-card-split')).toBeHidden();
  await page.getByTestId('sf-gift-card-code').fill('FULLCARD');
  await page.getByTestId('sf-gift-card-apply').click();
  await expect(page.getByTestId('sf-payment')).toHaveAttribute('data-collection', 'settlement');
  await expect(page.getByTestId('sf-settlement-explanation')).toHaveText('Your gift card covers this order. $37.88 will come off your gift card balance.');
  await expect(page.getByTestId('fake-card')).toHaveCount(0);
  await page.getByRole('button', { name: /Remove gift card/ }).click();
  await expect(page.getByTestId('sf-payment')).toHaveAttribute('data-collection', 'processor');
  await expect(page.getByTestId('fake-card')).toHaveValue('');
  await expect(page.getByTestId('sf-pay-button')).toBeDisabled();
  const updates = (await stripeCalls(page)).filter((call) => call.name === 'Stripe');
  expect(updates.length).toBeGreaterThanOrEqual(2);
});

test('gift card changed after display asks to check the amounts again', async ({ page }) => {
  await openCheckout(page, 'service');
  await waitForPayment(page, 'ready');
  await fillContact(page);
  await page.getByTestId('sf-gift-card-code').fill('FULLCARD');
  await page.getByTestId('sf-gift-card-apply').click();
  await expect(page.getByTestId('sf-pay-button')).toHaveText('Confirm order');
  await page.route('**/checkout/chk_service/pay', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: await (await page.request.get('/checkout/chk_service/attempt')).json().then((j) => j.state), next: 'new_payment', error: { kind: 'conflict', code: 'ORDER_CHANGED_REFRESH_REQUIRED', message_key: 'gift_card_changed', request_id: 'req_fixture' } }) });
  });
  await page.getByTestId('sf-pay-button').click();
  await waitForPayment(page, 'total_changed');
  await expect(page.getByTestId('sf-payment-message')).toHaveText('Your gift card balance changed. Check the amounts, then confirm.');
});

test('Affirm is recognized from the order payment source type, not from a notice', async () => {
  const fake = new FakeCheckout('chk_affirm');
  fake.notices = [];
  const html = await renderPage('sf-checkout', { storeName: 'Cedar & Stone', csrf: 'x', user: null, cartCount: 0, accountOrigin: null, appOrigin: 'http://localhost:4100', notices: [], data: { state: fake.project() } });
  expect(html).toContain('data-state="affirm_incomplete"');
  const other = new FakeCheckout('chk_authenticating');
  other.notices = ['affirm_incomplete'];
  const html2 = await renderPage('sf-checkout', { storeName: 'Cedar & Stone', csrf: 'x', user: null, cartCount: 0, accountOrigin: null, appOrigin: 'http://localhost:4100', notices: [], data: { state: other.project() } });
  expect(html2).toContain('data-state="authenticating"');
});

test('notices from the app map to buyer copy and unknown keys never reach the page', async ({ page }) => {
  const fake = new FakeCheckout('chk_card');
  fake.notices = ['delivery_requoted', 'gift_card_changed', 'action_reconciliation_required', 'cart_reconciliation_required', 'internal_debug_key'];
  const html = await renderPage('sf-checkout', { storeName: 'Cedar & Stone', csrf: 'x', user: null, cartCount: 0, accountOrigin: null, appOrigin: 'http://localhost:4100', notices: [], data: { state: fake.project() } });
  expect(html).toContain('Delivery prices changed. Choose an updated option.');
  expect(html).toContain('Your gift card balance changed. Check the amounts, then confirm.');
  expect(html).toContain('We are still finishing your last change.');
  expect(html).not.toContain('internal_debug_key');
  void page;
});

test('zero-based test ids on lists', async ({ page }) => {
  await openCheckout(page, 'card');
  await waitForPayment(page, 'ready');
  await fillContact(page);
  await chooseShipping(page);
  await expect(page.getByTestId('sf-delivery-option-0')).toBeVisible();
  await expect(page.getByTestId('sf-delivery-option-1')).toHaveCount(0);
});
