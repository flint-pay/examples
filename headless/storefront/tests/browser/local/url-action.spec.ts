// LOCAL STATE TESTS for a pending Flint-hosted page (a `url` action) and for the unfinished-return,
// expired, and unknown-type paths. The service behind these tests is an in-memory stand-in, the
// hosted page is a route that sends the buyer straight back, and Stripe.js is a stub. A pass means
// public/js react correctly to those shapes. It does not prove Flint or the real hosted page behave that way.

import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { chooseShipping, fillContact, fixtureLog, openCheckout, resetFixtures, typeCard, waitForPayment } from '../support/helpers.ts';

test.beforeEach(async ({ request }) => resetFixtures(request));

/** Counts requests to the fake hosted page and records Stripe calls, so both survive navigation. */
async function watch(page: Page) {
  const hosted: string[] = [];
  const consoleErrors: string[] = [];
  const stripeCalls: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/flint-hosted/')) hosted.push(request.url());
  });
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await page.exposeFunction('__logStripeCall', (name: string) => stripeCalls.push(name));
  await page.addInitScript(() => {
    Object.defineProperty(window, '__stripe', {
      configurable: true,
      get: () => undefined,
      set(record) {
        const push = record.calls.push.bind(record.calls);
        record.calls.push = (...args: any[]) => {
          (window as any).__logStripeCall(args[0]?.name);
          return push(...args);
        };
        Object.defineProperty(window, '__stripe', { value: record, writable: true, configurable: true });
      },
    });
  });
  return { hosted, consoleErrors, stripeCalls };
}

const paths = async (request: APIRequestContext, scenario: string, path: string) => (await fixtureLog(request, `chk_${scenario}`)).log.filter((entry) => entry.path === path);

async function shipAndPick(page: Page) {
  await chooseShipping(page);
  await page.getByTestId('sf-delivery-option-0').check();
  await expect(page.getByTestId('sf-delivery')).toHaveAttribute('data-state', 'selected');
}

async function payWith(page: Page, scenario: string, behavior: string) {
  await openCheckout(page, scenario);
  await waitForPayment(page, 'ready');
  await fillContact(page);
  await shipAndPick(page);
  await typeCard(page, behavior);
  await page.getByTestId('sf-pay-button').click();
}

test('a url action is a top-level redirect: no Stripe call, no resume, and the unfinished return waits for the buyer', async ({ page, request }) => {
  const seen = await watch(page);
  await payWith(page, 'card', 'url');
  // The fake hosted page sends the buyer back unfinished through the return route.
  await waitForPayment(page, 'affirm_incomplete');
  expect(seen.hosted).toHaveLength(1);
  expect(seen.stripeCalls.filter((name) => name === 'handleNextAction')).toHaveLength(0);
  expect(await paths(request, 'card', 'pay')).toHaveLength(1);
  expect(await paths(request, 'card', 'resume')).toHaveLength(0);
  // A card payment, so the wording is generic and does not name Affirm.
  await expect(page.getByTestId('sf-affirm-continue')).toHaveText('Continue');
  await expect(page.getByTestId('sf-payment-message')).toHaveText("Your payment isn't finished. Continue to finish it, or choose another way to pay.");
  await expect(page.getByTestId('sf-pay-another-way')).toBeVisible();
  // The page did not open the hosted page again on its own.
  await page.waitForTimeout(500);
  expect(seen.hosted).toHaveLength(1);
});

test('coming back to an unfinished hosted step offers Continue and Pay another way, and Continue opens the hosted page', async ({ page, request }) => {
  const seen = await watch(page);
  await openCheckout(page, 'urlreturn');
  await waitForPayment(page, 'affirm_incomplete');
  await expect(page.getByTestId('sf-affirm-continue')).toHaveText('Continue');
  expect(seen.hosted).toHaveLength(0);
  expect(await paths(request, 'urlreturn', 'resume')).toHaveLength(0);
  expect(await paths(request, 'urlreturn', 'pay')).toHaveLength(0);

  const hosted = page.waitForRequest((request) => new URL(request.url()).pathname.startsWith('/flint-hosted/'));
  await page.getByTestId('sf-affirm-continue').click();
  await hosted;
  expect(seen.stripeCalls.filter((name) => name === 'handleNextAction')).toHaveLength(0);
  expect(await paths(request, 'urlreturn', 'resume')).toHaveLength(0);
});

test('Pay another way after an unfinished hosted step names the payment, not Affirm, and returns to the card form', async ({ page }) => {
  await openCheckout(page, 'urlreturn');
  await waitForPayment(page, 'affirm_incomplete');
  await page.getByTestId('sf-pay-another-way').click();
  await expect(page.getByTestId('sf-affirm-dialog')).toContainText('This stops your payment.');
  await expect(page.getByTestId('sf-affirm-dialog')).not.toContainText('Affirm');
  await page.getByTestId('sf-affirm-dialog-confirm').click();
  await waitForPayment(page, 'ready');
});

