// LOCAL STATE TEST for adding a card. Stripe.js is a local double and the server routes are
// scripted. A card is only treated as usable after the server reports it active.
import { expect, test } from '@playwright/test';
import { harnessLog, installStripeStub, resetHarness, stubCalls, watch } from '../support/helpers.ts';

test.describe('add a card', () => {
  test.beforeEach(async ({ page, request }) => {
    await installStripeStub(page);
    await resetHarness(request, { card: 'activates' });
  });

  test('sets up, confirms in the browser, waits for active, then leaves through the return route', async ({ page, request, baseURL }) => {
    const seen = watch(page, baseURL ?? '');
    await page.goto('/__render/ac-payment-method-new?variant=subscription');
    const setup = page.getByTestId('ac-card-setup');
    await expect(setup).toHaveAttribute('data-state', 'adding');

    const calls = await stubCalls(page);
    expect(calls.elements[0]).toMatchObject({ clientSecret: 'seti_example_client_value' });
    expect(calls.create[0]).toMatchObject({ type: 'payment', opts: { wallets: { applePay: 'never', googlePay: 'never' } } });

    const save = page.getByTestId('ac-card-save');
    await expect(save).toBeDisabled();
    await expect(page.locator('[data-setup-blocker]')).toHaveText('Finish entering your card details to continue.');
    await page.getByTestId('stub-card').fill('4242');
    await expect(save).toBeEnabled();
    await save.click();

    await expect(setup).toHaveAttribute('data-state', 'confirming');
    await expect(page.getByTestId('ac-card-confirming')).toContainText("We're confirming your card. It'll be ready in a moment.");
    await expect(page).toHaveURL(/\/payment-methods\/new\/return$/, { timeout: 15_000 });

    const log = await harnessLog(request);
    const kinds = log.filter((entry) => entry.method === 'POST').map((entry) => entry.path);
    expect(kinds).toEqual(['/payment-methods/new/setup', '/payment-methods/new/confirm']);
    expect(log.find((entry) => entry.path === '/payment-methods/new/setup')?.body).toEqual({ return_to: '/subscriptions/sub_example_001' });
    expect(log.find((entry) => entry.path === '/payment-methods/new/confirm')?.body).toEqual({ payment_method_id: 'pm_example_001' });
    expect(log.filter((entry) => entry.path.endsWith('/status')).length).toBeGreaterThanOrEqual(2);
    expect(seen.flint).toEqual([]);
    expect(seen.foreign).toEqual([]);
  });

  test('passes the return URL on this origin and asks Stripe not to redirect unless it must', async ({ page, baseURL }) => {
    await page.goto('/__render/ac-payment-method-new');
    await expect(page.getByTestId('ac-card-setup')).toHaveAttribute('data-state', 'adding');
    await page.getByTestId('stub-card').fill('4242');
    await page.getByTestId('ac-card-save').click();
    await expect(page.getByTestId('ac-card-setup')).toHaveAttribute('data-state', 'confirming');
    // The double records the call before the card is confirmed active and the page leaves.
    const calls = await stubCalls(page);
    expect(calls.confirmSetup).toEqual([{ returnUrl: `${baseURL}/payment-methods/new/return`, redirect: 'if_required' }]);
  });

  test('a Stripe error is shown, keeps the form, and clears when the buyer edits', async ({ page, request }) => {
    await installStripeStub(page, { confirmSetupResult: { error: { message: 'Your card was declined.' } } });
    await page.goto('/__render/ac-payment-method-new');
    const setup = page.getByTestId('ac-card-setup');
    await expect(setup).toHaveAttribute('data-state', 'adding');
    await page.getByTestId('stub-card').fill('4242');
    await page.getByTestId('ac-card-save').click();
    await expect(setup).toHaveAttribute('data-state', 'setup_failed');
    const message = page.getByTestId('ac-card-setup-message');
    await expect(message).toHaveText('Your card was declined.');
    await expect(message).toHaveAttribute('role', 'alert');
    await expect(message).toBeFocused();
    await expect(page.getByTestId('ac-card-save')).toBeEnabled();
    expect((await harnessLog(request)).some((entry) => entry.path.endsWith('/confirm'))).toBe(false);
    await page.getByTestId('stub-card').fill('4243');
    await expect(setup).toHaveAttribute('data-state', 'adding');
  });

  test('a card the server marks failed is not usable and offers another try', async ({ page, request }) => {
    await resetHarness(request, { card: 'fails' });
    await page.goto('/__render/ac-payment-method-new');
    await expect(page.getByTestId('ac-card-setup')).toHaveAttribute('data-state', 'adding');
    await page.getByTestId('stub-card').fill('4242');
    await page.getByTestId('ac-card-save').click();
    await expect(page.getByTestId('ac-card-setup')).toHaveAttribute('data-state', 'setup_failed', { timeout: 10_000 });
    await expect(page.getByTestId('ac-card-setup-message')).toContainText('Your bank did not accept this card.');
    await expect(page.getByTestId('ac-card-try-another')).toBeVisible();
    await expect(page).not.toHaveURL(/return$/);
  });

  test('a slow confirmation says so and can be checked again', async ({ page, request }) => {
    await resetHarness(request, { card: 'never' });
    await page.goto('/__render/ac-payment-method-new');
    await expect(page.getByTestId('ac-card-setup')).toHaveAttribute('data-state', 'adding');
    await page.evaluate(() => {
      const root = document.querySelector('[data-card-setup]');
      if (root instanceof HTMLElement) root.dataset.confirmTimeoutMs = '1800';
    });
    await page.getByTestId('stub-card').fill('4242');
    await page.getByTestId('ac-card-save').click();
    await expect(page.getByTestId('ac-card-confirming')).toContainText('taking longer than usual', { timeout: 10_000 });
    await expect(page.getByTestId('ac-card-check-again')).toBeVisible();
    await expect(page).not.toHaveURL(/return$/);
  });

  test('when setup cannot start the form is hidden and the reason is shown', async ({ page }) => {
    await page.route('**/payment-methods/new/setup', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { kind: 'unavailable', code: 'CARD_SETUP_UNAVAILABLE', message_key: 'card_setup_unavailable' } }) }));
    await page.goto('/__render/ac-payment-method-new');
    await expect(page.getByTestId('ac-card-setup')).toHaveAttribute('data-state', 'setup_failed');
    await expect(page.getByTestId('ac-card-setup-message')).toContainText('Try again');
    await expect(page.getByTestId('ac-card-save')).toBeHidden();
  });

  test('when Stripe.js cannot load, it says so', async ({ page }) => {
    await page.unroute('https://js.stripe.com/**');
    await page.route('https://js.stripe.com/**', (route) => route.abort());
    await page.goto('/__render/ac-payment-method-new');
    await expect(page.getByTestId('ac-card-setup')).toHaveAttribute('data-state', 'setup_failed', { timeout: 10_000 });
    await expect(page.getByTestId('ac-card-setup-message')).toContainText("We couldn't load the payment form");
  });
});

