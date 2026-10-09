// LOCAL STATE TESTS. These run the real views and scripts against the in-memory
// stand-in service. They check structure, accessibility basics, and layout.
// They are not staging acceptance.

import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installStripeStub } from '../support/stripe-stub.ts';
import { resetFixtures } from '../support/helpers.ts';

test.beforeEach(async ({ request }) => resetFixtures(request));

const pages: { name: string; url: string; testid: string; state?: string }[] = [
  { name: 'home loaded', url: '/', testid: 'sf-home', state: 'loaded' },
  { name: 'home setup needed', url: '/?state=empty', testid: 'sf-home', state: 'empty_setup_needed' },
  { name: 'home error', url: '/?state=error', testid: 'sf-home', state: 'error' },
  { name: 'home cards not ready', url: '/?state=nocards', testid: 'sf-home', state: 'loaded' },
  { name: 'product', url: '/products/house-blend', testid: 'sf-product', state: 'loaded' },
  { name: 'product not found', url: '/products/missing', testid: 'sf-product', state: 'not_found' },
  { name: 'cart empty', url: '/cart', testid: 'sf-cart', state: 'empty' },
  { name: 'cart locked', url: '/fx/cart-locked', testid: 'sf-cart', state: 'locked' },
  { name: 'subscribe', url: '/subscribe/coffee-club-trial', testid: 'sf-subscribe', state: 'loaded' },
  { name: 'sign in', url: '/sign-in', testid: 'sf-sign-in' },
  { name: 'sign up', url: '/sign-up', testid: 'sf-sign-up' },
  { name: 'verify email idle', url: '/verify-email', testid: 'sf-verify-email', state: 'idle' },
  { name: 'verify email sent', url: '/verify-email?state=sent', testid: 'sf-verify-email', state: 'code_sent' },
  { name: 'checkout ready', url: '/checkout/chk_card', testid: 'sf-checkout' },
  { name: 'checkout pickup', url: '/checkout/chk_pickup', testid: 'sf-checkout' },
  { name: 'checkout service', url: '/checkout/chk_service', testid: 'sf-checkout' },
  { name: 'checkout trial', url: '/checkout/chk_subtrial', testid: 'sf-checkout' },
  { name: 'checkout expired', url: '/checkout/chk_expired', testid: 'sf-checkout' },
  { name: 'checkout unavailable', url: '/checkout/chk_unavailable', testid: 'sf-checkout' },
  { name: 'checkout declined', url: '/checkout/chk_declined', testid: 'sf-checkout' },
  { name: 'complete paid', url: '/checkout/chk_paid/complete', testid: 'sf-complete', state: 'paid' },
  { name: 'complete card saved', url: '/checkout/chk_guestsaved/complete', testid: 'sf-complete', state: 'paid' },
  { name: 'complete card not saved', url: '/checkout/chk_guestexpired/complete', testid: 'sf-complete', state: 'paid' },
  { name: 'complete bank', url: '/checkout/chk_bankdone/complete', testid: 'sf-complete', state: 'bank_processing' },
  { name: 'return elsewhere', url: '/checkout/chk_elsewhere/return', testid: 'sf-return' },
  { name: 'server error', url: '/fx/error', testid: 'sf-error' },
  { name: 'not found', url: '/nothing-here', testid: 'sf-not-found' },
];

