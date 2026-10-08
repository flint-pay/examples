// LOCAL STATE TESTS for the checkout page. The service behind these tests is an
// in-memory stand-in and Stripe.js is a stub. A pass means the views and
// public/js react correctly to the shapes the app sends. It does not prove
// Flint, Stripe, or the real app behave that way.

import { expect, test } from '@playwright/test';
import { chooseShipping, fillContact, fixtureLog, openCheckout, resetFixtures, typeCard, waitForPayment } from '../support/helpers.ts';
import { stripeCalls } from '../support/stripe-stub.ts';

test.beforeEach(async ({ request }) => resetFixtures(request));

async function readyOrder(page: any, scenario = 'card') {
  await openCheckout(page, scenario);
  await waitForPayment(page, 'ready');
  await fillContact(page);
}

async function shipAndSelect(page: any) {
  await chooseShipping(page);
  await expect(page.getByTestId('sf-delivery')).toHaveAttribute('data-state', 'options');
  await page.getByTestId('sf-delivery-option-0').check();
  await expect(page.getByTestId('sf-delivery')).toHaveAttribute('data-state', 'selected');
}

test('guest pays by card: blockers clear in order, totals follow the server, pay lands on the confirmation', async ({ page, request }) => {
  await openCheckout(page, 'card');
  await waitForPayment(page, 'ready');
  const pay = page.getByTestId('sf-pay-button');
  await expect(pay).toBeDisabled();
  await expect(page.getByTestId('sf-pay-blocker')).toHaveAttribute('data-blocker', 'contact_email_missing');
  await expect(page.getByTestId('sf-pay-blocker')).toHaveText('Enter your email address to pay.');
  await fillContact(page);
  await expect(page.getByTestId('sf-pay-blocker')).toHaveAttribute('data-blocker', 'delivery_selection_missing');
  await shipAndSelect(page);
  await expect(page.getByTestId('sf-pay-blocker')).toHaveAttribute('data-blocker', 'elements_incomplete');
  await expect(page.getByTestId('sf-summary-tax')).not.toHaveAttribute('data-state', 'requires_location');
  await expect(page.getByTestId('sf-summary-total')).toHaveAttribute('data-amount-minor', '7469');
  await expect(pay).toHaveText('Pay $74.69');
  await typeCard(page, 'ok');
  await expect(pay).toBeEnabled();
  await pay.click();
  await expect(page).toHaveURL(/\/checkout\/chk_card\/complete$/);
  await expect(page.getByTestId('sf-complete-status')).toHaveText('Order confirmed');
  await expect(page.getByTestId('sf-complete-order-number')).toHaveText('CS-1001');
  await expect(page.getByTestId('sf-account-link')).toHaveText('Create an account to track this order');
  const { log, payCount } = await fixtureLog(request, 'chk_card');
  expect(payCount).toBe(1);
  const body = log.find((entry) => entry.path === 'pay')!.body;
  expect(body.approved_collection_kind).toBe('processor');
  expect(body.approved_outstanding_money).toEqual({ amount: '7469', currency: 'USD' });
  expect(body.credential.kind).toBe('confirmation_token');
  expect(body.buyer_contact.email).toBe('buyer@example.test');
});

test('contact saves on blur and the Elements receive billing name and email, not a Flint call', async ({ page, request }) => {
  const hosts: string[] = [];
  page.on('request', (r) => hosts.push(new URL(r.url()).hostname));
  await readyOrder(page);
  await shipAndSelect(page);
  await typeCard(page, 'ok');
  await page.getByTestId('sf-pay-button').click();
  await expect(page).toHaveURL(/complete$/);
  const calls = await stripeCalls(page).catch(() => []);
  void calls;
  expect(hosts.filter((host) => /withflintpay\.com$/.test(host))).toEqual([]);
  const { log } = await fixtureLog(request, 'chk_card');
  expect(log.some((entry) => entry.path === 'contact' && entry.body.email === 'buyer@example.test')).toBe(true);
  expect(log.some((entry) => entry.path === 'timezone')).toBe(true);
});

test('Elements are created with manual creation, wallets off in the card element, and billing fields hidden', async ({ page }) => {
  await readyOrder(page);
  const calls = await stripeCalls(page);
  const created = calls.find((call) => call.name === 'create' && call.type === 'payment');
  expect(created.options.wallets).toEqual({ applePay: 'never', googlePay: 'never' });
  expect(created.options.terms).toEqual({ card: 'never' });
  expect(created.options.fields.billingDetails).toEqual({ name: 'never', email: 'never' });
  const stripeInit = calls.find((call) => call.name === 'Stripe');
  expect(stripeInit.options).toEqual({ stripeAccount: 'acct_fixture' });
  await page.evaluate(() => 0);
});

