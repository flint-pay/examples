// STAGING ACCEPTANCE HELPERS. These drive the real storefront app, which talks to
// a Flint sandbox, with real Stripe.js in Stripe test mode. Nothing here is
// stubbed. Selectors that reach into Stripe's frames follow Stripe's published
// markup and have not been run against a live sandbox from this repository yet.
//
// Never put real emails, ids, or keys in these files. Test buyers use the
// run-scoped inbox alias supplied by the lifecycle adapter.

import { expect, test, type Frame, type Page, type Request } from '@playwright/test';
import { browserBuyerEmail, requireBrowserLifecycle } from './buyer.ts';

export const TEST_BUYER = { name: 'Test Buyer', get email() { return browserBuyerEmail(process.env); } };
export const NEW_YORK_BILLING_ADDRESS = { line1: '11 Wall Street', city: 'New York', state: 'NY', postal: '10005' };
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

/**
 * Enters a billing address when the checkout asks for one so automatic tax can be calculated. That
 * happens on checkouts with no delivery step. Does nothing when the billing section is absent or
 * already set. Returns once the saved address is shown and the card form is available.
 * @returns whether an address was entered
 */
export async function fillBillingAddressIfRequired(page: Page, address = NEW_YORK_BILLING_ADDRESS): Promise<boolean> {
  const billing = page.getByTestId('sf-billing');
  if (!(await billing.isVisible().catch(() => false)) || (await billing.getAttribute('data-state')) !== 'needed') return false;
  await page.getByTestId('sf-bill-line1').fill(address.line1);
  await page.getByTestId('sf-bill-city').fill(address.city);
  await page.getByTestId('sf-bill-state').fill(address.state);
  await page.getByTestId('sf-bill-postal').fill(address.postal);
  await page.getByTestId('sf-billing-save').click();
  await expect(page.getByTestId('sf-billing')).toHaveAttribute('data-state', 'set', { timeout: 30_000 });
  await expect(page.getByTestId('sf-pay-form')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('sf-payment')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  return true;
}

export async function shipToTexas(page: Page) {
  await shipToAddress(page, TEXAS_ADDRESS);
}

export async function shipToAddress(page: Page, address: { line1: string; city: string; state: string; postal: string }) {
  await page.getByTestId('sf-ship-name').fill(TEST_BUYER.name);
  await page.getByTestId('sf-ship-line1').fill(address.line1);
  await page.getByTestId('sf-ship-city').fill(address.city);
  await page.getByTestId('sf-ship-state').fill(address.state);
  await page.getByTestId('sf-ship-postal').fill(address.postal);
  await page.getByTestId('sf-delivery-quote').click();
  await expect(page.getByTestId('sf-delivery-option-0')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('sf-delivery-option-0').check();
  await expect(page.getByTestId('sf-delivery')).toHaveAttribute('data-state', 'selected', { timeout: 30_000 });
}

export async function pickUpAtRoastery(page: Page) {
  await page.getByTestId('sf-delivery-mode-pickup').check();
  await page.getByTestId('sf-pickup-postal').fill(process.env.E2E_PICKUP_POSTAL_CODE ?? TEXAS_ADDRESS.postal);
  await page.getByTestId('sf-pickup-search').click();
  await expect(page.getByTestId('sf-pickup-location-0')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('sf-pickup-location-0').check();
  await page.getByTestId('sf-pickup-select').click();
  await expect(page.getByTestId('sf-delivery')).toHaveAttribute('data-state', 'selected', { timeout: 30_000 });
}

/**
 * Types a test card into Stripe's Payment Element, using the strategy of headless/e2e/support/driver.ts:
 * find the frame that holds `#payment-numberInput` rather than the first iframe, and type each field
 * with pressSequentially. When Stripe shows an accordion, the Card option is opened with an ordinary
 * click. Waits up to 30 seconds. A failure reports counts only, never frame addresses or page text.
 */
export async function enterCard(page: Page, number: string) {
  const deadline = Date.now() + 30_000;
  let frames = 0;
  let matched = 0;
  let accordion = 0;
  while (Date.now() < deadline) {
    frames = 0;
    matched = 0;
    accordion = 0;
    let option: ReturnType<Page['getByRole']> | null = null;
    for (const frame of page.frames()) {
      frames += 1;
      const input = frame.locator('#payment-numberInput');
      if (await input.count().catch(() => 0)) {
        matched += 1;
        if (await input.isVisible().catch(() => false)) {
          await typeCardFields(frame, number);
          return;
        }
      }
      const card = frame.getByRole('button', { name: /^Card/ });
      if (await card.first().isVisible().catch(() => false)) {
        accordion += 1;
        if ((await card.first().getAttribute('aria-expanded').catch(() => null)) !== 'true') option = card.first();
      }
    }
    // Stripe shows the Card option as a collapsed row. A normal click opens it; a disabled row is left alone.
    if (option && (await option.isEnabled().catch(() => false))) await option.click({ timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(250);
  }
  throw new Error(`STRIPE_CARD_INPUT_MISSING: ${frames} frames, ${matched} with the card number input, ${accordion} with a visible Card option, none usable within 30 seconds`);
}

async function typeCardFields(frame: Frame, number: string) {
  for (const [selector, value] of [['#payment-numberInput', number], ['#payment-expiryInput', '1234'], ['#payment-cvcInput', '123']] as const) {
    const input = frame.locator(selector);
    await input.fill('');
    await input.pressSequentially(value, { delay: 15 });
  }
  const postal = frame.locator('#payment-postalCodeInput');
  if (await postal.isVisible().catch(() => false)) {
    await postal.fill('');
    await postal.pressSequentially('78701', { delay: 15 });
  }
}

/**
 * Presses the test challenge control wherever Stripe puts it. The control's frame nesting is not
 * fixed, so every frame on the page is searched by the button's accessible name, as headless/e2e
 * does. Stripe's test widget names its buttons "Complete" and "Fail" (older ones add "authentication");
 * both exact names match, and "Cancel" never does. Waits up to 30 seconds and activates the enabled control
 * with focus and Enter, never forcing a click.
 * A missing control is a recorded failure.
 */
export async function completeChallenge(page: Page, outcome: 'complete' | 'fail') {
  const name = outcome === 'complete' ? /^Complete(?: authentication)?$/i : /^Fail(?: authentication)?$/i;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const button = frame.getByRole('button', { name }).first();
      if ((await button.isVisible().catch(() => false)) && (await button.isEnabled().catch(() => false))) {
        // Keyboard activation of the enabled control, the standard accessible way to press a button.
        await button.focus();
        await button.press('Enter');
        return;
      }
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`PROVIDER_CHALLENGE_CONTROL_MISSING: no visible "${outcome === 'complete' ? 'Complete' : 'Fail'}" or "${outcome === 'complete' ? 'Complete' : 'Fail'} authentication" button in any frame within 30 seconds`);
}

export async function payNow(page: Page) {
  await expect(page.getByTestId('sf-pay-button')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('sf-pay-button').click();
}
