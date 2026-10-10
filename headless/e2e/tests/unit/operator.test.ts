import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client,SdkError } from '@flintpay/node';
import type { CreateCheckoutSessionRequestInput, CreateInvoiceRequestInput, CreateOrderRequestInput, CreateSubscriptionPlanRequestInput, Invoice, InvoicePaymentPolicyInput, IssueInvoiceResult, Order, UpdateSubscriptionRequestInput } from '@flintpay/node';
import { Ledger } from '../../support/ledger.ts';
import { Operator, operations } from '../../support/operator.ts';
import type { VerifiedClients } from '../../support/sdk.ts';
import type { Fixtures, PlanStep } from '../../support/fixtures.ts';

const run = '20000101T000000Z-00000000';
const config = { pins: { A: { merchantId: 'mer_PLACEHOLDER', sandboxId: 'test_PLACEHOLDER_A' }, B: { merchantId: 'mer_PLACEHOLDER', sandboxId: 'test_PLACEHOLDER_B' } } };
async function setup(fn: (ledger: Ledger, dir: string) => Promise<void>) { const dir = await mkdtemp(join(tmpdir(), 'headless-operator-unit-')); try { await fn(new Ledger(join(dir, 'ledger.json'), run), dir); } finally { await rm(dir, { recursive: true, force: true }); } }
test('every operator method exists in the exact published SDK', () => {
  const client = new Client({ baseUrl: 'https://api.staging.withflintpay.com', apiKey: 'flint_test_PLACEHOLDER' });
  for (const operation of Object.keys(operations)) { const [resource, method] = operation.split('.'); assert.equal(typeof (client as any)[resource]?.[`${method}WithResponse`], 'function', operation); }
});

