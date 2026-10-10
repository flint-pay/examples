import test from 'node:test';
import assert from 'node:assert/strict';
import { account } from '../../scenarios/account.ts';
import type { Driver } from '../../support/driver.ts';

type Attempt = { status: number; body: unknown };
function invoiceHarness(attempts: [Attempt, Attempt], launch: { reused?: boolean; orderId?: string } = {}, throughConflict = false) {
  const origin = 'https://account.example.invalid', invoiceId = 'inv_UNIT_PLACEHOLDER', orderId = 'ord_UNIT_PLACEHOLDER';
  const reads: string[] = [], nextStep = new Error('INVOICE_REUSE_ASSERTION_PASSED');
  let url = origin, reloads = 0, authorityRequests = 0, nextFixtureRequests = 0, conflictChecks = 0;
  const page = {
    goto: async (destination: string) => { url = destination; },
    url: () => url,
    reload: async () => { reloads++; },
    getByTestId: (id: string) => {
      assert.equal(id, 'ac-payment', 'the surface conflict state belongs to the shared payment region');
      return new class Locator {
        async _expect(expression: string, options: { expressionArg: string; expectedText: { string: string }[] }) {
          assert.equal(expression, 'to.have.attribute.value'); assert.equal(options.expressionArg, 'data-state');
          assert.equal(options.expectedText[0].string, 'surface_conflict'); conflictChecks++;
          return { matches: true, received: 'surface_conflict', log: [] };
        }
      }();
    },
  };
  const driver = {
    fixtures: { buyers: { b1: { verified: true, customerId: 'cus_UNIT_PLACEHOLDER', email: 'buyer@example.invalid' } } },
    config: { apiOrigin: 'https://api.staging.withflintpay.com', origins: { accountA: origin } },
    operator: {
      issueInvoice: async (name: string) => {
        if (name === 'idle-invoice') { nextFixtureRequests++; if (!throughConflict) throw nextStep; return { invoice_id: 'inv_IDLE_PLACEHOLDER', order_id: 'ord_IDLE_PLACEHOLDER' }; }
        if (name === 'conflict-invoice') { assert.equal(throughConflict, true); return { invoice_id: 'inv_CONFLICT_PLACEHOLDER', order_id: 'ord_CONFLICT_PLACEHOLDER' }; }
        assert.equal(name, 'acceptance-invoice'); return { invoice_id: invoiceId, order_id: orderId };
      },
      runDate: () => 0,
      execute: async (step: { name: string; operation: string; args: unknown[] }) => {
        if (step.operation === 'invoices.getOrCreateCheckoutSession') {
          assert.equal(throughConflict, true);
          const kind = step.name === 'idle-hosted' ? 'IDLE' : 'CONFLICT';
          assert.deepEqual(step.args, [`inv_${kind}_PLACEHOLDER`, { surface: 'hosted' }]);
          return { data: { checkout_session: { checkout_session_id: `cs_${kind}_HOSTED_PLACEHOLDER`, order_id: `ord_${kind}_PLACEHOLDER`, surface: 'hosted' }, checkout_access: { checkout_auth_token: 'UNIT_CHECKOUT_TOKEN_PLACEHOLDER' } } };
        }
        assert.equal(step.operation, 'customerSessions.create'); authorityRequests++;
        return { data: { secret: 'UNIT_CUSTOMER_TOKEN_PLACEHOLDER' } };
      },
      ledger: { action: async (name: string, sandbox: string, operation: string, _args: unknown, _send: unknown, observe: (response: unknown) => Promise<void>) => {
        if (name === 'idle-embedded-replace') {
          assert.equal(throughConflict, true); assert.equal(operation, 'me.createInvoiceCheckoutSession');
          const response = { reused_existing: false, checkout_session: { checkout_session_id: 'cs_IDLE_EMBEDDED_PLACEHOLDER', order_id: 'ord_IDLE_PLACEHOLDER', surface: 'embedded' } };
          await observe(response); return response;
        }
        if (name === 'conflict-hosted-pay') {
          assert.equal(throughConflict, true); assert.equal(operation, 'orders.pay-checkout');
          const response = { payment_attempt: { status: 'requires_action' } }; await observe(response); return response;
        }
        assert.equal(name, 'invoice-reuse'); assert.equal(sandbox, 'A'); assert.equal(operation, 'me.createInvoiceCheckoutSession');
        const response = { reused_existing: launch.reused ?? true, checkout_session: { checkout_session_id: 'cs_UNIT_PLACEHOLDER', order_id: launch.orderId ?? orderId } };
        await observe(response); return response;
      } },
    },
    track: async (sandbox: string, type: string, id: string) => { assert.equal(sandbox, 'A'); assert.equal(type, 'checkout_session'); assert.ok(['cs_UNIT_PLACEHOLDER', ...(throughConflict ? ['cs_IDLE_EMBEDDED_PLACEHOLDER'] : [])].includes(id)); },
    trackOrder: async (sandbox: string, id: string) => { assert.equal(sandbox, 'A'); assert.ok([launch.orderId ?? orderId, ...(throughConflict ? ['ord_IDLE_PLACEHOLDER', 'ord_CONFLICT_PLACEHOLDER'] : [])].includes(id)); },
    requireOwned: (sandbox: string, id: string) => { assert.equal(sandbox, 'A'); assert.equal(id, invoiceId); assert.equal(conflictChecks, 1); throw nextStep; },
    email: async () => ({}),
    emailLink: () => `${origin}/invoices/${invoiceId}`,
    page: async () => page,
    login: async () => {},
    goto: async (_page: unknown, appOrigin: string, path: string) => {
      assert.equal(appOrigin, origin); assert.ok([`/invoices/${invoiceId}/pay`, ...(throughConflict ? ['/invoices/inv_CONFLICT_PLACEHOLDER/pay'] : [])].includes(path)); url = `${appOrigin}${path}`;
    },
    job: async (_page: unknown, path: string) => {
      assert.equal(path, `/invoices/${invoiceId}/pay/attempt`);
      assert.equal(reloads, reads.length); return attempts[reads.push(path) - 1];
    },
  } as unknown as Driver;
  return { driver, reads, nextStep, authorityRequests: () => authorityRequests, nextFixtureRequests: () => nextFixtureRequests, conflictChecks: () => conflictChecks };
}
const attempt = (orderNumber: unknown): Attempt => ({ status: 200, body: { state: { order: { order_number: orderNumber } } } });

