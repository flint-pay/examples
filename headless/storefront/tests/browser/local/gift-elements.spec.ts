// LOCAL STATE TESTS for the Stripe Elements a checkout mounts when a gift card covers part of the order.
// The service behind them is an in-memory stand-in that, like the real one, offers only the methods that can
// collect a partial remainder. Stripe.js is a stub that records which Elements each confirmation token came
// from, because Stripe rejects a confirmation whose payment method types differ from those Elements.
// A pass shows the page rebuilds Elements from current guidance. It does not prove Stripe accepts the result.

import { expect, test } from '@playwright/test';
import { chooseShipping, fillContact, fixtureLog, openCheckout, resetFixtures, typeCard, waitForPayment } from '../support/helpers.ts';
import { tokenElements } from '../support/stripe-stub.ts';

const FULL_TYPES = ['card', 'affirm', 'us_bank_account'];
const PARTIAL_TYPES = ['card', 'us_bank_account'];

test.beforeEach(async ({ request }) => resetFixtures(request));

async function applyGift(page: any) {
  await page.getByTestId('sf-gift-card-code').fill('GOODCARD');
  await page.getByTestId('sf-gift-card-apply').click();
  await expect(page.getByTestId('sf-gift-card-applied-0')).toContainText('Gift card ending 4821');
  await expect(page.getByTestId('sf-pay-button')).toHaveText('Pay $49.69');
}

async function select(page: any) {
  await chooseShipping(page);
  await page.getByTestId('sf-delivery-option-0').check();
  await expect(page.getByTestId('sf-delivery')).toHaveAttribute('data-state', 'selected');
}

async function pays(request: any) {
  return (await fixtureLog(request, 'chk_card')).log.filter((entry) => entry.path === 'pay');
}

test('a partial gift card rebuilds Elements with the remainder methods before the token is created', async ({ page, request }) => {
  await openCheckout(page, 'card');
  await waitForPayment(page, 'ready');
  await fillContact(page);
  await select(page);
  expect((await page.evaluate(() => (window as any).__stripe.elementOptions[0])).paymentMethodTypes).toEqual(FULL_TYPES);
  await typeCard(page, 'ok');
  await applyGift(page);
  await waitForPayment(page, 'ready');
  // The earlier Elements are gone with whatever was typed into them.
  await expect(page.getByTestId('fake-card')).toHaveCount(1);
  await expect(page.getByTestId('fake-card')).toHaveValue('');
  await expect(page.getByTestId('sf-pay-blocker')).toHaveAttribute('data-blocker', 'elements_incomplete');
  await expect(page.getByTestId('fake-affirm-messaging')).toHaveCount(0);
  await typeCard(page, 'ok');
  await page.getByTestId('sf-pay-button').click();
  await expect(page).toHaveURL(/complete$/);
  const elements = await tokenElements(page);
  expect(elements).toHaveLength(1);
  expect(elements[0].paymentMethodTypes).toEqual(PARTIAL_TYPES);
  expect(elements[0].amount).toBe(4969);
  const sent = await pays(request);
  expect(sent).toHaveLength(1);
  expect(sent[0].body.credential).toEqual({ kind: 'confirmation_token', value: 'ctoken_fake_ok' });
  expect(sent[0].body.approved_gift_card_money).toEqual({ amount: '2500', currency: 'USD' });
});

test('a gift card applied while Stripe.js is still loading does not leave stale methods on the form', async ({ page, request }) => {
  await openCheckout(page, 'card', { delayMs: 1500 });
  await fillContact(page);
  await select(page);
  await applyGift(page);
  await waitForPayment(page, 'ready');
  await typeCard(page, 'ok');
  await page.getByTestId('sf-pay-button').click();
  await expect(page).toHaveURL(/complete$/);
  const elements = await tokenElements(page);
  expect(elements).toHaveLength(1);
  expect(elements[0].paymentMethodTypes).toEqual(PARTIAL_TYPES);
  expect(elements[0].amount).toBe(4969);
  expect(await pays(request)).toHaveLength(1);
});

test('removing the gift card brings the full method set back and keeps the save-card choice', async ({ page, request }) => {
  await openCheckout(page, 'card');
  await waitForPayment(page, 'ready');
  await fillContact(page);
  await select(page);
  await applyGift(page);
  await page.getByTestId('sf-save-card').check();
  await page.getByRole('button', { name: /Remove gift card ending 4821/ }).click();
  await expect(page.getByTestId('sf-gift-card-applied-0')).toHaveCount(0);
  await expect(page.getByTestId('sf-pay-button')).toHaveText('Pay $74.69');
  await waitForPayment(page, 'ready');
  await expect(page.getByTestId('sf-save-card')).toBeChecked();
  await typeCard(page, 'ok');
  await page.getByTestId('sf-pay-button').click();
  await expect(page).toHaveURL(/complete$/);
  const elements = await tokenElements(page);
  expect(elements).toHaveLength(1);
  expect(elements[0].paymentMethodTypes).toEqual(FULL_TYPES);
  expect(elements[0].amount).toBe(7469);
  const sent = await pays(request);
  expect(sent).toHaveLength(1);
  expect(sent[0].body.save_payment_method).toBe(true);
});