test('invoice fixture creates a taxed order before drafting and replays interrupted issue through the published SDK', async () => setup(async (ledger, dir) => {
  const zero = { amount: '0', currency: 'USD' }, subtotal = { amount: '12000', currency: 'USD' }, tax = { amount: '1065', currency: 'USD' }, total = { amount: '13065', currency: 'USD' };
  const order: Order = {
    order_id: 'ord_UNIT_FAKE', buyer_actions: [], status: 'open', payment_status: 'unpaid', refund_status: 'none',
    line_items: [{ order_line_item_id: 'oli_UNIT_FAKE', name: 'Acceptance service', quantity: '1', version: '1', refunded_quantity: '0', unit_price_money: subtotal, base_subtotal_money: subtotal, subtotal_money: subtotal, tax_money: tax, total_money: total, discount_money: zero, modifier_total_money: zero, refunded_money: zero }],
    pricing_amounts: { charge_money: zero, discount_money: zero, requested_tip_money: zero, subtotal_money: subtotal, tax_money: tax, total_money: total },
    settlement_amounts: { balance_money: total, outstanding_money: total, paid_money: zero, credit_money: zero, net_collected_money: zero, refunded_money: zero, settled_tip_money: zero },
    tax: { enabled: true, mode: 'automatic', status: 'calculated', taxability_reason: 'standard_rated' },
  };
  const invoice: Invoice = { invoice_id: 'inv_UNIT_FAKE', order_id: order.order_id, merchant_id: config.pins.A.merchantId, status: 'draft', version: '1', collection_block_status: 'none', credit_money: zero, currently_due_money: zero, outstanding_money: total, paid_money: zero, refunded_money: zero, refund_status: 'none', is_overdue: false, late_fees: [], reminders_paused: false };
  const orderInput: CreateOrderRequestInput = {
    customer_id: 'cus_UNIT_FAKE', line_items: [{ name: 'Acceptance service', quantity: '1', unit_price_money: subtotal, fulfillment: { requirement: 'none' }, tax: { taxable: true } }],
    tax: { enabled: true, location: { address_source: 'provided', address_type: 'billing_address', address: { line1: '11 Wall Street', city: 'New York', state: 'NY', postal_code: '10005', country: 'US' } } }, metadata: { e2e_run: run },
  };
  const invoiceInput: CreateInvoiceRequestInput = {
    order_id: order.order_id, collection: { mode: 'buyer_initiated', payment_policy: { enabled_payment_options: ['card'] } },
    payment_due: { type: 'absolute', due_at: '2000-01-15T00:00:00.000Z' }, recipient_email: 'buyer@example.invalid', metadata: { e2e_run: run },
  };
  const calls: { method: string; path: string; key: string | null; body: unknown }[] = [];
  let orderCreated = false, invoiceCreated = false, issueResponseLost = false;
  const client = new Client({ baseUrl: 'https://api.staging.withflintpay.com', apiKey: 'flint_test_PLACEHOLDER', maxAttempts: 1, transport: async (input, init) => {
    const path = new URL(String(input)).pathname, method = init!.method!, body = JSON.parse(String(init!.body)), key = new Headers(init!.headers).get('Idempotency-Key');
    calls.push({ method, path, key, body });
    const response = (data: Order | Invoice | IssueInvoiceResult) => Response.json({ data }, { headers: { 'X-Request-Id': 'req_UNIT_FAKE' } });
    if (method === 'POST' && path === '/v1/orders') {
      assert.deepEqual(body, { ...orderInput, line_items: [{ ...orderInput.line_items[0], quantity: 1, unit_price_money: { amount: 12000, currency: 'USD' } }] });
      assert.equal(orderCreated, false); orderCreated = true;
      return response(order);
    }
    if (method === 'POST' && path === '/v1/invoices') {
      assert.deepEqual(body, invoiceInput); assert.equal(orderCreated, true); assert.equal(invoiceCreated, false); invoiceCreated = true;
      assert.ok(ledger.state.resources.some(r => r.resource === order.order_id && r.type === 'order' && r.sandbox === 'A' && r.owned));
      return response(invoice);
    }
    if (method === 'PATCH' && path === `/v1/orders/${order.order_id}`) {
      assert.equal(invoiceCreated, true);
      return Response.json({ error: { type: 'conflict', code: 'INVOICE_LOCKED_ORDER_FINANCIALS', message: 'Financial fields cannot be changed while an active invoice owns collection. Void the invoice first.' } }, { status: 409 });
    }
    assert.equal(method, 'POST'); assert.equal(path, `/v1/invoices/${invoice.invoice_id}/issue`); assert.deepEqual(body, { delivery_mode: 'email' });
    assert.equal(invoiceCreated, true);
    if (!issueResponseLost) { issueResponseLost = true; throw new TypeError('Unit fixture lost the issue response'); }
    return response({ invoice: { ...invoice, status: 'open', version: '2' } });
  } });
  const clients = { config, writable: async () => client } as unknown as VerifiedClients;
  await assert.rejects(() => new Operator(clients, ledger, {} as Fixtures).issueInvoice('acceptance-invoice', 'cus_UNIT_FAKE', 'buyer@example.invalid'), error => {
    assert.ok(error instanceof SdkError); assert.equal(issueResponseLost, true, JSON.stringify(calls)); return true;
  });
  assert.equal(ledger.state.actions['A:acceptance-invoice-issue'].phase, 'unknown');
  const loaded = new Ledger(join(dir, 'ledger.json'), run); await loaded.load();
  const resumed = new Operator(clients, loaded, {} as Fixtures);
  assert.deepEqual(await resumed.issueInvoice('acceptance-invoice', 'cus_UNIT_FAKE', 'buyer@example.invalid'), invoice);
  assert.deepEqual(await resumed.issueInvoice('acceptance-invoice', 'cus_UNIT_FAKE', 'buyer@example.invalid'), invoice);
  assert.deepEqual(calls.map(c => c.path), ['/v1/orders', '/v1/invoices', `/v1/invoices/${invoice.invoice_id}/issue`, `/v1/invoices/${invoice.invoice_id}/issue`]);
  assert.ok(calls.every(c => c.key)); assert.equal(new Set(calls.map(c => c.key)).size, 3); assert.deepEqual(calls[2], calls[3]);
  assert.deepEqual(Object.values(loaded.state.actions).map(a => [a.operation, a.phase]), [['orders.create', 'known'], ['invoices.create', 'known'], ['invoices.issue', 'known']]);
  assert.deepEqual(loaded.state.resources.map(r => [r.type, r.resource, r.cleanup]), [['order', order.order_id, 'review'], ['order_line_item', 'oli_UNIT_FAKE', 'review'], ['invoice', invoice.invoice_id, 'invoice']]);
  assert.equal(loaded.state.resources.filter(r => r.type === 'order').length, 1);
  await assert.rejects(() => resumed.issueInvoice('acceptance-invoice', 'cus_CHANGED', 'buyer@example.invalid'), { code: 'IDEMPOTENCY_REQUEST_CHANGED' });
  assert.equal(calls.length, 4);
  // A draft already owns collection. The retired create-then-update sequence must be rejected.
  await assert.rejects(() => client.orders.updateWithResponse(order.order_id, { tax: orderInput.tax }), { code: 'INVOICE_LOCKED_ORDER_FINANCIALS' });
  assert.equal('orders.update' in operations, false);
}));

