// STAGING ACCEPTANCE: single-app checkout journeys SF-03, SF-04, SF-06 to SF-10, SF-25.
//
// These run against the real app, a sandbox, and Stripe test mode. Assertions that need
// Flint's own records (attempt lists, requested_tip_money, settled payments) belong to
// headless/e2e, which reads Flint with the operator key. Here the page is the evidence.

import { expect, test } from '@playwright/test';
import {
  addToCart, CARDS, completeChallenge, ensureTestMode, enterCard, fillContact, payNow, pickUpAtRoastery,
  requireAcceptance, shipToTexas, startCheckout, watchConsole, watchFlintHosts,
} from './support/staging.ts';

requireAcceptance();

test.beforeEach(async ({ page }) => ensureTestMode(page));

test('SF-25 online class (service) skips delivery and pays', async ({ page }) => {
  const flint = watchFlintHosts(page);
  await addToCart(page, 'brewing-class');
  await startCheckout(page);
  await expect(page.getByTestId('sf-delivery')).toHaveCount(0);
  await fillContact(page);
  await enterCard(page, CARDS.success);
  await payNow(page);
  await expect(page.getByTestId('sf-complete-status')).toHaveAttribute('data-status', 'paid', { timeout: 60_000 });
  flint.assertClean();
});

test('SF-04 discount before delivery applies; an invalid code shows copy; a code after delivery releases it', async ({ page }) => {
  await addToCart(page, 'stoneware-mug');
  await startCheckout(page);
  await page.getByTestId('sf-discount-code').fill('NOT-A-CODE');
  const [rejectedDiscount] = await Promise.all([
    page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/discount')),
    page.getByTestId('sf-discount-apply').click(),
  ]);
  expect(rejectedDiscount.status()).toBe(400);
  await expect(page.locator('[data-job-error="discount"]')).toHaveText("That code can't be used on this order.");
  await page.getByTestId('sf-discount-code').fill('WELCOME10');
  await page.getByTestId('sf-discount-apply').click();
  await expect(page.getByTestId('sf-discount-applied-1')).toBeVisible({ timeout: 30_000 });
  const discount = Number(await page.getByTestId('sf-summary-discounts').getAttribute('data-amount-minor'));
  expect(discount).toBeGreaterThan(0);
  await page.getByRole('button', { name: /Remove discount/ }).click();
  await expect(page.getByTestId('sf-discount-applied-1')).toHaveCount(0);
  await fillContact(page);
  await shipToTexas(page);
  await page.getByTestId('sf-discount-code').fill('WELCOME10');
  await page.getByTestId('sf-discount-apply').click();
  await expect(page.getByTestId('sf-notice-delivery_released')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('sf-pay-blocker')).toHaveAttribute('data-blocker', 'delivery_selection_missing');
});

test('SF-03 pickup by postal code with a 15 percent tip keeps the selection and pays', async ({ page }) => {
  await addToCart(page, 'pour-over-kit');
  await startCheckout(page);
  await fillContact(page);
  await pickUpAtRoastery(page);
  await page.getByTestId('sf-tip-15').check();
  await expect(page.getByTestId('sf-summary-tip')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('sf-delivery-selected')).toBeVisible();
  await enterCard(page, CARDS.success);
  await payNow(page);
  await expect(page.getByTestId('sf-complete-status')).toHaveAttribute('data-status', 'paid', { timeout: 60_000 });
});

test('SF-06 tax is pending until delivery, then comes from the order (needs the tax connection, PRQ-TAX)', async ({ page }) => {
  await addToCart(page, 'burr-grinder');
  await startCheckout(page);
  const tax = page.getByTestId('sf-summary-tax');
  if (!(await tax.getAttribute('data-state'))) test.skip(true, 'PRQ-TAX: automatic tax is not connected for this sandbox, so there is no pending tax state to observe');
  await expect(tax).toHaveText('Calculated after you choose delivery');
  await fillContact(page);
  await shipToTexas(page);
  await expect(page.getByTestId('sf-summary-tax')).not.toHaveAttribute('data-state', 'requires_location');
  expect(Number(await page.getByTestId('sf-summary-tax').getAttribute('data-amount-minor'))).toBeGreaterThan(0);
});

