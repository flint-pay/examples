// LOCAL STATE HARNESS. Not the account app and not acceptance evidence.
//
// It serves the real views (renderPage) and the real public assets with canned fixture data, and
// answers the app's JSON routes with scripted responses so the frontend states can be checked
// offline: declines, 3-D Secure, lost responses, waiting, bank processing, and so on.
// Real behavior against a sandbox is proven by the staging acceptance suite, not here.

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { fileURLToPath } from 'node:url';
import { renderPage } from '../../../src/views/index.ts';
import { attempt, context, ids, pageContext, paymentPage, paymentState, usd } from './fixtures.ts';
import type { PageId } from '../../../src/views/index.ts';

const publicDir = fileURLToPath(new URL('../../../public', import.meta.url));
const port = Number(process.env.HARNESS_PORT ?? 4291);

type Scenario =
  | 'success'
  | 'decline_then_success'
  | 'requires_action'
  | 'reload_authenticate'
  | 'total_changed'
  | 'lost_response'
  | 'wait_then_done'
  | 'bank'
  | 'slow_submit'
  | 'decline_affirm'
  | 'affirm'
  | 'recovery'
  | 'stuck_waiting';

interface LogEntry {
  method: string;
  path: string;
  actionId: string | null;
  csrf: string | null;
  origin: string | null;
  body: unknown;
}

const harness = {
  scenario: 'success' as Scenario,
  submits: 0,
  attempts: 0,
  resumes: 0,
  statusPolls: 0,
  retryPolls: 0,
  log: [] as LogEntry[],
  card: 'activates' as 'activates' | 'fails' | 'never',
};

const clientAction = {
  account_id: 'acct_example_001',
  publishable_key: 'pk_test_example_001',
  payment_intent: { client_secret: 'pi_example_client_value', stripe_js_call: 'handle_next_action' },
};

function doneState(kind: 'done' | 'bank_processing' = 'done') {
  return paymentState({
    next: kind,
    attempt: attempt(kind === 'done' ? 'succeeded' : 'processing'),
    approved_outstanding_money: usd(0),
    order: { ...paymentState().order, settlement_amounts: { ...paymentState().order.settlement_amounts, outstanding_money: usd(0) } },
  });
}

function job(state: ReturnType<typeof paymentState>, extra: Record<string, unknown> = {}) {
  return { state, next: state.next, ...extra };
}

const app = new Hono();

app.use('/assets/*', serveStatic({ root: publicDir, rewriteRequestPath: (path) => path.replace(/^\/assets/, '') }));
app.use('/js/*', serveStatic({ root: publicDir }));

app.use('*', async (c, next) => {
  const path = c.req.path;
  const interesting = !path.startsWith('/assets/') && !path.startsWith('/js/') && !path.startsWith('/__') && path !== '/favicon.ico';
  if (interesting) {
    let body: unknown = null;
    if (c.req.method !== 'GET' && (c.req.header('content-type') ?? '').includes('json')) body = await c.req.raw.clone().json().catch(() => null);
    harness.log.push({
      method: c.req.method,
      path,
      actionId: c.req.header('x-action-id') ?? null,
      csrf: c.req.header('x-csrf-token') ?? null,
      origin: c.req.header('origin') ?? null,
      body,
    });
  }
  await next();
});

// ---- Harness control -------------------------------------------------------

app.post('/__harness/reset', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { scenario?: Scenario; card?: typeof harness.card };
  harness.scenario = body.scenario ?? 'success';
  harness.card = body.card ?? 'activates';
  harness.submits = 0;
  harness.attempts = 0;
  harness.resumes = 0;
  harness.statusPolls = 0;
  harness.retryPolls = 0;
  harness.log = [];
  return c.json({ ok: true });
});
app.get('/__harness/log', (c) => c.json(harness.log));

// ---- Static page rendering -------------------------------------------------

app.get('/__render/:pageId', (c) => {
  const pageId = c.req.param('pageId') as PageId;
  const variant = c.req.query('variant') ?? 'default';
  try {
    if (variant === 'xss') return c.html(renderPage('ac-home', xssContext()));
    const rendered = renderPage(pageId, pageContext(pageId, variant));
    return c.html(rendered);
  } catch (error) {
    return c.text(`render failed: ${error instanceof Error ? error.message : String(error)}`, 500);
  }
});

