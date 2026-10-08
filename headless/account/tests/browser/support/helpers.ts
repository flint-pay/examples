import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

const stubSource = readFileSync(fileURLToPath(new URL('./stripe-stub.js', import.meta.url)), 'utf8');

export const ROOT_TESTID: Record<string, string> = {
  'sign-in': 'sign-in',
  'sign-up': 'sign-up',
  'verify-email': 'verify-email',
  'not-found': 'ac-errors',
  error: 'ac-errors',
  'ac-home': 'ac-home',
  'ac-orders': 'ac-orders',
  'ac-order': 'ac-order',
  'ac-order-receipt': 'ac-order-receipt',
  'ac-return-start': 'ac-return-start',
  'ac-returns': 'ac-returns',
  'ac-return': 'ac-return',
  'ac-return-pay': 'ac-return-pay',
  'ac-invoices': 'ac-invoices',
  'ac-invoice': 'ac-invoice',
  'ac-invoice-pay': 'ac-invoice-pay',
  'ac-subscriptions': 'ac-subscriptions',
  'ac-subscription': 'ac-subscription',
  'ac-payment-methods': 'ac-payment-methods',
  'ac-payment-method-new': 'ac-payment-method-new',
  'ac-payment-method-return': 'ac-payment-method-return',
  'ac-profile': 'ac-profile',
  'ac-profile-email': 'ac-profile-email',
  'ac-profile-password': 'ac-password',
  'ac-addresses': 'ac-addresses',
  'ac-address-form': 'ac-address-form-page',
  'ac-gift-cards': 'ac-gift-cards',
  'ac-gift-card-add': 'ac-gift-card-add-page',
  'ac-gift-card': 'ac-gift-card',
  'ac-email-preferences': 'ac-email-preferences-page',
  'ac-privacy': 'ac-privacy',
  'ac-link-purchases': 'ac-link-purchases-page',
};

/** Replaces Stripe.js with the local double. The real script is never fetched in local tests. */
export async function installStripeStub(page: Page, config: Record<string, unknown> = {}): Promise<void> {
  await page.route('https://js.stripe.com/**', (route) => route.fulfill({ contentType: 'text/javascript', body: stubSource }));
  if (Object.keys(config).length) {
    await page.addInitScript((overrides) => {
      const apply = () => {
        const stub = (window as unknown as { __stripeStub?: { config: Record<string, unknown> } }).__stripeStub;
        if (stub) Object.assign(stub.config, overrides);
        else setTimeout(apply, 5);
      };
      apply();
    }, config);
  }
}

export interface Watch {
  /** Requests to anything other than the harness origin or the Stripe double. */
  foreign: string[];
  /** Requests to a Flint host. Must always be empty. */
  flint: string[];
  consoleErrors: string[];
}

export function watch(page: Page, origin: string): Watch {
  const seen: Watch = { foreign: [], flint: [], consoleErrors: [] };
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) return;
    if (/withflintpay\.com/i.test(url)) seen.flint.push(url);
    if (!url.startsWith('https://js.stripe.com/')) seen.foreign.push(url);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') seen.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => seen.consoleErrors.push(error.message));
  return seen;
}

export async function resetHarness(request: APIRequestContext, body: { scenario?: string; card?: string; removeUnknown?: boolean; canCheck?: boolean } = {}): Promise<void> {
  const response = await request.post('/__harness/reset', { data: body });
  expect(response.ok()).toBeTruthy();
}

export interface LogEntry {
  method: string;
  path: string;
  actionId: string | null;
  csrf: string | null;
  origin: string | null;
  body: unknown;
}

export async function harnessLog(request: APIRequestContext): Promise<LogEntry[]> {
  const response = await request.get('/__harness/log');
  return (await response.json()) as LogEntry[];
}

export async function stubCalls(page: Page): Promise<{
  elements: Array<Record<string, unknown>>;
  elementsUpdate: Array<Record<string, unknown>>;
  tokens: Array<Record<string, unknown>>;
  nextActions: string[];
  confirmSetup: Array<{ returnUrl: string; redirect: string }>;
  create: Array<{ type: string; opts: Record<string, unknown> }>;
  cleared: number;
}> {
  return page.evaluate(() => (window as unknown as { __stripeStub: { calls: never } }).__stripeStub.calls);
}

export function payUrl(surface: 'invoice' | 'return', variant = 'default'): string {
  const root = surface === 'invoice' ? '/invoices/inv_example_001' : '/returns/ret_example_001';
  return `${root}/pay?variant=${variant}`;
}

export const viewports = [
  { name: 'phone', width: 390, height: 844 },
  // A 1280px window at 200 percent zoom is 640 CSS pixels wide.
  { name: 'zoom 200 percent', width: 640, height: 800 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1024, height: 768 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;

/**
 * Records the data of the next submitted form whose action matches `action` and stops the
 * navigation. Call it after page.goto. The listener runs after the page's own handlers, so it sees
 * what the page would really send, including fields a script filled in.
 */
export async function captureForm(page: Page, action: RegExp): Promise<() => URLSearchParams | null> {
  let captured: string | null = null;
  await page.exposeFunction('__captureSubmit', (formAction: string, data: string) => {
    if (action.test(formAction)) captured = data;
  });
  await page.evaluate(() => {
    document.addEventListener('submit', (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || event.defaultPrevented) return;
      const data = new URLSearchParams(new FormData(form) as unknown as Record<string, string>).toString();
      (window as unknown as { __captureSubmit: (a: string, d: string) => void }).__captureSubmit(form.getAttribute('action') ?? '', data);
      event.preventDefault();
    });
  });
  return () => (captured === null ? null : new URLSearchParams(captured));
}
