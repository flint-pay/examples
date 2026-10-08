// Renders pages with hostile values and checks they come out escaped. No browser needed.

import { expect, test } from '@playwright/test';
import { renderPage } from '../../../src/views/index.ts';
import { cartData, catalog, homeLoaded } from '../support/fixtures.ts';
import { FakeCheckout } from '../support/fake-backend.ts';

const hostile = '<img src=x onerror=alert(1)>"\'</script><script>alert(2)</script>';

const base = {
  storeName: hostile,
  csrf: 'csrf"><script>alert(3)</script>',
  user: { name: hostile, email: 'x@example.test' },
  cartCount: 1,
  accountOrigin: 'http://localhost:4200',
  appOrigin: 'http://localhost:4100',
  notices: ['total_changed:' + hostile],
};

function noRawInjection(html: string) {
  expect(html).not.toContain('<script>alert');
  expect(html).not.toContain('<img src=x');
  expect(html).not.toContain('onerror=alert(1)>"');
}

test('home, product, cart, and sign-in escape hostile names and notices', async () => {
  const item = { ...catalog[0]!, product: { ...catalog[0]!.product, name: hostile, description: hostile } };
  noRawInjection(await renderPage('sf-home', { ...base, data: { ...homeLoaded, products: [item] } }));
  noRawInjection(await renderPage('sf-product', { ...base, data: { item } }));
  const cart = cartData([{ id: 'ln_1', slug: 'house-blend', variant: 0, quantity: 1 }]);
  cart.cart.lines[0]!.item = item;
  noRawInjection(await renderPage('sf-cart', { ...base, data: cart }));
  noRawInjection(await renderPage('sign-in', { ...base, data: { next: '/"><script>alert(4)</script>' } }));
});

test('checkout page escapes order data and keeps the embedded JSON inert', async () => {
  const fake = new FakeCheckout('chk_card');
  fake.order.line_items[0].name = hostile;
  fake.contactName = hostile;
  fake.session.merchant_support = { email: 'a@example.test', url: 'javascript:alert(5)' };
  const html = await renderPage('sf-checkout', { ...base, data: { state: fake.project() } });
  noRawInjection(html);
  expect(html).not.toContain('href="javascript:');
  const json = /<script type="application\/json" id="checkout-bootstrap">([\s\S]*?)<\/script>/.exec(html)![1]!;
  expect(json).not.toContain('</script');
  expect(JSON.parse(json).state.order.line_items[0].name).toBe(hostile);
});

test('the checkout page never carries provider secrets from a requires_action state', async () => {
  const fake = new FakeCheckout('chk_authenticating');
  const html = await renderPage('sf-checkout', { ...base, storeName: 'Cedar & Stone', data: { state: fake.project() } });
  for (const token of ['_secret_', 'client_secret', 'client_action']) expect(html, token).not.toContain(token);
  expect(html).toContain('pending_action_id');
});