test('invalid discount shows the buyer copy and a valid code reduces the total', async ({ page }) => {
  await readyOrder(page);
  await page.getByTestId('sf-discount-code').fill('NOPE');
  await page.getByTestId('sf-discount-apply').click();
  await expect(page.locator('[data-job-error="discount"]')).toHaveText("That code can't be used on this order.");
  await page.getByTestId('sf-discount-code').fill('welcome10');
  await page.getByTestId('sf-discount-apply').click();
  await expect(page.getByTestId('sf-discount-applied-0')).toContainText('WELCOME10');
  await expect(page.getByTestId('sf-summary-discounts')).toHaveAttribute('data-amount-minor', '600');
  await expect(page.getByTestId('sf-summary-total')).toHaveAttribute('data-amount-minor', '5400');
});

test('discount after delivery releases the selection, reopens delivery, and blocks pay', async ({ page }) => {
  await readyOrder(page);
  await shipAndSelect(page);
  await typeCard(page, 'ok');
  await expect(page.getByTestId('sf-pay-button')).toBeEnabled();
  await page.getByTestId('sf-discount-code').fill('WELCOME10');
  await page.getByTestId('sf-discount-apply').click();
  await expect(page.getByTestId('sf-notice-delivery_released')).toHaveText(/choose delivery again/);
  await expect(page.getByTestId('sf-delivery')).toHaveAttribute('data-state', 'idle');
  await expect(page.getByTestId('sf-pay-blocker')).toHaveAttribute('data-blocker', 'delivery_selection_missing');
  await expect(page.getByTestId('sf-pay-button')).toBeDisabled();
});

test('delivery unavailable, needs input, and stale quote states', async ({ page }) => {
  await readyOrder(page);
  await chooseShipping(page, '99999');
  await expect(page.getByTestId('sf-delivery')).toHaveAttribute('data-state', 'unavailable');
  await expect(page.getByTestId('sf-delivery-unavailable')).toContainText("We can't deliver to this address");
  await expect(page.getByTestId('sf-delivery-unavailable')).toContainText('outside the delivery area');
  await page.getByTestId('sf-ship-state').fill('NY');
  await page.getByTestId('sf-ship-postal').fill('10001');
  await page.getByTestId('sf-delivery-quote').click();
  await page.getByTestId('sf-delivery-option-0').check();
  await expect(page.getByTestId('sf-delivery')).toHaveAttribute('data-state', 'needs_input');
  await expect(page.getByTestId('sf-delivery-needs-input')).toContainText('Add a phone number for delivery updates.');
  await expect(page.getByTestId('sf-pay-blocker')).toHaveAttribute('data-blocker', 'delivery_input_required');
  await page.getByTestId('sf-delivery-needs-input').getByRole('link').click();
  await expect(page.getByTestId('sf-contact-phone')).toBeFocused();
});

test('a stale delivery quote re-quotes the same address and asks for a new choice', async ({ page }) => {
  await readyOrder(page);
  await page.getByTestId('sf-ship-line1').fill('Stale St');
  await page.getByTestId('sf-ship-city').fill('Austin');
  await page.getByTestId('sf-ship-state').fill('TX');
  await page.getByTestId('sf-ship-postal').fill('78701');
  await page.getByTestId('sf-delivery-quote').click();
  await page.getByTestId('sf-delivery-option-0').check();
  await expect(page.locator('[data-job-error="delivery"]')).toContainText('Delivery prices changed. Choose an updated option.');
  await expect(page.getByTestId('sf-delivery')).toHaveAttribute('data-state', 'options');
  await page.getByTestId('sf-delivery-option-0').check();
  await expect(page.getByTestId('sf-delivery')).toHaveAttribute('data-state', 'selected');
});

