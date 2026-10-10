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

type DeletionRead = { customer_deletion_request_id: string; customer_id: string; status: string; resolved_at?: string };
const completedDeletion = (overrides: Partial<DeletionRead> = {}): DeletionRead => ({ customer_deletion_request_id: 'cdr_d_PLACEHOLDER', customer_id: 'cus_DELETION_PLACEHOLDER', status: 'completed', resolved_at: '2000-01-01T00:00:00Z', ...overrides });

function deletionHarness(reads: DeletionRead[]) {
  type Buyer = 'b2' | 'd';
  const origin = 'https://account.example.invalid', events: string[] = [], calls: any[] = [], pollContinued = new Error('DELETION_COMPLETION_POLL_RETRIED');
  const buyers = {
    b2: { verified: true, customerId: 'cus_OTHER_PLACEHOLDER', email: 'other@example.invalid', password: 'UNIT_PASSWORD_PLACEHOLDER' },
    d: { verified: true, customerId: 'cus_DELETION_PLACEHOLDER', email: 'deletion@example.invalid', password: 'UNIT_PASSWORD_PLACEHOLDER' },
  };
  const statuses = new Map<Buyer, string>(), urls = new Map<Buyer, string>();
  let remoteSessionRevoked = false, localVault = true, localClosed = false, signInAttempts = 0, publicReads = 0, alert = '';
  class Locator {
    readonly buyer: Buyer; readonly id: string;
    constructor(buyer: Buyer, id: string) { this.buyer = buyer; this.id = id; }
    first() { return this; }
    async click() { events.push(`${this.buyer}:click:${this.id}`); }
    async _expect(expression: string, options: { expectedText: { string: string }[]; expressionArg?: string }) {
      let received: string;
      if (this.id === 'ac-deletion-status') {
        assert.equal(this.buyer, 'b2', 'approval revokes access to authenticated deletion UI');
        assert.equal(expression, 'to.have.attribute.value'); assert.equal(options.expressionArg, 'data-state');
        received = statuses.get(this.buyer)!; events.push(`${this.buyer}:status:${received}`);
      } else {
        assert.equal(this.id, 'alert'); assert.equal(expression, 'to.have.text');
        assert.equal(this.buyer, 'd'); assert.equal(localClosed, true); assert.equal(signInAttempts, 2);
        received = alert; events.push('d:closed-sign-in');
      }
      return { matches: received.includes(options.expectedText[0].string), received, log: [] };
    }
  }
  const page = (buyer: Buyer) => ({
    buyer,
    url: () => urls.get(buyer)!,
    getByTestId: (id: string) => { assert.ok(['ac-deletion-request', 'ac-deletion-status'].includes(id)); return new Locator(buyer, id); },
    getByRole: (role: string) => {
      if (role === 'alert') return new Locator(buyer, 'alert');
      assert.equal(role, 'dialog');
      return { getByRole: (child: string, options: { name: RegExp }) => { assert.equal(child, 'button'); assert.ok(options.name.test('Request')); return new Locator(buyer, 'dialog-request'); } };
    },
    reload: async () => {
      events.push(`${buyer}:reload`);
      if (buyer === 'd') {
        assert.equal(remoteSessionRevoked, true); assert.equal(statuses.get('d'), 'completed');
        // The revoked customer credential clears the local vault and ends the app session.
        localVault = false; urls.set('d', `${origin}/sign-in?notice=session_ended&next=%2Fprivacy`); events.push('d:session-ended');
      }
    },
  });
  type Page = ReturnType<typeof page>;
  const driver = {
    fixtures: { buyers, values: { plans: { prepareDeletion: [] } } },
    config: { origins: { accountA: origin } },
    page: async (buyer: Buyer) => page(buyer),
    login: async (_page: Page, buyer: Buyer) => { urls.set(buyer, `${origin}/`); events.push(`${buyer}:login`); },
    requireOwned: (sandbox: string, id: string) => { assert.equal(sandbox, 'A'); assert.ok(Object.values(buyers).some(buyer => buyer.customerId === id)); },
    goto: async (p: Page, appOrigin: string, path: string) => { assert.equal(appOrigin, origin); assert.equal(path, '/privacy'); urls.set(p.buyer, `${origin}${path}`); events.push(`${p.buyer}:goto:${path}`); },
    job: async (p: Page, path: string) => { assert.equal(path, '/privacy/deletion-request'); events.push(`${p.buyer}:request`); return { body: { request: { status: 'pending_review', customer_deletion_request_id: `cdr_${p.buyer}_PLACEHOLDER` } } }; },
    track: async (sandbox: string, type: string, id: string, purpose: string) => { assert.equal(sandbox, 'A'); assert.equal(type, 'deletion_request'); assert.ok(id.startsWith('cdr_')); assert.equal(purpose, 'review'); },
    operator: {
      execute: async (step: any) => {
        calls.push(step); assert.equal(step.operation, 'customerDeletionRequests.resolve');
        const buyer: Buyer = step.name === 'delete-d-decision' ? 'd' : 'b2';
        assert.deepEqual(step.args, [`cdr_${buyer}_PLACEHOLDER`, { decision: buyer === 'd' ? 'approve' : 'reject' }]);
        statuses.set(buyer, buyer === 'd' ? 'processing' : 'rejected');
        if (buyer === 'd') remoteSessionRevoked = true;
        events.push(`${buyer}:decision:${step.args[1].decision}`);
      },
      clients: { clients: { A: { customers: { getDeletionRequest: async (customerId: string, requestId: string) => {
        assert.equal(customerId, buyers.d.customerId); assert.equal(requestId, 'cdr_d_PLACEHOLDER');
        assert.equal(remoteSessionRevoked, true); assert.equal(localVault, true); assert.equal(signInAttempts, 0);
        const value = reads[publicReads++];
        if (!value) throw pollContinued;
        statuses.set('d', value.status); events.push(`d:public-status:${value.status}`); return value;
      } } } } },
    },
    form: async (p: Page, path: string, values?: unknown) => {
      assert.equal(p.buyer, 'd'); assert.equal(path, '/sign-in'); assert.equal(new URL(p.url()).pathname, '/sign-in');
      assert.deepEqual(values, { email: buyers.d.email, password: buyers.d.password });
      events.push(`d:form:${path}`);
      signInAttempts++;
      if (!localClosed) {
        assert.equal(localVault, false); assert.equal(remoteSessionRevoked, true); assert.equal(statuses.get('d'), 'completed');
        // Sign-in reaches the protected next page; replacement-session failure discovers completed deletion.
        localClosed = true; alert = 'Your session ended. Sign in again to continue.'; events.push('d:closure-reconciled');
      } else alert = 'This account was closed.';
      urls.set('d', `${origin}/sign-in?notice=session_ended&next=%2Fprivacy`);
    },
  } as unknown as Driver;
  return { driver, events, calls, pollContinued, publicReads: () => publicReads };
}