function xssContext() {
  const payload = '<img src=x onerror="window.__xss=1">';
  const ctx = pageContext('ac-home', 'default');
  ctx.user = { name: payload, email: 'avery@example.test' };
  ctx.storeName = `Cedar </title><script>window.__xss=1</script>`;
  ctx.notices = [{ key: 'receipt_sent', params: { email: payload } }];
  return ctx;
}

// ---- Payment pages and jobs ------------------------------------------------

for (const [root, kind, pageId] of [
  ['invoices', 'invoice', 'ac-invoice-pay'],
  ['returns', 'return', 'ac-return-pay'],
] as const) {
  const base = `/${root}/:id/pay`;

  app.get(base, (c) => {
    const variant = c.req.query('variant') ?? 'default';
    const ctx = pageContext(pageId, variant);
    if (variant === 'xss') {
      const page = paymentPage(kind, paymentState());
      page.data.buyer = { name: '</script><script>window.__xss=1</script>', email: 'avery@example.test' };
      return c.html(renderPage(pageId, page));
    }
    return c.html(renderPage(pageId, ctx));
  });

  app.get(`${base}/return`, (c) => c.html('<!doctype html><title>Done</title><main data-testid="harness-complete">Payment return route reached</main>'));

  app.post(`${base}/submit`, async (c) => {
    harness.submits += 1;
    const body = (await c.req.json().catch(() => ({}))) as { approved_outstanding_money?: { amount: string } };
    switch (harness.scenario) {
      case 'decline_then_success':
        if (harness.submits === 1) {
          return c.json(job(paymentState({ attempt: attempt('failed', { failure_code: 'incorrect_cvc' }), decline: { code: 'incorrect_cvc' }, next: 'new_payment' })));
        }
        return c.json(job(doneState()));
      case 'decline_affirm':
        if (harness.submits === 1) {
          return c.json(job(paymentState({ attempt: attempt('failed', { failure_code: 'payment_method_declined' }), decline: { code: 'payment_method_declined', payment_option: 'affirm' }, next: 'new_payment' })));
        }
        return c.json(job(doneState()));
      case 'requires_action':
        return c.json(job(paymentState({ next: 'authenticate', attempt: attempt('requires_action'), pending_action_id: 'pa_example_001' }), { client_action: clientAction }));
      case 'total_changed': {
        if (body.approved_outstanding_money?.amount === '13000') return c.json(job(doneState()));
        const state = paymentState({ approved_outstanding_money: usd(13000), total_changed: true, notices: ['total_changed'] });
        return c.json({ error: { kind: 'conflict', code: 'ORDER_CHANGED_REFRESH_REQUIRED', message_key: 'total_changed' }, state, next: state.next }, 409);
      }
      case 'lost_response':
        if (harness.submits === 1) return c.json({ error: { kind: 'unknown_outcome', code: 'UNKNOWN_PAYMENT_OUTCOME', message_key: 'unknown_outcome' } }, 503);
        return c.json(job(doneState()));
      case 'wait_then_done':
        return c.json(job(paymentState({ next: 'wait', attempt: attempt('processing') })));
      case 'stuck_waiting':
        return c.json(job(paymentState({ next: 'wait', attempt: attempt('processing') })));
      case 'bank':
        return c.json(job(doneState('bank_processing')));
      case 'slow_submit':
        await new Promise((resolve) => setTimeout(resolve, 700));
        return c.json(job(doneState()));
      default:
        return c.json(job(doneState()));
    }
  });

  app.post(`${base}/resume`, (c) => {
    harness.resumes += 1;
    if (harness.scenario === 'affirm' || harness.scenario === 'requires_action' || harness.scenario === 'reload_authenticate') return c.json(job(doneState()));
    return c.json(job(doneState()));
  });

  app.get(`${base}/attempt`, (c) => {
    harness.attempts += 1;
    switch (harness.scenario) {
      case 'wait_then_done':
        return c.json(harness.attempts <= 2 ? job(paymentState({ next: 'wait', attempt: attempt('processing') })) : job(doneState()));
      case 'stuck_waiting':
        return c.json(job(paymentState({ next: 'wait', attempt: attempt('processing') })));
      case 'lost_response':
        return c.json(job(doneState()));
      case 'recovery':
        return c.json(job(paymentState({ next: 'resume', attempt: attempt('requires_retry'), recovery_mode: true })));
      case 'reload_authenticate':
        return c.json(job(paymentState({ next: 'authenticate', attempt: attempt('requires_action'), pending_action_id: 'pa_example_001' }), { client_action: clientAction }));
      case 'affirm':
        return c.json(job(paymentState({ next: 'authenticate', attempt: attempt('requires_action', { legs: [{ payment_intent_id: 'pi_example_aff', status: 'open', amount_money: usd(12000), payment_option: 'affirm' }] }), pending_action_id: 'pa_example_aff', returned: true }), { client_action: clientAction }));
      default:
        return c.json(job(paymentState()));
    }
  });

  app.post(`${base}/cancel-attempt`, (c) => c.json(job(paymentState({ attempt: attempt('canceled'), next: 'new_payment' }))));
}

