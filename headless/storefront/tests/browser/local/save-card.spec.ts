// LOCAL STATE TESTS for confirming a card a guest saved with a phone number.
// The service behind these tests is an in-memory stand-in. A pass means the
// confirmation page and public/complete.js react correctly to the shapes the
// app sends. It does not prove Flint, Stripe, or the real app behave that way.

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { BASE, chooseShipping, fillContact, fixtureLog, openCheckout, resetFixtures, typeCard, waitForPayment } from '../support/helpers.ts';

test.beforeEach(async ({ request }) => resetFixtures(request));

const confirmRequests = async (request: APIRequestContext, scenario: string) =>
  (await fixtureLog(request, `chk_${scenario}`)).log.filter((entry) => entry.path === 'verification' && entry.body.purpose === 'confirm_saved_payment_method');

/** Fills the form as a guest and pays. The code asked for when the email was entered is skipped. */
async function payAsGuest(page: Page, scenario: string, phone: string | null) {
  await openCheckout(page, scenario);
  await waitForPayment(page, 'ready');
  await fillContact(page);
  await page.getByTestId('sf-returning-skip').click();
  await chooseShipping(page);
  await page.getByTestId('sf-delivery-option-0').check();
  await typeCard(page, 'ok');
  await page.getByTestId('sf-save-card').check();
  if (phone) await page.getByTestId('sf-save-phone').fill(phone);
  await page.getByTestId('sf-pay-button').click();
  await expect(page).toHaveURL(new RegExp(`${scenario}/complete$`));
}

const panel = (page: Page) => page.getByTestId('sf-save-confirm');

test('a guest who saves with a phone gets one text on the receipt, and a reload does not send another', async ({ page, request }) => {
  await payAsGuest(page, 'guestsave', '5125550167');
  const pay = (await fixtureLog(request, 'chk_guestsave')).log.find((entry) => entry.path === 'pay')!.body;
  expect(pay.save_payment_method).toBe(true);
  expect(pay.save_payment_method_phone).toBe('5125550167');
  await expect(page.getByTestId('sf-save-confirm-form')).toContainText('Enter the code Flint Pay texted to ••• 67');
  // The code asked for before payment is not what the receipt shows.
  await expect(page.getByText('••• 0100')).toHaveCount(0);
  await expect(page.getByTestId('sf-save-confirm-code')).toBeFocused();
  let sent = await confirmRequests(request, 'guestsave');
  expect(sent.map((entry) => entry.body)).toEqual([{ purpose: 'confirm_saved_payment_method', channel: 'sms' }]);
  await page.reload();
  await expect(page.getByTestId('sf-save-confirm-form')).toBeVisible();
  sent = await confirmRequests(request, 'guestsave');
  expect(sent).toHaveLength(1);
});

test('a wrong code is an alert that keeps focus on the field, and the right code saves the card', async ({ page }) => {
  await payAsGuest(page, 'guestsave', '5125550167');
  const code = page.getByTestId('sf-save-confirm-code');
  await code.fill('000000');
  await page.getByTestId('sf-save-confirm-confirm').click();
  const status = page.getByTestId('sf-save-confirm-status');
  await expect(status).toHaveText("That code isn't right. Use the latest code, or send a new one.");
  await expect(status).toHaveAttribute('role', 'alert');
  await expect(code).toHaveAttribute('aria-invalid', 'true');
  await expect(code).toBeFocused();
  await code.fill('123456');
  await page.getByTestId('sf-save-confirm-confirm').click();
  await expect(page.getByTestId('sf-save-confirm-saved')).toHaveText('Card saved. Next time, confirm with a code texted to your phone.');
  await expect(page.getByTestId('sf-save-confirm-form')).toHaveCount(0);
});

test('a code that is not six digits is refused before any request', async ({ page, request }) => {
  await payAsGuest(page, 'guestsave', '5125550167');
  await page.getByTestId('sf-save-confirm-code').fill('12');
  await page.getByTestId('sf-save-confirm-confirm').click();
  await expect(page.getByTestId('sf-save-confirm-status')).toHaveAttribute('role', 'alert');
  const log = (await fixtureLog(request, 'chk_guestsave')).log;
  expect(log.some((entry) => entry.path === 'verification/confirm')).toBe(false);
});

test('Email the code instead sends an email-channel request and asks for the emailed code', async ({ page, request }) => {
  await payAsGuest(page, 'guestsave', '5125550167');
  await page.getByTestId('sf-save-confirm-email').click();
  await expect(page.getByTestId('sf-save-confirm-form')).toContainText('Enter the code we emailed to b•••@example.test');
  const sent = await confirmRequests(request, 'guestsave');
  expect(sent.map((entry) => entry.body)).toEqual([
    { purpose: 'confirm_saved_payment_method', channel: 'sms' },
    { purpose: 'confirm_saved_payment_method', channel: 'email' },
  ]);
  // The buyer supplies no address, and the emailed prompt does not offer email again.
  expect(sent.every((entry) => entry.body.email === undefined)).toBe(true);
  await expect(page.getByTestId('sf-save-confirm-email')).toHaveCount(0);
  await page.getByTestId('sf-save-confirm-code').fill('123456');
  await page.getByTestId('sf-save-confirm-confirm').click();
  await expect(page.getByTestId('sf-save-confirm-saved')).toHaveText('Card saved. Next time, confirm with a code emailed to you.');
});