test('AC-14 waits for public completion after revocation and checks closed sign-in through lazy reconciliation', async () => {
  const h = deletionHarness([completedDeletion({ status: 'processing', resolved_at: undefined }), completedDeletion()]);
  assert.deepEqual(await account['AC-14'](h.driver), ['DELETION_PENDING_DUPLICATE_REJECT_APPROVE_CLOSED']);
  assert.deepEqual(h.calls.map(step => step.name), ['delete-b2-decision', 'delete-d-decision']);
  for (const buyer of ['b2', 'd']) assert.equal(h.events.filter(event => event === `${buyer}:request`).length, 2);
  assert.equal(h.publicReads(), 2);
  assert.deepEqual(h.events.filter(event => /decision|status|session-ended|form|closure-reconciled|closed-sign-in/.test(event)), [
    'b2:decision:reject', 'b2:status:rejected', 'd:decision:approve', 'd:public-status:processing', 'd:public-status:completed',
    'd:session-ended', 'd:form:/sign-in', 'd:closure-reconciled', 'd:form:/sign-in', 'd:closed-sign-in',
  ]);
});

test('AC-14 never advances closure checks for a mismatched or unfinished public deletion', async t => {
  const cases = [
    { name: 'another request', value: completedDeletion({ customer_deletion_request_id: 'cdr_OTHER_PLACEHOLDER' }) },
    { name: 'another customer', value: completedDeletion({ customer_id: 'cus_OTHER_PLACEHOLDER' }) },
    { name: 'pending review', value: completedDeletion({ status: 'pending_review' }) },
    { name: 'processing', value: completedDeletion({ status: 'processing' }) },
    { name: 'missing resolution time', value: completedDeletion({ resolved_at: undefined }) },
    { name: 'empty resolution time', value: completedDeletion({ resolved_at: '' }) },
    { name: 'invalid resolution time', value: completedDeletion({ resolved_at: 'unfinished' }) },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const h = deletionHarness([item.value]);
    // A second getter call aborts the real poll, proving the first sample was rejected without a long timeout.
    await assert.rejects(account['AC-14'](h.driver), error => error === h.pollContinued);
    assert.equal(h.publicReads(), 2);
    assert.ok(!h.events.includes('d:reload')); assert.ok(!h.events.includes('d:form:/sign-in'));
    assert.ok(h.events.includes('b2:status:rejected'));
  });
});
