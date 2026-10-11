import { test } from 'node:test';
import assert from 'node:assert/strict';

// The adapter reads window.Stripe, so a stand-in records the options each Elements group is created with.
type Group = { options: Record<string, any>; created: string[] };
const groups: Group[] = [];
const element = () => ({ on() {}, mount() {}, destroy() {}, clear() {}, update() {} });
(globalThis as any).window = {
  setTimeout,
  Stripe: () => ({
    elements(options: Record<string, any> = {}) {
      const group: Group = { options, created: [] };
      groups.push(group);
      return { create: (type: string) => (group.created.push(type), element()), update() {}, submit: async () => ({}) };
    },
  }),
};
const { createStripePayment } = await import('../../public/js/stripe-payment.js');

const amount = { amount: '1800', currency: 'USD' };
const guidance = (mode: string, extra: Record<string, unknown> = {}) => ({
  publishable_key: 'pk_unit',
  account_id: 'acct_unit',
  elements: {
    mode,
    next_step: 'create_confirmation_token',
    payment_method_types: ['card', 'affirm', 'us_bank_account'],
    digital_wallets: ['apple_pay', 'google_pay'],
    payment_method_options: { us_bank_account: { setup_future_usage: 'off_session' }, affirm: { setup_future_usage: 'none' } },
    amount_money: mode === 'setup' ? null : amount,
    ...extra,
  },
});
const mount = () => ({ payment: {} as HTMLElement, wallets: {} as HTMLElement, walletsRegion: { removeAttribute() {} } as unknown as HTMLElement, messaging: null });

async function start(stripeGuidance: ReturnType<typeof guidance>, kind: 'order' | 'subscription', excludeAffirm = false) {
  groups.length = 0;
  await createStripePayment({
    guidance: stripeGuidance, kind, saveOffered: false, excludeAffirm, amount: stripeGuidance.elements.mode === 'setup' ? null : amount,
    mounts: mount(), onChange() {}, onReady() {}, onWalletClick: () => true, onWalletConfirm: async () => {},
    getBilling: () => ({ name: 'Test Buyer', email: 'buyer@example.test' }), getShipping: () => null,
  } as never);
  const payment = groups.find((group) => group.created.includes('payment'));
  const wallet = groups.find((group) => group.created.includes('expressCheckout'));
  assert.ok(payment && wallet, 'both the Payment Element and the Express Checkout Element are created');
  return { payment: payment.options, wallet: wallet.options };
}

for (const [name, mode, kind] of [['an ordinary order', 'payment', 'order'], ['a subscription', 'payment', 'subscription'], ['a setup', 'setup', 'order']] as const) {
  test(`the wallet Elements for ${name} use the published explicit methods, not automatic ones`, async () => {
    const published = guidance(mode);
    const { payment, wallet } = await start(published, kind);
    assert.deepEqual(wallet.paymentMethodTypes, published.elements.payment_method_types);
    assert.deepEqual(wallet.paymentMethodOptions, published.elements.payment_method_options);
    assert.deepEqual(wallet, payment);
    assert.equal(wallet.mode, mode);
    assert.equal(wallet.paymentMethodCreation, 'manual');
    assert.equal(wallet.setupFutureUsage, kind === 'subscription' ? 'off_session' : undefined);
    assert.equal('amount' in wallet, mode !== 'setup');
  });
}

test('the wallet Elements drop Affirm when the checkout excludes it, like the Payment Element', async () => {
  const { payment, wallet } = await start(guidance('payment'), 'order', true);
  assert.deepEqual(wallet.paymentMethodTypes, ['card', 'us_bank_account']);
  assert.deepEqual(wallet, payment);
});