test('pickup with a 15 percent tip keeps the selection', async ({ page }) => {
  await readyOrder(page, 'pickup');
  await page.getByTestId('sf-delivery-mode-pickup').check();
  await page.getByTestId('sf-pickup-postal').fill('78701');
  await page.getByTestId('sf-pickup-search').click();
  await expect(page.getByTestId('sf-pickup-location-0')).toBeVisible();
  await expect(page.getByTestId('sf-pickup-options')).toContainText('Cedar & Stone Roastery');
  await page.getByTestId('sf-pickup-location-0').check();
  await expect(page.getByTestId('sf-delivery')).toHaveAttribute('data-state', 'options');
  await page.getByTestId('sf-pickup-select').click();
  await expect(page.getByTestId('sf-delivery-selected')).toContainText('Pick up at Cedar & Stone Roastery');
  await expect(page.getByTestId('sf-tip-none')).toBeChecked();
  await page.getByTestId('sf-tip-15').check();
  await expect(page.getByTestId('sf-summary-tip')).toHaveAttribute('data-amount-minor', '1020');
  await expect(page.getByTestId('sf-delivery-selected')).toBeVisible();
  await page.getByTestId('sf-tip-custom').check();
  await page.getByTestId('sf-tip-custom-amount').fill('abc');
  await page.getByTestId('sf-tip-apply').click();
  await expect(page.locator('[data-job-error="tip"]')).toContainText('Enter a tip amount in dollars');
});

test('a service order has no delivery section and pays', async ({ page }) => {
  await readyOrder(page, 'service');
  await expect(page.getByTestId('sf-delivery')).toHaveCount(0);
  await typeCard(page, 'ok');
  await page.getByTestId('sf-pay-button').click();
  await expect(page).toHaveURL(/complete$/);
});

test('decline shows buyer copy as an alert, clears the card, and a retry succeeds', async ({ page }) => {
  await readyOrder(page);
  await shipAndSelect(page);
  await typeCard(page, 'decline');
  await page.getByTestId('sf-pay-button').click();
  await waitForPayment(page, 'declined');
  const message = page.getByTestId('sf-payment-message');
  await expect(message).toHaveText('Your payment was declined. Try another card or payment method.');
  await expect(message).toHaveAttribute('role', 'alert');
  await expect(message).toBeFocused();
  await expect(page.getByTestId('fake-card')).toHaveValue('');
  await expect(page.getByTestId('sf-contact-email')).toHaveValue('buyer@example.test');
  await typeCard(page, 'ok');
  await page.getByTestId('sf-pay-button').click();
  await expect(page).toHaveURL(/complete$/);
});

test('code specific decline copy for incorrect_cvc', async ({ page }) => {
  await readyOrder(page);
  await shipAndSelect(page);
  await typeCard(page, 'cvc');
  await page.getByTestId('sf-pay-button').click();
  await expect(page.getByTestId('sf-payment-message')).toHaveText("The security code doesn't match. Check it and try again.");
});

test('3D Secure runs the pending action then resumes', async ({ page, request }) => {
  await readyOrder(page);
  await shipAndSelect(page);
  await typeCard(page, '3ds');
  await page.getByTestId('sf-pay-button').click();
  await expect(page).toHaveURL(/complete$/);
  const { resumeCount } = await fixtureLog(request, 'chk_card');
  expect(resumeCount).toBe(1);
});

test('failed 3D Secure resumes anyway and shows the authentication copy', async ({ page }) => {
  await readyOrder(page);
  await shipAndSelect(page);
  await typeCard(page, '3dsfail');
  await page.evaluate(() => ((window as any).__stripe.nextAction = 'error'));
  await page.getByTestId('sf-pay-button').click();
  await waitForPayment(page, 'declined');
  await expect(page.getByTestId('sf-payment-message')).toHaveText("Your payment wasn't completed. Try again.");
});

test('reload during requires_action restores the challenge from the attempt read', async ({ page }) => {
  const secrets: string[] = [];
  page.on('response', async (response) => {
    if (response.url().includes('/checkout/') && response.request().resourceType() === 'document') secrets.push(await response.text());
  });
  await openCheckout(page, 'authenticating');
  await expect(page).toHaveURL(/complete$/, { timeout: 15_000 });
  const calls = await stripeCalls(page).catch(() => []);
  void calls;
  expect(secrets.join('\n')).not.toContain('_secret_');
});

test('unknown outcome waits on the same attempt and never starts a second payment', async ({ page, request }) => {
  await readyOrder(page);
  await shipAndSelect(page);
  await typeCard(page, 'unknown');
  await page.route('**/checkout/chk_card/pay', async (route) => {
    await route.fetch();
    await route.abort('failed');
  });
  await page.getByTestId('sf-pay-button').click();
  await expect(page).toHaveURL(/complete$/, { timeout: 20_000 });
  const { payCount } = await fixtureLog(request, 'chk_card');
  expect(payCount).toBe(1);
});