test.describe('card return route', () => {
  test.beforeEach(async ({ page, request }) => {
    await installStripeStub(page);
    await resetHarness(request, { card: 'activates' });
  });

  test('removes Stripe parameters from the address, then waits for active', async ({ page }) => {
    await page.goto('/__render/ac-payment-method-return?variant=default&setup_intent=seti_example&redirect_status=succeeded');
    await expect.poll(() => new URL(page.url()).search).toBe('');
    await expect(page.getByTestId('ac-card-setup')).toHaveAttribute('data-state', 'confirming');
    await expect(page).toHaveURL(/\/payment-methods\/new\/return$/, { timeout: 15_000 });
  });

  test('says so when there is no card to finish', async ({ page }) => {
    await page.goto('/__render/ac-payment-method-return?variant=nothing');
    await expect(page.getByTestId('ac-card-setup')).toHaveAttribute('data-state', 'nothing');
    await expect(page.getByTestId('ac-card-return-nothing')).toContainText("We couldn't find a card being added.");
  });

  test('shows a failed card without marking it usable', async ({ page }) => {
    await page.goto('/__render/ac-payment-method-return?variant=failed');
    await expect(page.getByTestId('ac-card-setup')).toHaveAttribute('data-state', 'setup_failed');
    await expect(page.getByTestId('ac-card-setup-message')).toBeVisible();
  });
});