test('invoice fixtures use card by default and request only the explicit provider policy', async t => {
  type Options = InvoicePaymentPolicyInput['enabled_payment_options'];
  const cases: { name: string; options?: Options; expected: Options; merchantOptions: Options }[] = [
    { name: 'card works without ACH enabled', expected: ['card'], merchantOptions: ['card', 'apple_pay', 'google_pay', 'affirm'] },
    { name: 'Affirm does not request ACH', options: ['card', 'affirm'], expected: ['card', 'affirm'], merchantOptions: ['card', 'affirm'] },
    { name: 'ACH does not request Affirm', options: ['card', 'ach_debit'], expected: ['card', 'ach_debit'], merchantOptions: ['card', 'ach_debit'] },
  ];
  for (const item of cases) await t.test(item.name, async () => setup(async ledger => {
    const zero = { amount: '0', currency: 'USD' }, total = { amount: '12000', currency: 'USD' };
    const order: Order = {
      order_id: 'ord_UNIT_FAKE', buyer_actions: [], status: 'open', payment_status: 'unpaid', refund_status: 'none', line_items: [],
      pricing_amounts: { charge_money: zero, discount_money: zero, requested_tip_money: zero, subtotal_money: total, tax_money: zero, total_money: total },
      settlement_amounts: { balance_money: total, outstanding_money: total, paid_money: zero, credit_money: zero, net_collected_money: zero, refunded_money: zero, settled_tip_money: zero },
      tax: { enabled: true, mode: 'automatic', status: 'calculated', taxability_reason: 'standard_rated' },
    };
    const invoiceFixture: Invoice = { invoice_id: 'inv_UNIT_FAKE', order_id: order.order_id, merchant_id: config.pins.A.merchantId, status: 'draft', version: '1', collection_block_status: 'none', credit_money: zero, currently_due_money: zero, outstanding_money: total, paid_money: zero, refunded_money: zero, refund_status: 'none', is_overdue: false, late_fees: [], reminders_paused: false };
    let policy: InvoicePaymentPolicyInput | undefined;
    const client = new Client({ baseUrl: 'https://api.staging.withflintpay.com', apiKey: 'flint_test_PLACEHOLDER', maxAttempts: 1, transport: async (input, init) => {
      const path = new URL(String(input)).pathname, body = JSON.parse(String(init!.body));
      assert.equal(init!.method, 'POST');
      assert.ok(new Headers(init!.headers).get('Idempotency-Key'));
      if (path === '/v1/orders') return Response.json({ data: order });
      if (path === '/v1/invoices') {
        policy = body.collection.payment_policy;
        assert.deepEqual(policy?.enabled_payment_options, item.expected);
        assert.ok(policy?.enabled_payment_options.every(option => item.merchantOptions.includes(option)), 'invoice options must be enabled for merchant checkout');
        return Response.json({ data: { ...invoiceFixture, payment_policy: policy } });
      }
      assert.equal(path, '/v1/invoices/inv_UNIT_FAKE/issue');
      return Response.json({ data: { invoice: { ...invoiceFixture, status: 'open', payment_policy: policy } } });
    } });
    const clients = { config, writable: async () => client } as unknown as VerifiedClients;
    const invoice = await new Operator(clients, ledger, {} as Fixtures).issueInvoice('policy-invoice', 'cus_UNIT_FAKE', 'buyer@example.invalid', item.options);
    assert.deepEqual(invoice.payment_policy.enabled_payment_options, item.expected);
    assert.deepEqual(Object.values(ledger.state.actions).map(action => action.operation), ['orders.create', 'invoices.create', 'invoices.issue']);
  }));
});

test('invoice draft refuses absent, unowned or foreign-sandbox source orders before SDK calls', async () => setup(async ledger => {
  let calls = 0;
  const clients = { config, writable: async () => ({ invoices: { createWithResponse: async () => { calls++; } } }) } as unknown as VerifiedClients;
  const operator = new Operator(clients, ledger, {} as Fixtures);
  const input: CreateInvoiceRequestInput = { order_id: 'ord_UNIT_FAKE' };
  const step: PlanStep = { name: 'invoice-draft', sandbox: 'A', operation: 'invoices.create', args: [input], creates: [{ path: 'invoice_id', type: 'invoice', cleanup: 'invoice', reviewAt: '2000-02-01T00:00:00Z' }], purpose: 'unit-invoice' };
  await assert.rejects(() => operator.execute(step), { code: 'RUN_RESOURCE_AUTHORITY_REQUIRED' });
  for (const ownership of [{ sandbox: 'A' as const, owned: false }, { sandbox: 'B' as const, owned: true }]) {
    await ledger.record({ resource: 'ord_UNIT_FAKE', type: 'order', mode: 'test', merchant: 'mer_PLACEHOLDER', sandboxId: config.pins[ownership.sandbox].sandboxId, createdBy: run, purpose: 'unit-invoice', cleanup: 'review', owner: 'unit', reviewAt: '2000-02-01T00:00:00Z', ...ownership });
    await assert.rejects(() => operator.execute(step), { code: 'RUN_RESOURCE_AUTHORITY_REQUIRED' });
  }
  assert.equal(calls, 0); assert.deepEqual(ledger.state.actions, {});
}));

test('quick-pay invoice drafts still require tracking their newly created orders', () => {
  const operator = new Operator({ config } as unknown as VerifiedClients, new Ledger('/unused', run), {} as Fixtures);
  const input: CreateInvoiceRequestInput = { quick_pay: { line_items: [{ name: 'Service', quantity: '1', unit_price_money: { amount: '12000', currency: 'USD' }, fulfillment: { requirement: 'none' }, tax: { taxable: true } }] } };
  const step: PlanStep = { name: 'quick-invoice', sandbox: 'A', operation: 'invoices.create', args: [input], creates: [{ path: 'invoice_id', type: 'invoice', cleanup: 'invoice', reviewAt: '2000-02-01T00:00:00Z' }], purpose: 'unit-invoice' };
  assert.throws(() => operator.validate(step), { code: 'ALL_CREATED_RESOURCES_MUST_BE_TRACKED' });
  operator.validate({ ...step, creates: [...step.creates, { path: 'order_id', type: 'order', cleanup: 'review', reviewAt: '2000-02-01T00:00:00Z' }] });
});