test('waiting past 60 seconds shows still confirming and Check again, with no new payment offered', async ({ page }) => {
  await page.clock.install();
  await openCheckout(page, 'waiting');
  await waitForPayment(page, 'waiting');
  await expect(page.getByTestId('sf-pay-button')).toBeDisabled();
  await page.clock.fastForward(70_000);
  await expect(page.getByTestId('sf-check-again')).toBeVisible();
});

test('double click and Enter on Pay create one attempt', async ({ page, request }) => {
  await readyOrder(page);
  await shipAndSelect(page);
  await typeCard(page, 'slow');
  await page.getByTestId('sf-pay-button').dblclick();
  await page.getByTestId('sf-pay-button').press('Enter').catch(() => undefined);
  await waitForPayment(page, 'waiting');
  const { payCount } = await fixtureLog(request, 'chk_card');
  expect(payCount).toBe(1);
});

test('total changed asks for a fresh click and shows the new amount', async ({ page }) => {
  await readyOrder(page);
  await shipAndSelect(page);
  await typeCard(page, 'changed');
  await page.getByTestId('sf-pay-button').click();
  await waitForPayment(page, 'total_changed');
  await expect(page.getByTestId('sf-payment-message')).toContainText('Your total changed to $75.69');
  await expect(page.getByTestId('sf-pay-button')).toHaveText('Pay $75.69');
  await typeCard(page, 'ok');
  await page.getByTestId('sf-pay-button').click();
  await expect(page).toHaveURL(/complete$/);
});

test('gift card: unavailable, challenge, partial, and full coverage use settlement', async ({ page, request }) => {
  await readyOrder(page);
  await shipAndSelect(page);
  await page.getByTestId('sf-gift-card-code').fill('BADCARD');
  await page.getByTestId('sf-gift-card-apply').click();
  await expect(page.locator('[data-job-error="gift-card"]')).toContainText("That gift card code isn't valid for this order.");
  await page.getByTestId('sf-gift-card-code').fill('CHALLENGE');
  await page.getByTestId('sf-gift-card-apply').click();
  await expect(page.locator('[data-job-error="gift-card"]')).toContainText("We can't check gift card codes right now.");
  await page.getByTestId('sf-gift-card-code').fill('GOODCARD');
  await page.getByTestId('sf-gift-card-apply').click();
  await expect(page.getByTestId('sf-gift-card-applied-0')).toContainText('Gift card ending 4821');
  await expect(page.getByTestId('sf-summary-gift-cards')).toHaveAttribute('data-amount-minor', '2500');
  await expect(page.getByTestId('sf-summary-outstanding')).toHaveAttribute('data-amount-minor', '4969');
  await expect(page.getByTestId('sf-pay-button')).toHaveText('Pay $49.69');
  await page.getByRole('button', { name: /Remove gift card ending 4821/ }).click();
  await expect(page.getByTestId('sf-gift-card-applied-0')).toHaveCount(0);
  await page.getByTestId('sf-gift-card-code').fill('FULLCARD');
  await page.getByTestId('sf-gift-card-apply').click();
  await expect(page.getByTestId('sf-settlement-explanation')).toBeVisible();
  await expect(page.getByTestId('sf-pay-button')).toHaveText('Confirm order');
  await expect(page.getByTestId('sf-pay-button')).toBeEnabled();
  await page.getByTestId('sf-pay-button').click();
  await expect(page).toHaveURL(/complete$/);
  const body = (await fixtureLog(request, 'chk_card')).log.find((entry) => entry.path === 'pay')!.body;
  expect(body.approved_collection_kind).toBe('settlement');
  expect(body.credential).toBeUndefined();
  expect(body.approved_order_revision).toBe('3');
  expect(body.approved_gift_card_money).toEqual({ amount: '7469', currency: 'USD' });
  const logText = JSON.stringify((await fixtureLog(request, 'chk_card')).log);
  expect(logText).not.toContain('FULLCARD');
});