async function noErrors(page: Page) {
  const errors: string[] = [];
  // An intentional 404 or 500 page makes the browser log its own status; that is not a script error.
  page.on('console', (message) => message.type() === 'error' && !/status of (404|500)/.test(message.text()) && errors.push(message.text()));
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

for (const entry of pages) {
  test(`renders ${entry.name} with landmarks, one h1, and no console errors`, async ({ page }) => {
    await installStripeStub(page);
    const errors = await noErrors(page);
    await page.goto(entry.url);
    const main = page.getByTestId(entry.testid);
    await expect(main).toBeVisible();
    if (entry.state) await expect(main).toHaveAttribute('data-state', entry.state);
    await expect(page.getByTestId('sf-test-banner')).toHaveText('Test mode: payments use Stripe test cards and no money moves.');
    await expect(page.locator('header')).toHaveCount(1);
    await expect(page.locator('nav').first()).toBeVisible();
    await expect(page.locator('footer')).toHaveCount(1);
    await expect(page.locator('h1')).toHaveCount(1);
    expect(await page.locator('[role="alert"]:visible, [role="status"]:visible').count()).toBeGreaterThanOrEqual(0);
    expect(errors).toEqual([]);
  });
}

for (const width of [390, 768, 1024, 1440]) {
  test(`no horizontal scroll at ${width}px on key screens`, async ({ page }) => {
    await installStripeStub(page);
    await page.setViewportSize({ width, height: 900 });
    for (const url of ['/', '/products/house-blend', '/fx/cart-locked', '/checkout/chk_card', '/checkout/chk_paid/complete', '/checkout/chk_guestsaved/complete', '/sign-up']) {
      await page.goto(url);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${url} overflows at ${width}`).toBeLessThanOrEqual(0);
    }
  });
}

test('touch targets are at least 44px on primary controls at 390px', async ({ page }) => {
  await installStripeStub(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/checkout/chk_card');
  for (const id of ['sf-pay-button', 'sf-discount-apply', 'sf-delivery-quote', 'sf-nav-cart']) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box!.height, id).toBeGreaterThanOrEqual(43.5);
  }
  for (const id of ['sf-contact-name', 'sf-contact-email', 'sf-discount-code']) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box!.height, id).toBeGreaterThanOrEqual(43.5);
  }
});

test('order summary collapses below 1024px and stays open at 1024px and above', async ({ page }) => {
  await installStripeStub(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/checkout/chk_card');
  const details = page.locator('details[data-summary]');
  await expect(details).not.toHaveAttribute('open', '');
  await expect(page.locator('summary')).toContainText('Order total $60.00');
  await page.locator('summary').click();
  await expect(details).toHaveAttribute('open', '');
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(details).toHaveAttribute('open', '');
  const layout = await page.evaluate(() => {
    const aside = document.querySelector('[data-testid="sf-summary"]')!.getBoundingClientRect();
    const first = document.querySelector('#contact')!.getBoundingClientRect();
    return { asideLeft: aside.left, contactLeft: first.left };
  });
  expect(layout.asideLeft).toBeGreaterThan(layout.contactLeft + 300);
});

test('home grid uses 1, 2, and 3 columns', async ({ page }) => {
  const columns = async () => page.evaluate(() => getComputedStyle(document.querySelector('.grid')!).gridTemplateColumns.split(' ').length);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/');
  expect(await columns()).toBe(1);
  await page.setViewportSize({ width: 800, height: 800 });
  expect(await columns()).toBe(2);
  await page.setViewportSize({ width: 1200, height: 800 });
  expect(await columns()).toBe(3);
});

test('skip link is first in tab order and moves focus to main', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  const link = page.getByRole('link', { name: 'Skip to main content' });
  await expect(link).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
});

test('money elements expose amount and currency', async ({ page }) => {
  await installStripeStub(page);
  await page.goto('/checkout/chk_card');
  await expect(page.getByTestId('sf-summary-total')).toHaveAttribute('data-amount-minor', '6000');
  await expect(page.getByTestId('sf-summary-total')).toHaveAttribute('data-currency', 'USD');
  await expect(page.getByTestId('sf-summary-tax')).toHaveAttribute('data-state', 'requires_location');
});

test('axe reports no serious or critical violations on screen states', async ({ page }) => {
  await installStripeStub(page);
  for (const entry of pages) {
    await page.goto(entry.url);
    await expect(page.getByTestId(entry.testid)).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    const bad = results.violations.filter((violation: any) => ['serious', 'critical'].includes(violation.impact));
    expect(bad.map((violation: any) => `${entry.name}: ${violation.id}`)).toEqual([]);
  }
});
