import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../../support/ledger.ts';
import { Results } from '../../support/results.ts';
import { writePrivate, privateDirectory, checkoutRoot } from '../../support/private-files.ts';
import { validateRegistry, rows } from '../../scenarios/registry.ts';
import { money, equalMoney, giftAllocation, settlementRequest, assertOneCharge, assertTrialSetup } from '../../support/money.ts';

const run = '20000101T000000Z-00000000';
const resource = { resource: 'ord_PLACEHOLDER', type: 'order', mode: 'test' as const, sandbox: 'A' as const, merchant: 'mer_PLACEHOLDER', sandboxId: 'test_PLACEHOLDER', createdBy: run, purpose: 'unit-fixture', cleanup: 'review', owner: 'unit', reviewAt: '2000-02-01T00:00:00Z', owned: true };
async function temp(fn: (dir: string) => Promise<void>) { const dir = await mkdtemp(join(tmpdir(), 'headless-unit-')); try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } }
test('unknown creation survives restart and resubmits exactly one original key', async () => temp(async dir => {
  const keys: string[] = [], file = join(dir, 'ledger.json'), ledger = new Ledger(file, run);
  const send = async (key: string) => { keys.push(key); if (keys.length === 1) throw new Error('unknown'); return { id: resource.resource }; };
  const track = async (_: any) => ledger.record(resource);
  await assert.rejects(() => ledger.action('create', 'A', 'orders.create', [{ amount: '12000' }], send, track)); assert.throws(() => ledger.assertTracked());
  const resumed = new Ledger(file, run); await resumed.load(); await resumed.action('create', 'A', 'orders.create', [{ amount: '12000' }], send, async () => resumed.record(resource)); assert.equal(keys[0], keys[1]); assert.equal(resumed.state.resources.length, 1);
  await resumed.action('create', 'A', 'orders.create', [{ amount: '12000' }], send, async () => {}); assert.equal(keys.length, 2);
  await assert.rejects(() => resumed.action('create', 'A', 'orders.create', [{ amount: '12001' }], send, async () => {}), { message: 'IDEMPOTENCY_REQUEST_CHANGED' });
}));
test('partial creation ledger survives a later setup error', async () => temp(async dir => {
  const ledger = new Ledger(join(dir, 'ledger.json'), run);
  await assert.rejects(() => ledger.action('partial', 'A', 'orders.create', [], async () => ({ id: resource.resource }), async () => { await ledger.record(resource); throw new Error('follow-on failed'); }));
  const recovered = new Ledger(ledger.file, run); await recovered.load(); assert.equal(recovered.state.resources.length, 1); assert.throws(() => recovered.assertTracked());
}));
test('untracked outcome, failed cleanup and unrestored settings each fail teardown', async () => temp(async dir => {
  const ledger = new Ledger(join(dir, 'ledger.json'), run); await ledger.record(resource); assert.throws(() => ledger.assertTracked());
  await ledger.disposition(ledger.state.resources[0], 'RETAINED FOR RECONCILIATION'); ledger.assertTracked(); await ledger.snapshot('settings-A', { version: '1' }); assert.throws(() => ledger.assertTracked(), { message: 'SETTINGS_NOT_RESTORED' });
}));
test('private state permissions and public-workspace rejection', async () => temp(async dir => {
  const file = join(dir, 'private.json'); await writePrivate(file, { placeholder: true }); assert.equal((await stat(file)).mode & 0o077, 0); await assert.rejects(() => privateDirectory(checkoutRoot));
}));
test('prerequisite is recorded once and dependent rows stay NOT RUN', async () => temp(async dir => {
  const results = new Results(join(dir, 'result.json'), ['SF-01', 'SF-02']); results.root({ id: 'PRQ-INBOX', status: 'PENDING', code: 'INBOX_CONFIG_REQUIRED' }); results.stopped('SF-02', 'PRQ-INBOX'); assert.equal(results.rows.get('SF-02')?.status, 'NOT RUN');
  assert.throws(() => results.root({ id: 'PRQ-INBOX', status: 'BLOCKED', code: 'DIFFERENT' })); assert.throws(() => results.finish('SF-01', 'PASS', [])); assert.throws(() => results.finish('SF-01', 'OUT OF SCOPE', ['NO_USER_EXCEPTION'])); await results.save();
}));
test('all 52 settled rows and seven supplemental contract rows have an implementation', () => { validateRegistry(); assert.equal(rows.length, 59); });
test('money avoids floating point and rejects numeric amounts', () => {
  assert.equal(money({ amount: '9007199254740993', currency: 'USD' }).amount, '9007199254740993'); assert.throws(() => money({ amount: 12000, currency: 'USD' })); assert.throws(() => equalMoney({ amount: '1', currency: 'USD' }, { amount: '1', currency: 'CAD' }));
});
function giftOrder() { return { order_revision: '9', gift_cards: [{ gift_card_id: 'gift_PLACEHOLDER' }], settlement_amounts: { outstanding_money: { amount: '12000', currency: 'USD' } }, gift_card_estimate: { order_revision: '9', gift_cards: [{ gift_card_id: 'gift_PLACEHOLDER', amount_money: { amount: '12000', currency: 'USD' } }], gift_card_money: { amount: '12000', currency: 'USD' }, processor_money: { amount: '0', currency: 'USD' } } }; }
test('fully gift-funded request accepts latest allocation and omits processor source', () => { const order = giftOrder(); const request = settlementRequest(order); assert.equal(request.action, 'pay'); assert.equal('payment_source' in request, false); assert.equal((request.accepted_gift_card_allocation as any).order_revision, '9'); assert.throws(() => settlementRequest(order, { token: 'pm_PLACEHOLDER' })); });
test('zero balance uses published action pay without payment source', () => { const request = settlementRequest({ settlement_amounts: { outstanding_money: { amount: '0', currency: 'USD' } } }); assert.deepEqual(request, { action: 'pay', expected_outstanding_money: { amount: '0', currency: 'USD' } }); });
test('gift allocation rejects stale revisions or mismatched exact sums', () => { const order = giftOrder(); order.gift_card_estimate.order_revision = '8'; assert.throws(() => giftAllocation(order)); order.gift_card_estimate.order_revision = '9'; order.gift_card_estimate.processor_money.amount = '1'; assert.throws(() => giftAllocation(order)); });
test('one-charge assertions reject duplicate settled intents and a paid label without state', () => {
  const order = { payment_status: 'paid', settlement_amounts: { outstanding_money: { amount: '0', currency: 'USD' } } }, attempt = { status: 'succeeded', payment_intents: [{ payment_intent_id: 'pi_PLACEHOLDER', status: 'succeeded' }] }; assertOneCharge(order, [attempt]); assert.throws(() => assertOneCharge(order, [attempt, attempt])); assert.throws(() => assertOneCharge({ ...order, payment_status: 'unpaid' }, [attempt]));
});

