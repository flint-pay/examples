import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import type { Checkout, Driver } from '../../support/driver.ts';
import { browserEnvironment } from '../../support/child.ts';
import { affirm, providerSteps } from '../../scenarios/provider.ts';
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

test('affirm() waits for the app to see Affirm selected before it chooses a billing country', async t => {
  const browser = await chromium.launch({ headless: true, env: browserEnvironment() });
  t.after(() => browser.close());
  const recipes = {
    'affirm-select': [{ frameOrigin: stripe, selector: '[name="affirm-select"]', action: 'click' }],
    'affirm-approve': [{ frameOrigin: stripe, selector: '[name="affirm-approve"]', action: 'click' }],
  };
  const d = { fixtures: { values: { providerSteps: recipes } }, config: { origins: { storefrontA: merchant } } } as unknown as Driver;
  // The Stripe frame reports the selection to the merchant page after a delay, like the Payment Element's change event.
  // Pay is enabled from the start, so a helper that does not wait would press it before the country is chosen.
  const checkout = (saved: boolean) => `<select id="affirm-country" data-testid="sf-affirm-country" disabled hidden><option value="">Choose a country</option><option value="US">United States</option></select>
<button data-testid="sf-pay-button" type="button">Pay</button>
<iframe src="${stripe}/affirm"></iframe>
<script>
  const country = document.getElementById('affirm-country');
  window.__log = [];
  window.__approved = false;
  window.addEventListener('message', event => {
    if (event.origin !== '${stripe}') return;
    if (event.data === 'affirm-approved') window.__approved = true;
    if (event.data !== 'affirm-selected') return;
    window.__log.push('selected:before disabled=' + country.disabled + ' hidden=' + country.hidden);
    country.disabled = false;
    country.hidden = ${saved};
  });
  document.querySelector('[data-testid="sf-pay-button"]').addEventListener('click', () => window.__log.push('pay:' + country.value));
</script>`;
  const frame = `<button name="affirm-select" onclick="setTimeout(() => parent.postMessage('affirm-selected', '*'), 400)">Affirm</button><button name="affirm-approve" onclick="parent.postMessage('affirm-approved', '*')">Approve</button>`;

  await t.test('without a saved billing address the country appears, US is chosen, and only then does Pay run', async () => {
    await documents(browser, { [`${merchant}/checkout`]: checkout(false), [`${stripe}/affirm`]: frame }, async page => {
      await affirm(d, { page } as unknown as Checkout, 'approve');
      expect(await page.evaluate(() => (window as any).__log)).toEqual(['selected:before disabled=true hidden=true', 'pay:US']);
      await expect(page.getByTestId('sf-affirm-country')).toBeVisible();
      await expect(page.getByTestId('sf-affirm-country')).toHaveValue('US');
      assert.equal(await page.evaluate(() => (window as any).__approved), true);
    });
  });

  await t.test('with a saved billing address the country stays hidden and Pay runs without choosing one', async () => {
    await documents(browser, { [`${merchant}/checkout`]: checkout(true), [`${stripe}/affirm`]: frame }, async page => {
      await affirm(d, { page } as unknown as Checkout, 'approve');
      expect(await page.evaluate(() => (window as any).__log)).toEqual(['selected:before disabled=true hidden=true', 'pay:']);
      await expect(page.getByTestId('sf-affirm-country')).toBeHidden();
      await expect(page.getByTestId('sf-affirm-country')).toBeEnabled();
      await expect(page.getByTestId('sf-affirm-country')).toHaveValue('');
      assert.equal(await page.evaluate(() => (window as any).__approved), true);
    });
  });
});
