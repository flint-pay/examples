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
    let control = page.mainFrame().locator(step.selector);
    if (step.frameOrigin) {
      const expected = new URL(step.frameOrigin).origin;
      invariant(/^https:\/\/([a-z0-9-]+\.)*(stripe\.com|stripe\.network|affirm\.com|plaid\.com)$/.test(expected) || recipe === 'gift-public-challenge' && expected === 'https://challenges.cloudflare.com', 'PROVIDER_RECIPE_ORIGIN');
      let visibleCount = 0;
      await expect.poll(async () => {
        visibleCount = 0;
        for (const frame of page.frames()) {
          let origin;
          try { origin = new URL(frame.url()).origin; } catch { continue; }
          if (origin !== expected) continue;
          const matches = frame.locator(step.selector).filter({ visible: true });
          const count = await matches.count();
          visibleCount += count;
          if (count > 0) control = matches;
        }
        return visibleCount;
      }, { timeout: 60_000 }).not.toBe(0);
      invariant(visibleCount === 1, 'PROVIDER_CONTROL_AMBIGUOUS');
    } else {
      invariant(/^https:\/\/([a-z0-9-]+\.)*(stripe\.com|affirm\.com)$/.test(new URL(page.url()).origin) || recipe === 'gift-public-challenge' && Object.values(d.config.origins).includes(new URL(page.url()).origin), 'PROVIDER_TEST_PAGE_REQUIRED');
    }
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
  const country = c.page.getByTestId('sf-affirm-country');
  // The field is enabled once the app sees Affirm selected, including when a saved billing address hides it.
  if (await country.count()) {
    await expect(country).toBeEnabled();
    if (await country.isVisible()) await country.selectOption('US');
  }
  await expect(c.page.getByTestId('sf-pay-button')).toBeEnabled(); await c.page.getByTestId('sf-pay-button').click();
  await providerSteps(d, c.page, `affirm-${outcome}`);
}
