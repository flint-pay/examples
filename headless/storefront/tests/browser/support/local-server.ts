// LOCAL STATE TEST SERVER. Serves the real views (renderPage) and the real
// public/ assets on top of the in-memory stand-in from fake-backend.ts. It is
// started only by the `local-state` Playwright project. It is not the app and
// it never talks to Flint or Stripe.

import { readFile } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { renderPage } from '../../../src/views/index.ts';
import type { PageContext, PageId } from '../../../src/views/types.ts';
import { cartData, catalog, homeLoaded, plans } from './fixtures.ts';
import { FakeCheckout } from './fake-backend.ts';

const PORT = Number(process.env.LOCAL_STATE_PORT ?? 4190);
const ORIGIN = `http://localhost:${PORT}`;
const PUBLIC = new URL('../../../public/', import.meta.url);
const CSRF = 'csrf-fixture-token';

const checkouts = new Map<string, FakeCheckout>();
let cart: { id: string; slug: string; variant: number; quantity: number }[] = [];
let lineSeq = 0;

function checkout(ref: string): FakeCheckout | undefined {
  if (!/^chk_[a-z]+$/.test(ref)) return undefined;
  let existing = checkouts.get(ref);
  if (!existing) {
    existing = new FakeCheckout(ref);
    checkouts.set(ref, existing);
  }
  return existing;
}

function context(data: Record<string, unknown>, extra: Partial<PageContext> = {}): PageContext {
  return {
    storeName: 'Cedar & Stone',
    csrf: CSRF,
    user: null,
    cartCount: cart.reduce((sum, line) => sum + line.quantity, 0),
    accountOrigin: 'http://localhost:4200',
    appOrigin: ORIGIN,
    data,
    notices: [],
    ...extra,
  };
}

const app = new Hono();

app.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('Content-Security-Policy', "default-src 'self'; script-src 'self' https://js.stripe.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://api.stripe.com; frame-src https://js.stripe.com; base-uri 'self'; form-action 'self'");
});

const types: Record<string, string> = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
app.get('/styles.css', (c) => asset(c, 'styles.css'));
app.get('/js/:file', (c) => asset(c, `js/${c.req.param('file')}`));
app.get('/images/:file', (c) => asset(c, `images/${c.req.param('file')}`));

async function asset(c: any, path: string) {
  if (path.includes('..')) return c.notFound();
  try {
    const body = await readFile(new URL(path, PUBLIC));
    const ext = path.slice(path.lastIndexOf('.'));
    return c.body(body, 200, { 'Content-Type': types[ext] ?? 'application/octet-stream' });
  } catch {
    return c.notFound();
  }
}

const page = async (c: any, id: PageId, data: Record<string, unknown>, extra: Partial<PageContext> = {}, status = 200) => c.html(await renderPage(id, context(data, extra)), status);

// ----- Catalog and cart -----
app.get('/', (c) => {
  const mode = c.req.query('state');
  const data = mode === 'empty' ? { products: [], plans: [], cards: 'ready', setupNeeded: true } : mode === 'error' ? { products: [], plans: [], loadFailed: true } : mode === 'nocards' ? { ...homeLoaded, cards: 'unavailable' } : homeLoaded;
  return page(c, 'sf-home', data);
});
app.get('/products/:slug', (c) => {
  const item = catalog.find((entry) => entry.slug === c.req.param('slug')) ?? null;
  const notices = c.req.query('notice') ? [c.req.query('notice')!] : [];
  return page(c, 'sf-product', { item, loadFailed: c.req.query('state') === 'error' }, { notices, path: c.req.path }, item || c.req.query('state') === 'error' ? 200 : 404);
});
app.get('/cart', (c) => page(c, 'sf-cart', cartData(cart.map((line) => ({ id: line.id, slug: line.slug, variant: line.variant, quantity: line.quantity }))), { path: '/cart' }));
app.post('/cart/items', async (c) => {
  const isJson = c.req.header('content-type')?.includes('application/json');
  const input: any = isJson ? await c.req.json() : await c.req.parseBody();
  const item = catalog.find((entry) => entry.slug === input.product_slug);
  const variant = item ? Math.max(0, item.variants.findIndex((entry) => entry.variant_id === input.variant_id)) : 0;
  if (!item) return c.json({ error: { kind: 'not_found', code: 'NOT_FOUND', message_key: 'not_found' } }, 404);
  const existing = cart.find((line) => line.slug === item.slug && line.variant === variant);
  if (existing) existing.quantity = Math.min(20, existing.quantity + Number(input.quantity ?? 1));
  else cart.push({ id: `ln_fixture_${++lineSeq}`, slug: item.slug, variant, quantity: Number(input.quantity ?? 1) });
  if (isJson || c.req.header('accept')?.includes('application/json')) return c.json({ cart: cartData(cart.map((line) => ({ ...line }))).cart, notice: 'added_to_cart' });
  return c.redirect(`/products/${item.slug}?notice=added_to_cart`, 303);
});
app.post('/cart/items/:id', async (c) => {
  const input: any = await c.req.parseBody();
  const line = cart.find((entry) => entry.id === c.req.param('id'));
  if (line) line.quantity = Math.min(20, Math.max(1, Number(input.quantity)));
  return c.redirect('/cart', 303);
});
app.post('/cart/items/:id/remove', (c) => {
  cart = cart.filter((entry) => entry.id !== c.req.param('id'));
  return c.redirect('/cart', 303);
});
app.post('/checkout', (c) => c.redirect('/checkout/chk_card', 303));
app.get('/subscribe/:slug', (c) => {
  const item = plans.find((entry) => entry.slug === c.req.param('slug')) ?? null;
  return page(c, 'sf-subscribe', { item }, {}, item ? 200 : 404);
});
app.post('/subscribe/:slug', (c) => c.redirect(`/checkout/chk_${c.req.param('slug').includes('trial') ? 'subtrial' : 'subpaid'}`, 303));

