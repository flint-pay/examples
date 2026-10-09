// STAGING ACCEPTANCE HELPERS. These drive the real storefront app, which talks to
// a Flint sandbox, with real Stripe.js in Stripe test mode. Nothing here is
// stubbed. Selectors that reach into Stripe's frames follow Stripe's published
// markup and have not been run against a live sandbox from this repository yet.
//
// Never put real emails, ids, or keys in these files. Test buyers use the
// run-scoped inbox alias supplied by the lifecycle adapter.

import { expect, test, type Page, type Request } from '@playwright/test';
import { browserBuyerEmail, requireBrowserLifecycle } from './buyer.ts';

export const TEST_BUYER = { name: 'Test Buyer', get email() { return browserBuyerEmail(process.env); } };
export const TEXAS_ADDRESS = { line1: '400 Congress Ave', city: 'Austin', state: 'TX', postal: '78701' };

export const CARDS = {
  success: '4242424242424242',
  decline: '4000000000009995',
  challenge: '4000002500003155',
} as const;

export function requireAcceptance() {
  test.skip(process.env.STOREFRONT_ACCEPTANCE !== '1', 'staging acceptance needs STOREFRONT_ACCEPTANCE=1, a running app, and a sandbox');
  requireBrowserLifecycle(process.env);
}

/** Refuses to run unless the app reports test mode. */
export async function ensureTestMode(page: Page) {
  const response = await page.request.get('/healthz');
  expect(response.ok(), 'the app must be running and healthy').toBe(true);
  const health = await response.json();
  expect(health.mode, 'acceptance runs only in test mode').toBe('test');
}

/** Fails the test when the browser itself calls a Flint host. The app server talks to Flint, never the page. */
export function watchFlintHosts(page: Page) {
  const violations: string[] = [];
  const record = (request: Request) => {
    const url = new URL(request.url());
    if (/(^|\.)withflintpay\.com$/.test(url.hostname)) {
      const relay = request.isNavigationRequest() && request.method() === 'GET' && /^\/payment-returns\//.test(url.pathname);
      if (!relay) violations.push(`${request.method()} ${url.origin}${url.pathname}`);
    }
  };
  page.on('request', record);
  return {
    assertClean() {
      expect(violations, 'the browser must not call Flint hosts except the payment return relay').toEqual([]);
    },
  };
}

export function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

export async function addToCart(page: Page, slug: string, quantity = 1) {
  await page.goto(`/products/${slug}`);
  await page.getByTestId('sf-quantity').fill(String(quantity));
  await page.getByTestId('sf-add-to-cart').click();
  await expect(page.getByTestId('sf-add-status')).toHaveText('Added to cart');
}

export async function startCheckout(page: Page) {
  await page.goto('/cart');
  await page.getByTestId('sf-checkout-start').click();
  await expect(page).toHaveURL(/\/checkout\/chk_[0-9A-HJKMNP-TV-Z]{20}$/);
  await expect(page.getByTestId('sf-payment')).not.toHaveAttribute('data-state', 'loading', { timeout: 30_000 });
}

export async function fillContact(page: Page) {
  await page.getByTestId('sf-contact-name').fill(TEST_BUYER.name);
  await page.getByTestId('sf-contact-email').fill(TEST_BUYER.email);
  await page.getByTestId('sf-contact-email').blur();
}

export async function shipToTexas(page: Page) {
  await page.getByTestId('sf-ship-name').fill(TEST_BUYER.name);
  await page.getByTestId('sf-ship-line1').fill(TEXAS_ADDRESS.line1);
  await page.getByTestId('sf-ship-city').fill(TEXAS_ADDRESS.city);
  await page.getByTestId('sf-ship-state').fill(TEXAS_ADDRESS.state);
  await page.getByTestId('sf-ship-postal').fill(TEXAS_ADDRESS.postal);
  await page.getByTestId('sf-delivery-quote').click();
  await expect(page.getByTestId('sf-delivery-option-0')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('sf-delivery-option-0').check();
  await expect(page.getByTestId('sf-delivery')).toHaveAttribute('data-state', 'selected', { timeout: 30_000 });
}

export async function pickUpAtRoastery(page: Page) {
  await page.getByTestId('sf-delivery-mode-pickup').check();
  await page.getByTestId('sf-pickup-postal').fill(TEXAS_ADDRESS.postal);
  await page.getByTestId('sf-pickup-search').click();
  await expect(page.getByTestId('sf-pickup-location-0')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('sf-pickup-location-0').check();
  await page.getByTestId('sf-pickup-select').click();
  await expect(page.getByTestId('sf-delivery')).toHaveAttribute('data-state', 'selected', { timeout: 30_000 });
}

/** Types a test card into Stripe's Payment Element frame. */
export async function enterCard(page: Page, number: string) {
  const frame = page.frameLocator('#payment-element iframe').first();
  const cardNumber = frame.getByLabel('Card number');
  if (!(await cardNumber.isVisible().catch(() => false))) {
    await frame.getByRole('button', { name: /^Card/ }).click().catch(() => undefined);
  }
  await cardNumber.fill(number);
  await frame.getByLabel(/Expiration date/).fill('12 / 34');
  await frame.getByLabel(/Security code/).fill('123');
  const zip = frame.getByLabel(/ZIP|Postal/);
  if (await zip.isVisible().catch(() => false)) await zip.fill('78701');
}

export async function completeChallenge(page: Page, outcome: 'complete' | 'fail') {
  const challenge = page.frameLocator('iframe[name="stripe-challenge-frame"]').frameLocator('iframe').first();
  await challenge.getByRole('button', { name: outcome === 'complete' ? /Complete/i : /Fail/i }).click({ timeout: 30_000 });
}

export async function payNow(page: Page) {
  await expect(page.getByTestId('sf-pay-button')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('sf-pay-button').click();
}
