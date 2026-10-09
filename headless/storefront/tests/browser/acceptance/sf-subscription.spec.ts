// STAGING ACCEPTANCE (supplemental): guest subscription checkouts, monthly and zero-dollar trial.
//
// These run against the real app, a sandbox, and Stripe test mode, with the audited lifecycle.
// They cover the guest checkout and confirmation page only. The full SF-19 and SF-20 contracts
// also check Flint's subscription records, signed-in account pages and lifecycle email in
// headless/e2e, so a pass here is not a pass of those scenarios. Each run leaves one paid order
// and one subscription in the sandbox that the lifecycle cleanup must cancel.

import { expect, test, type Page } from '@playwright/test';
import {
  CARDS, ensureTestMode, enterCard, fillBillingAddressIfRequired, fillContact,
  requireAcceptance, watchFlintHosts,
} from './support/staging.ts';

requireAcceptance();

test.beforeEach(async ({ page }) => ensureTestMode(page));

/** Opens the plan confirmation page, continues as a guest, and waits for the checkout to settle. */
async function launchSubscription(page: Page, slug: string) {
  await page.goto(`/subscribe/${slug}`);
  await page.getByTestId('sf-subscribe-continue').click();
  await expect(page).toHaveURL(/\/checkout\/chk_[0-9A-HJKMNP-TV-Z]{20}$/);
  await expect(page.getByTestId('sf-payment')).not.toHaveAttribute('data-state', 'loading', { timeout: 30_000 });
}

test('SF-19-native monthly subscription: a guest pays by card and the subscription is active', async ({ page }) => {
  const flint = watchFlintHosts(page);
  await launchSubscription(page, 'coffee-club-monthly');
  await fillContact(page);
  await fillBillingAddressIfRequired(page);
  // The terms sit in the payment section, which shows its form only once billing is done.
  await expect(page.getByTestId('sf-subscription-terms')).toBeVisible();
  await expect(page.getByTestId('sf-payment')).toHaveAttribute('data-collection', 'processor');
  await enterCard(page, CARDS.success);
  // Standard keyboard activation of the pay button, so the form's own submit handler runs.
  await expect(page.getByTestId('sf-pay-button')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('sf-pay-button').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('sf-complete')).toHaveAttribute('data-state', 'subscription_active', { timeout: 60_000 });
  await expect(page.getByTestId('sf-subscription-status')).toHaveAttribute('data-status', 'active');
  flint.assertClean();
});

test('SF-20-native trial subscription: setup collects a card with nothing due, then the trial is running', async ({ page }) => {
  const flint = watchFlintHosts(page);
  await launchSubscription(page, 'coffee-club-trial');
  await fillContact(page);
  await fillBillingAddressIfRequired(page);
  await expect(page.getByTestId('sf-payment')).toHaveAttribute('data-collection', 'setup');
  await expect(page.getByTestId('sf-summary-outstanding')).toHaveAttribute('data-amount-minor', '0');
  await expect(page.getByTestId('sf-pay-button')).toHaveText('Start free trial');
  await enterCard(page, CARDS.success);
  // Standard keyboard activation of the pay button, so the form's own submit handler runs.
  await expect(page.getByTestId('sf-pay-button')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('sf-pay-button').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('sf-complete')).toHaveAttribute('data-state', 'subscription_trialing', { timeout: 60_000 });
  await expect(page.getByTestId('sf-subscription-status')).toHaveAttribute('data-status', 'trialing');
  flint.assertClean();
});