// ---- Card setup ------------------------------------------------------------

app.post('/payment-methods/new/setup', (c) =>
  c.json({
    payment_method: { payment_method_id: ids.method, status: 'pending' },
    client_setup: { stripe: { account_id: 'acct_example_001', publishable_key: 'pk_test_example_001', setup_intent: { client_secret: 'seti_example_client_value', stripe_js_call: 'confirm_setup' } } },
  }),
);
app.post('/payment-methods/new/confirm', (c) => c.json({ payment_method: { payment_method_id: ids.method, status: 'pending' } }));
app.get('/payment-methods/:id/status', (c) => {
  harness.statusPolls += 1;
  const status = harness.card === 'fails' ? 'failed' : harness.card === 'never' ? 'pending' : harness.statusPolls >= 3 ? 'active' : 'pending';
  return c.json({ payment_method: { payment_method_id: c.req.param('id'), status } });
});
app.get('/payment-methods/new/return', (c) => c.html('<!doctype html><title>Done</title><main data-testid="harness-complete">Card return route reached</main>'));

// ---- Email preferences -----------------------------------------------------

app.post('/email-preferences/lookup', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { token?: string };
  if (body.token === 'tok_valid') return c.json({ link: { email: 'avery@example.test', email_preference: 'shipping_updates', enabled: true } });
  if (body.token === 'tok_off') return c.json({ link: { email: 'avery@example.test', email_preference: 'checkout_reminders', enabled: false } });
  if (body.token === 'tok_flaky') return c.json({ error: { kind: 'unavailable', code: 'UNAVAILABLE' } }, 503);
  return c.json({ error: { kind: 'not_found', code: 'EMAIL_PREFERENCE_LINK_INVALID', message_key: 'email_preference_link_invalid' } }, 404);
});
app.post('/email-preferences/unsubscribe', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { token?: string };
  if (body.token === 'tok_valid') return c.json({ link: { email: 'avery@example.test', email_preference: 'shipping_updates', enabled: false } });
  return c.json({ error: { kind: 'not_found', code: 'EMAIL_PREFERENCE_LINK_INVALID' } }, 404);
});

// ---- Polling routes --------------------------------------------------------

app.get('/subscriptions/:id/retries/:retryId', (c) => {
  harness.retryPolls += 1;
  const status = harness.retryPolls >= 2 ? 'succeeded' : 'processing';
  return c.json({ retry: { subscription_payment_retry_id: c.req.param('retryId'), subscription_id: c.req.param('id'), status, created_at: '2026-10-07T15:04:00Z', updated_at: '2026-10-07T15:04:00Z' } });
});
app.get('/subscriptions/:id', (c) => {
  const requested = c.req.query('variant') ?? 'default';
  // After the scripted retry succeeds, a reload shows the finished state.
  const variant = c.req.query('retry') || (requested === 'retrying' && harness.retryPolls >= 2) ? 'retry_succeeded' : requested;
  return c.html(renderPage('ac-subscription', pageContext('ac-subscription', variant)));
});
app.get('/invoices/:id/status', (c) => {
  harness.statusPolls += 1;
  return c.json({ invoice: { invoice_id: c.req.param('id'), status: harness.statusPolls >= 2 ? 'paid' : 'open' } });
});
app.get('/invoices/:id', (c) => c.html(renderPage('ac-invoice', pageContext('ac-invoice', c.req.query('variant') ?? 'paid'))));

app.get('/', (c) => c.html(renderPage('ac-home', context(pageContext('ac-home').data))));
app.post('/sign-out', (c) => c.html('<!doctype html><title>Signed out</title><main data-testid="harness-signed-out">Signed out</main>'));
app.notFound((c) => c.text('harness: no route', 404));

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
  console.log(`local state harness on http://127.0.0.1:${port}`);
});
