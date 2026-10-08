// LOCAL STATE TEST. Renders every page and state from fixtures and checks structure, not behavior
// against Flint. See playwright.config.ts for what local tests do and do not prove.
import { expect, test } from '@playwright/test';
import type { PageId } from '../../../src/views/index.ts';
import { auditPage, overflowsHorizontally } from '../support/audit.ts';
import { ROOT_TESTID, installStripeStub, viewports, watch } from '../support/helpers.ts';

const variants: Partial<Record<PageId, string[]>> = {
  'sign-in': ['default', 'error'],
  'sign-up': ['default', 'error'],
  'verify-email': ['default', 'sent', 'invalid'],
  'ac-home': ['default', 'new_account', 'section_error', 'nothing_needed', 'setup_needed', 'notice', 'wrong_environment'],
  'ac-orders': ['default', 'paged', 'empty', 'error'],
  'ac-order': ['default', 'processing', 'no_delivery', 'window_closed', 'errors', 'receipt'],
  'ac-return-start': ['default', 'nothing', 'error'],
  'ac-returns': ['default', 'empty', 'error'],
  'ac-return': ['default', 'approved', 'awaiting_payment', 'completed', 'canceled'],
  'ac-invoices': ['default', 'empty', 'error'],
  'ac-invoice': ['default', 'overdue', 'processing', 'paid', 'closed', 'awaiting'],
  'ac-invoice-pay': ['default', 'declined', 'saved', 'surface_conflict', 'collection_in_progress', 'unavailable', 'expired', 'waiting', 'recovery', 'authenticate', 'affirm_incomplete', 'pay_remaining', 'bank_processing', 'total_changed'],
  'ac-return-pay': ['default', 'declined', 'surface_conflict'],
  'ac-subscriptions': ['default', 'empty', 'error'],
  'ac-subscription': ['default', 'past_due', 'retrying', 'retry_failed', 'retry_succeeded', 'scheduled_cancel', 'paused', 'store_policy', 'cancel_error', 'end_of_period'],
  'ac-payment-methods': ['default', 'empty', 'error'],
  'ac-payment-method-new': ['default', 'subscription'],
  'ac-payment-method-return': ['default', 'nothing', 'failed'],
  'ac-profile': ['default', 'error'],
  'ac-profile-email': ['default', 'codes'],
  'ac-profile-password': ['default', 'error'],
  'ac-addresses': ['default', 'empty', 'error'],
  'ac-address-form': ['default', 'edit', 'first'],
  'ac-gift-cards': ['default', 'empty', 'error'],
  'ac-gift-card-add': ['default', 'link', 'invalid'],
  'ac-gift-card': ['default', 'missing'],
  'ac-email-preferences': ['default', 'signed_in', 'no_email'],
  'ac-privacy': ['default', 'empty'],
  'ac-link-purchases': ['default', 'sent', 'done', 'none'],
};
const single: PageId[] = ['not-found', 'error', 'ac-order-receipt'];

test.describe('every page and state renders cleanly', () => {
  test.beforeEach(async ({ page }) => {
    await installStripeStub(page);
  });

  const all: Array<[PageId, string]> = [
    ...Object.entries(variants).flatMap(([id, list]) => (list ?? []).map((variant) => [id as PageId, variant] as [PageId, string])),
    ...single.map((id) => [id, 'default'] as [PageId, string]),
  ];

  for (const [pageId, variant] of all) {
    test(`${pageId} (${variant})`, async ({ page, baseURL }) => {
      const seen = watch(page, baseURL ?? '');
      const response = await page.goto(`/__render/${pageId}?variant=${variant}`);
      expect(response?.status()).toBe(200);
      await expect(page.locator('main')).toHaveAttribute('data-testid', ROOT_TESTID[pageId] ?? '');
      const problems = await auditPage(page, { bare: pageId === 'ac-order-receipt' });
      expect(problems).toEqual([]);
      // Let page scripts settle, then confirm nothing reached outside the app or logged errors.
      await page.waitForLoadState('networkidle');
      expect(seen.flint).toEqual([]);
      expect(seen.foreign).toEqual([]);
      expect(seen.consoleErrors).toEqual([]);
    });
  }
});

test.describe('layout at the four widths', () => {
  const sample: Array<[PageId, string]> = [
    ['ac-home', 'default'],
    ['ac-orders', 'default'],
    ['ac-order', 'default'],
    ['ac-invoice-pay', 'default'],
    ['ac-subscription', 'default'],
    ['ac-return-start', 'default'],
    ['ac-addresses', 'default'],
    ['ac-payment-methods', 'default'],
    ['ac-gift-card-add', 'default'],
    ['sign-in', 'default'],
  ];
  for (const viewport of viewports) {
    for (const [pageId, variant] of sample) {
      test(`${pageId} has no horizontal scroll at ${viewport.width}px`, async ({ page }) => {
        await installStripeStub(page);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(`/__render/${pageId}?variant=${variant}`);
        await page.waitForLoadState('networkidle');
        expect(await overflowsHorizontally(page)).toBe(false);
      });
    }
  }

  test('navigation is a sidebar from 1024px and a labelled menu below', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/__render/ac-orders');
    await expect(page.getByRole('navigation', { name: 'Account navigation' })).toBeVisible();
    await expect(page.getByText('Account menu')).toBeHidden();
    await page.setViewportSize({ width: 768, height: 900 });
    await expect(page.getByRole('navigation', { name: 'Account navigation' })).toBeHidden();
    const menu = page.getByTestId('ac-account-menu');
    await expect(menu.locator('summary')).toHaveText('Account menu');
    await menu.locator('summary').click();
    await expect(page.getByRole('navigation', { name: 'Account menu' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Account menu' }).getByRole('link', { name: 'Orders' })).toHaveAttribute('aria-current', 'page');
  });

  test('tables become stacked lists on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/__render/ac-orders');
    const row = page.getByTestId('ac-order-row-ord_example_001');
    await expect(row).toBeVisible();
    expect(await row.evaluate((el) => getComputedStyle(el).display)).toBe('block');
    await page.setViewportSize({ width: 900, height: 800 });
    expect(await row.evaluate((el) => getComputedStyle(el).display)).toBe('table-row');
  });

  test('touch targets are at least 44px on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const target of ['ac-home', 'ac-subscription', 'ac-addresses', 'ac-return-start']) {
      await page.goto(`/__render/${target}`);
      const small = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, summary')) {
          if (!(el instanceof HTMLElement)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (el.closest('.skip-link') || el.classList.contains('sr-only')) continue;
          // Links inside running text are exempt from the target size rule.
          if (el.tagName === 'A' && el.closest('p, li, address, dd, dt') && !el.classList.contains('btn') && !el.closest('.nav-list, .row-link, .contact-list, .back-link, th')) continue;
          if (rect.height < 43.5 || rect.width < 43.5) {
            if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
              const label = el.labels?.[0]?.getBoundingClientRect();
              if (label && label.height >= 43.5) continue;
              const row = el.closest('.field-check, .saved-option')?.getBoundingClientRect();
              if (row && row.height >= 43.5) continue;
            }
            out.push(`${el.tagName.toLowerCase()} ${(el.textContent ?? el.getAttribute('name') ?? '').trim().slice(0, 30)} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
          }
        }
        return out;
      });
      expect(small, target).toEqual([]);
    }
  });
});
