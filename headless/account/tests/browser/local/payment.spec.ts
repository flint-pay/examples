// LOCAL STATE TEST for the embedded payment page (invoice and return balance).
//
// What this proves: how the page behaves for each response the server can send, using scripted
// responses and a local double of Stripe.js. What it does not prove: that Flint accepts the
// request, that Stripe confirms a card, or that a sandbox charge happens once. That is staging
// acceptance (headless/e2e).
import { expect, test, type Page } from '@playwright/test';
import { harnessLog, installStripeStub, payUrl, resetHarness, stubCalls, watch } from '../support/helpers.ts';

const COMPLETE_INVOICE = '/invoices/inv_example_001/pay/return';
const COMPLETE_RETURN = '/returns/ret_example_001/pay/return';

async function open(page: Page, surface: 'invoice' | 'return', variant = 'default') {
  await page.goto(payUrl(surface, variant));
}

async function ready(page: Page) {
  await expect(page.getByTestId('ac-payment')).toHaveAttribute('data-state', 'ready');
}

async function enterCard(page: Page) {
  await page.getByTestId('stub-card').fill('4242');
}

async function submitCalls(request: Parameters<typeof harnessLog>[0], suffix = '/pay/submit') {
  return (await harnessLog(request)).filter((entry) => entry.method === 'POST' && entry.path.endsWith(suffix));
}

/** Pays after one decline, so the page ends on a paid state whose final outstanding is zero. */
async function declineThenPay(page: Page, request: Parameters<typeof harnessLog>[0], surface: 'invoice' | 'return', complete: string) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await resetHarness(request, { scenario: 'decline_then_success' });
  await open(page, surface);
  await ready(page);
  await enterCard(page);
  await page.getByTestId('ac-pay-button').click();
  await expect(page.getByTestId('ac-payment')).toHaveAttribute('data-state', 'declined');
  await enterCard(page);
  await page.getByTestId('ac-pay-button').click();
  // The local Stripe double rejects a nonpositive Elements amount like Stripe.js, so a zero update would stop this.
  await expect(page).toHaveURL(new RegExp(`${complete}$`));
  await expect(page.getByTestId('harness-complete')).toBeVisible();
  expect(errors).toEqual([]);
}

