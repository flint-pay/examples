import test from 'node:test';
import assert from 'node:assert/strict';
import { account, namedPlan } from '../../scenarios/account.ts';
import type { Driver } from '../../support/driver.ts';

function planHarness(plans?: Record<string, unknown>) {
  const calls: unknown[] = [];
  const driver = {
    fixtures: { values: { plans } },
    operator: { execute: async (step: unknown) => { calls.push(step); } },
  } as unknown as Driver;
  return { driver, calls };
}

test('an explicit empty deletion preparation executes no operator calls', async () => {
  const h = planHarness({ prepareDeletion: [] });
  await namedPlan(h.driver, 'prepareDeletion');
  assert.deepEqual(h.calls, []);
});

test('deletion preparation still requires an explicit array', async t => {
  const missing = planHarness({});
  await assert.rejects(namedPlan(missing.driver, 'prepareDeletion'), { code: 'OPERATOR_PLAN_REQUIRED' });
  assert.deepEqual(missing.calls, []);
  for (const value of [undefined, null, {}, 'steps', 1, false]) await t.test(String(value), async () => {
    const h = planHarness(value === undefined ? undefined : { prepareDeletion: value });
    await assert.rejects(namedPlan(h.driver, 'prepareDeletion'), { code: 'OPERATOR_PLAN_REQUIRED' });
    assert.deepEqual(h.calls, []);
  });
});

test('other named plans still reject empty arrays', async t => {
  for (const name of ['shipOrder', 'decideReturnAsExchange', 'makePastDue', 'unknownPlan']) await t.test(name, async () => {
    const h = planHarness({ [name]: [] });
    await assert.rejects(namedPlan(h.driver, name), { code: 'OPERATOR_PLAN_REQUIRED' });
    assert.deepEqual(h.calls, []);
  });
});

test('nonempty plans preserve step order and replace nested references', async t => {
  for (const name of ['prepareDeletion', 'shipOrder']) await t.test(name, async () => {
    const steps = [{ name: 'first', args: ['$customerId', { ids: ['$orderId', '$unbound'] }] }, { name: 'second', args: [] }];
    const h = planHarness({ [name]: steps });
    await namedPlan(h.driver, name, { customerId: 'cus_UNIT_PLACEHOLDER', orderId: 'ord_UNIT_PLACEHOLDER' });
    assert.deepEqual(h.calls, [{ name: 'first', args: ['cus_UNIT_PLACEHOLDER', { ids: ['ord_UNIT_PLACEHOLDER', '$unbound'] }] }, { name: 'second', args: [] }]);
    assert.equal(steps[0].args[0], '$customerId');
  });
});

