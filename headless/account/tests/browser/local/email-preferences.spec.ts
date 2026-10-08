// LOCAL STATE TEST for the public email preference page. The routes are scripted.
import { expect, test } from '@playwright/test';
import { harnessLog, resetHarness, watch } from '../support/helpers.ts';

const page_ = '/__render/ac-email-preferences';

test.describe('unsubscribe link', () => {
  test.beforeEach(async ({ request }) => {
    await resetHarness(request);
  });

  test('reads the token from the fragment, removes it, confirms, and unsubscribes', async ({ page, request, baseURL }) => {
    const seen = watch(page, baseURL ?? '');
    await page.goto(`${page_}#flint_email_preference_token=tok_valid`);
    const root = page.getByTestId('ac-email-preferences');
    await expect(root).toHaveAttribute('data-state', 'token-confirm');
    expect(page.url()).not.toContain('#');
    expect(page.url()).not.toContain('tok_valid');
    expect(await page.evaluate(() => window.location.hash)).toBe('');
    await expect(page.getByText('Unsubscribe avery@example.test from shipping updates?')).toBeVisible();

    await page.getByTestId('ac-unsubscribe-button').click();
    await expect(root).toHaveAttribute('data-state', 'token-done');
    await expect(page.getByTestId('ac-pref-done')).toContainText("You're unsubscribed from shipping updates. You'll still get receipts and other emails about your orders.");

    const log = await harnessLog(request);
    const posts = log.filter((entry) => entry.method === 'POST');
    expect(posts.map((entry) => entry.path)).toEqual(['/email-preferences/lookup', '/email-preferences/unsubscribe']);
    for (const entry of log) expect(entry.path).not.toContain('tok_valid');
    expect(posts.every((entry) => (entry.body as { token: string }).token === 'tok_valid')).toBe(true);

    // The token never lands in the page, storage, or any URL.
    expect(await page.content()).not.toContain('tok_valid');
    const storage = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage, document.cookie]));
    expect(storage).not.toContain('tok_valid');
    expect(seen.flint).toEqual([]);
    expect(seen.foreign).toEqual([]);
  });

  test('reloading after the fragment is gone shows the missing-link state', async ({ page }) => {
    await page.goto(`${page_}#flint_email_preference_token=tok_valid`);
    await expect(page.getByTestId('ac-email-preferences')).toHaveAttribute('data-state', 'token-confirm');
    await page.reload();
    await expect(page.getByTestId('ac-email-preferences')).toHaveAttribute('data-state', 'token-missing');
    await expect(page.getByTestId('ac-pref-missing')).toContainText('Open the unsubscribe link from your email again.');
    await expect(page.getByTestId('ac-pref-sign-in')).toHaveAttribute('href', '/sign-in?next=%2Femail-preferences');
  });

  test('a page with no token shows the missing-link state', async ({ page }) => {
    await page.goto(page_);
    await expect(page.getByTestId('ac-email-preferences')).toHaveAttribute('data-state', 'token-missing');
  });

  test('a link already used says the address is already unsubscribed', async ({ page }) => {
    await page.goto(`${page_}#flint_email_preference_token=tok_off`);
    await expect(page.getByTestId('ac-email-preferences')).toHaveAttribute('data-state', 'token-done');
    await expect(page.getByTestId('ac-pref-done')).toContainText('avery@example.test is already unsubscribed from checkout reminders.');
    await expect(page.getByTestId('ac-unsubscribe-button')).toBeHidden();
  });

  test('an invalid link says so and points to sign-in', async ({ page }) => {
    await page.goto(`${page_}#flint_email_preference_token=tok_unknown`);
    await expect(page.getByTestId('ac-email-preferences')).toHaveAttribute('data-state', 'token-invalid');
    await expect(page.getByTestId('ac-pref-invalid')).toContainText("This link isn't valid anymore. Sign in to manage your email preferences.");
    await expect(page.getByTestId('ac-pref-invalid').getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in?next=%2Femail-preferences');
  });

  test('a temporary failure can be retried without losing the link', async ({ page }) => {
    await page.goto(`${page_}#flint_email_preference_token=tok_flaky`);
    await expect(page.getByTestId('ac-pref-retry')).toBeVisible();
    expect(page.url()).not.toContain('#');
  });

  test('without JavaScript it says JavaScript is needed', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(`${page_}`);
    await expect(page.getByTestId('ac-pref-noscript')).toContainText('JavaScript is needed to open an unsubscribe link.');
    await expect(page.getByTestId('ac-pref-lookup')).toBeHidden();
    await context.close();
  });
});

test.describe('signed-in preferences', () => {
  test('show the saved choices as labelled toggles', async ({ page }) => {
    await page.goto(`${page_}?variant=signed_in`);
    await expect(page.getByTestId('ac-email-preferences')).toHaveAttribute('data-state', 'signed-in');
    await expect(page.getByLabel('Shipping updates')).toBeChecked();
    await expect(page.getByLabel('Checkout reminders')).not.toBeChecked();
    await expect(page.getByTestId('ac-pref-save')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Account navigation' })).toBeVisible();
  });

  test('a link opened while signed in uses the token flow instead', async ({ page }) => {
    await page.goto(`${page_}?variant=signed_in#flint_email_preference_token=tok_valid`);
    await expect(page.getByTestId('ac-email-preferences')).toHaveAttribute('data-state', 'token-confirm');
    await expect(page.getByTestId('ac-pref-signed-in')).toBeHidden();
  });

  test('a customer with no email is told to add one', async ({ page }) => {
    await page.goto(`${page_}?variant=no_email`);
    await expect(page.getByTestId('ac-pref-no-email')).toHaveText('Add an email to manage email preferences.');
  });
});
