import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Driver } from '../../support/driver.ts';
import { crossApp } from '../../scenarios/cross-app.ts';

function isolationHarness(t: TestContext, collision = false) {
  const run = '20000101T000000Z-00000000', order = 'ord_UNIT_FOREIGN_FAKE';
  const key = `fx-${run}-same-key-two-sandboxes`;
  const reads: string[] = [], tracked: { sandbox: string; id: string }[] = [];
  const requests: { sandbox: string; body: unknown; key: string }[] = [];
  const journals: { sandbox: string; args: unknown[]; key: string }[] = [];
  const foreign = async (resource: string, id: string) => {
    reads.push(`${resource}:${id}`); throw { status: 404 };
  };
  // The buyer SDK uses this injected transport; all merchant operations are local doubles.
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assert.equal(url.href, `https://api.staging.withflintpay.com/v1/me/orders/${order}`);
    assert.equal(init?.method, 'GET'); reads.push(`buyer-order:${order}`);
    return new Response(JSON.stringify({ error: { type: 'not_found', code: 'ORDER_NOT_FOUND', message: 'Synthetic foreign order' } }), { status: 404, headers: { 'content-type': 'application/json' } });
  });
  const driver = {
    config: { run, apiOrigin: 'https://api.staging.withflintpay.com' },
    created: new Map([['guestCardOrder', order], ['invoice', 'inv_UNIT_FOREIGN_FAKE']]),
    fixtures: { values: {}, buyers: { b1: { customerId: 'cus_UNIT_A_FAKE' }, b1b: { customerId: 'cus_UNIT_B_FAKE' } } },
    operator: {
      clients: {
        clients: { B: {
          orders: { get: (id: string) => foreign('order', id) },
          customers: { get: (id: string) => foreign('customer', id) },
          invoices: { get: (id: string) => foreign('invoice', id) },
        } },
        writable: async (sandbox: string) => ({ orders: { createWithResponse: async (body: unknown, options: { idempotencyKey: string }) => {
          requests.push({ sandbox, body: structuredClone(body), key: options.idempotencyKey });
          return { body: { data: { order_id: `ord_UNIT_${collision ? 'COLLISION' : sandbox}_FAKE` } }, meta: { requestId: `req_UNIT_${sandbox}` } };
        } } }),
      },
      execute: async (step: { sandbox: string; operation: string; args: unknown[] }) => {
        assert.equal(step.sandbox, 'B'); assert.equal(step.operation, 'customerSessions.create');
        assert.deepEqual(step.args, [{ customer_id: 'cus_UNIT_B_FAKE', expires_in_seconds: '300' }]);
        return { data: { secret: 'flint_cses_UNIT_B_FAKE' } };
      },
      ledger: { action: async <T>(name: string, sandbox: string, operation: string, args: unknown[], send: (key: string) => Promise<T>, reconcile: (result: T) => Promise<void>, suppliedKey: string) => {
        assert.equal(name, 'cross-sandbox-key'); assert.equal(operation, 'orders.create');
        journals.push({ sandbox, args, key: suppliedKey });
        const result = await send(suppliedKey); await reconcile(result); return result;
      } },
    },
    trackOrder: async (sandbox: string, id: string) => { tracked.push({ sandbox, id }); },
  } as unknown as Driver;
  return { driver, key, reads, tracked, requests, journals };
}

test('I-01 declares fixture taxability and preserves resource and cross-sandbox idempotency isolation', async t => {
  const h = isolationHarness(t);
  assert.deepEqual(await crossApp['I-01'](h.driver), ['SANDBOX_BUYER_RESOURCE_AND_IDEMPOTENCY_ISOLATION']);
  assert.deepEqual(h.reads, ['order:ord_UNIT_FOREIGN_FAKE', 'customer:cus_UNIT_A_FAKE', 'invoice:inv_UNIT_FOREIGN_FAKE', 'buyer-order:ord_UNIT_FOREIGN_FAKE']);
  assert.deepEqual(h.requests, ['A', 'B'].map(sandbox => ({ sandbox, key: h.key, body: {
    external_reference_id: h.key,
    line_items: [{ name: 'Isolation acceptance service', quantity: '1', unit_price_money: { amount: '100', currency: 'USD' }, fulfillment: { requirement: 'none' }, tax: { taxable: true } }],
  } })));
  assert.equal(h.journals.length, 2); assert.equal(h.journals[0].args, h.journals[1].args);
  for (const entry of h.journals) {
    assert.equal(entry.key, h.key);
    assert.deepEqual(entry.args, [h.requests.find(request => request.sandbox === entry.sandbox)!.body]);
  }
  assert.deepEqual(h.tracked, [{ sandbox: 'A', id: 'ord_UNIT_A_FAKE' }, { sandbox: 'B', id: 'ord_UNIT_B_FAKE' }]);
});

test('I-01 rejects a cross-sandbox order ID collision after tracking both creations', async t => {
  const h = isolationHarness(t, true);
  await assert.rejects(() => crossApp['I-01'](h.driver), { code: 'IDEMPOTENCY_CROSS_SANDBOX_COLLISION' });
  assert.deepEqual(h.tracked, [{ sandbox: 'A', id: 'ord_UNIT_COLLISION_FAKE' }, { sandbox: 'B', id: 'ord_UNIT_COLLISION_FAKE' }]);
});
