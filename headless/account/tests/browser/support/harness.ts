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
import { securityHeaders } from '../../../src/security/headers.ts';
import { CHALLENGE_ORIGIN, FAKE_PROOF, challengeCodes, frameUrl, sessionIdFor, sessionTag, type ChallengeCode } from './challenge.ts';
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
  /** The gift cards on the order the fake app holds: none, a partial one, or one that pays everything. */
  gift: 'none' as 'none' | 'partial' | 'full' | 'removed',
  /** One notice the next pay page shows, as the app's flash does after a redirect. */
  flash: null as string | null,
  challenges: new Map<string, { code: string; spec: ChallengeCode; used: boolean }>(),
  /**
   * An apply or remove whose outcome is unknown, held by the fake app the way the real one holds it.
   * It is matched by the code (apply) or the card (remove), never by the action ID.
   */
  unconfirmed: null as null | 'apply' | 'remove',
  pendingCode: '',
  /** The next remove of the card ends with an unknown outcome. */
  removeUnknown: false,
  /** False while a change is unresolved and the page cannot check it yet. */
  canCheck: true,
  challengeSeq: 0,
  challengePosts: 0,
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

// The app's own security headers, so the verification frame is checked under the real policy.
app.use('*', async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(securityHeaders({ giftChallengeOrigin: CHALLENGE_ORIGIN }))) c.header(name, value);
});

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
  const body = (await c.req.json().catch(() => ({}))) as { scenario?: Scenario; card?: typeof harness.card; removeUnknown?: boolean; canCheck?: boolean };
  harness.scenario = body.scenario ?? 'success';
  harness.card = body.card ?? 'activates';
  harness.submits = 0;
  harness.attempts = 0;
  harness.resumes = 0;
  harness.statusPolls = 0;
  harness.retryPolls = 0;
  harness.log = [];
  harness.gift = 'none';
  harness.flash = null;
  harness.challenges.clear();
  harness.unconfirmed = null;
  harness.pendingCode = '';
  harness.removeUnknown = Boolean(body.removeUnknown);
  harness.canCheck = body.canCheck !== false;
  harness.challengeSeq = 0;
  harness.challengePosts = 0;
  return c.json({ ok: true });
});
app.get('/__harness/log', (c) => c.json(harness.log));
app.get('/__harness/challenge', (c) => c.json({ posts: harness.challengePosts, gift: harness.gift, unconfirmed: harness.unconfirmed }));

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
    // After a gift card is applied or removed the page shows the order the fake app now holds.
    const recovery = !harness.unconfirmed ? null : !harness.canCheck ? 'gift_unconfirmed_wait' : harness.unconfirmed === 'apply' ? 'gift_unconfirmed_apply' : 'gift_unconfirmed_remove';
    const variant = c.req.query('variant') ?? recovery ?? (harness.gift === 'partial' ? 'gift_split' : harness.gift === 'full' ? 'gift_settlement' : harness.gift === 'removed' ? 'gift' : 'default');
    const ctx = pageContext(pageId, variant);
    if (harness.flash) {
      ctx.notices = [harness.flash];
      harness.flash = null;
    }
    if (variant === 'xss') {
      const page = paymentPage(kind, paymentState());
      page.data.buyer = { name: '</script><script>window.__xss=1</script>', email: 'avery@example.test' };
      return c.html(renderPage(pageId, page));
    }
    return c.html(renderPage(pageId, ctx));
  });

  app.get(`${base}/return`, (c) => c.html('<!doctype html><title>Done</title><main data-testid="harness-complete">Payment return route reached</main>'));

  // ---- Gift cards: apply, the verification retry, and remove ----
  const surfaceId = kind;
  const payPath = (id: string) => `/${root}/${id}/pay`;
  const refuse = (c: any, status: number, errorKind: string, code: string, messageKey: string) =>
    c.json({ error: { kind: errorKind, code, message_key: messageKey, request_id: 'req_example_001' } }, status);

  const issue = (c: any, code: string, spec: ChallengeCode, reason: 'proof_required' | 'proof_rejected' = 'proof_required') => {
    if (spec.apply === 'origin') return refuse(c, 409, 'conflict', 'GIFT_CARD_CHALLENGE_ORIGIN_REQUIRED', 'gift_challenge_origin_required');
    if (spec.apply === 'unavailable') return refuse(c, 503, 'unavailable', 'GIFT_CARD_CHALLENGE_UNAVAILABLE', 'gift_card_challenge_required');
    harness.challengeSeq += 1;
    const challengeId = `gch_${String(harness.challengeSeq).padStart(32, 'A')}`;
    harness.challenges.set(challengeId, { code, spec, used: false });
    return c.json({
      gift_challenge: {
        challenge_id: challengeId,
        url: frameUrl(spec),
        session_tag: sessionTag(challengeId, sessionIdFor(surfaceId)),
        reason,
        expires_in_seconds: spec.expires ?? 900,
      },
    });
  };

  app.post(`${base}/gift-card`, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { gift_card_code?: string };
    if (!c.req.header('x-action-id')) return refuse(c, 400, 'validation', 'INVALID_INPUT', 'generic_error');
    const code = String(body.gift_card_code ?? '').toUpperCase();
    const changeUnconfirmed = () => refuse(c, 409, 'conflict', 'GIFT_CARD_CHANGE_UNCONFIRMED', 'gift_card_change_unconfirmed');
    if (harness.unconfirmed === 'remove') return changeUnconfirmed();
    if (harness.unconfirmed === 'apply') {
      // The app replays the original request for the same code and ignores the action ID.
      if (code !== harness.pendingCode) return changeUnconfirmed();
      harness.unconfirmed = null;
      if (code === 'UNKNOWNCHALLENGE') return issue(c, code, { page: 'completed' });
      harness.gift = 'partial';
      harness.flash = 'gift_card_applied';
      return c.json({ redirect: payPath(c.req.param('id')!) });
    }
    if (code === 'PROXYAPPLY502' || code === 'PROXYAPPLY503') {
      // A proxy answers with its own page. The app may have processed the request, so it holds the change.
      harness.unconfirmed = 'apply';
      harness.pendingCode = code;
      return c.html('<!doctype html><title>Bad gateway</title><h1>Bad gateway</h1>', code.endsWith('502') ? 502 : 503);
    }
    if (code === 'UNKNOWNAPPLY' || code === 'UNKNOWNCHALLENGE') {
      harness.unconfirmed = 'apply';
      harness.pendingCode = code;
      return refuse(c, 503, 'unknown_outcome', 'UNKNOWN_OUTCOME', 'gift_challenge_unconfirmed');
    }
    const spec = challengeCodes[code];
    if (spec) return issue(c, code, spec);
    if (code !== 'GOODCARD' && code !== 'FULLCARD') return refuse(c, 404, 'validation', 'GIFT_CARD_UNAVAILABLE', 'gift_card_unavailable_pay');
    harness.gift = code === 'FULLCARD' ? 'full' : 'partial';
    harness.flash = 'gift_card_applied';
    return c.json({ redirect: payPath(c.req.param('id')!) });
  });

  /** The retry route. A proof works once, as it does at Flint. */
  app.post(`${base}/gift-card/challenge`, async (c) => {
    harness.challengePosts += 1;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (Object.keys(body).sort().join(',') !== 'challenge_id,gift_card_code,proof' || body.proof !== FAKE_PROOF) return refuse(c, 400, 'validation', 'INVALID_INPUT', 'generic_error');
    const challenge = harness.challenges.get(String(body.challenge_id));
    if (!challenge || challenge.used || String(body.gift_card_code).toUpperCase() !== challenge.code) return refuse(c, 409, 'conflict', 'GIFT_CHALLENGE_EXPIRED', 'gift_challenge_expired');
    challenge.used = true;
    switch (challenge.spec.retry) {
      case 'rejected':
        return issue(c, challenge.code, { page: 'completed' }, 'proof_rejected');
      case 'expired':
        return refuse(c, 409, 'conflict', 'GIFT_CHALLENGE_EXPIRED', 'gift_challenge_expired');
      case 'proxy502':
      case 'proxy503':
        harness.unconfirmed = 'apply';
        harness.pendingCode = challenge.code;
        return c.html('<!doctype html><title>Bad gateway</title><h1>Bad gateway</h1>', challenge.spec.retry === 'proxy502' ? 502 : 503);
      case 'origin':
        return refuse(c, 409, 'conflict', 'GIFT_CARD_CHALLENGE_ORIGIN_REQUIRED', 'gift_challenge_origin_required');
      case 'unavailable':
        return refuse(c, 503, 'unavailable', 'GIFT_CARD_CHALLENGE_UNAVAILABLE', 'gift_card_challenge_required');
      case 'unknown':
        return refuse(c, 503, 'unknown_outcome', 'UNKNOWN_OUTCOME', 'gift_challenge_unconfirmed');
      case 'stale':
        return refuse(c, 409, 'conflict', 'GIFT_CHALLENGE_ORDER_CHANGED', 'gift_card_apply_again_pay');
      case 'refused':
        return refuse(c, 404, 'validation', 'GIFT_CARD_UNAVAILABLE', 'gift_card_unavailable_pay');
      default:
        harness.gift = 'partial';
        harness.flash = 'gift_card_applied';
        return c.json({ redirect: payPath(c.req.param('id')!) });
    }
  });

  app.post(`${base}/gift-card/:giftCardId/remove`, async (c) => {
    if (harness.unconfirmed === 'apply') return c.redirect(payPath(c.req.param('id')!), 303);
    if (harness.removeUnknown && !harness.unconfirmed) {
      // The answer is lost. The page shows the recovery note and the card is still on the order.
      harness.removeUnknown = false;
      harness.unconfirmed = 'remove';
      return c.redirect(payPath(c.req.param('id')!), 303);
    }
    harness.unconfirmed = null;
    // The order still takes gift cards, so the section stays on the page without any.
    harness.gift = 'removed';
    harness.flash = 'gift_card_removed';
    return c.redirect(payPath(c.req.param('id')!), 303);
  });

  app.post(`${base}/submit`, async (c) => {
    harness.submits += 1;
    if (harness.unconfirmed) {
      // No payment starts while a gift card change is unresolved. The answer carries the current view.
      const state = pageContext(pageId, harness.unconfirmed === 'apply' ? 'gift_unconfirmed_apply' : 'gift_unconfirmed_remove').data.state;
      return c.json({ error: { kind: 'conflict', code: 'GIFT_CARD_CHANGE_UNCONFIRMED', message_key: 'gift_card_change_unconfirmed' }, state, next: state.next }, 409);
    }
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
