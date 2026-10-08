// LOCAL STATE TESTS for payments whose outcome is not known yet.
//
// The stand-in service holds an "unresolved saved request" the way the app does
// after lost responses: it answers next=resume even though no attempt exists.
// These tests check what the page does with that answer: it resumes with an
// empty POST, never builds a new credential or approval, stops at its bounds,
// and keeps the order frozen while it works. They do not prove the real app or
// Flint behave this way.

import { expect, test } from '@playwright/test';
import { chooseShipping, fillContact, fixtureLog, openCheckout, resetFixtures, typeCard, waitForPayment } from '../support/helpers.ts';

test.beforeEach(async ({ request }) => resetFixtures(request));

const count = (log: { path: string }[], path: string) => log.filter((entry) => entry.path === path).length;

test('a page that opens with next=resume and no attempt resumes with empty POSTs and completes', async ({ page, request }) => {
  await openCheckout(page, 'lostresume');
  await expect(page.getByTestId('sf-payment')).toHaveAttribute('data-state', /resuming/);
  await expect(page).toHaveURL(/complete$/, { timeout: 20_000 });
  const { log, payCount, resumeCount } = await fixtureLog(request, 'chk_lostresume');
  expect(payCount).toBe(0);
  expect(resumeCount).toBe(2);
  for (const entry of log.filter((item) => item.path === 'resume')) expect(entry.body).toEqual({});
  expect(count(log, 'pay')).toBe(0);
});

test('while resolving, pay and every order change are blocked with the reason in text', async ({ page }) => {
  await openCheckout(page, 'stuckresume');
  await expect(page.getByTestId('sf-locked-note')).toBeVisible();
  await expect(page.getByTestId('sf-locked-note')).toHaveText('Changes are paused until your payment finishes confirming.');
  await expect(page.locator('[data-checkout]')).toHaveAttribute('data-resolving', '');
  await expect(page.getByTestId('sf-pay-button')).toBeDisabled();
  await expect(page.getByTestId('sf-pay-blocker')).toHaveAttribute('data-blocker', 'attempt_open');
  for (const id of ['sf-contact-email', 'sf-discount-code', 'sf-discount-apply', 'sf-gift-card-code', 'sf-delivery-quote']) {
    await expect(page.getByTestId(id), id).toBeDisabled();
  }
});

test('a lost pay response that leaves no attempt is recovered with resume, one pay, and no new credential', async ({ page, request }) => {
  await openCheckout(page, 'service');
  await waitForPayment(page, 'ready');
  await fillContact(page);
  await typeCard(page, 'lostsend');
  await page.getByTestId('sf-pay-button').click();
  await expect(page).toHaveURL(/complete$/, { timeout: 20_000 });
  const { log, payCount, resumeCount } = await fixtureLog(request, 'chk_service');
  expect(payCount).toBe(1);
  expect(count(log, 'pay')).toBe(1);
  expect(resumeCount).toBe(2);
  for (const entry of log.filter((item) => item.path === 'resume')) expect(entry.body).toEqual({});
});

test('a resume that keeps answering resume stops after 3 requests and offers Check again', async ({ page, request }) => {
  await openCheckout(page, 'stuckresume');
  await expect(page.getByTestId('sf-check-again')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('sf-payment-message')).toContainText("You won't be charged twice");
  await expect(page.getByTestId('sf-pay-button')).toBeDisabled();
  const first = await fixtureLog(request, 'chk_stuckresume');
  expect(first.resumeCount).toBe(3);
  // Reads do not change anything and the page does not keep asking on its own.
  await page.waitForTimeout(3_000);
  const idle = await fixtureLog(request, 'chk_stuckresume');
  expect(idle.resumeCount).toBe(3);
  expect(count(idle.log, 'attempt')).toBe(0);
  expect(idle.payCount).toBe(0);
  // Check again is a new bounded run: three more empty resumes, then it stops again.
  await page.getByTestId('sf-check-again').click();
  await expect(page.getByTestId('sf-check-again')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await fixtureLog(request, 'chk_stuckresume')).resumeCount).toBe(6);
  await page.waitForTimeout(2_000);
  const after = await fixtureLog(request, 'chk_stuckresume');
  expect(after.resumeCount).toBe(6);
  expect(after.payCount).toBe(0);
});

test('a saved request that fails returns to a usable form with the decline copy and unlocked sections', async ({ page, request }) => {
  await openCheckout(page, 'resumefail');
  await waitForPayment(page, 'declined');
  await expect(page.getByTestId('sf-payment-message')).toHaveText('Your payment was declined. Try another card or payment method.');
  await expect(page.getByTestId('fake-card')).toBeVisible();
  await expect(page.getByTestId('sf-contact-email')).toBeEnabled();
  await expect(page.getByTestId('sf-locked-note')).toBeHidden();
  await fillContact(page);
  await chooseShipping(page);
  await page.getByTestId('sf-delivery-option-0').check();
  await expect(page.getByTestId('sf-delivery')).toHaveAttribute('data-state', 'selected');
  await typeCard(page, 'ok');
  await page.getByTestId('sf-pay-button').click();
  await expect(page).toHaveURL(/complete$/);
  const { payCount, resumeCount } = await fixtureLog(request, 'chk_resumefail');
  expect(resumeCount).toBe(1);
  expect(payCount).toBe(1);
});

test('after a stuck run the page never starts a second payment, even if Pay is forced', async ({ page, request }) => {
  await openCheckout(page, 'stuckresume');
  await expect(page.getByTestId('sf-check-again')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => {
    const form = document.getElementById('pay-form') as HTMLFormElement;
    const button = document.getElementById('pay-button') as HTMLButtonElement;
    button.disabled = false;
    form.requestSubmit();
  });
  await page.waitForTimeout(500);
  expect((await fixtureLog(request, 'chk_stuckresume')).payCount).toBe(0);
});