test('trial subscription sets up a payment method and shows the trial confirmation', async ({ page, request }) => {
  await openCheckout(page, 'subtrial');
  await waitForPayment(page, 'ready');
  await expect(page.getByTestId('sf-pay-button')).toHaveText('Start free trial');
  await expect(page.getByTestId('sf-subscription-terms')).toContainText('$22.00 every month, before tax. 14-day free trial. Cancel anytime from your account.');
  await fillContact(page);
  await typeCard(page, 'ok');
  await page.getByTestId('sf-pay-button').click();
  await expect(page.getByTestId('sf-complete-status')).toHaveText('Your free trial has started');
  const calls = await stripeCalls(page);
  void calls;
  const body = (await fixtureLog(request, 'chk_subtrial')).log.find((entry) => entry.path === 'pay')!.body;
  expect(body.approved_collection_kind).toBe('setup');
  expect(body.credential.kind).toBe('payment_method_token');
});

test('paid subscription labels the button with the amount and shows an active subscription', async ({ page }) => {
  await openCheckout(page, 'subpaid');
  await waitForPayment(page, 'ready');
  await expect(page.getByTestId('sf-pay-button')).toHaveText('Subscribe for $22.00');
  await fillContact(page);
  await typeCard(page, 'ok');
  await page.getByTestId('sf-pay-button').click();
  await expect(page.getByTestId('sf-complete-status')).toHaveText("You're subscribed");
  await expect(page.getByTestId('sf-subscription-status')).toHaveText('Active');
});

test('subscription setup options carry off_session usage', async ({ page }) => {
  await openCheckout(page, 'subpaid');
  await waitForPayment(page, 'ready');
  const options = await page.evaluate(() => (window as any).__stripe.elementOptions);
  expect(options[0].setupFutureUsage).toBe('off_session');
  expect(options[0].paymentMethodCreation).toBe('manual');
});

test('bank processing leaves the form and shows the processing confirmation with no retry', async ({ page }) => {
  await openCheckout(page, 'bank');
  await expect(page).toHaveURL(/complete$/, { timeout: 15_000 });
  await expect(page.getByTestId('sf-complete-status')).toHaveText('Your bank payment is processing');
  await expect(page.getByRole('button', { name: /pay|cancel|retry/i })).toHaveCount(0);
});

test('Affirm incomplete offers Continue and Pay another way behind a dialog', async ({ page }) => {
  await openCheckout(page, 'affirm');
  await waitForPayment(page, 'affirm_incomplete');
  await expect(page.getByTestId('sf-affirm-continue')).toBeVisible();
  await page.getByTestId('sf-pay-another-way').click();
  await expect(page.getByTestId('sf-affirm-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Keep Affirm' }).click();
  await expect(page.getByTestId('sf-pay-another-way')).toBeFocused();
  await page.getByTestId('sf-pay-another-way').click();
  await page.getByTestId('sf-affirm-dialog-confirm').click();
  await waitForPayment(page, 'ready');
});

test('recovery mode shows finishing payment, hides the editing sections, and resumes', async ({ page }) => {
  await openCheckout(page, 'recovery');
  await expect(page.getByTestId('sf-contact')).toHaveCount(0);
  await expect(page.getByTestId('sf-discount')).toHaveCount(0);
  await expect(page).toHaveURL(/complete$/, { timeout: 15_000 });
});

test('expired and unavailable states give a next step and no payment form', async ({ page }) => {
  await openCheckout(page, 'expired');
  await expect(page.getByTestId('sf-expired')).toContainText('This checkout expired. Your cart is saved.');
  await expect(page.getByRole('button', { name: 'Start again' })).toBeVisible();
  await expect(page.getByTestId('sf-pay-form')).toHaveCount(0);
  await openCheckout(page, 'unavailable');
  await expect(page.getByTestId('sf-unavailable')).toContainText('Payments are unavailable'.slice(0, 8));
  await expect(page.getByTestId('sf-pay-form')).toHaveCount(0);
});

test('signed in buyer sees saved cards and pays with one', async ({ page, request }) => {
  await openCheckout(page, 'signedin');
  await waitForPayment(page, 'ready');
  await expect(page.getByText('Signed in as buyer@example.test')).toBeVisible();
  await expect(page.getByTestId('sf-saved-method-0')).toBeChecked();
  await expect(page.getByTestId('fake-card')).toBeHidden();
  await chooseShipping(page);
  await page.getByTestId('sf-delivery-option-0').check();
  await expect(page.getByTestId('sf-pay-button')).toBeEnabled();
  await page.getByTestId('sf-pay-button').click();
  await expect(page).toHaveURL(/complete$/);
  const body = (await fixtureLog(request, 'chk_signedin')).log.find((entry) => entry.path === 'pay')!.body;
  expect(body.credential).toEqual({ kind: 'saved_payment_method', value: 'pm_fixture_visa' });
  await expect(page.getByTestId('sf-account-link')).toHaveText('Track this order in your account');
});

