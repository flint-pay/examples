// STAGING SMOKE CHECKS against a running copy of the real account app (ACCOUNT_BASE_URL).
//
// These only read public, signed-out pages. They need no sandbox data and make no writes. They
// are not the acceptance journeys: sign-up, email codes, payments, returns, and subscriptions with
// real sandbox resources belong to the shared acceptance harness in headless/e2e.
//
// Run: ACCOUNT_BROWSER_MODE=staging ACCOUNT_BASE_URL=http://localhost:4200 npm run test:browser
import { expect, test } from '@playwright/test';
import { watch } from '../support/helpers.ts';

test.describe('real app, signed out', () => {
  test('the sign-in page renders with the test mode banner and talks only to this app', async ({ page, baseURL }) => {
    const seen = watch(page, baseURL ?? '');
    const response = await page.goto('/sign-in');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await expect(page.getByTestId('ac-test-banner')).toContainText('Test mode: payments use Stripe test cards and no money moves.');
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(seen.flint).toEqual([]);
    expect(seen.foreign).toEqual([]);
    expect(seen.consoleErrors).toEqual([]);
  });

  test('account pages send a signed-out visitor to sign in and keep the path', async ({ page }) => {
    await page.goto('/orders?page=example');
    await expect(page).toHaveURL(/\/sign-in\?next=%2Forders%3Fpage%3Dexample$/);
  });

  test('resource hint links keep their full path through sign-in', async ({ page }) => {
    await page.goto('/invoices/inv_not_real?flint_resource_type=invoice&flint_resource_id=inv_not_real&flint_mode=sandbox');
    await expect(page).toHaveURL(/\/sign-in\?next=/);
    const next = new URL(page.url()).searchParams.get('next') ?? '';
    expect(next.startsWith('/invoices/inv_not_real?')).toBe(true);
    expect(next).toContain('flint_resource_type=invoice');
  });

  test('the sign-in form posts to this app with a CSRF field', async ({ page }) => {
    await page.goto('/sign-in');
    const form = page.getByTestId('ac-sign-in-form');
    await expect(form).toHaveAttribute('method', 'post');
    await expect(form).toHaveAttribute('action', '/sign-in');
    await expect(form.locator('input[name="_csrf"]')).toHaveCount(1);
  });

  test('the email preference page is public and needs the link from an email', async ({ page }) => {
    await page.goto('/email-preferences');
    await expect(page.getByTestId('ac-email-preferences')).toHaveAttribute('data-state', 'token-missing');
    await expect(page.getByTestId('ac-pref-missing')).toContainText('Open the unsubscribe link from your email again.');
  });

  test('security headers are present and no page script is inline', async ({ page }) => {
    const response = await page.goto('/sign-in');
    const csp = response?.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('https://js.stripe.com');
    expect(response?.headers()['cache-control']).toContain('no-store');
    const inline = await page.locator('script:not([src])').evaluateAll((nodes) => nodes.filter((n) => n.getAttribute('type') !== 'application/json').length);
    expect(inline).toBe(0);
  });

  test('an unknown path does not reveal account data', async ({ page }) => {
    const response = await page.goto('/orders/ord_not_a_real_order');
    expect(page.url()).toContain('/sign-in');
    expect(response?.status()).toBe(200);
  });
});
