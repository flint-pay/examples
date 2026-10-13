// STAGING ACCEPTANCE: SF-01. Needs a running app against a sandbox with the sample catalog.

import { expect, test } from '@playwright/test';
import { addToCart, ensureTestMode, requireAcceptance, watchConsole, watchFlintHosts } from './support/staging.ts';

requireAcceptance();

test('SF-01 browse, add with a variant, change quantity, remove, empty cart', async ({ page }) => {
  const errors = watchConsole(page);
  const flint = watchFlintHosts(page);
  await ensureTestMode(page);
  await page.goto('/');
  await expect(page.getByTestId('sf-home')).toHaveAttribute('data-state', 'loaded');
  const listed = await page.getByTestId('sf-product-card-house-blend').locator('.card-price').textContent();
  await page.getByTestId('sf-product-card-house-blend').click();
  await expect(page.getByTestId('sf-product-price')).toHaveText(listed!.trim());
  await page.getByTestId('sf-variant-ground').check();
  await page.getByTestId('sf-quantity').fill('2');
  await page.getByTestId('sf-add-to-cart').click();
  await expect(page.getByTestId('sf-add-status')).toHaveText('Added to cart');
  await page.goto('/cart');
  const line = page.locator('[data-testid^="sf-cart-line-"]').first();
  await expect(line).toContainText('Ground');
  const unit = Number(await line.locator('.cart-unit .money').getAttribute('data-amount-minor'));
  await expect(page.getByTestId('sf-cart-subtotal')).toHaveAttribute('data-amount-minor', String(unit * 2));
  await line.locator('input[type="number"]').fill('3');
  await line.getByRole('button', { name: /Update quantity/ }).click();
  await expect(page.getByTestId('sf-cart-subtotal')).toHaveAttribute('data-amount-minor', String(unit * 3));
  await page.locator('[data-testid^="sf-cart-remove-"]').click();
  await expect(page.getByTestId('sf-cart-empty')).toBeVisible();
  expect(errors).toEqual([]);
  flint.assertClean();
});

test('SF-22 headless Chromium: wallet region hidden, card form usable, no console errors', async ({ page }) => {
  const errors = watchConsole(page);
  const flint = watchFlintHosts(page);
  await ensureTestMode(page);
  await addToCart(page, 'stoneware-mug');
  await page.goto('/cart');
  await page.getByTestId('sf-checkout-start').click();
  await expect(page.getByTestId('sf-payment')).toHaveAttribute('data-state', /ready|declined/, { timeout: 30_000 });
  await expect(page.getByTestId('sf-wallets')).toBeHidden();
  await expect(page.locator('#payment-element iframe').first()).toBeVisible();
  expect(errors).toEqual([]);
  flint.assertClean();
});
