import { expect } from '@playwright/test';
import type { Driver, Checkout } from '../support/driver.ts';
import { invariant } from '../support/safe.ts';
import { equalMoney, money, giftAllocation, assertOneCharge } from '../support/money.ts';
import { bank, affirm } from './provider.ts';
import { walletScenario } from './wallets.ts';

export type Scenario = (d: Driver) => Promise<string[]>;
async function normal(d: Driver, name: string, product = 'house-blend'): Promise<Checkout> {
  const c = await d.checkout(await d.page(name), product); await d.delivery(c); return c;
}
async function subscription(d: Driver, trial: boolean): Promise<any> {
  const page = await d.page(trial ? 'trial' : 'b1');
  if (!trial) await d.login(page, 'b1', d.sf());
  const slug = trial ? 'coffee-club-trial' : 'coffee-club-monthly';
  await d.goto(page, d.sf(), `/subscribe/${slug}`); await d.form(page, `/subscribe/${slug}`);
  await page.waitForURL(/\/checkout\/[^/]+$/);
  const c: Checkout = { page, ref: new URL(page.url()).pathname.split('/')[2], origin: d.sf(), sandbox: 'A', orderId: '', state: null };
  await d.state(c);
  const email = page.getByTestId('sf-contact-email'); if (await email.isEditable()) { await email.fill(d.fixtures.buyers.b1.email); await email.blur(); }
  await page.getByTestId('sf-contact-name').fill('Acceptance buyer');
  if (trial) invariant(c.state.setup_collection && money(c.state.order.settlement_amounts.outstanding_money).amount === '0', 'TRIAL_SETUP_COLLECTION_REQUIRED');
  else invariant(c.state.session.subscription_terms && c.state.payment_collection, 'SUBSCRIPTION_TERMS_MISSING');
  await d.delivery(c);
  let browserConfirmSetup = false;
  const providerRequest = (request: import('@playwright/test').Request) => { if (/\/setup_intents\/[^/]+\/confirm/.test(new URL(request.url()).pathname)) browserConfirmSetup = true; };
  page.on('request', providerRequest);
  const submitted = page.waitForRequest(r => new URL(r.url()).pathname === `/checkout/${c.ref}/pay` && r.method() === 'POST'); await d.pay(c);
  const body = (await submitted).postDataJSON(); invariant(body.credential?.kind === (trial ? 'payment_method_token' : 'confirmation_token'), 'SUBSCRIPTION_COLLECTION_CREDENTIAL_KIND');
  await expect(page.getByTestId('sf-complete')).toHaveAttribute('data-state', trial ? 'subscription_trialing' : 'subscription_active', { timeout: 60_000 });
  const order = await d.trackOrder('A', c.orderId);
  invariant(order.subscription_id, 'SUBSCRIPTION_NOT_CREATED');
  const sub = await d.operator.clients.clients.A.subscriptions.get(order.subscription_id);
  invariant(sub.status === (trial ? 'trialing' : 'active'), 'SUBSCRIPTION_STATE_MISMATCH');
  if (trial) invariant(order.active_payment_attempt?.mode === 'setup' && !browserConfirmSetup, 'TRIAL_MUST_USE_PUBLIC_SETUP_COLLECTION');
  invariant(sub.payment_method_id, 'SUBSCRIPTION_METHOD_REQUIRED'); const saved = await d.operator.clients.clients.A.paymentMethods.get(sub.payment_method_id);
  invariant(saved.status === 'active' && saved.usage === 'off_session', 'SUBSCRIPTION_OFF_SESSION_METHOD'); page.off('request', providerRequest);
  d.created.set(trial ? 'trialSubscription' : 'paidSubscription', sub.subscription_id);
  return { c, sub };
}
export const storefront: Record<string, Scenario> = {
  'SF-01': async d => {
    const page = await d.page('catalog'); await d.goto(page, d.sf(), '/'); await expect(page.getByTestId('sf-home')).toBeVisible(); await d.axe(page, 'sf-home');
    for (const [slug, fixture] of Object.entries(d.fixtures.products)) {
      const product = await d.operator.clients.clients.A.products.get(fixture.productId);
      invariant(product.product_id === fixture.productId, 'CATALOG_PRODUCT_MISMATCH');
      const card = page.getByTestId(`sf-product-card-${slug}`);
      await expect(card.locator('[data-amount-minor]').first()).toHaveAttribute('data-amount-minor', fixture.unitPrice.amount);
    }
    await d.cart(page); await d.axe(page, 'sf-cart-filled');
    const line = page.locator('[data-testid^="sf-cart-line-"]').first();
    const id = (await line.getAttribute('data-testid'))!.slice('sf-cart-line-'.length);
    await page.getByTestId(`sf-cart-quantity-${id}`).fill('2'); await line.getByRole('button', { name: /update/i }).click();
    await expect(page.getByTestId(`sf-cart-quantity-${id}`)).toHaveValue('2');
    await page.getByTestId(`sf-cart-remove-${id}`).click(); await expect(page.getByTestId('sf-cart-empty')).toBeVisible(); await d.axe(page, 'sf-cart-empty');
    return ['CATALOG_CART_PRICES_AND_MUTATIONS'];
  },
  'SF-02': async d => {
    const after = new Date(), c = await normal(d, 'guest-card'); await d.pay(c); const order = await d.settled(c, 1);
    d.created.set('guestCardOrder', order.order_id); const mail = await d.email('b1', after, 'order_receipts');
    const link = d.emailLink(mail, 'flint_account_link_relay');
    const page = await d.page('receipt-link'); await page.goto(link); await expect(page.locator('form[action="/sign-in"]')).toBeVisible();
    if (!d.fixtures.buyers.b1.verified) await d.signup(page, 'b1', d.config.origins.accountA, `/orders/${order.order_id}`);
    else await d.form(page, '/sign-in', { email: d.fixtures.buyers.b1.email, password: d.fixtures.buyers.b1.password });
    await expect(page.getByTestId('ac-order')).toBeVisible(); invariant(new URL(page.url()).pathname === `/orders/${order.order_id}`, 'RECEIPT_SIGNIN_RETURN_PATH');
    d.created.set('receiptLink', link); return ['GUEST_DELIVERY_CARD_SETTLED_RECEIPT_SIGNIN_RESOURCE'];
  },
  'SF-03': async d => {
    const c = await d.checkout(await d.page('pickup')); await d.delivery(c, true); const selection = c.state.delivery_selection?.delivery_selection_id;
    await c.page.getByTestId('sf-tip-15').check(); await d.state(c);
    invariant(c.state.delivery_selection?.delivery_selection_id === selection && c.state.order.requested_tip?.percent === 15, 'TIP_SELECTION_CHANGED');
    const amount = money(c.state.order.pricing_amounts.requested_tip_money); invariant(BigInt(amount.amount) > 0n, 'TIP_NOT_APPLIED');
    await d.summary(c); await d.pay(c); await d.settled(c); return ['PICKUP_TIP_EXACT_AND_SETTLED'];
  },
  'SF-04': async d => {
    const c = await d.checkout(await d.page('discount'));
    await c.page.getByTestId('sf-discount-code').fill('WELCOME10'); await c.page.getByTestId('sf-discount-apply').click(); await d.state(c);
    invariant(BigInt(money(c.state.order.pricing_amounts.discount_money).amount) > 0n, 'DISCOUNT_NOT_APPLIED');
    await c.page.getByTestId('sf-discount-code').fill('INVALID-ACCEPTANCE'); await c.page.getByTestId('sf-discount-apply').click(); await expect(c.page.getByRole('alert')).toBeVisible();
    await d.state(c); const discounts = c.state.order.applied_discounts.map((x: any) => x.order_discount_id); await d.job(c.page, `/checkout/${c.ref}/discount/remove`, { order_discount_ids: discounts }); await c.page.reload(); await d.state(c);
    await d.delivery(c); await c.page.getByTestId('sf-discount-code').fill('WELCOME10'); await c.page.getByTestId('sf-discount-apply').click();
    await d.state(c); invariant(!c.state.delivery_selection && c.state.notices.includes('delivery_released'), 'DISCOUNT_MUST_RELEASE_DELIVERY');
    await expect(c.page.getByTestId('sf-pay-button')).toBeDisabled(); return ['DISCOUNT_INVALID_AND_DELIVERY_RELEASE'];
  },
  'SF-05': async d => {
    const c = await normal(d, 'gift', 'burr-grinder');
    const issued = await d.operator.issueGiftCard('gift-remainder');
    const code = issued.code ?? issued.gift_card_code; invariant(typeof code === 'string', 'PUBLIC_GIFT_CODE_UNAVAILABLE'); d.scanner.addGift(code);
    const before = money(c.state.order.settlement_amounts.outstanding_money);
    await d.applyGift(c,code);
    const allocation = giftAllocation(c.state.order); equalMoney(allocation.gift_card_money, { amount: '2500', currency: 'USD' });
    invariant(BigInt(money(allocation.processor_money).amount) < BigInt(before.amount), 'GIFT_REMAINDER_NOT_REDUCED');
    // One invalid guess only, including reruns. Durable marker is saved before input.
    if (!d.operator.ledger.state.actions['A:invalid-gift-marker']) await d.operator.ledger.action('invalid-gift-marker', 'A', 'local-marker', [], async () => true, async () => {});
    else invariant(false, 'INVALID_GIFT_ALREADY_ATTEMPTED');
    await c.page.getByTestId('sf-gift-card-code').fill('INVALID-ONCE'); await c.page.getByTestId('sf-gift-card-apply').click(); await expect(c.page.getByRole('alert')).toContainText("isn't valid");
    await d.pay(c); const order = await d.settled(c); invariant(order.gift_card_settlements?.length === 1, 'GIFT_SETTLEMENT_MISSING'); return ['GIFT_REVISION_ALLOCATION_AND_ONE_CHARGE'];
  },
  'SF-06': async d => {
    const c = await d.checkout(await d.page('tax')); await expect(c.page.getByTestId('sf-summary-tax')).toContainText('Calculated'); await d.delivery(c); await d.summary(c);
    invariant(BigInt(money(c.state.order.pricing_amounts.tax_money).amount) > 0n, 'TEXAS_TAX_NOT_CALCULATED'); return ['AUTOMATIC_TAX_EQUALS_FLINT'];
  },
  'SF-07': async d => {
    const c = await normal(d, 'decline'); await d.pay(c, '4000000000009995'); await expect(c.page.getByTestId('sf-payment')).toHaveAttribute('data-state', 'declined');
    await expect(c.page.getByTestId('sf-payment-message')).toContainText('declined'); await d.axe(c.page, 'sf-checkout-declined'); await d.pay(c); await d.settled(c, 2); return ['DECLINE_RETRY_TWO_ATTEMPTS_ONE_CHARGE'];
  },
  'SF-08': async d => {
    const success = await normal(d, '3ds-success'); await d.pay(success, '4000002500003155'); await d.challenge(success.page, 'success'); await d.settled(success);
    const failed = await normal(d, '3ds-failed'); await d.pay(failed, '4000002500003155'); await d.challenge(failed.page, 'fail');
    await expect(failed.page.getByTestId('sf-payment')).toHaveAttribute('data-state', 'declined'); await expect(failed.page.getByTestId('sf-payment-message')).toContainText("wasn't completed"); await d.pay(failed); await d.settled(failed); return ['3DS_COMPLETE_FAIL_AND_RECOVERY'];
  },
  'SF-09': async d => {
    const c = await normal(d, 'interrupted'); await d.pay(c, '4000002500003155');
    await expect.poll(async () => (await d.operator.clients.clients.A.orders.listPaymentAttempts(c.orderId)).data.some(a => a.status === 'requires_action')).toBe(true);
    await c.page.reload(); await d.challenge(c.page, 'success'); await d.settled(c, 1);
    const unknown = await normal(d, 'unknown');
    let intercepted = false;
    await unknown.page.route(`**/checkout/${unknown.ref}/pay`, async route => { const response = await route.fetch(); invariant(response.status() < 500, 'UNKNOWN_INJECTION_SERVER_FAILURE'); intercepted = true; await route.abort('failed'); });
    await d.pay(unknown); await expect(unknown.page.getByTestId('sf-payment')).toHaveAttribute('data-state', 'waiting');
    await unknown.page.unroute(`**/checkout/${unknown.ref}/pay`); await unknown.page.reload(); await d.settled(unknown, 1); invariant(intercepted, 'UNKNOWN_RESPONSE_NOT_INJECTED'); return ['INTERRUPTED_AND_UNKNOWN_RECONCILED_ONE_CHARGE'];
  },
  'SF-10': async d => {
    const c = await normal(d, 'duplicate'); await d.card(c.page); const button = c.page.getByTestId('sf-pay-button'); await expect(button).toBeEnabled(); await button.focus();
    await button.dblclick(); await c.page.keyboard.press('Enter'); await d.settled(c, 1); return ['DUPLICATE_SUBMIT_ONE_ATTEMPT'];
  },
  'SF-11': async d => {
    const c = await normal(d, 'mutate'); const variant = d.fixtures.products['stoneware-mug'];
    const reviewAt = new Date(Date.now() + 30 * 86400_000).toISOString();
    const before = (await d.operator.clients.clients.A.orders.get(c.orderId)).line_items.map(l => l.order_line_item_id);
    await d.operator.execute({ name: 'mutate-checkout', sandbox: 'A', operation: 'orders.addLineItems', args: [c.orderId, { line_items: [{ variant_id: variant.variantId, quantity: '1' }] }], creates: [{ type: 'order_line_item', path: 'line_items.0.order_line_item_id', cleanup: 'review', reviewAt }], purpose: 'refresh-checkout' });
    await c.page.reload(); await d.state(c); invariant(c.state.notices.includes('checkout_refreshed') && c.state.order.line_items.some((l: any) => !before.includes(l.order_line_item_id)), 'CHECKOUT_NOT_REFRESHED');
    await d.delivery(c); const oldMoney = money(c.state.order.settlement_amounts.outstanding_money);
    const tab = await c.page.context().newPage(); await tab.goto(c.page.url()); await d.job(tab, `/checkout/${c.ref}/discount`, { promotion_code: 'WELCOME10' }); await d.card(c.page); await c.page.getByTestId('sf-pay-button').click();
    await expect(c.page.getByTestId('sf-payment')).toHaveAttribute('data-state', 'total_changed'); await d.auditKnownStates(c.page); await d.state(c); invariant(c.state.order.settlement_amounts.outstanding_money.amount !== oldMoney.amount, 'TOTAL_DID_NOT_CHANGE');
    await d.delivery(c); await d.pay(c); await d.settled(c); await tab.close(); return ['SESSION_REPLACEMENT_AND_REAPPROVAL'];
  },
  'SF-12': async d => {
    const page = await d.page('b1'); await d.login(page, 'b1', d.sf()); const c = await d.checkout(page); await d.delivery(c);
    const saved = page.locator('[data-testid^="sf-saved-method-"]').first(); await expect(saved).toBeVisible(); await saved.check(); await page.getByTestId('sf-pay-button').click();
    const order = await d.settled(c); invariant(order.customer_id === d.fixtures.buyers.b1.customerId, 'SIGNED_IN_ORDER_BINDING'); await d.goto(page, d.config.origins.accountA, `/orders/${order.order_id}`); await expect(page.getByTestId('ac-order')).toBeVisible(); return ['SIGNED_IN_SAVED_CARD_ACCOUNT_ORDER'];
  },
  'SF-13': async d => {
    const c = await normal(d, 'ach-success', 'brewing-class'); await bank(d, c, 'success');
    await expect.poll(async () => (await d.operator.clients.clients.A.orders.get(c.orderId)).payment_status, { timeout: d.config.suite === 'extended' ? 3600_000 : 600_000, intervals: [5000, 10000] }).toBe('paid');
    await d.trackOrder('A', c.orderId); d.created.set('achPaidOrder', c.orderId); return ['ACH_INSTANT_PROCESSING_THEN_SETTLED'];
  },
  'SF-14': async d => {
    const processing = await normal(d, 'ach-processing', 'brewing-class'); await bank(d, processing, 'processing');
    const order = await d.trackOrder('A', processing.orderId); invariant(order.payment_status === 'unpaid' && order.active_payment_attempt?.status === 'processing' && !order.customer_id, 'ACH_PROCESSING_EXPECTATION'); d.created.set('guestAchOrder', order.order_id); d.created.set('guestAchUnlinkedObserved', '1');
    const fail = await normal(d, 'ach-failure', 'brewing-class'); await bank(d, fail, 'failure');
    await expect.poll(async () => (await d.operator.clients.clients.A.orders.listPaymentAttempts(fail.orderId)).data.some(a => a.status === 'failed' || a.status === 'requires_retry'), { timeout: 600_000, intervals: [5000] }).toBe(true);
    await d.goto(fail.page, d.sf(), `/checkout/${fail.ref}`); await expect(fail.page.getByTestId('sf-payment')).toHaveAttribute('data-state', 'declined'); await expect(fail.page.getByTestId('sf-payment-message')).toContainText('bank'); return ['ACH_PROCESSING_UNPAID_AND_LATER_DECLINE'];
  },
  'SF-15': async d => { const c = await normal(d, 'affirm-approve', 'burr-grinder'); await affirm(d, c, 'approve'); await d.settled(c, 1); d.created.set('affirmCheckout', c.ref); d.created.set('affirmOrder', c.orderId); return ['AFFIRM_APPROVAL_RELAY_AND_SETTLEMENT']; },
  'SF-16': async d => { const c = await normal(d, 'affirm-decline', 'burr-grinder'); await affirm(d, c, 'decline'); await expect(c.page.getByTestId('sf-payment-message')).toContainText("didn't approve"); await d.pay(c); await d.settled(c); return ['AFFIRM_DECLINE_CARD_RECOVERY']; },
  'SF-17': async d => {
    const c = await normal(d, 'affirm-cancel', 'burr-grinder'); await affirm(d, c, 'cancel'); await expect(c.page.getByTestId('sf-affirm-continue')).toBeVisible();
    await c.page.getByTestId('sf-affirm-continue').click(); await (await import('./provider.ts')).providerSteps(d, c.page, 'affirm-cancel');
    await c.page.getByTestId('sf-pay-another-way').click(); if (await c.page.getByTestId('sf-affirm-dialog').isVisible()) await c.page.getByTestId('sf-affirm-dialog-confirm').click(); await d.pay(c); await d.settled(c); return ['AFFIRM_CANCEL_CONTINUE_AND_ALTERNATE_ONE_CHARGE'];
  },
  'SF-18': async d => {
    const ref = d.created.get('affirmCheckout'), id = d.created.get('affirmOrder'); invariant(ref && id, 'AFFIRM_APPROVAL_REQUIRED');
    const page = await d.page('affirm-approve'), before = (await d.operator.clients.clients.A.orders.listPaymentAttempts(id)).data;
    for (let i = 0; i < 3; i++) await d.goto(page, d.sf(), `/checkout/${ref}/return`);
    const after = (await d.operator.clients.clients.A.orders.listPaymentAttempts(id)).data; invariant(before.length === after.length, 'RETURN_REPLAY_NEW_ATTEMPT'); assertOneCharge(await d.operator.clients.clients.A.orders.get(id), after); return ['RETURN_REPLAY_THREE_NO_NEW_ATTEMPTS'];
  },
  'SF-19': async d => { const { sub, c } = await subscription(d, false); await d.goto(c.page, d.config.origins.accountA, `/subscriptions/${sub.subscription_id}`); await expect(c.page.getByTestId('ac-subscription')).toBeVisible(); return ['PAID_SUBSCRIPTION_TERMS_AND_ACCOUNT']; },
  'SF-20': async d => { const after = new Date(), { sub } = await subscription(d, true); const mail = await d.email('b1', after, 'subscription_lifecycle'); const page = await d.page('subscription-email'); await page.goto(d.emailLink(mail, 'flint_account_link_relay')); await d.form(page, '/sign-in', { email: d.fixtures.buyers.b1.email, password: d.fixtures.buyers.b1.password }); invariant(new URL(page.url()).pathname === `/subscriptions/${sub.subscription_id}`, 'SUBSCRIPTION_EMAIL_RESOURCE_DESTINATION'); await expect(page.getByTestId('ac-subscription')).toBeVisible(); return ['ZERO_TRIAL_SETUP_AND_LIFECYCLE_EMAIL']; },
  'SF-21': async d => {
    const ttl = d.fixtures.values.checkoutMinimumTtlSeconds; invariant(typeof ttl === 'number' && ttl > 0, 'CHECKOUT_MINIMUM_TTL_REQUIRED');
    const c = await normal(d, 'expiry'); await c.page.waitForTimeout((ttl + 2) * 1000); await c.page.reload(); await d.state(c); invariant(c.state.notices.includes('checkout_refreshed'), 'EXPIRED_SESSION_NOT_REPLACED');
    await d.delivery(c); await d.pay(c, '4000002500003155'); await c.page.waitForTimeout((ttl + 2) * 1000); await c.page.reload(); await expect(c.page.getByTestId('sf-payment')).toHaveAttribute('data-state', 'recovery'); await d.challenge(c.page, 'success'); await d.settled(c, 1); return ['EXPIRY_REPLACEMENT_AND_INFLIGHT_RECOVERY'];
  },
  'SF-22': async d => { const c = await normal(d, 'headless-wallet'); await expect(c.page.getByTestId('sf-wallets')).toBeHidden(); await d.card(c.page); await expect(c.page.getByTestId('sf-pay-button')).toBeEnabled(); invariant(d.guards.get(c.page.context())!.consoleErrors === 0, 'BROWSER_CONSOLE_ERROR'); return ['HEADLESS_WALLETS_HIDDEN_CARD_USABLE']; },
  'SF-22M': walletScenario,
  'SF-23': async d => {
    const c = await normal(d, 'security'); const rejected = await d.job(c.page, `/checkout/${c.ref}/tip`, { percent: 15 }, { noCsrf: true }); invariant(rejected.status === 403, 'CSRF_NOT_REJECTED');
    const foreign = await d.page('foreign'); await d.goto(foreign, d.sf(), '/'); const response = await d.job(foreign, `/checkout/${c.ref}/state`); invariant(response.status === 404, 'CROSS_SESSION_CHECKOUT_VISIBLE');
    let limited = false;
    for (let i = 0; i < 50 && !limited; i++) limited = (await d.job(foreign, '/sign-in', { email: 'invalid@example.invalid', password: 'incorrect-placeholder' })).status === 429;
    invariant(limited, 'RATE_LIMIT_NOT_ENFORCED'); await d.guardCheck(); return ['CSRF_CHECKOUT_ISOLATION_RATE_LIMIT'];
  },
  'SF-24': async d => {
    const page = await d.page('b1b', 'B'), c = await d.checkout(page, 'brewing-class', 'B', 'b1b');
    await page.getByTestId('sf-save-card').check(); const after = new Date(); await d.job(page, `/checkout/${c.ref}/verification`, { purpose: 'save_payment_method', channel: 'email', email: d.fixtures.buyers.b1b.email });
    const mail = await d.email('b1b', after, 'checkout_verification'); await d.job(page, `/checkout/${c.ref}/verification/confirm`, { code: mail.codes[0] }); await page.reload(); await d.pay(c); await d.settled(c);
    const next = await d.checkout(page, 'brewing-class', 'B', 'b1b'); const returning = await d.email('b1b', new Date(Date.now() - 5000), 'checkout_verification');
    await page.getByTestId('sf-returning-code').fill(returning.codes[0]); await d.form(page, `/checkout/${next.ref}/verification/confirm`); const saved = page.locator('[data-testid^="sf-saved-method-"]').first(); await expect(saved).toBeVisible(); await saved.check(); await page.getByTestId('sf-pay-button').click(); await d.settled(next);
    const phone = d.fixtures.values.sandboxSmsPhone; invariant(phone, 'SMS_FIXTURE_REQUIRED');
    const sms = await d.checkout(await d.page('phone-save', 'B'), 'brewing-class', 'B', 'b1b'); await sms.page.getByTestId('sf-save-card').check(); await sms.page.getByTestId('sf-save-phone').fill(phone); await d.pay(sms); await d.settled(sms);
    for (const code of ['000000', '999999', '123456']) {
      if (code === '000000') await d.job(sms.page, `/checkout/${sms.ref}/verification`, { purpose: 'confirm_saved_payment_method', channel: 'sms' });
      const r = await d.job(sms.page, `/checkout/${sms.ref}/verification/confirm`, { code }); invariant(code === '123456' ? r.status === 200 : r.status >= 400, 'SANDBOX_SMS_RULE');
    }
    return ['HOSTED_MODE_EMAIL_AND_SMS_SAVED_METHOD'];
  },
  'SF-25': async d => { const c = await d.checkout(await d.page('service'), 'brewing-class'); await expect(c.page.getByTestId('sf-delivery')).toBeHidden(); await d.pay(c); await d.settled(c); return ['SERVICE_WITHOUT_DELIVERY_SETTLED']; },
};
