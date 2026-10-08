import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { installStripeStub } from './stripe-stub.ts';

export const BASE = process.env.LOCAL_STATE_ORIGIN ?? `http://localhost:${process.env.LOCAL_STATE_PORT ?? 4190}`;

export async function resetFixtures(request: APIRequestContext) {
  await request.post(`${BASE}/__reset`);
}

export async function fixtureLog(request: APIRequestContext, ref: string): Promise<{ log: { method: string; path: string; body: any }[]; payCount: number; resumeCount: number }> {
  const response = await request.get(`${BASE}/__log/${ref}`);
  return response.json();
}

export async function openCheckout(page: Page, scenario: string, options: { wallets?: boolean } = {}) {
  await installStripeStub(page, options);
  await page.goto(`${BASE}/checkout/chk_${scenario}`);
}

export async function waitForPayment(page: Page, state: string) {
  await expect(page.getByTestId('sf-payment')).toHaveAttribute('data-state', state, { timeout: 15_000 });
}

export async function fillContact(page: Page, who = { name: 'Test Buyer', email: 'buyer@example.test' }) {
  await page.getByTestId('sf-contact-name').fill(who.name);
  await page.getByTestId('sf-contact-email').fill(who.email);
  await page.getByTestId('sf-contact-email').blur();
}

export async function chooseShipping(page: Page, postal = '78701') {
  await page.getByTestId('sf-ship-line1').fill('100 Test Street');
  await page.getByTestId('sf-ship-city').fill('Austin');
  await page.getByTestId('sf-ship-state').fill('TX');
  await page.getByTestId('sf-ship-postal').fill(postal);
  await page.getByTestId('sf-delivery-quote').click();
}

export async function typeCard(page: Page, behavior = 'ok') {
  await page.getByTestId('fake-card').fill(behavior);
}
