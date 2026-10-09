// LOCAL STATE TESTS for a free trial whose card setup never ran. The service behind these tests is an
// in-memory stand-in. Like real Flint, its trial order is paid from creation and has no subscription
// until the card setup succeeds. A pass means the confirmation page and public/complete.js react
// correctly to those shapes. It does not prove Flint, Stripe, or the real app behave that way.

import { expect, test } from '@playwright/test';
import { BASE, fillContact, fixtureLog, openCheckout, resetFixtures, typeCard, waitForPayment } from '../support/helpers.ts';

test.beforeEach(async ({ request }) => resetFixtures(request));

const payRequests = async (request: Parameters<typeof fixtureLog>[0], scenario: string) =>
  (await fixtureLog(request, `chk_${scenario}`)).log.filter((entry) => entry.path === 'pay');

test('opening confirmation for a trial that never started returns to checkout without paying', async ({ page, request }) => {
  await openCheckout(page, 'subtrial');
  await waitForPayment(page, 'ready');
  await page.goto(`${BASE}/checkout/chk_subtrial/complete`);
  await expect(page).toHaveURL(/\/checkout\/chk_subtrial$/);
  await waitForPayment(page, 'ready');
  await expect(page.getByTestId('sf-notice-trial_not_started')).toContainText("Your free trial hasn't started yet. Add your card and select Start free trial. You won't be charged today.");
  await expect(page.getByTestId('sf-pay-button')).toHaveText('Start free trial');
  // The button stays off until the form is complete, as on any checkout.
  await fillContact(page);
  await typeCard(page, 'ok');
  await expect(page.getByTestId('sf-pay-button')).toBeEnabled();
  expect(await payRequests(request, 'subtrial')).toHaveLength(0);
});

test('starting the trial after that sends one setup request and shows the trial', async ({ page, request }) => {
  await openCheckout(page, 'subtrial');
  await page.goto(`${BASE}/checkout/chk_subtrial/complete`);
  await expect(page).toHaveURL(/\/checkout\/chk_subtrial$/);
  await waitForPayment(page, 'ready');
  await expect(page.getByTestId('sf-notice-trial_not_started')).toBeVisible();
  await fillContact(page);
  await typeCard(page, 'ok');
  await page.getByTestId('sf-pay-button').click();
  await expect(page.getByTestId('sf-complete-status')).toHaveText('Your free trial has started');
  const pays = await payRequests(request, 'subtrial');
  expect(pays).toHaveLength(1);
  expect(pays[0]!.body.approved_collection_kind).toBe('setup');
  expect(pays[0]!.body.credential.kind).toBe('payment_method_token');
});

test('the notice shows once', async ({ page }) => {
  await openCheckout(page, 'subtrial');
  await page.goto(`${BASE}/checkout/chk_subtrial/complete`);
  await expect(page.getByTestId('sf-notice-trial_not_started')).toBeVisible();
  await page.reload();
  await waitForPayment(page, 'ready');
  await expect(page.getByTestId('sf-notice-trial_not_started')).toHaveCount(0);
});

test('a failed setup returns to checkout in the declined state with no trial notice', async ({ page, request }) => {
  await openCheckout(page, 'subtrialdeclined');
  await page.goto(`${BASE}/checkout/chk_subtrialdeclined/complete`);
  await expect(page).toHaveURL(/\/checkout\/chk_subtrialdeclined$/);
  await waitForPayment(page, 'declined');
  await expect(page.getByTestId('sf-notice-trial_not_started')).toHaveCount(0);
  expect(await payRequests(request, 'subtrialdeclined')).toHaveLength(0);
});

test('a setup still processing stays on the confirming page', async ({ page, request }) => {
  await page.goto(`${BASE}/checkout/chk_subtrialwaiting/complete`);
  await expect(page).toHaveURL(/\/checkout\/chk_subtrialwaiting\/complete$/);
  await expect(page.getByTestId('sf-complete-status')).toHaveAttribute('data-status', 'confirming');
  await expect(page.locator('[data-poll]')).toBeVisible();
  await expect(page.getByTestId('sf-notice-trial_not_started')).toHaveCount(0);
  await page.waitForTimeout(2600);
  await expect(page).toHaveURL(/\/checkout\/chk_subtrialwaiting\/complete$/);
  expect(await payRequests(request, 'subtrialwaiting')).toHaveLength(0);
});

test('the confirming poll reloads when the server sends the buyer back to checkout', async ({ page }) => {
  await openCheckout(page, 'subtrial');
  // Serve the confirming page once, as an older stuck page would show it, then let the real route redirect.
  let first = true;
  await page.route('**/checkout/chk_subtrial/complete', async (route) => {
    if (!first || route.request().resourceType() !== 'document') return route.continue();
    first = false;
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html><body><h1 id="complete-title" data-status="confirming">We're confirming your payment.</h1><div data-poll data-poll-interval="200" data-poll-max="5000"></div><script type="module" src="/js/complete.js"></script></body></html>`,
    });
  });
  await page.goto(`${BASE}/checkout/chk_subtrial/complete`);
  await expect(page).toHaveURL(/\/checkout\/chk_subtrial$/, { timeout: 10_000 });
  await expect(page.getByTestId('sf-notice-trial_not_started')).toBeVisible();
});
