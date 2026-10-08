import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { Driver, Checkout } from '../support/driver.ts';
import { invariant } from '../support/safe.ts';

export type ProviderStep = { frameOrigin?: string; selector: string; action: 'click' | 'fill' | 'check' | 'select'; value?: string };
// Recipes contain selectors observed on the actual provider test flow. They do not
// inject outcomes or call provider APIs. The caller supplies them privately.
export async function providerSteps(d: Driver, page: Page, recipe: string): Promise<void> {
  const steps: ProviderStep[] = d.fixtures.values.providerSteps?.[recipe];
  invariant(Array.isArray(steps) && steps.length > 0, 'PROVIDER_RECIPE_REQUIRED');
  for (const step of steps) {
    invariant(['click', 'fill', 'check', 'select'].includes(step.action), 'PROVIDER_ACTION_INVALID');
    let frame = page.mainFrame();
    if (step.frameOrigin) {
      const expected = new URL(step.frameOrigin).origin;
      invariant(/^https:\/\/([a-z0-9-]+\.)*(stripe\.com|stripe\.network|affirm\.com|plaid\.com)$/.test(expected) || recipe === 'gift-public-challenge' && expected === 'https://challenges.cloudflare.com', 'PROVIDER_RECIPE_ORIGIN');
      await expect.poll(() => page.frames().some(f => { try { return new URL(f.url()).origin === expected; } catch { return false; } }), { timeout: 60_000 }).toBe(true);
      frame = page.frames().find(f => new URL(f.url() || 'about:blank').origin === expected)!;
    } else {
      invariant(/^https:\/\/([a-z0-9-]+\.)*(stripe\.com|affirm\.com)$/.test(new URL(page.url()).origin) || recipe === 'gift-public-challenge' && Object.values(d.config.origins).includes(new URL(page.url()).origin), 'PROVIDER_TEST_PAGE_REQUIRED');
    }
    const control = frame.locator(step.selector);
    await expect(control).toBeVisible();
    if (step.action === 'click') await control.click();
    else if (step.action === 'check') await control.check();
    else if (step.action === 'select') await control.selectOption(step.value ?? '');
    else await control.fill(step.value ?? '');
  }
}
export async function bank(d: Driver, c: Checkout, caseName: 'success' | 'processing' | 'failure'): Promise<void> {
  await providerSteps(d, c.page, `ach-instant-${caseName}`);
  await c.page.getByTestId('sf-pay-button').click();
  await expect(c.page.getByTestId('sf-complete')).toHaveAttribute('data-state', 'bank_processing', { timeout: 60_000 });
  await expect(c.page.getByTestId('sf-pay-button')).toHaveCount(0);
  invariant(!await c.page.getByRole('button', { name: /retry|cancel/i }).count(), 'BANK_PROCESSING_ACTIONS');
}
export async function affirm(d: Driver, c: Checkout, outcome: 'approve' | 'decline' | 'cancel'): Promise<void> {
  await providerSteps(d, c.page, 'affirm-select');
  await expect(c.page.getByTestId('sf-pay-button')).toBeEnabled(); await c.page.getByTestId('sf-pay-button').click();
  await providerSteps(d, c.page, `affirm-${outcome}`);
}