function subscriptionPlanStep(quantity: unknown = 1): PlanStep {
  return { name: 'numeric-plan', sandbox: 'A', operation: 'subscriptionPlans.create', args: [{
    name: 'Unit subscription', billing_interval: 'monthly', billing_interval_count: 1, currency: 'USD',
    line_items: [{ variant_id: 'var_UNIT_FAKE', quantity, modifiers: [{ modifier_id: 'mod_UNIT_FAKE', quantity: '1' }] }],
  }], creates: [{ path: 'subscription_plan_id', type: 'plan', cleanup: 'review', reviewAt: '2000-02-01T00:00:00Z' }], purpose: 'unit-plan' };
}
function subscriptionUpdateStep(quantity: unknown = 1): PlanStep {
  return { name: 'numeric-update', sandbox: 'A', operation: 'subscriptions.update', args: ['sub_UNIT_FAKE', { quantity, expected_version: '1' }], creates: [], purpose: 'unit-update' };
}
function subscriptionCheckoutStep(quantity: unknown = 1): PlanStep {
  return { name: 'numeric-checkout', sandbox: 'A', operation: 'checkoutSessions.create', args: [{ subscription_plan_id: 'plan_UNIT_FAKE', subscription_terms: { quantity } }], creates: [{ path: 'checkout_session.checkout_session_id', type: 'checkout_session', cleanup: 'checkout_session', reviewAt: '2000-02-01T00:00:00Z' }], purpose: 'unit-checkout' };
}
async function ownSubscription(ledger: Ledger) {
  await ledger.record({ resource: 'sub_UNIT_FAKE', type: 'subscription', mode: 'test', sandbox: 'A', merchant: 'mer_PLACEHOLDER', sandboxId: 'test_PLACEHOLDER_A', createdBy: run, purpose: 'unit', cleanup: 'subscription', owner: 'unit', reviewAt: '2000-02-01T00:00:00Z', owned: true });
}
test('subscription plan numeric line quantity executes through applyPlan and the durable ledger', async () => setup(async (ledger, dir) => {
  const input: CreateSubscriptionPlanRequestInput = {
    name: 'Unit subscription', billing_interval: 'monthly', billing_interval_count: 1, currency: 'USD',
    line_items: [{ variant_id: 'var_UNIT_FAKE', quantity: 1, modifiers: [{ modifier_id: 'mod_UNIT_FAKE', quantity: '1' }] }],
  };
  const step = { ...subscriptionPlanStep(), args: [input] };
  let calls = 0;
  const fake = { subscriptionPlans: { createWithResponse: async (body: CreateSubscriptionPlanRequestInput, options: { idempotencyKey: string }) => {
    calls++; assert.deepEqual(body, input);
    const durable = new Ledger(join(dir, 'ledger.json'), run); await durable.load();
    assert.equal(durable.state.actions['A:numeric-plan'].phase, 'unknown');
    assert.deepEqual(durable.state.actions['A:numeric-plan'].args, [input]);
    assert.equal(durable.state.actions['A:numeric-plan'].key, options.idempotencyKey);
    return { body: { data: { subscription_plan_id: 'plan_UNIT_FAKE' } }, meta: { requestId: 'req_UNIT_FAKE' } };
  } } };
  const clients = { config, writable: async () => fake } as unknown as VerifiedClients;
  const operator = new Operator(clients, ledger, {} as Fixtures);
  operator.validate(step); assert.equal(calls, 0);
  await operator.applyPlan([step]); assert.equal(calls, 1);
  const loaded = new Ledger(join(dir, 'ledger.json'), run); await loaded.load();
  const resumed = new Operator(clients, loaded, {} as Fixtures);
  assert.deepEqual(await resumed.execute(step), { data: { subscription_plan_id: 'plan_UNIT_FAKE' }, requestId: 'req_UNIT_FAKE' });
  assert.equal(calls, 1); assert.equal(loaded.state.actions['A:numeric-plan'].phase, 'known');
  assert.equal(loaded.state.resources.length, 1);
  assert.equal(loaded.state.resources[0].resource, 'plan_UNIT_FAKE');
  assert.equal(loaded.state.resources[0].type, 'plan'); assert.equal(loaded.state.resources[0].owned, true);
  assert.equal(loaded.state.resources[0].creationRequestId, 'req_UNIT_FAKE');
  await assert.rejects(() => resumed.execute(subscriptionPlanStep(2)), { code: 'IDEMPOTENCY_REQUEST_CHANGED' });
  assert.equal(calls, 1);
}));
test('subscription update numeric quantity retains exact version and run-owned authority through execute', async () => setup(async (ledger, dir) => {
  const input: UpdateSubscriptionRequestInput = { quantity: 100, expected_version: '1' }, step = subscriptionUpdateStep(100);
  let calls = 0;
  const fake = { subscriptions: { updateWithResponse: async (id: string, body: UpdateSubscriptionRequestInput, options: { idempotencyKey: string }) => {
    calls++; assert.equal(id, 'sub_UNIT_FAKE'); assert.deepEqual(body, input);
    const durable = new Ledger(join(dir, 'ledger.json'), run); await durable.load();
    assert.equal(durable.state.actions['A:numeric-update'].phase, 'unknown');
    assert.deepEqual(durable.state.actions['A:numeric-update'].args, [id, input]);
    assert.equal(durable.state.actions['A:numeric-update'].key, options.idempotencyKey);
    return { body: { data: { subscription_id: id, quantity: body.quantity, version: '2' } }, meta: {} };
  } } };
  const clients = { config, writable: async () => fake } as unknown as VerifiedClients;
  const operator = new Operator(clients, ledger, {} as Fixtures);
  await assert.rejects(() => operator.execute(step), { code: 'RUN_RESOURCE_AUTHORITY_REQUIRED' });
  assert.equal(calls, 0); assert.deepEqual(ledger.state.actions, {});
  await ownSubscription(ledger); operator.validate(step);
  await operator.execute(step);
  const loaded = new Ledger(join(dir, 'ledger.json'), run); await loaded.load();
  await new Operator(clients, loaded, {} as Fixtures).execute(step);
  assert.equal(calls, 1); assert.equal(loaded.state.actions['A:numeric-update'].phase, 'known');
  assert.deepEqual(loaded.state.actions['A:numeric-update'].args, ['sub_UNIT_FAKE', input]);
}));
test('subscription checkout numeric quantity executes with unchanged terms and durable resource tracking', async () => setup(async (ledger, dir) => {
  const input: CreateCheckoutSessionRequestInput = { subscription_plan_id: 'plan_UNIT_FAKE', subscription_terms: { quantity: 100 } };
  const step = { ...subscriptionCheckoutStep(100), args: [input] };
  let calls = 0;
  const fake = { checkoutSessions: { createWithResponse: async (body: CreateCheckoutSessionRequestInput, options: { idempotencyKey: string }) => {
    calls++; assert.deepEqual(body, input);
    const durable = new Ledger(join(dir, 'ledger.json'), run); await durable.load();
    assert.equal(durable.state.actions['A:numeric-checkout'].phase, 'unknown');
    assert.deepEqual(durable.state.actions['A:numeric-checkout'].args, [input]);
    assert.equal(durable.state.actions['A:numeric-checkout'].key, options.idempotencyKey);
    return { body: { data: { checkout_session: { checkout_session_id: 'cs_UNIT_FAKE' } } }, meta: {} };
  } } };
  const clients = { config, writable: async () => fake } as unknown as VerifiedClients;
  const operator = new Operator(clients, ledger, {} as Fixtures);
  operator.validate(step); await operator.execute(step);
  const loaded = new Ledger(join(dir, 'ledger.json'), run); await loaded.load();
  await new Operator(clients, loaded, {} as Fixtures).execute(step);
  assert.equal(calls, 1); assert.equal(loaded.state.actions['A:numeric-checkout'].phase, 'known');
  assert.equal(loaded.state.resources.length, 1);
  assert.equal(loaded.state.resources[0].resource, 'cs_UNIT_FAKE');
  assert.equal(loaded.state.resources[0].type, 'checkout_session'); assert.equal(loaded.state.resources[0].owned, true);
}));
test('subscription quantities obey their published bounds and reject invalid values before journaling or SDK calls', async () => setup(async ledger => {
  let calls = 0;
  const operator = new Operator({ config, writable: async () => { calls++; return {}; } } as unknown as VerifiedClients, ledger, {} as Fixtures);
  await ownSubscription(ledger);
  for (const [makeStep, max] of [[subscriptionPlanStep, 9999], [subscriptionUpdateStep, 100], [subscriptionCheckoutStep, 100]] as const) {
    for (const quantity of [1, max]) operator.validate(makeStep(quantity));
    const omitted = makeStep();
    if (omitted.operation === 'subscriptionPlans.create') delete omitted.args[0].line_items[0].quantity;
    else if (omitted.operation === 'subscriptions.update') delete omitted.args[1].quantity;
    else delete omitted.args[0].subscription_terms.quantity;
    operator.validate(omitted);
    for (const quantity of ['1', '9999', 0, -1, 1.5, max + 1, 2 ** 31 - 1, 2 ** 31, -(2 ** 31) - 1, NaN, Infinity, null, true]) {
      await assert.rejects(() => operator.execute(makeStep(quantity)), { code: 'EXACT_FIXTURE_INTEGER_REQUIRED' });
    }
  }
  assert.equal(calls, 0); assert.deepEqual(ledger.state.actions, {});
}));
test('numeric subscription exceptions do not admit order, modifier, revision or misplaced quantities', async () => setup(async ledger => {
  const operator = new Operator({ config } as VerifiedClients, ledger, {} as Fixtures);
  await ownSubscription(ledger);
  const modifier = subscriptionPlanStep(); modifier.args[0].line_items[0].modifiers[0].quantity = 1;
  const nested = subscriptionUpdateStep(); nested.args[1].metadata = { quantity: 1 };
  const misplaced = subscriptionPlanStep(); misplaced.args[0].quantity = 1;
  const order: PlanStep = { name: 'numeric-order', sandbox: 'A', operation: 'orders.create', args: [{ line_items: [{ name: 'Unit line', quantity: 1, unit_price_money: { amount: '100', currency: 'USD' } }] }], creates: [{ path: 'order_id', type: 'order', cleanup: 'review', reviewAt: '2000-02-01T00:00:00Z' }], purpose: 'unit-order' };
  const version = subscriptionUpdateStep(); version.args[1].expected_version = 1;
  const revision = subscriptionPlanStep(); revision.args[0].order_revision = 1;
  const checkout = subscriptionCheckoutStep(); checkout.args[0].quick_pay_item = { quantity: 1 };
  for (const step of [modifier, nested, misplaced, order, version, revision, checkout]) assert.throws(() => operator.validate(step), { code: 'EXACT_FIXTURE_INTEGER_REQUIRED' });
  order.args[0].line_items[0].quantity = '1'; operator.validate(order);
  assert.deepEqual(ledger.state.actions, {});
}));
test('challenge registration returns the current owned session only in memory',async()=>setup(async ledger=>{
 const id='ord_CHALLENGE_PLACEHOLDER',sessionId='cs_CHALLENGE_PLACEHOLDER',origin='http://localhost:4100',url='https://checkout.staging.withflintpay.com/gift-card-challenge/gccf_fixture.token';
 await ledger.record({resource:id,type:'order',mode:'test',sandbox:'A',merchant:'mer_PLACEHOLDER',sandboxId:'test_PLACEHOLDER_A',createdBy:run,purpose:'unit',cleanup:'review',owner:'unit',reviewAt:'2000-02-01T00:00:00Z',owned:true});
 const session={checkout_session_id:sessionId,order_id:id,status:'open',recovery_mode:false,page_origin:origin,gift_card_challenge:{url}},fake={checkoutSessions:{list:async()=>({data:[session]}),get:async(value:string)=>{assert.equal(value,sessionId);return session;}}};
 const op=new Operator({config,clients:{A:fake}} as unknown as VerifiedClients,ledger,{} as Fixtures);
 assert.deepEqual(await op.challengeFor(id,origin),{url,checkoutSessionId:sessionId});assert.equal(await op.challengeUrlFor(id,origin),url);await assert.rejects(()=>op.challengeFor('ord_UNOWNED_PLACEHOLDER',origin),{code:'RUN_RESOURCE_AUTHORITY_REQUIRED'});
 assert.equal(JSON.stringify(ledger.state).includes(sessionId),false);assert.equal(JSON.stringify(ledger.state).includes(url),false);
}));
test('settings reject arbitrary preexisting authority before invoking the client', async () => setup(async ledger => {
  let called = false;
  const clients = { config, writable: async () => { called = true; return {}; } } as unknown as VerifiedClients;
  const op = new Operator(clients, ledger, { settingsAuthority: {} } as Fixtures);
  await assert.rejects(() => op.settings('A', { customer_account: { mode: 'merchant_hosted' } }), { message: 'PREEXISTING_SETTINGS_CHANGE_FORBIDDEN' }); assert.equal(called, false);
}));
test('unknown settings outcome replays the original version and restores the snapshot', async () => setup(async ledger => {
  let current: any = { version: '1', customer_account: { mode: 'flint_hosted' } }, lost = true;
  const seen: any[] = [], cache = new Map<string, any>();
  const fake = { settings: { get: async () => structuredClone(current), update: async (body: any, options: any) => {
    seen.push({ body: structuredClone(body), key: options.idempotencyKey });
    if (cache.has(options.idempotencyKey)) return cache.get(options.idempotencyKey);
    assert.equal(body.expected_version, current.version); current = { ...body, version: (BigInt(current.version) + 1n).toString() }; delete current.expected_version;
    const response = structuredClone(current); cache.set(options.idempotencyKey, response); if (lost) { lost = false; throw new Error('unknown'); } return response;
  } } };
  const clients = { config, writable: async () => fake } as unknown as VerifiedClients;
  const fixtures = { settingsAuthority: { A: { runOwned: true, owner: 'unit', reviewAt: '2000-02-01T00:00:00Z' } } } as Fixtures;
  const op = new Operator(clients, ledger, fixtures);
  await assert.rejects(() => op.settings('A', { customer_account: { mode: 'merchant_hosted' } }));
  await op.settings('A', { customer_account: { mode: 'merchant_hosted' } }); assert.deepEqual(seen[0], seen[1]);
  await op.cleanup(); assert.equal(current.customer_account.mode, 'flint_hosted'); ledger.assertTracked();
}));
test('concurrent settings change is preserved and teardown fails', async () => setup(async ledger => {
  let current: any = { version: '1', customer_account: { mode: 'flint_hosted' } };
  const fake = { settings: { get: async () => structuredClone(current), update: async (body: any) => { current = { ...body, version: '2' }; delete current.expected_version; return structuredClone(current); } } };
  const clients = { config, writable: async () => fake } as unknown as VerifiedClients;
  const op = new Operator(clients, ledger, { settingsAuthority: { A: { runOwned: true, owner: 'unit', reviewAt: '2000-02-01T00:00:00Z' } } } as Fixtures);
  await op.settings('A', { customer_account: { mode: 'merchant_hosted' } }); current = { version: '3', customer_account: { mode: 'foreign-owner-value' } };
  await assert.rejects(() => op.cleanup(), { message: 'TEARDOWN_FAILED' }); assert.equal(current.customer_account.mode, 'foreign-owner-value');
}));
test('cleanup fails if supported revocation reports failure', async () => setup(async ledger => {
  const clients = { config, writable: async () => ({ customerSessions: { revoke: async () => ({ revoked: false, customer_session_id: 'cs_PLACEHOLDER' }) } }) } as unknown as VerifiedClients;
  await ledger.record({ resource: 'cs_PLACEHOLDER', type: 'customer_session', mode: 'test', sandbox: 'A', merchant: 'mer_PLACEHOLDER', sandboxId: 'test_PLACEHOLDER_A', createdBy: run, purpose: 'unit', cleanup: 'customer_session', owner: 'unit', reviewAt: '2000-02-01T00:00:00Z', owned: true });
  await assert.rejects(() => new Operator(clients, ledger, {} as Fixtures).cleanup(), { message: 'TEARDOWN_FAILED' }); assert.equal(ledger.state.resources[0].status, 'PENDING AUTHORIZED CLEANUP');
}));
test('supplied unowned resources are never cleaned up', async () => setup(async ledger => {
  let called = false; const clients = { config, writable: async () => { called = true; return {}; } } as unknown as VerifiedClients;
  await ledger.record({ resource: 'sub_PLACEHOLDER', type: 'subscription', mode: 'test', sandbox: 'A', merchant: 'mer_PLACEHOLDER', sandboxId: 'test_PLACEHOLDER_A', createdBy: run, purpose: 'unit', cleanup: 'subscription', owner: 'fixture-owner', reviewAt: '2000-02-01T00:00:00Z', owned: false });
  await new Operator(clients, ledger, {} as Fixtures).cleanup(); assert.equal(called, false);
}));
test('same explicit key is durably recorded in both sandbox journals', async () => setup(async ledger => {
  for (const sandbox of ['A', 'B'] as const) await ledger.action('isolation', sandbox, 'orders.create', [], async key => key, async () => {}, 'same-PLACEHOLDER-key');
  assert.equal(ledger.state.actions['A:isolation'].key, ledger.state.actions['B:isolation'].key);
}));