// ----- Checkout pages -----
app.get('/checkout/:ref', async (c) => {
  const fake = checkout(c.req.param('ref'));
  if (!fake) return page(c, 'not-found', {}, {}, 404);
  const state = fake.project();
  if (['paid', 'partially_paid'].includes(String((state.session as any).status))) return c.redirect(`/checkout/${fake.ref}/complete`, 303);
  return page(c, 'sf-checkout', { state }, { user: fake.user, path: c.req.path });
});
app.get('/checkout/:ref/return', (c) => {
  const ref = c.req.param('ref');
  if (ref === 'chk_elsewhere') return page(c, 'return-elsewhere', {});
  return c.redirect(`/checkout/${ref}`, 303);
});
app.get('/checkout/:ref/complete', (c) => {
  const fake = checkout(c.req.param('ref'));
  if (!fake) return page(c, 'not-found', {}, {}, 404);
  const state = { ...fake.project(), subscription: fake.subscription ?? undefined } as any;
  const accountUrl = fake.user ? 'http://localhost:4200/orders/ord_fixture_1' : 'http://localhost:4200/sign-up?next=%2Forders%2Ford_fixture_1';
  return page(c, 'sf-complete', { state, paidSignal: c.req.query('signal') === '1', accountUrl }, { user: fake.user });
});
app.all('/checkout/:ref/*', async (c) => {
  const fake = checkout(c.req.param('ref'));
  if (!fake) return c.json({ error: { kind: 'not_found', code: 'NOT_FOUND', message_key: 'not_found' } }, 404);
  const name = new URL(c.req.url).pathname.replace(`/checkout/${fake.ref}/`, '');
  if (c.req.method !== 'GET') {
    if (c.req.header('x-csrf-token') !== CSRF) return c.json({ error: { kind: 'validation', code: 'CSRF_TOKEN_REJECTED', message_key: 'csrf_token_rejected' } }, 403);
  }
  const body = c.req.method === 'POST' ? await c.req.json().catch(() => ({})) : {};
  const reply = fake.handle(c.req.method, name, body);
  if (name === 'receipt' && fake.log.filter((entry) => entry.path === 'receipt').length > 1) {
    return c.json({ error: { kind: 'rate_limited', code: 'RECEIPT_JUST_SENT', message_key: 'receipt_just_sent' }, state: fake.project() }, 429);
  }
  return c.json(reply.body, reply.status as 200);
});

// ----- Identity pages -----
app.get('/sign-in', (c) => page(c, 'sign-in', { next: c.req.query('next') ?? '' }, { notices: c.req.query('notice') ? [c.req.query('notice')!] : [] }));
app.post('/sign-in', (c) => page(c, 'sign-in', { next: '' }, { error: { kind: 'validation', code: 'INVALID_SIGN_IN', message_key: 'invalid_sign_in' } }, 401));
app.get('/sign-up', (c) => page(c, 'sign-up', { next: c.req.query('next') ?? '' }));
app.post('/sign-up', (c) => page(c, 'sign-up', { next: '' }, { error: { kind: 'conflict', code: 'EMAIL_ALREADY_REGISTERED', message_key: 'email_already_registered' } }, 409));
app.get('/verify-email', (c) => {
  const sent = c.req.query('state') === 'sent';
  return page(c, 'verify-email', { next: '/', email: 'buyer@example.test', verification: sent ? { status: 'code_sent', sentAt: Date.now() } : null }, { user: { name: 'Test Buyer', email: 'buyer@example.test' } });
});
app.get('/fx/error', (c) => page(c, 'error', {}, { error: { kind: 'unavailable', code: 'X', message_key: 'generic_error', request_id: 'req_fixture' } }, 500));
app.get('/fx/cart-locked', (c) => page(c, 'sf-cart', { ...cartData([{ id: 'ln_locked', slug: 'house-blend', variant: 0, quantity: 1 }]), locked: true, checkoutRef: 'chk_waiting' }));
app.post('/__reset', (c) => {
  checkouts.clear();
  cart = [];
  return c.json({ ok: true });
});
app.get('/__log/:ref', (c) => {
  const fake = checkouts.get(c.req.param('ref'));
  return c.json({ log: fake?.log ?? [], payCount: fake?.payCount ?? 0, resumeCount: fake?.resumeCount ?? 0 });
});
app.get('/__health', (c) => c.text('ok'));
app.notFound((c) => page(c, 'not-found', {}, {}, 404));

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, () => {
  process.stdout.write(`local state server on ${ORIGIN}\n`);
});
