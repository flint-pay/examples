import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { Driver } from '../../support/driver.ts';
import type { Checkout } from '../../support/driver.ts';
import { browserEnvironment } from '../../support/child.ts';
import { settlement } from '../../scenarios/settlement.ts';

const merchant = 'https://merchant.example.test';
const stripe = 'https://js.stripe.com';

// These local documents exercise the acceptance boundary; they never contact a provider.
async function boundary(browser: Browser, options: { manual?: boolean; verification?: string; attempts?: unknown[]; paid?: string } = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let payments = 0;
  try {
    await context.route('**/*', async route => {
      if (route.request().url() === `${merchant}/checkout`) await route.fulfill({ contentType: 'text/html', body:
        `<iframe src="${stripe}/element"></iframe><button data-testid="sf-pay-button">Pay</button>` });
      else if (route.request().url() === `${stripe}/element`) await route.fulfill({ contentType: 'text/html', body: `
        <button id="us_bank_account-tab" onclick="document.querySelector('#picker').hidden=false;document.querySelector('#card').hidden=true">US bank account</button>
        <button id="card-tab" onclick="document.querySelector('#card').hidden=false">Card</button>
        <div id="picker" hidden><button onclick="window.linked=true">Test (Non-OAuth)</button>
          ${options.manual ? '<a href="#manual">Enter bank details manually</a>' : ''}
          <button aria-label="Close" onclick="document.querySelector('#picker').hidden=true">Close</button></div>
        <div id="card"><input id="payment-numberInput"><input id="payment-expiryInput"><input id="payment-cvcInput"></div>` });
      else { payments++; await route.abort(); }
    });
    const page = await context.newPage(); await page.goto(`${merchant}/checkout`);
    const checkout = { page, ref: 'chk_UNIT_BANK', orderId: 'ord_UNIT_BANK', state: {
      payment_collection: { stripe: { elements: { payment_method_types: ['card', 'us_bank_account'],
        payment_method_options: { us_bank_account: { verification_method: options.verification ?? 'instant' } } } } },
    } } as Checkout;
    const driver = {
      page: async () => page, checkout: async () => checkout,
      card: (target: typeof page) => Driver.prototype.card.call({} as Driver, target),
      operator: { clients: { clients: { A: { orders: {
        get: async () => ({ payment_status: 'unpaid', payment_intent_ids: [], settlement_amounts: {
          paid_money: { amount: options.paid ?? '0', currency: 'USD' }, outstanding_money: { amount: '1000', currency: 'USD' },
        } }), listPaymentAttempts: async () => ({ data: options.attempts ?? [] }),
      } } } } },
    } as unknown as Driver;
    const result = await settlement['SF-ACH-MICRODEP']!(driver);
    assert.equal(payments, 0);
    const frame = page.frames().find(frame => frame.url() === `${stripe}/element`)!;
    assert.equal(await frame.evaluate(() => (window as any).linked), undefined);
    assert.equal(await frame.locator('#payment-numberInput').inputValue(), '4242424242424242');
    return result;
  } finally { await context.close(); }
}

test('instant-only bank acceptance proves absence and card availability without submitting payment', async t => {
  const browser = await chromium.launch({ headless: true, env: browserEnvironment() });
  t.after(() => browser.close());
  await t.test('real picker controls can close and return to a ready card form without linking a bank', async () => {
    assert.deepEqual(await boundary(browser), ['INSTANT_ONLY_BANK_NO_MANUAL_ENTRY_NO_ATTEMPT_CARD_AVAILABLE']);
  });
  await t.test('a visible manual-entry option fails the boundary', async () => {
    await assert.rejects(() => boundary(browser, { manual: true }), /toHaveCount/);
  });
  await t.test('automatic verification does not satisfy the instant-only contract', async () => {
    await assert.rejects(() => boundary(browser, { verification: 'automatic' }), { code: 'INSTANT_ONLY_BANK_GUIDANCE_REQUIRED' });
  });
  await t.test('a payment attempt cannot be hidden by an unpaid order projection', async () => {
    await assert.rejects(() => boundary(browser, { attempts: [{ status: 'processing' }] }), { code: 'INSTANT_ONLY_BOUNDARY_MUST_NOT_CHARGE' });
  });
  await t.test('collected money fails even without an attempt in the list', async () => {
    await assert.rejects(() => boundary(browser, { paid: '1' }), { code: 'INSTANT_ONLY_BOUNDARY_MUST_NOT_CHARGE' });
  });
});