test('external gift funding uses a sanctioned customer ID read through the public client', async () => setup(async ledger => {
  const id = 'cus_FUNDING_PLACEHOLDER';
  await ledger.record({ resource: id, type: 'customer', mode: 'test', sandbox: 'A', merchant: 'mer_PLACEHOLDER', sandboxId: 'test_PLACEHOLDER_A', createdBy: run, purpose: 'supplied-fixture', cleanup: 'review', owner: 'unit', reviewAt: '2000-02-01T00:00:00Z', owned: false });
  let buyerId: string | undefined;
  const fake = { customers: { get: async (value: string) => { assert.equal(value, id); return { customer_id: id }; } }, giftCards: { createWithResponse: async (body: any) => { buyerId = body.funding.source.buyer_id; return { body: { data: { gift_card: { gift_card_id: 'gift_PLACEHOLDER' }, code: 'GIFT-PLACEHOLDER' } }, meta: {} }; } } };
  const clients = { config, clients: { A: fake }, writable: async () => fake } as unknown as VerifiedClients;
  const op = new Operator(clients, ledger, { values: { giftFundingCustomerId: id } } as unknown as Fixtures); await op.issueGiftCard('funded'); assert.equal(buyerId, id);
}));
test('synthetic unrecognized gift funding references are refused before issuance', async () => setup(async ledger => {
  let calls = 0; const clients = { config, clients: { A: { customers: { get: async () => { calls++; } } } } } as unknown as VerifiedClients;
  const op = new Operator(clients, ledger, { values: { giftFundingCustomerId: 'cus_UNSANCTIONED_PLACEHOLDER' } } as unknown as Fixtures);
  await assert.rejects(() => op.issueGiftCard('funded'), { message: 'SANCTIONED_FUNDING_CUSTOMER_REQUIRED' }); assert.equal(calls, 0);
}));
for(const initial of ['absent','null','object'] as const)test(`settings restore ${initial} snapshots with exact clearing and crash replay`,async()=>setup(async(ledger,dir)=>{
  let current:any={version:'1',...(initial==='absent'?{}:{customer_account:initial==='null'?null:{mode:'flint_hosted'}})},lostApply=true,lostRestore=true;
  const effective={mode:'flint_hosted'},seen:any[]=[],cache=new Map<string,any>();
  const fake={settings:{get:async()=>structuredClone(current),getEffective:async()=>({customer_account:current.customer_account??effective}),update:async(body:any,options:any)=>{
    seen.push({body:structuredClone(body),key:options.idempotencyKey});if(cache.has(options.idempotencyKey))return cache.get(options.idempotencyKey);
    assert.equal(body.expected_version,current.version);current={...current,...body,version:(BigInt(current.version)+1n).toString()};delete current.expected_version;if(body.customer_account===null)delete current.customer_account;
    const response=structuredClone(current);cache.set(options.idempotencyKey,response);
    if(body.customer_account?.mode==='merchant_hosted'&&lostApply){lostApply=false;throw new Error('lost apply');}
    if(body.customer_account?.mode!=='merchant_hosted'&&lostRestore){lostRestore=false;throw new Error('lost restore');}return response;
  }}};
  const clients={config,writable:async()=>fake} as unknown as VerifiedClients,fixtures={settingsAuthority:{A:{runOwned:true,owner:'unit',reviewAt:'2000-02-01T00:00:00Z'}}} as Fixtures;
  const op=new Operator(clients,ledger,fixtures);await assert.rejects(()=>op.settings('A',{customer_account:{mode:'merchant_hosted'}}));
  const loaded=new Ledger(join(dir,'ledger.json'),run);await loaded.load();assert.equal(loaded.state.settings['settings-A'].snapshot._presence.customer_account,initial==='object'?'value':initial);
  const resumed=new Operator(clients,loaded,fixtures);await resumed.settings('A',{customer_account:{mode:'merchant_hosted'}});assert.deepEqual(seen[0],seen[1]);
  await assert.rejects(()=>resumed.cleanup(),{message:'TEARDOWN_FAILED'});
  const afterCrash=new Ledger(join(dir,'ledger.json'),run);await afterCrash.load();await new Operator(clients,afterCrash,fixtures).cleanup();assert.deepEqual(seen[2],seen[3]);
  if(initial==='object')assert.deepEqual(current.customer_account,{mode:'flint_hosted'});else{assert.equal(Object.hasOwn(current,'customer_account'),false);assert.equal(seen[2].body.customer_account,null);}
  afterCrash.assertTracked();
}));
test('unsupported settings absence and null remain blocked before any write',async()=>setup(async ledger=>{
 for(const value of [undefined,null]){let writes=0;const clients={config,writable:async()=>({settings:{get:async()=>({version:'1',checkout:value}),update:async()=>{writes++;}}})} as unknown as VerifiedClients;
 const op=new Operator(clients,ledger,{settingsAuthority:{A:{runOwned:true,owner:'unit',reviewAt:'2000-02-01T00:00:00Z'}}} as Fixtures);
 await assert.rejects(()=>op.settings('A',{checkout:{}}),{message:'SETTINGS_PATCH_NOT_RESTORABLE'});assert.equal(writes,0);}
}));