test('when the email must be confirmed too, the receipt offers an emailed code after the texted one', async ({ page, request }) => {
  await payAsGuest(page, 'guestemail', '5125550167');
  await page.getByTestId('sf-save-confirm-code').fill('123456');
  await page.getByTestId('sf-save-confirm-confirm').click();
  await expect(page.getByTestId('sf-save-confirm-form')).toHaveCount(0);
  await expect(panel(page)).toContainText('Your number is confirmed. To finish, confirm your email with a code.');
  await expect(page.getByTestId('sf-save-confirm-text')).toHaveCount(0);
  await page.getByTestId('sf-save-confirm-email').click();
  await expect(page.getByTestId('sf-save-confirm-form')).toContainText('Enter the code we emailed to b•••@example.test');
  await page.getByTestId('sf-save-confirm-code').fill('123456');
  await page.getByTestId('sf-save-confirm-confirm').click();
  await expect(page.getByTestId('sf-save-confirm-saved')).toBeVisible();
  const sent = await confirmRequests(request, 'guestemail');
  expect(sent.map((entry) => entry.body.channel)).toEqual(['sms', 'email']);
});

test('when texting is unavailable the email choice stays, with no alert', async ({ page, request }) => {
  await payAsGuest(page, 'guestnotext', '5125550167');
  await expect(page.getByTestId('sf-save-confirm-status')).toHaveText("We can't text a code right now. Email the code instead.");
  await expect(page.getByTestId('sf-save-confirm-status')).toHaveAttribute('role', 'status');
  await expect(panel(page).locator('[role="alert"]')).toHaveCount(0);
  await expect(page.getByTestId('sf-save-confirm-text')).toBeHidden();
  await expect(page.getByTestId('sf-save-confirm-email')).toBeVisible();
  // A reload does not retry the text on its own.
  await page.reload();
  expect(await confirmRequests(request, 'guestnotext')).toHaveLength(1);
  await page.getByTestId('sf-save-confirm-email').click();
  await expect(page.getByTestId('sf-save-confirm-form')).toContainText('Enter the code we emailed to');
});

test('a guest who saves without a phone gets no confirmation panel and no code request', async ({ page, request }) => {
  await payAsGuest(page, 'guestsave', null);
  await expect(page.getByTestId('sf-complete-status')).toHaveText('Order confirmed');
  await expect(panel(page)).toHaveCount(0);
  expect(await confirmRequests(request, 'guestsave')).toHaveLength(0);
});

test('a card saved without any phone offer never shows the panel', async ({ page, request }) => {
  await openCheckout(page, 'card');
  await waitForPayment(page, 'ready');
  await fillContact(page);
  await chooseShipping(page);
  await page.getByTestId('sf-delivery-option-0').check();
  await typeCard(page, 'ok');
  await page.getByTestId('sf-save-card').check();
  await expect(page.getByTestId('sf-save-phone')).toHaveCount(0);
  await page.getByTestId('sf-pay-button').click();
  await expect(page).toHaveURL(/chk_card\/complete$/);
  await expect(page.getByTestId('sf-complete-status')).toHaveText('Order confirmed');
  await expect(panel(page)).toHaveCount(0);
  expect((await fixtureLog(request, 'chk_card')).log.some((entry) => entry.body?.purpose === 'confirm_saved_payment_method')).toBe(false);
});

test('a receipt with no saved card request shows no panel', async ({ page }) => {
  await page.goto('/checkout/chk_paid/complete');
  await expect(page.getByTestId('sf-complete-status')).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
});

test('a saved card shows what to expect next time, and an expired one is a plain note', async ({ page, request }) => {
  await page.goto('/checkout/chk_guestsaved/complete');
  await expect(page.getByTestId('sf-save-confirm-saved')).toHaveText('Card saved. Next time, confirm with a code texted to your phone.');
  await page.goto('/checkout/chk_guestexpired/complete');
  await expect(page.getByTestId('sf-save-confirm-expired')).toHaveText("Your card wasn't saved because it wasn't confirmed within 24 hours. Your payment wasn't affected.");
  await expect(panel(page).locator('button, input')).toHaveCount(0);
  expect(await confirmRequests(request, 'guestsaved')).toHaveLength(0);
  expect(await confirmRequests(request, 'guestexpired')).toHaveLength(0);
});

test('a code asked for before payment is not drawn as the receipt code form', async ({ request }) => {
  const response = await request.get(`${BASE}/checkout/chk_guestleft/complete`);
  const html = await response.text();
  expect(html).toContain('data-save-card');
  expect(html).toContain('data-auto-send="sms"');
  expect(html).not.toContain('sf-save-confirm-form');
  expect(html).not.toContain('••• 0100');
});

for (const width of [390, 1024]) {
  test(`the code form fits at ${width}px with touch-sized controls`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await payAsGuest(page, 'guestsave', '5125550167');
    await expect(page.getByTestId('sf-save-confirm-form')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    for (const id of ['sf-save-confirm-code', 'sf-save-confirm-confirm', 'sf-save-confirm-resend', 'sf-save-confirm-email']) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box!.height, id).toBeGreaterThanOrEqual(43.5);
    }
  });
}
