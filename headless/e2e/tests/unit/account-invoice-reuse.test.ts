import test from 'node:test';
import assert from 'node:assert/strict';
import { account } from '../../scenarios/account.ts';
import type { Driver } from '../../support/driver.ts';

type Attempt = { status: number; body: unknown };
function invoiceHarness(attempts: [Attempt, Attempt]) {
  const origin = 'https://account.example.invalid', invoiceId = 'inv_UNIT_PLACEHOLDER';
  const reads: string[] = [], nextStep = new Error('INVOICE_REUSE_ASSERTION_PASSED');
  let url = origin, reloads = 0, authorityRequests = 0;
  const page = {
    goto: async (destination: string) => { url = destination; },
    url: () => url,
    reload: async () => { reloads++; },
  };
  const driver = {
    fixtures: { buyers: { b1: { verified: true, customerId: 'cus_UNIT_PLACEHOLDER', email: 'buyer@example.invalid' } } },
    config: { origins: { accountA: origin } },
    operator: {
      issueInvoice: async () => ({ invoice_id: invoiceId }),
      runDate: () => 0,
      execute: async () => { authorityRequests++; throw nextStep; },
    },
    email: async () => ({}),
    emailLink: () => `${origin}/invoices/${invoiceId}`,
    page: async () => page,
    login: async () => {},
    goto: async (_page: unknown, appOrigin: string, path: string) => {
      assert.equal(appOrigin, origin); assert.equal(path, `/invoices/${invoiceId}/pay`); url = `${appOrigin}${path}`;
    },
    job: async (_page: unknown, path: string) => {
      assert.equal(path, `/invoices/${invoiceId}/pay/attempt`);
      assert.equal(reloads, reads.length); return attempts[reads.push(path) - 1];
    },
  } as unknown as Driver;
  return { driver, reads, nextStep, authorityRequests: () => authorityRequests };
}
const attempt = (orderId: unknown): Attempt => ({ status: 200, body: { state: { order: { order_id: orderId } } } });

test('AC-05 rejects two NOT_FOUND attempt reads before requesting buyer authority', async () => {
  const notFound = { status: 404, body: { error: { code: 'NOT_FOUND' } } };
  const h = invoiceHarness([notFound, notFound]);
  await assert.rejects(account['AC-05'](h.driver), { code: 'INVOICE_RELAUNCH_READ_FAILED' });
  assert.equal(h.reads.length, 2); assert.equal(h.authorityRequests(), 0);
});

test('AC-05 requires successful reads with populated matching order IDs', async t => {
  const valid = attempt('ord_UNIT_PLACEHOLDER');
  const cases: { name: string; attempts: [Attempt, Attempt]; code: string }[] = [
    { name: 'first read failed with an order body', attempts: [{ ...valid, status: 404 }, valid], code: 'INVOICE_RELAUNCH_READ_FAILED' },
    { name: 'second read failed with an order body', attempts: [valid, { ...valid, status: 404 }], code: 'INVOICE_RELAUNCH_READ_FAILED' },
    { name: 'both IDs missing', attempts: [attempt(undefined), attempt(undefined)], code: 'INVOICE_RELAUNCH_ORDER_MISSING' },
    { name: 'first ID empty', attempts: [attempt(''), valid], code: 'INVOICE_RELAUNCH_ORDER_MISSING' },
    { name: 'second ID empty', attempts: [valid, attempt('')], code: 'INVOICE_RELAUNCH_ORDER_MISSING' },
    { name: 'both IDs numeric', attempts: [attempt(123), attempt(123)], code: 'INVOICE_RELAUNCH_ORDER_MISSING' },
    { name: 'order changed', attempts: [valid, attempt('ord_OTHER_PLACEHOLDER')], code: 'INVOICE_RELAUNCH_CHANGED_ORDER' },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const h = invoiceHarness(item.attempts);
    await assert.rejects(account['AC-05'](h.driver), { code: item.code });
    assert.equal(h.reads.length, 2); assert.equal(h.authorityRequests(), 0);
  });
  await t.test('same populated order advances to the next assertion', async () => {
    const h = invoiceHarness([valid, valid]);
    await assert.rejects(account['AC-05'](h.driver), error => error === h.nextStep);
    assert.equal(h.reads.length, 2); assert.equal(h.authorityRequests(), 1);
  });
});