test('AC-14 with empty preparation still approves, observes completion, and checks closed sign-in', async () => {
  type Buyer = 'b2' | 'd';
  const origin = 'https://account.example.invalid', events: string[] = [], calls: any[] = [];
  const buyers = {
    b2: { verified: true, customerId: 'cus_OTHER_PLACEHOLDER', email: 'other@example.invalid', password: 'UNIT_PASSWORD_PLACEHOLDER' },
    d: { verified: true, customerId: 'cus_DELETION_PLACEHOLDER', email: 'deletion@example.invalid', password: 'UNIT_PASSWORD_PLACEHOLDER' },
  };
  const statuses = new Map<Buyer, string>();
  class Locator {
    readonly buyer: Buyer; readonly id: string;
    constructor(buyer: Buyer, id: string) { this.buyer = buyer; this.id = id; }
    first() { return this; }
    async click() { events.push(`${this.buyer}:click:${this.id}`); }
    async _expect(expression: string, options: { expectedText: { string: string }[]; expressionArg?: string }) {
      let received: string;
      if (this.id === 'ac-deletion-status') {
        assert.equal(expression, 'to.have.attribute.value'); assert.equal(options.expressionArg, 'data-state');
        received = statuses.get(this.buyer)!; events.push(`${this.buyer}:status:${received}`);
      } else {
        assert.equal(this.id, 'alert'); assert.equal(expression, 'to.have.text');
        assert.equal(this.buyer, 'd'); assert.equal(statuses.get('d'), 'completed');
        assert.ok(events.includes('d:form:/sign-in'));
        received = 'This account is closed'; events.push('d:closed-sign-in');
      }
      return { matches: received.includes(options.expectedText[0].string), received, log: [] };
    }
  }
  const page = (buyer: Buyer) => ({
    buyer,
    getByTestId: (id: string) => { assert.ok(['ac-deletion-request', 'ac-deletion-status'].includes(id)); return new Locator(buyer, id); },
    getByRole: (role: string) => {
      if (role === 'alert') return new Locator(buyer, 'alert');
      assert.equal(role, 'dialog');
      return { getByRole: (child: string, options: { name: RegExp }) => { assert.equal(child, 'button'); assert.ok(options.name.test('Request')); return new Locator(buyer, 'dialog-request'); } };
    },
    reload: async () => { events.push(`${buyer}:reload`); },
  });
  type Page = ReturnType<typeof page>;
  const driver = {
    fixtures: { buyers, values: { plans: { prepareDeletion: [] } } },
    config: { origins: { accountA: origin } },
    page: async (buyer: Buyer) => page(buyer),
    login: async (_page: Page, buyer: Buyer) => { events.push(`${buyer}:login`); },
    requireOwned: (sandbox: string, id: string) => { assert.equal(sandbox, 'A'); assert.ok(Object.values(buyers).some(buyer => buyer.customerId === id)); },
    goto: async (p: Page, appOrigin: string, path: string) => { assert.equal(appOrigin, origin); assert.ok(['/privacy', '/sign-in'].includes(path)); events.push(`${p.buyer}:goto:${path}`); },
    job: async (p: Page, path: string) => { assert.equal(path, '/privacy/deletion-request'); events.push(`${p.buyer}:request`); return { body: { request: { status: 'pending_review', customer_deletion_request_id: `cdr_${p.buyer}_PLACEHOLDER` } } }; },
    track: async (sandbox: string, type: string, id: string, purpose: string) => { assert.equal(sandbox, 'A'); assert.equal(type, 'deletion_request'); assert.ok(id.startsWith('cdr_')); assert.equal(purpose, 'review'); },
    operator: { execute: async (step: any) => {
      calls.push(step); assert.equal(step.operation, 'customerDeletionRequests.resolve');
      const buyer: Buyer = step.name === 'delete-d-decision' ? 'd' : 'b2';
      assert.deepEqual(step.args, [`cdr_${buyer}_PLACEHOLDER`, { decision: buyer === 'd' ? 'approve' : 'reject' }]);
      statuses.set(buyer, buyer === 'd' ? 'completed' : 'rejected'); events.push(`${buyer}:decision:${step.args[1].decision}`);
    } },
    form: async (p: Page, path: string, values?: unknown) => {
      assert.equal(p.buyer, 'd'); assert.ok(['/sign-out', '/sign-in'].includes(path));
      if (path === '/sign-in') assert.deepEqual(values, { email: buyers.d.email, password: buyers.d.password });
      events.push(`d:form:${path}`);
    },
  } as unknown as Driver;
  assert.deepEqual(await account['AC-14'](driver), ['DELETION_PENDING_DUPLICATE_REJECT_APPROVE_CLOSED']);
  assert.deepEqual(calls.map(step => step.name), ['delete-b2-decision', 'delete-d-decision']);
  for (const buyer of ['b2', 'd']) assert.equal(events.filter(event => event === `${buyer}:request`).length, 2);
  assert.deepEqual(events.filter(event => /decision|status|form|closed-sign-in/.test(event)), ['b2:decision:reject', 'b2:status:rejected', 'd:decision:approve', 'd:status:completed', 'd:form:/sign-out', 'd:form:/sign-in', 'd:closed-sign-in']);
});