for(const trips of [true,false])test(`challenge trip ${trips?'proves a shared dimension':'fails at the bounded lookup limit'} without merchant apply or persisted codes`,async()=>setup(async(ledger,dir)=>{
 let sessionCount=0,lookups=0;const requests:any[]=[],codes:string[]=[];
 const fake={orders:{get:async()=>({order_revision:'5'}),applyGiftCard:async(_id:string,body:any,options:any)=>{lookups++;requests.push(options);codes.push(body.gift_card_code);assert.match(body.gift_card_code,/^E2ENOPE[A-Za-z0-9_-]{16}$/);assert.equal('Flint-Gift-Card-Challenge'in body,false);const code=trips&&(sessionCount>1||lookups===2)?'GIFT_CARD_CHALLENGE_REQUIRED':'GIFT_CARD_UNAVAILABLE';throw new SdkError('validation','fixture','response',false,{status:400,headers:{},attempts:1,durationMs:1},code);}},checkoutSessions:{closeSession:async()=>({})}};
 const clients={config:{...config,origins:{storefrontA:'http://localhost:4100'}},writable:async()=>fake} as unknown as VerifiedClients,op=new Operator(clients,ledger,{} as Fixtures);
 op.execute=async step=>{
   const session=step.operation==='checkoutSessions.create';if(session)sessionCount++;const id=`${session?'cs':'ord'}_fixture_${sessionCount+(!session?1:0)}`;
   await ledger.record({resource:id,type:session?'checkout_session':'order',mode:'test',sandbox:'A',merchant:'mer_PLACEHOLDER',sandboxId:'test_PLACEHOLDER_A',createdBy:run,purpose:'gift-challenge-probe',cleanup:session?'checkout_session':'review',owner:'unit',reviewAt:'2000-02-01T00:00:00Z',owned:true});
   return {data:session?{checkout_session:{checkout_session_id:id},checkout_access:{checkout_auth_token:'fixture authority'}}:{order_id:id}};
 };
 if(trips){await op.tripGiftChallenge();assert.equal(sessionCount,2);assert.equal(lookups,3);assert.ok(ledger.state.giftChallengeTrippedAt);await op.tripGiftChallenge();assert.equal(sessionCount,3);assert.equal(lookups,4);}else{await assert.rejects(()=>op.tripGiftChallenge(),{code:'CHALLENGE_TRIP_NOT_OBSERVED'});assert.equal(sessionCount,3);assert.equal(lookups,15);}
 assert.ok(requests.every(options=>options.authMode==='checkout'&&options.apiKey===undefined&&options.maxAttempts===1));assert.ok(ledger.state.resources.filter(resource=>resource.type==='checkout_session').every(resource=>resource.status==='CLEANED UP'));
 const saved=await import('node:fs/promises').then(fs=>fs.readFile(join(dir,'ledger.json'),'utf8'));for(const code of codes)assert.equal(saved.includes(code),false);assert.equal(saved.includes('fixture authority'),false);
}));

