// LOCAL STATE TESTS for catalog, cart, subscribe, and identity pages.
// Stand-in service only. Not staging acceptance.

import { expect, test } from '@playwright/test';
import { resetFixtures } from '../support/helpers.ts';

test.beforeEach(async ({ request }) => resetFixtures(request));

test('home states: setup needed, error with retry link, and cards-not-ready banner', async ({ page }) => {
  await page.goto('/?state=empty');
  await expect(page.getByTestId('sf-setup-needed')).toContainText('Set up the sample store');
  await expect(page.getByTestId('sf-setup-needed')).toContainText('Run npm run setup -- --apply in headless/storefront');
  await page.goto('/?state=error');
  await expect(page.getByText("We couldn't load the shop. Try again.")).toBeVisible();
  await expect(page.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', '/');
  await page.goto('/?state=nocards');
  await expect(page.getByTestId('sf-cards-not-ready')).toContainText('accept_card_payments');
});

test('product with variants: add to cart stays on the page, announces, and updates the count', async ({ page }) => {
  await page.goto('/products/house-blend');
  await expect(page.getByTestId('sf-variant-whole-bean')).toBeChecked();
  await page.getByTestId('sf-variant-ground').check();
  await page.getByTestId('sf-quantity').fill('3');
  await page.getByTestId('sf-add-to-cart').click();
  await expect(page.getByTestId('sf-add-status')).toHaveText('Added to cart');
  await expect(page.getByTestId('sf-cart-count')).toHaveText('3');
  await expect(page.getByTestId('sf-nav-cart')).toHaveAttribute('aria-label', 'Cart, 3 items');
  await expect(page).toHaveURL(/\/products\/house-blend$/);
});

test('product without JS falls back to a redirect with a notice', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL: 'http://localhost:4190' });
  const page = await context.newPage();
  await page.goto('/products/stoneware-mug');
  await page.getByTestId('sf-add-to-cart').click();
  await expect(page).toHaveURL(/\/products\/stoneware-mug\?notice=added_to_cart$/);
  await expect(page.getByTestId('sf-notice-added_to_cart')).toContainText('Added to cart');
  await expect(page.getByTestId('sf-cart-count')).toHaveText('1');
  await context.close();
});

test('product with a single variant has no radio group and quantity is limited to 1 to 20', async ({ page }) => {
  await page.goto('/products/stoneware-mug');
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.getByTestId('sf-quantity')).toHaveAttribute('min', '1');
  await expect(page.getByTestId('sf-quantity')).toHaveAttribute('max', '20');
});

test('cart: lines, update, remove, empty state, and checkout start form', async ({ page }) => {
  await page.goto('/cart');
  await expect(page.getByTestId('sf-cart-empty')).toContainText('Your cart is empty. Browse coffee and gear to get started.');
  await page.goto('/products/house-blend');
  await page.getByTestId('sf-add-to-cart').click();
  await expect(page.getByTestId('sf-cart-count')).toHaveText('1');
  await page.goto('/cart');
  const line = page.locator('[data-testid^="sf-cart-line-"]').first();
  await expect(line).toContainText('House blend coffee, 12 oz');
  await expect(line).toContainText('Whole bean');
  await expect(page.getByTestId('sf-cart-subtotal')).toHaveAttribute('data-amount-minor', '1800');
  await expect(page.getByText('Subtotal before delivery, discounts, and tax')).toBeVisible();
  await line.locator('input[type="number"]').fill('4');
  await line.getByRole('button', { name: /Update quantity/ }).click();
  await expect(page.getByTestId('sf-cart-subtotal')).toHaveAttribute('data-amount-minor', '7200');
  await expect(page.getByTestId('sf-checkout-start')).toHaveText('Check out');
  await page.locator('[data-testid^="sf-cart-remove-"]').click();
  await expect(page.getByTestId('sf-cart-empty')).toBeVisible();
});

test('cart locked state replaces edit controls with a link back to the payment', async ({ page }) => {
  await page.goto('/fx/cart-locked');
  await expect(page.getByTestId('sf-cart-locked')).toHaveText('Your payment is still being confirmed. You can change your cart after it finishes.');
  await expect(page.locator('[data-testid^="sf-cart-remove-"]')).toHaveCount(0);
  await expect(page.getByTestId('sf-checkout-start')).toHaveAttribute('href', '/checkout/chk_waiting');
});