test('AC-05 rejects two NOT_FOUND attempt reads before requesting buyer authority', async () => {
  const notFound = { status: 404, body: { error: { code: 'NOT_FOUND' } } };
  const h = invoiceHarness([notFound, notFound]);
  await assert.rejects(account['AC-05'](h.driver), { code: 'INVOICE_RELAUNCH_READ_FAILED' });
  assert.equal(h.reads.length, 2); assert.equal(h.authorityRequests(), 0);
});

test('AC-05 requires successful reads with populated matching projected order numbers', async t => {
  const valid = attempt('ORDER_UNIT_PLACEHOLDER');
  const cases: { name: string; attempts: [Attempt, Attempt]; code: string }[] = [
    { name: 'first read failed with an order body', attempts: [{ ...valid, status: 404 }, valid], code: 'INVOICE_RELAUNCH_READ_FAILED' },
    { name: 'second read failed with an order body', attempts: [valid, { ...valid, status: 404 }], code: 'INVOICE_RELAUNCH_READ_FAILED' },
    { name: 'both numbers missing', attempts: [attempt(undefined), attempt(undefined)], code: 'INVOICE_RELAUNCH_ORDER_MISSING' },
    { name: 'first number empty', attempts: [attempt(''), valid], code: 'INVOICE_RELAUNCH_ORDER_MISSING' },
    { name: 'second number empty', attempts: [valid, attempt('')], code: 'INVOICE_RELAUNCH_ORDER_MISSING' },
    { name: 'both numbers numeric', attempts: [attempt(123), attempt(123)], code: 'INVOICE_RELAUNCH_ORDER_MISSING' },
    { name: 'order changed', attempts: [valid, attempt('ORDER_OTHER_PLACEHOLDER')], code: 'INVOICE_RELAUNCH_CHANGED_ORDER' },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const h = invoiceHarness(item.attempts);
    await assert.rejects(account['AC-05'](h.driver), { code: item.code });
    assert.equal(h.reads.length, 2); assert.equal(h.authorityRequests(), 0);
  });
  await t.test('same projected order and reused checkout advance without a browser order ID', async () => {
    const h = invoiceHarness([valid, valid]);
    await assert.rejects(account['AC-05'](h.driver), error => error === h.nextStep);
    assert.equal(h.reads.length, 2); assert.equal(h.authorityRequests(), 1);
    assert.equal(h.nextFixtureRequests(), 1);
  });
});

test('AC-05 still requires checkout reuse and the invoice exact order ID', async t => {
  const valid = attempt('ORDER_UNIT_PLACEHOLDER');
  for (const item of [
    { name: 'a fresh checkout is not reuse', launch: { reused: false }, code: 'INVOICE_SESSION_NOT_REUSED' },
    { name: 'a reused checkout for another order is rejected', launch: { orderId: 'ord_OTHER_PLACEHOLDER' }, code: 'INVOICE_RELAUNCH_CHANGED_ORDER' },
  ]) await t.test(item.name, async () => {
    const h = invoiceHarness([valid, valid], item.launch);
    await assert.rejects(account['AC-05'](h.driver), { code: item.code });
    assert.equal(h.reads.length, 2); assert.equal(h.authorityRequests(), 1); assert.equal(h.nextFixtureRequests(), 0);
  });
});

test('AC-05 observes hosted surface conflict on the shared payment region', async t => {
  const valid = attempt('ORDER_UNIT_PLACEHOLDER'), h = invoiceHarness([valid, valid], {}, true);
  const zero = { amount: '0', currency: 'USD' }, total = { amount: '12000', currency: 'USD' };
  let publicReads = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assert.equal(url.origin, 'https://api.staging.withflintpay.com'); assert.equal(url.pathname, '/v1/orders/ord_CONFLICT_PLACEHOLDER'); assert.equal(init?.method, 'GET');
    publicReads++;
    return Response.json({ data: {
      order_id: 'ord_CONFLICT_PLACEHOLDER', buyer_actions: [], status: 'open', payment_status: 'unpaid', refund_status: 'none', line_items: [],
      pricing_amounts: { charge_money: zero, discount_money: zero, requested_tip_money: zero, subtotal_money: total, tax_money: zero, total_money: total },
      settlement_amounts: { balance_money: total, outstanding_money: total, paid_money: zero, credit_money: zero, net_collected_money: zero, refunded_money: zero, settled_tip_money: zero },
      tax: { enabled: false, mode: 'external', status: 'not_required', taxability_reason: 'tax_disabled' },
    } });
  });
  await assert.rejects(account['AC-05'](h.driver), error => error === h.nextStep);
  assert.equal(publicReads, 1); assert.equal(h.conflictChecks(), 1);
});