test('an Affirm return keeps the Affirm wording', async ({ page }) => {
  await openCheckout(page, 'urlreturnaffirm');
  await waitForPayment(page, 'affirm_incomplete');
  await expect(page.getByTestId('sf-affirm-continue')).toHaveText('Continue with Affirm');
});

test('an action past its expiry is not opened: the attempt is cancelled and the buyer can try again', async ({ page, request }) => {
  const seen = await watch(page);
  await openCheckout(page, 'urlreturnexpired');
  await waitForPayment(page, 'declined');
  await expect(page.getByTestId('sf-payment-message')).toHaveText("Your payment wasn't completed. Try again.");
  expect(seen.hosted).toHaveLength(0);
  expect(seen.stripeCalls.filter((name) => name === 'handleNextAction')).toHaveLength(0);
  expect(await paths(request, 'urlreturnexpired', 'cancel-attempt')).toHaveLength(1);
  expect(await paths(request, 'urlreturnexpired', 'resume')).toHaveLength(0);
});

test('an expired action from a fresh payment is not opened either', async ({ page, request }) => {
  const seen = await watch(page);
  await payWith(page, 'card', 'urlexpired');
  await waitForPayment(page, 'declined');
  await expect(page.getByTestId('sf-payment-message')).toHaveText("Your payment wasn't completed. Try again.");
  expect(seen.hosted).toHaveLength(0);
  expect(await paths(request, 'card', 'cancel-attempt')).toHaveLength(1);
});

test('an unknown action type shows a generic error and does not crash, navigate, or resume', async ({ page, request }) => {
  const seen = await watch(page);
  await payWith(page, 'card', 'urlunknown');
  await waitForPayment(page, 'unavailable');
  await expect(page.getByTestId('sf-payment-message')).toContainText("Checkout hit a problem we can't fix here.");
  expect(seen.hosted).toHaveLength(0);
  expect(seen.stripeCalls.filter((name) => name === 'handleNextAction')).toHaveLength(0);
  expect(await paths(request, 'card', 'resume')).toHaveLength(0);
  expect(seen.consoleErrors).toEqual([]);
});

test('a client secret never reaches the page markup, for a stripe action or a url action', async ({ page }) => {
  await payWith(page, 'card', '3ds');
  await expect(page).toHaveURL(/complete$/);
  await page.goBack();
  expect(await page.content()).not.toContain('pi_fixture_secret');
  await resetFixtures(page.request);
  await openCheckout(page, 'urlreturn');
  await waitForPayment(page, 'affirm_incomplete');
  const html = await page.content();
  expect(html).not.toContain('pi_fixture_secret');
  expect(html).not.toMatch(/client_secret|client_action/);
});

test('an expired action whose cancel keeps failing stops after three tries and leaves the buyer a way forward', async ({ page, request }) => {
  const seen = await watch(page);
  await openCheckout(page, 'urlcancelfail');
  await waitForPayment(page, 'affirm_incomplete');
  await expect.poll(async () => (await paths(request, 'urlcancelfail', 'cancel-attempt')).length).toBe(3);
  // The expiry message stays, with the generic error beside it, and nothing loops.
  await expect(page.getByTestId('sf-payment-message')).toContainText("Your payment wasn't completed. Try again.");
  await expect(page.getByTestId('sf-payment-message')).toContainText('Something went wrong');
  await expect(page.getByTestId('sf-pay-another-way')).toBeVisible();
  await page.waitForTimeout(3000);
  expect(await paths(request, 'urlcancelfail', 'cancel-attempt')).toHaveLength(3);
  expect(seen.hosted).toHaveLength(0);
  expect(await paths(request, 'urlcancelfail', 'resume')).toHaveLength(0);
  // Continue is the buyer's own retry: one more bounded round.
  await page.getByTestId('sf-affirm-continue').click();
  await expect.poll(async () => (await paths(request, 'urlcancelfail', 'cancel-attempt')).length).toBe(6);
  await expect(page.getByTestId('sf-payment')).toHaveAttribute('data-state', 'affirm_incomplete');
});

test('a page restored after the redirect stops saying it is leaving and offers Continue and Pay another way', async ({ page, request }) => {
  await openCheckout(page, 'urlhold');
  await waitForPayment(page, 'affirm_incomplete');
  const hosted = page.waitForRequest((request) => new URL(request.url()).pathname.startsWith('/flint-hosted/'));
  await page.getByTestId('sf-affirm-continue').click();
  await hosted;
  // The hosted page does not take over here, so this page is still on screen, as when it is restored.
  await waitForPayment(page, 'authenticating');
  await expect(page.getByTestId('sf-payment')).toContainText('Taking you to finish your payment');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await waitForPayment(page, 'affirm_incomplete');
  await expect(page.getByTestId('sf-affirm-continue')).toBeVisible();
  await expect(page.getByTestId('sf-pay-another-way')).toBeVisible();
  expect(await paths(request, 'urlhold', 'resume')).toHaveLength(0);
});