test('subscribe confirms the plan then continues to checkout', async ({ page }) => {
  await page.goto('/subscribe/coffee-club-trial');
  await expect(page.getByTestId('sf-subscribe-billing')).toContainText('$22.00 every month after 14 days');
  await page.getByTestId('sf-subscribe-continue').click();
  await expect(page).toHaveURL(/\/checkout\/chk_subtrial$/);
});

test('sign in failure shows the generic message with focus on it', async ({ page }) => {
  await page.goto('/sign-in?next=%2Fcart');
  await page.getByTestId('sf-sign-in-email').fill('buyer@example.test');
  await page.getByTestId('sf-sign-in-password').fill('wrong-password');
  await page.getByTestId('sf-sign-in-submit').click();
  await expect(page.getByTestId('sf-error-message')).toHaveText('Email or password is incorrect.');
  await expect(page.locator('#page-error')).toBeFocused();
});

test('sign up validates on the client with linked errors and keeps the next path', async ({ page }) => {
  await page.goto('/sign-up?next=%2Fcart');
  await page.getByTestId('sf-sign-up-submit').click();
  await expect(page.locator('#name')).toBeFocused();
  await expect(page.locator('#name')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#name')).toHaveAttribute('aria-describedby', /name-client-error/);
  await page.getByTestId('sf-sign-up-name').fill('Test Buyer');
  await page.getByTestId('sf-sign-up-email').fill('buyer@example.test');
  await page.getByTestId('sf-sign-up-password').fill('short');
  await page.getByTestId('sf-sign-up-submit').click();
  await expect(page.locator('#password')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('input[name="next"]')).toHaveValue('/cart');
  await expect(page.getByTestId('sf-sign-up-password')).toHaveAttribute('data-sensitive', 'true');
});

test('duplicate email on sign up links to sign in', async ({ page }) => {
  await page.goto('/sign-up');
  await page.getByTestId('sf-sign-up-name').fill('Test Buyer');
  await page.getByTestId('sf-sign-up-email').fill('buyer@example.test');
  await page.getByTestId('sf-sign-up-password').fill('long-enough-password');
  await page.getByTestId('sf-sign-up-submit').click();
  await expect(page.getByTestId('sf-sign-up-email-error')).toContainText('An account already uses this email.');
  await expect(page.getByTestId('sf-sign-in-instead')).toHaveAttribute('href', '/sign-in');
});

test('verify email: idle copy, code entry attributes, and delayed resend', async ({ page }) => {
  await page.goto('/verify-email');
  await expect(page.getByTestId('sf-verify-idle')).toHaveText("We'll email a code to buyer@example.test to connect your orders to this account.");
  await page.goto('/verify-email?state=sent');
  await expect(page.getByTestId('sf-verify-sent')).toHaveText('We emailed a 6-digit code to buyer@example.test.');
  const code = page.getByTestId('sf-verify-code');
  await expect(code).toHaveAttribute('inputmode', 'numeric');
  await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
  await expect(code).toHaveAttribute('maxlength', '6');
  await expect(page.getByTestId('sf-verify-resend')).toBeDisabled();
  await expect(page.locator('#resend-reason')).toBeVisible();
  await expect(page.getByTestId('sf-verify-different')).toBeVisible();
});

test('return elsewhere shows the Affirm guidance without order details', async ({ page }) => {
  await page.goto('/checkout/chk_elsewhere/return');
  await expect(page.getByTestId('sf-return-elsewhere')).toHaveText("We couldn't find your checkout in this browser. If you were paying with Affirm, go back to the browser where you started. We'll email your receipt when the payment is confirmed.");
  await expect(page.locator('body')).not.toContainText('CS-1001');
});

test('complete page: receipt can be sent once, then asks to check the inbox', async ({ page }) => {
  await page.goto('/checkout/chk_paid/complete?signal=1');
  await expect(page.getByTestId('sf-paid-signal')).toHaveText('Payment confirmed by Flint');
  await page.getByTestId('sf-send-receipt').click();
  await expect(page.getByTestId('sf-receipt-status')).toHaveText(/^We emailed your receipt/);
  await page.getByTestId('sf-send-receipt').click();
  await expect(page.getByTestId('sf-receipt-status')).toHaveText('We just sent a receipt. Check your inbox.');
  await expect(page.getByTestId('sf-receipt-status')).toHaveAttribute('role', 'alert');
});

test('security: a checkout job without the CSRF header is rejected', async ({ request }) => {
  const response = await request.post('/checkout/chk_card/contact', { data: { email: 'buyer@example.test' } });
  expect(response.status()).toBe(403);
});