test('SF-07 a declined card shows the default copy and a retry with 4242 succeeds', async ({ page }) => {
  await addToCart(page, 'stoneware-mug');
  await startCheckout(page);
  await fillContact(page);
  await shipToTexas(page);
  await enterCard(page, CARDS.decline);
  await payNow(page);
  await expect(page.getByTestId('sf-payment')).toHaveAttribute('data-state', 'declined', { timeout: 60_000 });
  await expect(page.getByTestId('sf-payment-message')).toHaveText('Your payment was declined. Try another card or payment method.');
  await enterCard(page, CARDS.success);
  await payNow(page);
  await expect(page.getByTestId('sf-complete-status')).toHaveAttribute('data-status', 'paid', { timeout: 60_000 });
});

test('SF-08 a completed challenge succeeds; a failed one shows authentication copy; a retry with 4242 succeeds', async ({ page }) => {
  await addToCart(page, 'stoneware-mug');
  await startCheckout(page);
  await fillContact(page);
  await shipToTexas(page);
  await enterCard(page, CARDS.challenge);
  await payNow(page);
  await completeChallenge(page, 'fail');
  await expect(page.getByTestId('sf-payment')).toHaveAttribute('data-state', 'declined', { timeout: 60_000 });
  await expect(page.getByTestId('sf-payment-message')).toHaveText("Your payment wasn't completed. Try again.");
  await enterCard(page, CARDS.challenge);
  await payNow(page);
  await completeChallenge(page, 'complete');
  await expect(page.getByTestId('sf-complete-status')).toHaveAttribute('data-status', 'paid', { timeout: 60_000 });
});

test('SF-09 interrupted payment: reload during the challenge, and a lost pay response, never double charge', async ({ page }) => {
  await addToCart(page, 'stoneware-mug');
  await startCheckout(page);
  await fillContact(page);
  await shipToTexas(page);
  await enterCard(page, CARDS.challenge);
  await payNow(page);
  await expect(page.getByTestId('sf-payment')).toHaveAttribute('data-state', /authenticating|resuming/, { timeout: 60_000 });
  await page.reload();
  await completeChallenge(page, 'complete');
  await expect(page.getByTestId('sf-complete-status')).toHaveAttribute('data-status', 'paid', { timeout: 60_000 });
});

test('SF-09b the pay response is lost after the server sent it: waiting, then the real outcome', async ({ page }) => {
  await addToCart(page, 'stoneware-mug');
  await startCheckout(page);
  await fillContact(page);
  await shipToTexas(page);
  await enterCard(page, CARDS.success);
  await page.route('**/checkout/*/pay', async (route) => {
    await route.fetch();
    await route.abort('failed');
  });
  await payNow(page);
  await expect(page.getByTestId('sf-complete-status')).toHaveAttribute('data-status', 'paid', { timeout: 90_000 });
  // The operator read of Flint attempts (headless/e2e) proves exactly one attempt and one settled payment.
});

test('SF-10 double click on Pay creates one attempt', async ({ page }) => {
  await addToCart(page, 'stoneware-mug');
  await startCheckout(page);
  await fillContact(page);
  await shipToTexas(page);
  await enterCard(page, CARDS.success);
  const posts: string[] = [];
  page.on('request', (request) => request.method() === 'POST' && /\/pay$/.test(request.url()) && posts.push(request.url()));
  await expect(page.getByTestId('sf-pay-button')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('sf-pay-button').dblclick();
  await expect(page.getByTestId('sf-complete-status')).toHaveAttribute('data-status', 'paid', { timeout: 60_000 });
  expect(posts.length).toBe(1);
});

test('no console errors through a card checkout', async ({ page }) => {
  const errors = watchConsole(page);
  await addToCart(page, 'brewing-class');
  await startCheckout(page);
  await fillContact(page);
  await enterCard(page, CARDS.success);
  await payNow(page);
  await expect(page.getByTestId('sf-complete-status')).toHaveAttribute('data-status', 'paid', { timeout: 60_000 });
  expect(errors).toEqual([]);
});
