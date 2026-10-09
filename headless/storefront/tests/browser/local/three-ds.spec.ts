// LOCAL STATE TESTS for finishing a 3D Secure action when the page has no card form.
// While an authentication is pending, the service offers no collection guidance, so Stripe runs
// the action on its own. The service behind these tests is an in-memory stand-in and Stripe.js is
// a stub. A pass means public/js react correctly to those shapes. It does not prove Flint, Stripe,
// or the real app behave that way.

import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { chooseShipping, fillContact, fixtureLog, openCheckout, resetFixtures, typeCard, waitForPayment } from '../support/helpers.ts';

test.beforeEach(async ({ request }) => resetFixtures(request));

/** Records Stripe stub calls as they happen, so they survive the move to the confirmation page. */
async function watchStripe(page: Page): Promise<{ name: string; hasSecret?: boolean }[]> {
  const seen: { name: string; hasSecret?: boolean }[] = [];
  await page.exposeFunction('__logStripeCall', (call: { name: string; hasSecret?: boolean }) => seen.push({ name: call.name, hasSecret: call.hasSecret }));
  await page.addInitScript(() => {
    Object.defineProperty(window, '__stripe', {
      configurable: true,
      get: () => undefined,
      set(record) {
        const push = record.calls.push.bind(record.calls);
        record.calls.push = (...args: any[]) => {
          (window as any).__logStripeCall(args[0]);
          return push(...args);
        };
        Object.defineProperty(window, '__stripe', { value: record, writable: true, configurable: true });
      },
    });
  });
  return seen;
}

const count = (seen: { name: string }[], name: string) => seen.filter((call) => call.name === name).length;
const paths = async (request: APIRequestContext, scenario: string, path: string) => (await fixtureLog(request, `chk_${scenario}`)).log.filter((entry) => entry.path === path);

async function shipAndPick(page: Page) {
  await chooseShipping(page);
  await page.getByTestId('sf-delivery-option-0').check();
  await expect(page.getByTestId('sf-delivery')).toHaveAttribute('data-state', 'selected');
}

test('a fresh payment that needs 3D Secure runs the action once, resumes once, and finishes', async ({ page, request }) => {
  const seen = await watchStripe(page);
  await openCheckout(page, 'card');
  await waitForPayment(page, 'ready');
  await fillContact(page);
  await shipAndPick(page);
  await typeCard(page, '3ds');
  await page.getByTestId('sf-pay-button').click();
  await expect(page).toHaveURL(/complete$/);
  expect(seen.filter((call) => call.name === 'handleNextAction')).toEqual([{ name: 'handleNextAction', hasSecret: true }]);
  expect(await paths(request, 'card', 'pay')).toHaveLength(1);
  const resumes = await paths(request, 'card', 'resume');
  expect(resumes).toHaveLength(1);
  expect(resumes[0]!.body).toEqual({});
});

test('reloading into a pending authentication runs the action from the attempt read without paying again', async ({ page, request }) => {
  const seen = await watchStripe(page);
  let document = '';
  page.on('response', async (response) => {
    if (response.request().resourceType() === 'document') document += await response.text().catch(() => '');
  });
  await openCheckout(page, 'authenticating');
  await expect(page).toHaveURL(/complete$/, { timeout: 15_000 });
  expect(document).not.toContain('pi_fixture_secret');
  expect(count(seen, 'handleNextAction')).toBe(1);
  expect(seen.find((call) => call.name === 'handleNextAction')?.hasSecret).toBe(true);
  expect(await paths(request, 'authenticating', 'pay')).toHaveLength(0);
  expect((await paths(request, 'authenticating', 'attempt')).length).toBeGreaterThanOrEqual(1);
  expect(await paths(request, 'authenticating', 'resume')).toHaveLength(1);
});

test('a provider error resumes once, shows Flint\'s outcome, and brings the card form back without a second action', async ({ page, request }) => {
  const seen = await watchStripe(page);
  await openCheckout(page, 'card');
  await waitForPayment(page, 'ready');
  await fillContact(page);
  await shipAndPick(page);
  await typeCard(page, '3dsfail');
  await page.evaluate(() => ((window as any).__stripe.nextAction = 'error'));
  await page.getByTestId('sf-pay-button').click();
  await waitForPayment(page, 'declined');
  await expect(page.getByTestId('sf-payment-message')).toHaveText("Your payment wasn't completed. Try again.");
  await expect(page.getByTestId('fake-card')).toBeVisible();
  expect(count(seen, 'handleNextAction')).toBe(1);
  expect(await paths(request, 'card', 'resume')).toHaveLength(1);
  // The same action does not run again on its own.
  await page.waitForTimeout(1500);
  expect(count(seen, 'handleNextAction')).toBe(1);
});

test('when Stripe cannot load, the page says payments are unavailable and stops asking', async ({ page, request }) => {
  await page.route('https://js.stripe.com/**', (route) => route.abort('failed'));
  await page.goto(`${process.env.LOCAL_STATE_ORIGIN ?? `http://localhost:${process.env.LOCAL_STATE_PORT ?? 4190}`}/checkout/chk_authenticating`);
  await waitForPayment(page, 'unavailable');
  await expect(page.getByTestId('sf-payment-message')).toContainText('Checkout hit a problem');
  const settled = (await fixtureLog(request, 'chk_authenticating')).log.length;
  await page.waitForTimeout(3000);
  expect((await fixtureLog(request, 'chk_authenticating')).log.length).toBe(settled);
  expect(await paths(request, 'authenticating', 'pay')).toHaveLength(0);
  expect(await paths(request, 'authenticating', 'resume')).toHaveLength(0);
});

test('a trial whose card setup needs 3D Secure runs the setup action once and starts the trial', async ({ page, request }) => {
  const seen = await watchStripe(page);
  await openCheckout(page, 'subtrial');
  await waitForPayment(page, 'ready');
  await fillContact(page);
  await typeCard(page, '3ds');
  await page.getByTestId('sf-pay-button').click();
  await expect(page.getByTestId('sf-complete')).toHaveAttribute('data-state', 'subscription_trialing', { timeout: 15_000 });
  expect(seen.filter((call) => call.name === 'handleNextAction')).toEqual([{ name: 'handleNextAction', hasSecret: true }]);
  expect(await paths(request, 'subtrial', 'pay')).toHaveLength(1);
  expect(await paths(request, 'subtrial', 'resume')).toHaveLength(1);
});