// Exchange orders materialize after confirmation through the asynchronous return effect.
test('return proposals track the resolution before a replacement order exists', async () => setup(async ledger => {
  const reviewAt = '2000-02-01T00:00:00Z';
  await ledger.record({ resource: 'ret_PLACEHOLDER', type: 'return', mode: 'test', sandbox: 'A', merchant: config.pins.A.merchantId, sandboxId: config.pins.A.sandboxId, createdBy: run, purpose: 'unit', cleanup: 'review', owner: 'unit', reviewAt, owned: true });
  let calls = 0;
  const clients = { config, writable: async () => ({ returns: { createResolutionWithResponse: async () => {
    calls++; return { body: { data: { return_resolution: { return_resolution_id: 'rres_PLACEHOLDER', status: 'proposed' } } }, meta: {} };
  } } }) } as unknown as VerifiedClients;
  const op = new Operator(clients, ledger, {} as Fixtures);
  const step: PlanStep = { name: 'exchange-proposal', sandbox: 'A', operation: 'returns.createResolution', args: ['ret_PLACEHOLDER', { resolution_type: 'exchange', line_items: [{ return_line_item_id: 'rtli_PLACEHOLDER', quantity: '1' }] }], creates: [{ type: 'return_resolution', path: 'return_resolution.return_resolution_id', cleanup: 'return_resolution', reviewAt }], purpose: 'unit-exchange' };
  assert.throws(() => op.validate({ ...step, creates: [] }), { code: 'ALL_CREATED_RESOURCES_MUST_BE_TRACKED' });
  await op.execute(step); await op.execute(step);
  assert.equal(calls, 1);
  assert.deepEqual(ledger.state.resources.map(r => [r.type, r.resource]), [['return', 'ret_PLACEHOLDER'], ['return_resolution', 'rres_PLACEHOLDER']]);
}));