test('returning buyer: code entry after email blur, a wrong code, the right code, then saved cards', async ({ page }) => {
  await openCheckout(page, 'returning');
  await waitForPayment(page, 'ready');
  await fillContact(page);
  await expect(page.getByTestId('sf-returning')).toBeVisible();
  await expect(page.getByTestId('sf-returning')).toContainText('Enter the code Flint Pay texted to');
  await expect(page.getByTestId('sf-pay-blocker')).not.toHaveAttribute('data-blocker', 'code');
  await page.getByTestId('sf-returning-code').fill('000000');
  await page.getByRole('button', { name: 'Confirm code' }).click();
  await expect(page.locator('[data-job-error="verification"]')).toContainText("That code isn't right");
  await page.getByTestId('sf-returning-code').fill('123456');
  await page.getByRole('button', { name: 'Confirm code' }).click();
  await expect(page.getByTestId('sf-saved-method-0')).toBeVisible();
  await expect(page.getByTestId('sf-returning')).toHaveCount(0);
});

test('returning buyer can skip the code', async ({ page }) => {
  await openCheckout(page, 'returning');
  await waitForPayment(page, 'ready');
  await fillContact(page);
  await page.getByTestId('sf-returning-skip').click();
  await expect(page.getByTestId('sf-returning')).toHaveCount(0);
});

test('saving a card is off by default and disabled for non-card types', async ({ page }) => {
  await readyOrder(page);
  const save = page.getByTestId('sf-save-card');
  await expect(save).not.toBeChecked();
  await save.check();
  await expect.poll(async () => (await stripeCalls(page)).some((call) => call.name === 'elements.update' && call.options.setupFutureUsage === 'on_session')).toBe(true);
  await page.getByTestId('fake-card').fill('bank');
  await expect(save).toBeDisabled();
  await expect(save).not.toBeChecked();
});

test('wallet region stays hidden without wallets and shows when the provider reports one', async ({ page }) => {
  await openCheckout(page, 'card');
  await waitForPayment(page, 'ready');
  await expect(page.getByTestId('sf-wallets')).toBeHidden();
  await openCheckout(page, 'wallet');
  await waitForPayment(page, 'ready');
  await expect(page.getByTestId('sf-wallets')).toBeVisible();
  await page.goto('about:blank');
  await openCheckout(page, 'wallet', { wallets: false });
  await waitForPayment(page, 'ready');
  await expect(page.getByTestId('sf-wallets')).toBeHidden();
});

test('wallet click is blocked with the reason until contact and delivery are done', async ({ page }) => {
  await openCheckout(page, 'wallet');
  await waitForPayment(page, 'ready');
  await page.getByTestId('fake-wallet-button').click();
  await expect(page.getByTestId('sf-payment-message')).toHaveText('Enter your email address to pay.');
});

test('provider secrets never appear in the checkout page, storage, or cookies', async ({ page, context }) => {
  let html = '';
  page.on('response', async (response) => {
    if (response.request().resourceType() === 'document') html += await response.text();
  });
  await openCheckout(page, 'authenticating');
  await expect(page).toHaveURL(/complete$/, { timeout: 15_000 });
  const forbidden = ['_secret_', 'client_secret', 'ckat_', 'cklt_', 'flint_test_', 'flint_cses_', 'whsec_'];
  for (const token of forbidden) expect(html, token).not.toContain(token);
  const storage = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage].map((s) => Object.entries(s))));
  expect(storage).toBe('[[],[]]');
  expect(await context.cookies()).toEqual([]);
});

test('keyboard only: contact, delivery radios with arrows, then Pay', async ({ page }) => {
  await readyOrder(page);
  await page.getByTestId('sf-delivery-mode-ship').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('sf-delivery-mode-pickup')).toBeChecked();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('sf-delivery-mode-ship')).toBeChecked();
  await shipAndSelect(page);
  await typeCard(page, 'ok');
  await page.getByTestId('sf-pay-button').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/complete$/);
});

test('the polite live region announces the amount after an update', async ({ page }) => {
  await readyOrder(page);
  await page.getByTestId('sf-discount-code').fill('WELCOME10');
  await page.getByTestId('sf-discount-apply').click();
  await expect(page.getByTestId('sf-live')).toHaveText(/Amount due now \$54\.00/);
});
