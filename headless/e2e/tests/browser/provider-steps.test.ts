import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import type { Driver } from '../../support/driver.ts';
import { browserEnvironment } from '../../support/child.ts';
import { providerSteps } from '../../scenarios/provider.ts';
import type { ProviderStep } from '../../scenarios/provider.ts';

const merchant = 'https://merchant.example.test';
const stripe = 'https://js.stripe.com';
const cloudflare = 'https://challenges.cloudflare.com';
const input = '<input name="provider-control">';

function driver(steps: ProviderStep[], recipe = 'local-provider-test'): Driver {
  return {
    fixtures: { values: { providerSteps: { [recipe]: steps } } },
    config: { origins: { storefrontA: merchant } },
  } as unknown as Driver;
}

// Serve every document locally. These tests never reach a provider or Flint API.
async function documents(browser: Browser, pages: Record<string, string>, run: (page: Page) => Promise<void>, at = `${merchant}/checkout`): Promise<void> {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    await context.route('**/*', async route => {
      const html = pages[route.request().url()];
      if (html === undefined) await route.abort();
      else await route.fulfill({ contentType: 'text/html', body: html });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(3000);
    await page.goto(at);
    await run(page);
  } finally { await context.close(); }
}

test('provider steps select a unique visible control across frames on the exact origin', async t => {
  const browser = await chromium.launch({ headless: true, env: browserEnvironment() });
  t.after(() => browser.close());
  const step: ProviderStep = { frameOrigin: stripe, selector: '[name="provider-control"]', action: 'fill', value: 'local-test-value' };

  await t.test('earlier same-origin frames and hidden matches do not hide the unique visible control', async () => {
    await documents(browser, {
      [`${merchant}/checkout`]: `<iframe></iframe><iframe src="${stripe}/decorative"></iframe><iframe src="${stripe}/hidden"></iframe><iframe src="${stripe}/control"></iframe><iframe src="https://hooks.stripe.com/other"></iframe>`,
      [`${stripe}/decorative`]: '<p>Decorative frame</p>',
      [`${stripe}/hidden`]: '<input name="provider-control" hidden>',
      [`${stripe}/control`]: `<input name="provider-control" hidden>${input}`,
      'https://hooks.stripe.com/other': input,
    }, async page => {
      await providerSteps(driver([step]), page, 'local-provider-test');
      const frames = page.frames();
      await expect(frames.find(frame => frame.url() === `${stripe}/control`)!.locator('input:visible')).toHaveValue('local-test-value');
      await expect(frames.find(frame => frame.url() === `${stripe}/hidden`)!.locator('input')).toHaveValue('');
      await expect(frames.find(frame => frame.url() === 'https://hooks.stripe.com/other')!.locator('input')).toHaveValue('');
    });
  });

  await t.test('waits for a visible control after the matching frames have loaded', async () => {
    await documents(browser, {
      [`${merchant}/checkout`]: `<iframe src="${stripe}/decorative"></iframe><iframe src="${stripe}/control"></iframe>`,
      [`${stripe}/decorative`]: '<p>Decorative frame</p>',
      [`${stripe}/control`]: '<input name="provider-control" hidden>',
    }, async page => {
      const frame = page.frames().find(frame => frame.url() === `${stripe}/control`)!;
      // Begin the helper while there are no visible matches, then reveal one.
      const pending = providerSteps(driver([step]), page, 'local-provider-test');
      await frame.evaluate(() => setTimeout(() => { document.querySelector('input')!.hidden = false; }, 200));
      await pending;
      await expect(frame.locator('input')).toHaveValue('local-test-value');
    });
  });

  for (const sameFrame of [false, true]) {
    await t.test(`rejects multiple visible matches ${sameFrame ? 'within one frame' : 'across frames'} before acting`, async () => {
      await documents(browser, {
        [`${merchant}/checkout`]: `<iframe src="${stripe}/first"></iframe>${sameFrame ? '' : `<iframe src="${stripe}/second"></iframe>`}`,
        [`${stripe}/first`]: sameFrame ? input + input : input,
        [`${stripe}/second`]: input,
      }, async page => {
        await assert.rejects(() => providerSteps(driver([step]), page, 'local-provider-test'), { code: 'PROVIDER_CONTROL_AMBIGUOUS' });
        for (const frame of page.frames().filter(frame => frame.url().startsWith(stripe))) {
          for (const control of await frame.locator('input').all()) await expect(control).toHaveValue('');
        }
      });
    });
  }

  await t.test('rejects an unsupported frame origin before acting', async () => {
    const unsupported = 'https://provider.example.test';
    await documents(browser, {
      [`${merchant}/checkout`]: `<iframe src="${unsupported}/control"></iframe>`,
      [`${unsupported}/control`]: input,
    }, async page => {
      await assert.rejects(() => providerSteps(driver([{ ...step, frameOrigin: unsupported }]), page, 'local-provider-test'), { code: 'PROVIDER_RECIPE_ORIGIN' });
      await expect(page.frames().find(frame => frame.url() === `${unsupported}/control`)!.locator('input')).toHaveValue('');
    });
  });

  await t.test('Cloudflare remains allowed only for the public gift challenge recipe', async () => {
    await documents(browser, {
      [`${merchant}/checkout`]: `<iframe src="${cloudflare}/control"></iframe>`,
      [`${cloudflare}/control`]: input,
    }, async page => {
      const challengeStep = { ...step, frameOrigin: cloudflare };
      await assert.rejects(() => providerSteps(driver([challengeStep]), page, 'local-provider-test'), { code: 'PROVIDER_RECIPE_ORIGIN' });
      await providerSteps(driver([challengeStep], 'gift-public-challenge'), page, 'gift-public-challenge');
      await expect(page.frames().find(frame => frame.url() === `${cloudflare}/control`)!.locator('input')).toHaveValue('local-test-value');
    });
  });

  await t.test('main-frame steps retain the provider page guard and public gift exception', async () => {
    const mainStep = { ...step, frameOrigin: undefined };
    await documents(browser, { [`${merchant}/checkout`]: input }, async page => {
      await assert.rejects(() => providerSteps(driver([mainStep]), page, 'local-provider-test'), { code: 'PROVIDER_TEST_PAGE_REQUIRED' });
      await expect(page.locator('input')).toHaveValue('');
      await providerSteps(driver([mainStep], 'gift-public-challenge'), page, 'gift-public-challenge');
      await expect(page.locator('input')).toHaveValue('local-test-value');
    });
    await documents(browser, { [`${stripe}/checkout`]: input }, async page => {
      await providerSteps(driver([mainStep]), page, 'local-provider-test');
      await expect(page.locator('input')).toHaveValue('local-test-value');
    }, `${stripe}/checkout`);
  });
});