test.describe('invoice payment', () => {
  test.beforeEach(async ({ page, request }) => {
    await installStripeStub(page);
    await resetHarness(request, { scenario: 'success' });
  });

  test('mounts Elements from the guidance and sends a single-use credential once', async ({ page, request, baseURL }) => {
    const seen = watch(page, baseURL ?? '');
    await open(page, 'invoice');
    await ready(page);

    const calls = await stubCalls(page);
    expect(calls.elements[0]).toMatchObject({ mode: 'payment', amount: 12000, currency: 'usd', paymentMethodCreation: 'manual', paymentMethodTypes: ['card'] });
    expect(calls.create[0]).toMatchObject({ type: 'payment', opts: { wallets: { applePay: 'never', googlePay: 'never' }, fields: { billingDetails: { name: 'never', email: 'never' } } } });

    const pay = page.getByTestId('ac-pay-button');
    await expect(pay).toHaveText('Pay $120.00');
    await expect(pay).toBeDisabled();
    await expect(page.getByTestId('ac-pay-blocker')).toHaveText('Finish entering your payment details to continue.');
    await expect(page.getByTestId('ac-wallets')).toBeHidden();
    await expect(page.getByTestId('ac-invoice-pay-amount')).toHaveAttribute('data-amount-minor', '12000');
    await expect(page.getByTestId('ac-invoice-pay-amount')).toHaveAttribute('data-currency', 'USD');

    await enterCard(page);
    await expect(pay).toBeEnabled();
    await expect(page.getByTestId('ac-pay-blocker')).toHaveText('');
    await pay.click();
    await expect(page).toHaveURL(new RegExp(`${COMPLETE_INVOICE}$`));
    await expect(page.getByTestId('harness-complete')).toBeVisible();

    const posts = await submitCalls(request);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ credential: { kind: 'confirmation_token', value: 'ctoken_stub_1' }, approved_outstanding_money: { amount: '12000', currency: 'USD' }, approved_collection_kind: 'processor' });
    expect(posts[0]?.actionId).toBeTruthy();
    expect(posts[0]?.csrf).toBe('csrf-example-token');
    expect(posts[0]?.origin).toBe(baseURL);

    expect(seen.flint).toEqual([]);
    expect(seen.foreign).toEqual([]);
  });

  test('passes billing details and the return URL to the confirmation token', async ({ page }) => {
    await open(page, 'invoice');
    await ready(page);
    await enterCard(page);
    // Stop before navigation so the double's records can be read.
    await page.route('**/pay/submit', (route) => route.fulfill({ contentType: 'application/json', status: 503, body: JSON.stringify({ error: { kind: 'bug' } }) }));
    await page.getByTestId('ac-pay-button').click();
    await expect(page.getByTestId('ac-payment-message')).toBeVisible();
    const calls = await stubCalls(page);
    expect(calls.tokens[0]).toEqual({
      payment_method_data: { billing_details: { name: 'Avery Example', email: 'avery@example.test' } },
      return_url: 'http://localhost:4291/payment-returns/example',
    });
  });

  test('a decline keeps the form, explains the code, clears the card, and allows a new try', async ({ page, request }) => {
    await resetHarness(request, { scenario: 'decline_then_success' });
    await open(page, 'invoice');
    await ready(page);
    await enterCard(page);
    await page.getByTestId('ac-pay-button').click();

    const payment = page.getByTestId('ac-payment');
    await expect(payment).toHaveAttribute('data-state', 'declined');
    const message = page.getByTestId('ac-payment-message');
    await expect(message).toHaveText("The security code doesn't match. Check it and try again.");
    await expect(message).toHaveAttribute('role', 'alert');
    await expect(message).toBeFocused();
    await expect(page.getByTestId('stub-card')).toHaveValue('');
    await expect(page.getByTestId('ac-pay-button')).toBeDisabled();
    await expect(page.getByTestId('ac-pay-blocker')).toHaveText('Finish entering your payment details to continue.');

    await enterCard(page);
    await page.getByTestId('ac-pay-button').click();
    await expect(page).toHaveURL(new RegExp(`${COMPLETE_INVOICE}$`));
    const posts = await submitCalls(request);
    expect(posts).toHaveLength(2);
    expect(posts[0]?.actionId).not.toBe(posts[1]?.actionId);
  });

  test('a paid invoice with nothing outstanding completes without sending Elements a zero amount', async ({ page, request }) => {
    await declineThenPay(page, request, 'invoice', COMPLETE_INVOICE);
    expect(await submitCalls(request)).toHaveLength(2);
  });

  test('3-D Secure: runs the action the server named, then resumes whatever Stripe returns', async ({ page, request }) => {
    await resetHarness(request, { scenario: 'requires_action' });
    await open(page, 'invoice');
    await ready(page);
    await enterCard(page);
    await page.getByTestId('ac-pay-button').click();
    await expect(page).toHaveURL(new RegExp(`${COMPLETE_INVOICE}$`));
    const log = await harnessLog(request);
    const kinds = log.filter((entry) => entry.method === 'POST').map((entry) => entry.path.split('/').pop());
    expect(kinds).toEqual(['submit', 'resume']);
  });

  test('3-D Secure: a Stripe error still ends in a resume so the server decides', async ({ page, request }) => {
    await installStripeStub(page, { nextActionResult: { error: { message: 'Authentication failed.' } } });
    await resetHarness(request, { scenario: 'requires_action' });
    await open(page, 'invoice');
    await ready(page);
    await enterCard(page);
    await page.getByTestId('ac-pay-button').click();
    await expect(page).toHaveURL(new RegExp(`${COMPLETE_INVOICE}$`));
    const log = await harnessLog(request);
    expect(log.filter((entry) => entry.path.endsWith('/resume'))).toHaveLength(1);
  });

  test('reloading in the middle of an action restores it from the server', async ({ page, request }) => {
    await resetHarness(request, { scenario: 'reload_authenticate' });
    await open(page, 'invoice', 'authenticate');
    await expect(page).toHaveURL(new RegExp(`${COMPLETE_INVOICE}$`));
    const log = (await harnessLog(request)).filter((entry) => entry.path.includes('/pay/') && !entry.path.endsWith('/return'));
    expect(log.map((entry) => `${entry.method} ${entry.path.split('/').pop()}`)).toEqual(['GET attempt', 'POST resume']);
    expect(log.some((entry) => entry.path.endsWith('/submit'))).toBe(false);
  });

  test('the same action is never run twice for one pending action ID', async ({ page, request }) => {
    await resetHarness(request, { scenario: 'reload_authenticate' });
    await open(page, 'invoice', 'authenticate');
    await expect(page).toHaveURL(new RegExp(`${COMPLETE_INVOICE}$`));
    const log = await harnessLog(request);
    expect(log.filter((entry) => entry.path.endsWith('/resume'))).toHaveLength(1);
  });

  test('a changed total needs a fresh click and the new amount', async ({ page, request }) => {
    await resetHarness(request, { scenario: 'total_changed' });
    await open(page, 'invoice');
    await ready(page);
    await enterCard(page);
    await page.getByTestId('ac-pay-button').click();

    await expect(page.getByTestId('ac-payment')).toHaveAttribute('data-state', 'total_changed');
    await expect(page.getByTestId('ac-payment-banner')).toHaveText('Your total changed to $130.00. Check it, then pay.');
    await expect(page.getByTestId('ac-invoice-pay-amount')).toHaveText('$130.00');
    await expect(page.getByTestId('ac-invoice-pay-amount')).toHaveAttribute('data-amount-minor', '13000');
    await expect(page.getByTestId('ac-pay-button')).toHaveText('Pay $130.00');
    const calls = await stubCalls(page);
    expect(calls.elementsUpdate.at(-1)).toMatchObject({ amount: 13000 });
    expect(calls.elementsUpdate.every((update) => Number(update.amount) > 0)).toBe(true);
    // No automatic second charge.
    await page.waitForTimeout(400);
    expect(await submitCalls(request)).toHaveLength(1);

    await page.getByTestId('ac-pay-button').click();
    await expect(page).toHaveURL(new RegExp(`${COMPLETE_INVOICE}$`));
    const posts = await submitCalls(request);
    expect(posts).toHaveLength(2);
    expect((posts[1]?.body as { approved_outstanding_money: unknown }).approved_outstanding_money).toEqual({ amount: '13000', currency: 'USD' });
  });

  test('a lost response retries the same request and never starts a second payment', async ({ page, request }) => {
    await resetHarness(request, { scenario: 'lost_response' });
    await open(page, 'invoice');
    await ready(page);
    await enterCard(page);
    await page.getByTestId('ac-pay-button').click();
    await expect(page).toHaveURL(new RegExp(`${COMPLETE_INVOICE}$`), { timeout: 15_000 });
    const posts = await submitCalls(request);
    expect(posts).toHaveLength(2);
    expect(posts[0]?.actionId).toBe(posts[1]?.actionId);
    expect(posts[0]?.body).toEqual(posts[1]?.body);
  });

  test('waiting never offers a new payment, then follows the attempt to the end', async ({ page, request }) => {
    await resetHarness(request, { scenario: 'wait_then_done' });
    await open(page, 'invoice');
    await ready(page);
    await enterCard(page);
    await page.getByTestId('ac-pay-button').click();
    await expect(page.getByTestId('ac-payment')).toHaveAttribute('data-state', 'waiting');
    await expect(page.getByTestId('ac-pay-button')).toBeHidden();
    await expect(page.getByTestId('ac-payment').getByText("We're confirming your payment. Don't close this page.")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${COMPLETE_INVOICE}$`), { timeout: 15_000 });
    expect(await submitCalls(request)).toHaveLength(1);
  });

  test('after a long wait it says so, offers Check again, and still offers no new payment', async ({ page, request }) => {
    await resetHarness(request, { scenario: 'stuck_waiting' });
    await open(page, 'invoice');
    await ready(page);
    await page.evaluate(() => {
      const root = document.querySelector('[data-payment-root]');
      if (root instanceof HTMLElement) root.dataset.stillAfterMs = '1500';
    });
    await enterCard(page);
    await page.getByTestId('ac-pay-button').click();
    const banner = page.getByTestId('ac-payment-banner');
    await expect(banner).toContainText("You won't be charged twice", { timeout: 15_000 });
    await expect(page.getByTestId('ac-check-again')).toBeVisible();
    await expect(page.getByTestId('ac-pay-button')).toBeHidden();
    expect(await submitCalls(request)).toHaveLength(1);
  });

  test('a bank payment goes to the processing page with no retry or cancel offered', async ({ page, request }) => {
    await resetHarness(request, { scenario: 'bank' });
    await open(page, 'invoice');
    await ready(page);
    await enterCard(page);
    await page.getByTestId('ac-pay-button').click();
    await expect(page).toHaveURL(new RegExp(`${COMPLETE_INVOICE}$`));
    expect((await harnessLog(request)).filter((entry) => entry.path.endsWith('/cancel-attempt'))).toHaveLength(0);
  });

  test('double click creates one request', async ({ page, request }) => {
    await resetHarness(request, { scenario: 'slow_submit' });
    await open(page, 'invoice');
    await ready(page);
    await enterCard(page);
    await page.getByTestId('ac-pay-button').dblclick();
    await expect(page).toHaveURL(new RegExp(`${COMPLETE_INVOICE}$`));
    expect(await submitCalls(request)).toHaveLength(1);
  });

  test('Enter on the focused Pay button creates one request, and the button keeps its label while busy', async ({ page, request }) => {
    await resetHarness(request, { scenario: 'slow_submit' });
    await open(page, 'invoice');
    await ready(page);
    await enterCard(page);
    const pay = page.getByTestId('ac-pay-button');
    await pay.focus();
    await page.keyboard.press('Enter');
    await expect(pay).toHaveAttribute('aria-busy', 'true');
    await expect(pay).toHaveText('Pay $120.00');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${COMPLETE_INVOICE}$`));
    expect(await submitCalls(request)).toHaveLength(1);
  });

  test('saved cards are chosen by radio and sent as a Flint payment method ID', async ({ page, request }) => {
    await open(page, 'invoice', 'saved');
    await ready(page);
    await expect(page.getByRole('group', { name: 'Saved cards' })).toBeVisible();
    await expect(page.getByLabel('Visa ending 4242, expires 12/30')).toBeVisible();
    await page.getByTestId('ac-saved-method-2').check();
    await expect(page.getByTestId('ac-payment-element')).toBeHidden();
    await expect(page.getByTestId('ac-pay-button')).toBeEnabled();
    await page.getByTestId('ac-pay-button').click();
    await expect(page).toHaveURL(new RegExp(`${COMPLETE_INVOICE}$`));
    const posts = await submitCalls(request);
    expect((posts[0]?.body as { credential: unknown }).credential).toEqual({ kind: 'saved_payment_method', value: 'pm_example_002' });
  });

  test('switching back to a new payment method shows the form again', async ({ page }) => {
    await open(page, 'invoice', 'saved');
    await ready(page);
    await page.getByTestId('ac-saved-method-1').check();
    await expect(page.getByTestId('ac-payment-element')).toBeHidden();
    await page.getByTestId('ac-use-new-method').check();
    await expect(page.getByTestId('ac-payment-element')).toBeVisible();
    await expect(page.getByTestId('ac-pay-button')).toBeDisabled();
  });

  test('Affirm is removed for the page view after Affirm declines, and card still works', async ({ page, request }) => {
    await resetHarness(request, { scenario: 'decline_affirm' });
    await open(page, 'invoice', 'with_affirm');
    await ready(page);
    expect((await stubCalls(page)).elements[0]).toMatchObject({ paymentMethodTypes: ['card', 'affirm'] });
    await enterCard(page);
    await page.getByTestId('ac-pay-button').click();
    await expect(page.getByTestId('ac-payment')).toHaveAttribute('data-state', 'declined');
    await expect(page.getByTestId('ac-payment-message')).toHaveText("Affirm didn't approve this purchase. Pay another way.");
    await expect.poll(async () => (await stubCalls(page)).elements.at(-1)).toMatchObject({ paymentMethodTypes: ['card'] });
    await enterCard(page);
    await page.getByTestId('ac-pay-button').click();
    await expect(page).toHaveURL(new RegExp(`${COMPLETE_INVOICE}$`));
  });

  test('an unfinished Affirm application offers to continue or pay another way', async ({ page, request }) => {
    await resetHarness(request, { scenario: 'affirm' });
    await open(page, 'invoice', 'affirm_incomplete');
    const payment = page.getByTestId('ac-payment');
    await expect(payment).toHaveAttribute('data-state', 'affirm_incomplete');
    await expect(page.getByTestId('ac-payment-banner')).toHaveText("Your Affirm application isn't finished. Continue with Affirm or choose another way to pay.");
    await expect(page.getByTestId('ac-affirm-continue')).toBeVisible();
    await expect(page.getByTestId('ac-pay-another-way')).toBeVisible();
    await expect(page.getByTestId('ac-pay-button')).toBeHidden();

    await page.getByTestId('ac-affirm-continue').click();
    await expect(page).toHaveURL(new RegExp(`${COMPLETE_INVOICE}$`));
    const log = await harnessLog(request);
    expect(log.filter((entry) => entry.path.endsWith('/submit'))).toHaveLength(0);
  });

  test('Pay another way cancels the open attempt and returns to the form', async ({ page, request }) => {
    await resetHarness(request, { scenario: 'affirm' });
    await open(page, 'invoice', 'affirm_incomplete');
    await expect(page.getByTestId('ac-payment')).toHaveAttribute('data-state', 'affirm_incomplete');
    await page.getByTestId('ac-pay-another-way').click();
    await expect(page.getByTestId('ac-payment')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByTestId('ac-pay-button')).toBeVisible();
    expect((await harnessLog(request)).filter((entry) => entry.path.endsWith('/cancel-attempt'))).toHaveLength(1);
  });

  test('recovery resumes the attempt without showing a form', async ({ page, request }) => {
    await resetHarness(request, { scenario: 'recovery' });
    await open(page, 'invoice', 'recovery');
    await expect(page).toHaveURL(new RegExp(`${COMPLETE_INVOICE}$`));
    const log = await harnessLog(request);
    expect(log.some((entry) => entry.path.endsWith('/submit'))).toBe(false);
    expect(log.some((entry) => entry.path.endsWith('/resume'))).toBe(true);
  });

  test('shows part-paid state with the amounts and pays only the remainder', async ({ page, request }) => {
    await open(page, 'invoice', 'pay_remaining');
    await expect(page.getByTestId('ac-payment')).toHaveAttribute('data-state', 'pay_remaining');
    const box = page.getByTestId('ac-pay-remaining');
    await expect(box).toContainText('$50.00 was paid.');
    await expect(box).toContainText('$70.00 was not paid.');
    await expect(box).toContainText('Pay the remaining $70.00 to finish. Your first payment is kept.');
    await expect(page.getByTestId('ac-pay-button')).toHaveText('Pay $70.00');
    await enterCard(page);
    await page.getByTestId('ac-pay-button').click();
    await expect(page).toHaveURL(new RegExp(`${COMPLETE_INVOICE}$`));
    const posts = await submitCalls(request);
    expect((posts[0]?.body as { approved_outstanding_money: unknown }).approved_outstanding_money).toEqual({ amount: '7000', currency: 'USD' });
  });

  test('an expired page offers to start again and no payment form', async ({ page }) => {
    await open(page, 'invoice', 'expired');
    await expect(page.getByTestId('ac-payment')).toHaveAttribute('data-state', 'expired');
    await expect(page.getByTestId('ac-start-again')).toHaveAttribute('href', '/invoices/inv_example_001/pay');
    await expect(page.getByTestId('ac-pay-button')).toBeHidden();
    expect(await page.evaluate(() => typeof (window as unknown as { Stripe?: unknown }).Stripe)).toBe('undefined');
  });

  test('unavailable payments say so, point to the store, and load no provider script', async ({ page }) => {
    await open(page, 'invoice', 'unavailable');
    const payment = page.getByTestId('ac-payment');
    await expect(payment).toHaveAttribute('data-state', 'unavailable');
    await expect(payment.getByText("Payments aren't available right now. Contact Cedar & Stone for help.")).toBeVisible();
    await expect(payment.getByRole('link', { name: 'Email help@example.test' })).toBeVisible();
    await expect(page.getByTestId('ac-pay-button')).toBeHidden();
    expect(await page.evaluate(() => typeof (window as unknown as { Stripe?: unknown }).Stripe)).toBe('undefined');
  });

  test('a payment already in progress elsewhere is explained with a way to check again', async ({ page }) => {
    for (const variant of ['surface_conflict', 'collection_in_progress']) {
      await open(page, 'invoice', variant);
      const payment = page.getByTestId('ac-payment');
      await expect(payment).toHaveAttribute('data-state', variant);
      await expect(payment).toContainText('A payment for this invoice is already in progress. Check again in a few minutes.');
      await expect(page.getByTestId('ac-check-again')).toHaveAttribute('href', '/invoices/inv_example_001/pay');
    }
  });

  test('wallets appear only when the browser offers them, and use the same credential path', async ({ page, request }) => {
    await installStripeStub(page, { wallets: true });
    await open(page, 'invoice', 'wallets');
    await ready(page);
    await expect(page.getByTestId('ac-wallets')).toBeVisible();
    await page.getByTestId('stub-wallet').click();
    await expect(page).toHaveURL(new RegExp(`${COMPLETE_INVOICE}$`));
    const posts = await submitCalls(request);
    expect(posts).toHaveLength(1);
    expect((posts[0]?.body as { credential: { kind: string } }).credential.kind).toBe('confirmation_token');
  });

  test('wallet region stays hidden when no wallet is available and the card form works', async ({ page }) => {
    await open(page, 'invoice', 'wallets');
    await ready(page);
    await expect(page.getByTestId('ac-wallets')).toBeHidden();
    await enterCard(page);
    await expect(page.getByTestId('ac-pay-button')).toBeEnabled();
  });

  test('a Stripe form error is shown and keeps the form usable', async ({ page }) => {
    await installStripeStub(page, { tokenError: 'Your card number is incomplete.' });
    await open(page, 'invoice');
    await ready(page);
    await enterCard(page);
    await page.getByTestId('ac-pay-button').click();
    await expect(page.getByTestId('ac-payment-message')).toHaveText('Your card number is incomplete.');
    await expect(page.getByTestId('ac-payment')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByTestId('ac-pay-button')).toBeEnabled();
  });

  test('provider secrets only travel in the job response and never reach the page, URL, or storage', async ({ page, request }) => {
    await resetHarness(request, { scenario: 'requires_action' });
    await open(page, 'invoice');
    await ready(page);
    const html = await page.content();
    expect(html).not.toContain('pi_example_client_value');
    await enterCard(page);
    await page.getByTestId('ac-pay-button').click();
    await expect(page).toHaveURL(new RegExp(`${COMPLETE_INVOICE}$`));
    expect(page.url()).not.toContain('pi_example');
    const storage = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage, document.cookie]));
    expect(storage).not.toContain('pi_example');
  });

  test('the secret reaches Stripe.js exactly once', async ({ page, request }) => {
    // Hold the page on the return route so the Stripe double's records can still be read.
    await page.route('**/pay/return', (route) => route.fulfill({ contentType: 'text/html', body: '<main>stop</main>' }));
    await resetHarness(request, { scenario: 'requires_action' });
    await open(page, 'invoice');
    await ready(page);
    await enterCard(page);
    await page.getByTestId('ac-pay-button').click();
    await expect.poll(async () => (await harnessLog(request)).some((entry) => entry.path.endsWith('/resume'))).toBe(true);
    await expect(page).toHaveURL(new RegExp(`${COMPLETE_INVOICE}$`));
  });
});