const trialOrder = { payment_status: 'paid', settlement_amounts: { outstanding_money: { amount: '0', currency: 'USD' } } };
const trialAttempt = { mode: 'setup', status: 'succeeded', is_resumable: false };
test('completed trial setup is proved by history after active recovery state is cleared', () => {
  assertTrialSetup(trialOrder, [trialAttempt], false);
  assertTrialSetup({ ...trialOrder, payment_intent_ids: [] }, [{ ...trialAttempt, payment_intents: [] }], false);
});
for (const [name, order, attempts, browserConfirmSetup, code] of [
  ['missing attempt', trialOrder, [], false, 'TRIAL_SETUP_ATTEMPT_COUNT'],
  ['duplicate attempts', trialOrder, [trialAttempt, trialAttempt], false, 'TRIAL_SETUP_ATTEMPT_COUNT'],
  ['extra failed attempt', trialOrder, [trialAttempt, { ...trialAttempt, status: 'failed' }], false, 'TRIAL_SETUP_ATTEMPT_COUNT'],
  ['payment mode', trialOrder, [{ ...trialAttempt, mode: 'payment' }], false, 'TRIAL_MUST_USE_PUBLIC_SETUP_COLLECTION'],
  ['incomplete setup', trialOrder, [{ ...trialAttempt, status: 'finalizing' }], false, 'TRIAL_MUST_USE_PUBLIC_SETUP_COLLECTION'],
  ['failed setup', trialOrder, [{ ...trialAttempt, status: 'failed' }], false, 'TRIAL_MUST_USE_PUBLIC_SETUP_COLLECTION'],
  ['resumable setup', trialOrder, [{ ...trialAttempt, is_resumable: true }], false, 'TRIAL_MUST_USE_PUBLIC_SETUP_COLLECTION'],
  ['missing resumability', trialOrder, [{ ...trialAttempt, is_resumable: undefined }], false, 'TRIAL_MUST_USE_PUBLIC_SETUP_COLLECTION'],
  ['browser confirmation', trialOrder, [trialAttempt], true, 'TRIAL_MUST_USE_PUBLIC_SETUP_COLLECTION'],
  ['active attempt', { ...trialOrder, active_payment_attempt: trialAttempt }, [trialAttempt], false, 'TRIAL_SETUP_STILL_ACTIVE'],
  ['order payment leg', { ...trialOrder, payment_intent_ids: ['pi_PLACEHOLDER'] }, [trialAttempt], false, 'TRIAL_MUST_NOT_CHARGE'],
  ['successful payment leg', trialOrder, [{ ...trialAttempt, payment_intents: [{ payment_intent_id: 'pi_PLACEHOLDER', status: 'succeeded' }] }], false, 'TRIAL_MUST_NOT_CHARGE'],
  ['failed payment leg', trialOrder, [{ ...trialAttempt, payment_intents: [{ payment_intent_id: 'pi_PLACEHOLDER', status: 'failed' }] }], false, 'TRIAL_MUST_NOT_CHARGE'],
  ['unpaid order', { ...trialOrder, payment_status: 'unpaid' }, [trialAttempt], false, 'ORDER_NOT_SETTLED'],
  ['outstanding balance', { ...trialOrder, settlement_amounts: { outstanding_money: { amount: '1', currency: 'USD' } } }, [trialAttempt], false, 'ORDER_NOT_SETTLED'],
] as const) test(`trial setup rejects ${name}`, () => {
  assert.throws(() => assertTrialSetup(order, [...attempts], browserConfirmSetup), { code });
});