test.describe('return balance payment', () => {
  test.beforeEach(async ({ page, request }) => {
    await installStripeStub(page);
    await resetHarness(request, { scenario: 'success' });
  });

  test('shows the exchange balance and pays through the same engine', async ({ page, request }) => {
    await open(page, 'return');
    await ready(page);
    await expect(page.getByTestId('ac-return-pay-amount')).toHaveAttribute('data-amount-minor', '12000');
    await expect(page.getByRole('heading', { name: 'Balance for your exchange' })).toBeVisible();
    await expect(page.getByTestId('ac-pay-button')).toHaveText('Pay $120.00');
    await enterCard(page);
    await page.getByTestId('ac-pay-button').click();
    await expect(page).toHaveURL(new RegExp(`${COMPLETE_RETURN}$`));
    expect(await submitCalls(request, '/returns/ret_example_001/pay/submit')).toHaveLength(1);
  });

  test('a decline behaves the same way', async ({ page, request }) => {
    await resetHarness(request, { scenario: 'decline_then_success' });
    await open(page, 'return');
    await ready(page);
    await enterCard(page);
    await page.getByTestId('ac-pay-button').click();
    await expect(page.getByTestId('ac-payment')).toHaveAttribute('data-state', 'declined');
  });

  test('a paid return balance with nothing outstanding completes without sending Elements a zero amount', async ({ page, request }) => {
    await declineThenPay(page, request, 'return', COMPLETE_RETURN);
    expect(await submitCalls(request, '/returns/ret_example_001/pay/submit')).toHaveLength(2);
  });

  test('surface conflict names the return', async ({ page }) => {
    await open(page, 'return', 'surface_conflict');
    await expect(page.getByTestId('ac-payment')).toContainText('A payment for this return is already in progress. Check again in a few minutes.');
  });
});
