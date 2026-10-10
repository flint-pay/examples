import { expect } from '@playwright/test';
import type { Driver } from '../support/driver.ts';
import type { Scenario } from './storefront.ts';
import { providerSteps, bank } from './provider.ts';
import { invariant, apiFailure, emit } from '../support/safe.ts';
import { equalMoney, money, assertOneCharge } from '../support/money.ts';
import { createBuyerClient, buyerInvoiceLaunch, hostedInvoiceLaunch, beginHostedAuthentication } from '../support/public-actions.ts';
import { exerciseOwnSessionRefresh } from '../support/owned-sessions.ts';
import { auditEmail, CHECKOUT_ORIGIN } from '../support/email-links.ts';
import { AppVault, anonymousSessionClient, sessionCall, assertVaultScans, verifyVaultAuthority } from '../support/app-vault.ts';
import type { SealedCredential, VaultSnapshot } from '../support/app-vault.ts';
import { runChild } from '../support/child.ts';
import { checkoutRoot } from '../support/private-files.ts';
import { join } from 'node:path';
import type { Client } from '@flintpay/node';
import { syncAppAudit, revocationCheckpoint, assertFreshRevocation } from '../support/audit-feed.ts';

async function signed(d: Driver, buyer: 'b1' | 'b2' | 'd' = 'b1') {
  const page = await d.page(buyer); if (!d.fixtures.buyers[buyer].verified) await d.signup(page, buyer); else await d.login(page, buyer); return page;
}
async function fixture(d: Driver, name: string): Promise<any> {
  const v = d.fixtures.values[name] ?? d.created.get(name); invariant(v, 'SCENARIO_FIXTURE_REQUIRED'); return v;
}
export async function namedPlan(d: Driver, name: string, refs: Record<string, string> = {}): Promise<void> {
  const steps = d.fixtures.values.plans?.[name]; invariant(Array.isArray(steps) && steps.length, 'OPERATOR_PLAN_REQUIRED');
  const replace = (v: any): any => typeof v === 'string' && v.startsWith('$') ? refs[v.slice(1)] ?? v : Array.isArray(v) ? v.map(replace) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replace(x)])) : v;
  for (const step of steps) await d.operator.execute(replace(step));
}
async function accountPayment(d: Driver, id: string, method: 'card' | 'affirm' | 'ach' = 'card', surface = 'invoices', declineFirst = false): Promise<void> {
  d.requireOwned('A', id); const page = await signed(d); await d.goto(page, d.config.origins.accountA, `/${surface}/${id}/pay`);
  await expect(page.getByTestId('ac-payment')).toHaveAttribute('data-state', 'ready');
  await d.axe(page, 'ac-invoice-pay-ready');
  if (declineFirst) {
    await d.card(page, '4000000000009995'); await expect(page.getByTestId('ac-pay-button')).toBeEnabled(); await page.getByTestId('ac-pay-button').click();
    await expect(page.getByTestId('ac-payment')).toHaveAttribute('data-state', 'declined'); await d.auditKnownStates(page);
  }
  if (method === 'card') await d.card(page); else await providerSteps(d, page, method === 'affirm' ? 'affirm-select' : 'ach-account-instant');
  await expect(page.getByTestId('ac-pay-button')).toBeEnabled(); await page.getByTestId('ac-pay-button').click();
  if (method === 'affirm') await providerSteps(d, page, 'affirm-approve');
  await page.waitForURL(new RegExp(`/${surface}/${id}(?:\\?|$)`), { timeout: 60_000 });
}
export const account: Record<string, Scenario> = {
  'AC-01': async d => {
    const card = await fixture(d, 'guestCardOrder'), ach = await fixture(d, 'guestAchOrder');
    invariant(d.created.get('guestAchUnlinkedObserved') === '1', 'GUEST_ACH_MUST_BE_UNLINKED_BEFORE_VERIFICATION');
    const page = await d.page('b1');
    if (!d.fixtures.buyers.b1.verified) await d.signup(page, 'b1');
    else if ((await d.operator.clients.clients.A.orders.get(ach)).customer_id !== d.fixtures.buyers.b1.customerId) {
      await d.login(page, 'b1'); await d.goto(page, d.config.origins.accountA, '/link-purchases'); const after = new Date(); await d.form(page, '/link-purchases/send'); const mail = await d.email('b1', after, 'verification'); await d.form(page, '/link-purchases/confirm', { code: mail.codes[0] });
      await expect(page.getByTestId('ac-link-result')).toHaveAttribute('data-count', '1');
    }
    else await d.login(page, 'b1');
    const customer = d.fixtures.buyers.b1.customerId; invariant(customer, 'BUYER_BINDING_REQUIRED');
    for (const id of [card, ach]) {
      invariant((await d.operator.clients.clients.A.orders.get(id)).customer_id === customer, 'GUEST_ORDER_NOT_LINKED'); await d.goto(page, d.config.origins.accountA, `/orders/${id}`); await expect(page.getByTestId('ac-order')).toBeVisible();
    }
    const other = await signed(d, 'b2'); await d.goto(other, d.config.origins.accountA, `/orders/${card}`); await expect(other.getByTestId('ac-notice')).toContainText("isn't in");
    const link = d.created.get('receiptLink'); if (link) { await d.form(page, '/sign-out'); await page.goto(link); await d.form(page, '/sign-in', { email: d.fixtures.buyers.b1.email, password: d.fixtures.buyers.b1.password }); await expect(page.getByTestId('ac-order')).toBeVisible(); }
    return ['VERIFIED_GUEST_LINKING_BOTH_ORDERS_FOREIGN_USER_DENIED'];
  },
  'AC-02': async d => {
    const page = await signed(d); await d.goto(page, d.config.origins.accountA, '/link-purchases'); await d.form(page, '/link-purchases/send');
    await d.form(page, '/link-purchases/confirm', { code: '000000' }); await expect(page.getByRole('alert')).toContainText("isn't right");
    await page.waitForTimeout(31_000); const after = new Date(); await d.form(page, '/link-purchases/send'); const mail = await d.email('b1', after, 'verification'); await d.form(page, '/link-purchases/confirm', { code: mail.codes[0] });
    // Supplied proof IDs come from an independently sanctioned public verification flow.
    // The harness never reads app sessions or a verification code from the database.
    const proofs = await fixture(d, 'guestLinkProofs');
    const c = await d.operator.clients.writable('A');
    const mismatch = await c.customers.linkGuestPurchases(d.fixtures.buyers.b2.customerId!, { customer_verification_id: proofs.otherCustomerVerificationId }, { idempotencyKey: `${d.config.run}-mismatch` }).then(() => null, e => e);
    invariant(mismatch?.code === 'CUSTOMER_VERIFICATION_CUSTOMER_MISMATCH', 'VERIFICATION_CUSTOMER_MISMATCH_REQUIRED');
    const used = await c.customers.linkGuestPurchases(d.fixtures.buyers.b1.customerId!, { customer_verification_id: proofs.usedVerificationId }, { idempotencyKey: `${d.config.run}-proof-reuse-new-key` }).then(() => null, e => e);
    invariant(used?.code === 'CUSTOMER_VERIFICATION_USED', 'VERIFICATION_ONE_USE_REQUIRED'); return ['WRONG_CODE_RESEND_MISMATCH_AND_USED_PROOF'];
  },
  'AC-03': async d => {
    const id = await fixture(d, 'guestCardOrder'), shippedAfter = new Date(); await namedPlan(d, 'shipOrder', { orderId: id });
    await d.email('b1', shippedAfter, 'fulfillment_updates');
    const page = await signed(d); await d.goto(page, d.config.origins.accountA, `/orders/${id}`); const events = page.locator('[data-testid^="ac-tracking-event-"]'); await expect(events.first()).toBeVisible();
    const times = await events.evaluateAll(es => es.map(e => e.querySelector('time')?.getAttribute('datetime'))); invariant(times.every((t, i) => t && (i === 0 || Date.parse(times[i - 1]!) >= Date.parse(t))), 'TRACKING_EVENT_SORT');
    const tracking = await fixture(d, 'trackingNumber'); await expect(page.getByTestId('ac-order')).toContainText(tracking);
    const after = new Date(); await page.getByTestId('ac-send-receipt').click(); await d.email('b1', after, 'order_receipts');
    await d.goto(page, d.config.origins.accountA, `/orders/${id}/receipt`); await expect(page.getByRole('heading')).toBeVisible(); await d.axe(page, 'ac-order'); return ['DELIVERY_EVENTS_TRACKING_RECEIPT'];
  },
  'AC-04': async d => {
    const families = ['order_receipts', 'fulfillment_updates', 'subscription_lifecycle', 'returns', 'invoices'];
    for (const family of families) invariant(d.mails.some(m => m.family === family), 'EMAIL_FAMILY_NOT_OBSERVED');
    let followed = 0;
    for (const item of d.mails.filter(m => families.includes(m.family) || m.family === 'dunning')) {
      const links = item.classifications.flatMap((c, i) => c.role === 'flint_account_link_relay' && c.verdict === 'pass' ? [item.mail.links[i].href] : []);
      invariant(links.length > 0, 'EMAIL_ACCOUNT_RELAY_REQUIRED');
      for (const link of links) {
        const page = await d.page(`email-${item.family}-${followed++}`); await page.goto(link); await expect(page.locator('form[action="/sign-in"]')).toBeVisible();
        await d.form(page, '/sign-in', { email: d.fixtures.buyers.b1.email, password: d.fixtures.buyers.b1.password });
        const url = new URL(page.url()); invariant(url.origin === d.config.origins.accountA && /^\/(orders|subscriptions|returns|invoices)\/[A-Za-z0-9_-]+$/.test(url.pathname), 'EMAIL_RESOURCE_DESTINATION_REQUIRED');
        invariant(!url.searchParams.has('flint_resource_type') && !url.searchParams.has('flint_environment_id') && !url.hash, 'RESOURCE_HINT_NOT_CONSUMED');
        const other = await signed(d, 'b2'); await other.goto(link); await expect(other.getByTestId('ac-notice')).toContainText("isn't in");
        const type = ({ orders: 'order', subscriptions: 'subscription', returns: 'return', invoices: 'invoice' } as Record<string, string>)[url.pathname.split('/')[1]];
        url.searchParams.set('flint_resource_type', type); url.searchParams.set('flint_environment_id', d.config.pins.B.sandboxId); await page.goto(url.href); await expect(page.getByTestId('ac-notice')).toContainText('different');
        url.searchParams.set('flint_environment_id', d.config.pins.A.sandboxId); url.searchParams.set('flint_resource_type', 'unknown'); await page.goto(url.href); invariant(new URL(page.url()).pathname === '/', 'UNKNOWN_HINT_HOME_REQUIRED');
      }
    }
    invariant(followed > 0, 'EMAIL_RELAYS_NOT_EXERCISED'); return ['ALL_EMAIL_HINT_FAMILIES_AUDITED_RELAYS_AUTH_OWNERSHIP_ENVIRONMENT'];
  },
  'AC-05': async d => {
    const after = new Date(); const invoice = await d.operator.issueInvoice('acceptance-invoice', d.fixtures.buyers.b1.customerId!, d.fixtures.buyers.b1.email);
    const mail = await d.email('b1', after, 'invoices'); const invoiceLink = d.emailLink(mail, 'flint_account_link_relay');
    const page = await signed(d); await page.goto(invoiceLink); invariant(new URL(page.url()).pathname === `/invoices/${invoice.invoice_id}`, 'INVOICE_EMAIL_RESOURCE_DESTINATION'); await d.goto(page, d.config.origins.accountA, `/invoices/${invoice.invoice_id}/pay`);
    const first = await d.job(page, `/invoices/${invoice.invoice_id}/pay/attempt`); await page.reload(); const second = await d.job(page, `/invoices/${invoice.invoice_id}/pay/attempt`);
    invariant(first.status === 200 && second.status === 200, 'INVOICE_RELAUNCH_READ_FAILED');
    const firstOrderId = first.body?.state?.order?.order_id, secondOrderId = second.body?.state?.order?.order_id;
    invariant(typeof firstOrderId === 'string' && firstOrderId.length > 0 && typeof secondOrderId === 'string' && secondOrderId.length > 0, 'INVOICE_RELAUNCH_ORDER_MISSING');
    invariant(firstOrderId === secondOrderId, 'INVOICE_RELAUNCH_CHANGED_ORDER');
    const buyer = await createBuyerClient(d, 'invoice-buyer-authority', d.fixtures.buyers.b1.customerId!);
    const reused = await buyerInvoiceLaunch(d, buyer, 'invoice-reuse', invoice.invoice_id); invariant(reused.reused_existing === true, 'INVOICE_SESSION_NOT_REUSED');
    const idle = await d.operator.issueInvoice('idle-invoice', d.fixtures.buyers.b1.customerId!, d.fixtures.buyers.b1.email);
    const hosted = await hostedInvoiceLaunch(d, 'idle-hosted', idle.invoice_id); const embedded = await buyerInvoiceLaunch(d, buyer, 'idle-embedded-replace', idle.invoice_id);
    invariant(embedded.reused_existing === false && embedded.checkout_session.surface === 'embedded' && hosted.checkout_session.checkout_session_id !== embedded.checkout_session.checkout_session_id, 'HOSTED_IDLE_NOT_REPLACED');
    const conflict = await d.operator.issueInvoice('conflict-invoice', d.fixtures.buyers.b1.customerId!, d.fixtures.buyers.b1.email);
    const pending = await hostedInvoiceLaunch(d, 'conflict-hosted', conflict.invoice_id); await beginHostedAuthentication(d, 'conflict-hosted-pay', pending);
    await d.goto(page, d.config.origins.accountA, `/invoices/${conflict.invoice_id}/pay`); await expect(page.getByTestId('ac-invoice-pay')).toHaveAttribute('data-state', 'surface_conflict');
    await accountPayment(d, invoice.invoice_id, 'card', 'invoices', true);
    const value = await d.operator.clients.clients.A.invoices.get(invoice.invoice_id); invariant(value.status === 'paid', 'INVOICE_NOT_PAID');
    assertOneCharge(await d.operator.clients.clients.A.orders.get(value.order_id), (await d.operator.clients.clients.A.orders.listPaymentAttempts(value.order_id)).data);
    const pdf = await page.getByTestId('ac-invoice-pdf').getAttribute('href'); invariant(pdf && new URL(pdf, page.url()).origin === d.config.origins.accountA, 'PDF_MUST_BE_APP_ORIGIN');
    const result = await page.request.get(new URL(pdf, page.url()).href, { maxRedirects: 0 }); invariant(result.ok() && result.headers()['content-type'].includes('application/pdf') && (await result.body()).subarray(0, 5).toString() === '%PDF-', 'PDF_NOT_VALID');
    d.created.set('invoice', invoice.invoice_id); return ['EMBEDDED_INVOICE_PAY_REUSE_CONFLICT_AND_PDF'];
  },
  'AC-05A': async d => {
    for (const method of ['affirm', 'ach'] as const) {
      const invoice = await d.operator.issueInvoice(`invoice-${method}`, d.fixtures.buyers.b1.customerId!, d.fixtures.buyers.b1.email); await accountPayment(d, invoice.invoice_id, method);
      const actual = await d.operator.clients.clients.A.invoices.get(invoice.invoice_id); invariant(method === 'affirm' ? actual.status === 'paid' : actual.status !== 'paid', 'INVOICE_PROVIDER_OUTCOME');
      const order = await d.trackOrder('A', actual.order_id); invariant(method === 'affirm' ? order.payment_status === 'paid' : order.active_payment_attempt?.status === 'processing', 'INVOICE_PROVIDER_ATTEMPT');
    }
    return ['INVOICE_AFFIRM_PAID_ACH_PROCESSING'];
  },
  'AC-06': async d => {
    const orderId = await fixture(d, 'returnEligibleOrder'); d.requireOwned('A', orderId); const page = await signed(d); await d.goto(page, d.config.origins.accountA, `/orders/${orderId}/return`);
    await page.locator('[data-testid^="ac-return-line-"]').first().check(); const reason = page.locator('[data-testid^="ac-return-reason-"]').first(); await reason.selectOption(await fixture(d, 'returnReasonId'));
    await page.getByTestId('ac-return-submit').click(); await page.waitForURL(/\/returns\/[^/]+$/); const id = new URL(page.url()).pathname.split('/')[2]; await d.track('A', 'return', id, 'review');
    const returnedAfter = new Date(); await namedPlan(d, 'decideReturnAsExchange', { returnId: id }); await d.email('b1', returnedAfter, 'returns'); await page.reload(); await expect(page.getByTestId('ac-return-pay')).toBeVisible();
    const before = await d.operator.clients.clients.A.returnResolutions.list({ return_id: id }); const resolution = before.data.find(r => r.execution_blockers.some(b => b.code === 'buyer_payment_pending')); invariant(resolution, 'EXCHANGE_BALANCE_NOT_PENDING');
    await d.track('A', 'return_resolution', resolution.return_resolution_id, 'return_resolution');
    await accountPayment(d, id, 'card', 'returns'); invariant(resolution.replacement_order_id, 'REPLACEMENT_ORDER_MISSING'); const replacement = await d.trackOrder('A', resolution.replacement_order_id); invariant(replacement.payment_status === 'paid' && replacement.return_credit_settlements?.length, 'RETURN_CREDIT_AND_SETTLEMENT');
    invariant(!(await d.operator.clients.clients.A.returnResolutions.get(resolution.return_resolution_id)).execution_blockers.some(b => b.code === 'buyer_payment_pending'), 'RESOLUTION_STILL_PENDING');
    const withdraw = await fixture(d, 'withdrawReturnId'); d.requireOwned('A', withdraw); await d.goto(page, d.config.origins.accountA, `/returns/${withdraw}`); await page.getByTestId('ac-return-withdraw').click(); invariant((await d.operator.clients.clients.A.returns.get(withdraw)).status === 'canceled', 'RETURN_WITHDRAW_FAILED');
    await d.axe(page, 'ac-return'); return ['BUYER_RETURN_EXCHANGE_CREDIT_EMBEDDED_BALANCE_WITHDRAW'];
  },
  'AC-07': async d => {
    const id = await fixture(d, 'paidSubscription'), page = await signed(d); d.requireOwned('A', id); await d.goto(page, d.config.origins.accountA, `/subscriptions/${id}`);
    await page.getByTestId('ac-sub-action-pause').click(); await d.form(page, `/subscriptions/${id}/pause`, { cycles: '2' }); invariant((await d.operator.clients.clients.A.subscriptions.get(id)).status === 'paused', 'SUBSCRIPTION_NOT_PAUSED');
    await page.getByTestId('ac-sub-action-resume').click(); invariant((await d.operator.clients.clients.A.subscriptions.get(id)).status === 'active', 'SUBSCRIPTION_NOT_RESUMED');
    await page.getByTestId('ac-sub-action-cancel').click(); await expect(page.getByRole('dialog')).toContainText('Pause'); await d.form(page, `/subscriptions/${id}/cancel`, { reason: 'too_expensive' }); invariant((await d.operator.clients.clients.A.subscriptions.get(id)).cancel_at_period_end, 'CANCEL_NOT_SCHEDULED');
    await page.getByTestId('ac-sub-action-reactivate').click(); invariant(!(await d.operator.clients.clients.A.subscriptions.get(id)).cancel_at_period_end, 'SUBSCRIPTION_NOT_REACTIVATED');
    const method = await fixture(d, 'alternateOffSessionMethod'); await d.job(page, `/subscriptions/${id}/payment-method`, { payment_method_id: method }); invariant((await d.operator.clients.clients.A.subscriptions.get(id)).payment_method_id === method, 'SUBSCRIPTION_METHOD_NOT_CHANGED');
    const second = await fixture(d, 'secondSubscription'); d.requireOwned('A', second); await d.goto(page, d.config.origins.accountA, `/subscriptions/${second}`); await page.getByTestId('ac-sub-action-cancel').click(); await d.job(page, `/subscriptions/${second}/cancel`, { cancel_immediately: true, cancellation_reason_code: 'unused' }); invariant((await d.operator.clients.clients.A.subscriptions.get(second)).status === 'canceled', 'IMMEDIATE_CANCEL_FAILED'); await d.axe(page, 'ac-subscription'); return ['SUBSCRIPTION_PAUSE_RESUME_CANCEL_KEEP_METHOD_RETENTION'];
  },
  'AC-08': async d => {
    const id = await fixture(d, 'pastDueSubscription'), after = new Date(); d.requireOwned('A', id); await namedPlan(d, 'makePastDue', { subscriptionId: id });
    await expect.poll(async () => (await d.operator.clients.clients.A.subscriptions.get(id)).status, { timeout: 15 * 60_000, intervals: [5000] }).toBe('past_due'); const mail = await d.email('b1', after, 'dunning'); const dunningLink = d.emailLink(mail, 'flint_account_link_relay');
    const page = await signed(d); await page.goto(dunningLink); invariant(new URL(page.url()).pathname === `/subscriptions/${id}`, 'DUNNING_RESOURCE_DESTINATION'); await d.job(page, `/subscriptions/${id}/payment-method`, { payment_method_id: await fixture(d, 'alternateOffSessionMethod') });
    const responses = await Promise.all([d.job(page, `/subscriptions/${id}/retry-payment`, {}), d.job(page, `/subscriptions/${id}/retry-payment`, {})]);
    invariant(responses.some(r => r.body?.error?.code === 'SUBSCRIPTION_PAYMENT_RETRY_IN_PROGRESS'), 'DOUBLE_RETRY_NOT_REJECTED');
    await expect.poll(async () => (await d.operator.clients.clients.A.subscriptions.get(id)).status, { timeout: 60_000 }).toBe('active'); await page.reload(); await expect(page.getByTestId('ac-retry-status')).toHaveAttribute('data-state', 'succeeded'); return ['REAL_PAST_DUE_DUNNING_BUYER_RETRY_AND_DUPLICATE'];
  },
  'AC-09': async d => {
    const page = await signed(d);
    const customer = d.fixtures.buyers.b1.customerId!; d.requireOwned('A', customer);
    const before = (await d.operator.clients.clients.A.paymentMethods.list({ customer_id: customer })).data.map(m => m.payment_method_id);
    for (const number of ['4242424242424242', '4000002500003155']) {
      const responsePromise = page.waitForResponse(r => new URL(r.url()).pathname === '/payment-methods/new/setup' && r.request().method() === 'POST');
      await d.goto(page, d.config.origins.accountA, '/payment-methods/new'); const response = await responsePromise; const body = await response.json(); invariant(body.payment_method?.status === 'pending', 'SAVED_CARD_MUST_START_PENDING');
      await d.track('A', 'payment_method', body.payment_method.payment_method_id, 'payment_method');
      await d.card(page, number); await page.getByTestId('ac-card-save').click();
      if (number !== '4242424242424242') await d.challenge(page, 'success');
      await expect.poll(async () => (await d.operator.clients.clients.A.paymentMethods.get(body.payment_method.payment_method_id)).status, { timeout: 60_000 }).toBe('active');
    }
    const cards = (await d.operator.clients.clients.A.paymentMethods.list({ customer_id: customer })).data.filter(m => !before.includes(m.payment_method_id)); invariant(cards.length === 2, 'SAVED_CARD_COUNT');
    await d.goto(page, d.config.origins.accountA, '/payment-methods'); const card = page.getByTestId(`ac-card-${cards[0].payment_method_id}`); await card.locator('form[action$="/default"] button').click();
    invariant((await d.operator.clients.clients.A.customers.get(customer)).default_payment_method_id === cards[0].payment_method_id, 'DEFAULT_METHOD_NOT_SET');
    const remove = page.getByTestId(`ac-card-${cards[1].payment_method_id}`); await remove.getByTestId('ac-card-remove').click(); await expect(page.getByRole('dialog')).toBeVisible(); await page.getByRole('dialog').getByRole('button', { name: /remove/i }).click(); await expect(remove).toHaveCount(0); await d.axe(page, 'ac-payment-methods'); return ['CARD_PENDING_ACTIVE_3DS_DEFAULT_REMOVE'];
  },
  'AC-10': async d => {
    const page = await signed(d, 'b2'); d.requireOwned('A', d.fixtures.buyers.b2.customerId!); await d.goto(page, d.config.origins.accountA, '/profile'); await d.form(page, '/profile', { name: 'Updated acceptance buyer', phone: '+12025550123' });
    const customer = await d.operator.clients.clients.A.customers.get(d.fixtures.buyers.b2.customerId!); invariant(customer.name === 'Updated acceptance buyer' && customer.phone === '+12025550123', 'PROFILE_UPDATE_NOT_SAVED');
    const newEmail = await fixture(d, 'b2NewEmail'), after = new Date(); await d.goto(page, d.config.origins.accountA, '/profile/email'); await d.form(page, '/profile/email', { new_email: newEmail });
    const current = await d.email('b2', after, 'email_change'); invariant(current.codes.length === 1 && !d.mails.find(m => m.mail === current)!.classifications.some(c => c.verdict === 'pass'), 'CURRENT_EMAIL_CODE_ONLY');
    invariant(d.inbox, 'INBOX_PREREQUISITE'); const next = await d.inbox.waitForEmail({ to: newEmail, after }); const nextLinks = auditEmail(next, 'email_change', { appOrigins: Object.values(d.config.origins), apiOrigin: d.config.apiOrigin, checkoutOrigin: CHECKOUT_ORIGIN, merchantSupportUrl: d.supportUrls.get('A') }); invariant(next.codes.length === 1 && !nextLinks.some(c => c.verdict === 'pass'), 'NEW_EMAIL_CODE_ONLY');
    await page.getByTestId('ac-email-code-current').fill(current.codes[0]); await page.getByTestId('ac-email-code-new').fill(next.codes[0]); await d.form(page, '/profile/email/confirm');
    d.fixtures.buyers.b2.email = newEmail; await d.form(page, '/sign-out'); await d.login(page, 'b2'); await d.axe(page, 'ac-profile-email'); return ['PROFILE_BOTH_EMAIL_CODES_NEW_EMAIL_LOGIN'];
  },
  'AC-11': async d => {
    const page = await signed(d), customer = d.fixtures.buyers.b1.customerId!; d.requireOwned('A', customer);
    invariant((await d.operator.clients.clients.A.customers.listAddresses(customer)).data.length === 0, 'FIRST_ADDRESS_FIXTURE_REQUIRED');
    await d.goto(page, d.config.origins.accountA, '/addresses/new'); await d.form(page, '/addresses', { ...d.fixtures.values.shippingAddress, recipient_name: 'Acceptance buyer', label: 'Acceptance address' });
    const addresses = (await d.operator.clients.clients.A.customers.listAddresses(customer)).data; invariant(addresses.length === 1 && addresses[0].is_default_shipping && addresses[0].is_default_billing, 'FIRST_ADDRESS_DEFAULTS');
    const id = addresses[0].customer_address_id; await d.track('A', 'address', id, 'review'); await d.goto(page, d.config.origins.accountA, `/addresses/${id}/edit`); await d.form(page, `/addresses/${id}`, { label: 'Updated acceptance address' });
    await d.job(page, `/addresses/${id}/default`, { purpose: 'shipping' }); const c = await d.checkout(page); invariant(c.state.order.delivery_destination?.address || c.state.session.customer_prefill, 'DEFAULT_ADDRESS_NOT_PREFILLED');
    await d.goto(page, d.config.origins.accountA, '/addresses'); await d.job(page, `/addresses/${id}/delete`, {}); invariant((await d.operator.clients.clients.A.customers.listAddresses(customer)).data.length === 0, 'ADDRESS_NOT_REMOVED'); return ['ADDRESS_DEFAULTS_EDIT_PREFILL_DELETE'];
  },
  'AC-12': async d => {
    const page = await signed(d), after = new Date(); d.requireOwned('A', d.fixtures.buyers.b1.customerId!);
    const issued = await d.operator.issueGiftCard('account-gift', '2500', d.fixtures.buyers.b1.email), id = issued.gift_card.gift_card_id;
    const code = issued.code ?? issued.gift_card_code; invariant(code, 'GIFT_CODE_REQUIRED'); d.scanner.addGift(code);
    const mail = await d.email('b1', after, 'gift_card_notification'), link = d.emailLink(mail, 'flint_hosted_gift_recipient_access');
    const token = new URLSearchParams(new URL(link).hash.slice(1)).get('token'); invariant(token, 'GIFT_RECIPIENT_TOKEN_REQUIRED'); d.scanner.addGift(token);
    await d.goto(page, d.config.origins.accountA, '/gift-cards/add?tab=link');
    await page.getByTestId('ac-gift-card-add-link').fill(link); await page.getByTestId('ac-gift-card-link-submit').click();
    await expect(page.getByTestId('ac-gift-card-available')).toHaveAttribute('data-amount-minor', '2500');
    await expect(page.getByTestId('ac-gift-card-history')).toBeVisible(); await expect(page.locator('[data-testid^="ac-gift-card-tx-"]').first()).toBeVisible();
    invariant(new URL(page.url()).pathname === `/gift-cards/${id}`, 'RECIPIENT_PROOF_MUST_SAVE_FIRST');
    await d.job(page, `/gift-cards/${id}/remove`, {}); await d.goto(page, d.config.origins.accountA, '/gift-cards'); await expect(page.getByTestId(`ac-gift-card-${id}`)).toHaveCount(0);
    await d.goto(page, d.config.origins.accountA, '/gift-cards/add'); await page.getByTestId('ac-gift-card-add-code').fill(code); await page.getByTestId('ac-gift-card-code-submit').click();
    invariant(new URL(page.url()).pathname === `/gift-cards/${id}`, 'CODE_SAVE_CARD_ID_MISMATCH'); await expect(page.getByTestId('ac-gift-card-available')).toHaveAttribute('data-amount-minor', '2500');
    await d.job(page, `/gift-cards/${id}/remove`, {});
    invariant(!d.operator.ledger.state.actions['A:invalid-account-gift-marker'], 'INVALID_GIFT_ALREADY_ATTEMPTED');
    await d.operator.ledger.action('invalid-account-gift-marker', 'A', 'local-marker', [], async () => true, async () => {});
    invariant(!d.created.has('invalidAccountGift'), 'INVALID_GIFT_ALREADY_ATTEMPTED'); d.created.set('invalidAccountGift', '1');
    await d.goto(page, d.config.origins.accountA, '/gift-cards/add'); await page.getByTestId('ac-gift-card-add-code').fill('INVALID-ACCOUNT-ONCE'); await page.getByTestId('ac-gift-card-code-submit').click(); await expect(page.getByRole('alert')).toContainText("isn't valid");
    await d.goto(page, d.config.origins.accountA, '/gift-cards/add?tab=link'); let saves = 0;
    const listener = (r: import('@playwright/test').Request) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/gift-cards') saves++; }; page.on('request', listener);
    await page.getByTestId('ac-gift-card-add-link').fill('https://example.invalid/gift-cards/invalid#token=PLACEHOLDER'); await page.getByTestId('ac-gift-card-link-submit').click(); await expect(page.getByTestId('ac-gift-card-link-error')).toBeVisible(); page.off('request', listener); invariant(saves === 0, 'MALFORMED_GIFT_LINK_MUST_NOT_SAVE');
    return ['GIFT_RECIPIENT_PROOF_FIRST_CODE_SECOND_NO_HOSTED_NAVIGATION'];
  },
  'AC-13': async d => {
    const mail = d.mails.find(m => m.family === 'fulfillment_updates')?.mail; invariant(mail, 'FULFILLMENT_EMAIL_REQUIRED'); const link = d.emailLink(mail, 'flint_email_preferences_relay');
    const page = await d.page('unsubscribe'); let token: string | null = null; page.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/email-preferences/lookup') { try { token = r.postDataJSON().token; } catch {} } }); await page.goto(link); await expect(page.getByTestId('ac-email-preferences')).toHaveAttribute('data-state', 'token-confirm'); invariant(!new URL(page.url()).hash, 'TOKEN_FRAGMENT_NOT_REMOVED');
    await page.getByTestId('ac-unsubscribe-button').click(); await expect(page.getByTestId('ac-email-preferences')).toHaveAttribute('data-state', 'token-done');
    invariant(token, 'UNSUBSCRIBE_LOOKUP_TOKEN_NOT_OBSERVED'); d.created.set('preferenceToken', token); const looked = await d.operator.clients.clients.A.emailPreferenceLinks.lookup({ token }); invariant(looked.enabled === false, 'UNSUBSCRIBE_NOT_SAVED');
    await page.reload(); await expect(page.getByTestId('ac-email-preferences')).toHaveAttribute('data-state', 'token-missing'); await d.login(page, 'b1'); await d.goto(page, d.config.origins.accountA, '/email-preferences'); await expect(page.getByTestId('ac-pref-shipping-updates')).not.toBeChecked(); await d.axe(page, 'ac-email-preferences-token'); return ['UNSUBSCRIBE_PUBLIC_TOKEN_CONSUMPTION_AND_PREFERENCE'];
  },
  'AC-14': async d => {
    for (const buyer of ['b2', 'd'] as const) {
      const page = await signed(d, buyer); d.requireOwned('A', d.fixtures.buyers[buyer].customerId!); await d.goto(page, d.config.origins.accountA, '/privacy'); await page.getByTestId('ac-deletion-request').click(); await page.getByRole('dialog').getByRole('button', { name: /request/i }).click();
      const first = await d.job(page, '/privacy/deletion-request', {}), second = await d.job(page, '/privacy/deletion-request', {}); const request = first.body?.request ?? first.body?.deletion_request;
      invariant(request?.status === 'pending_review' && request.customer_deletion_request_id === (second.body?.request ?? second.body?.deletion_request)?.customer_deletion_request_id, 'DELETION_DUPLICATE_MISMATCH');
      await d.track('A', 'deletion_request', request.customer_deletion_request_id, 'review');
      if (buyer === 'd') await namedPlan(d, 'prepareDeletion', { customerId: d.fixtures.buyers.d.customerId! });
      await d.operator.execute({ name: `delete-${buyer}-decision`, sandbox: 'A', operation: 'customerDeletionRequests.resolve', args: [request.customer_deletion_request_id, { decision: buyer === 'd' ? 'approve' : 'reject' }], creates: [], purpose: 'deletion-acceptance' });
      await page.reload(); await expect(page.getByTestId('ac-deletion-status').first()).toHaveAttribute('data-state', buyer === 'd' ? 'completed' : 'rejected', { timeout: 60_000 });
      if (buyer === 'd') { await d.form(page, '/sign-out'); await d.goto(page, d.config.origins.accountA, '/sign-in'); await d.form(page, '/sign-in', { email: d.fixtures.buyers.d.email, password: d.fixtures.buyers.d.password }); await expect(page.getByRole('alert')).toContainText('closed'); }
    }
    return ['DELETION_PENDING_DUPLICATE_REJECT_APPROVE_CLOSED'];
  },
  'AC-15API': async d => exerciseOwnSessionRefresh(d.operator, await fixture(d, 'sessionDisposableCustomerId')),
  'AC-15': async d => appRefreshAcceptance(d),
  'AC-16': async d => appSignoutAcceptance(d),
  'AC-17': async d => {
    const c = await d.checkout(await d.page('late-guest'), 'brewing-class'); await bank(d, c, 'processing');
    invariant(!(await d.operator.clients.clients.A.orders.get(c.orderId)).customer_id, 'VERIFIED_BUYER_GUEST_ORDER_LINKED_EARLY'); const page = await signed(d); await d.goto(page, d.config.origins.accountA, '/link-purchases'); const after = new Date(); await d.form(page, '/link-purchases/send'); const mail = await d.email('b1', after, 'verification'); await d.form(page, '/link-purchases/confirm', { code: mail.codes[0] });
    await expect(page.getByTestId('ac-link-result')).toHaveAttribute('data-count', '1'); invariant((await d.operator.clients.clients.A.orders.get(c.orderId)).customer_id === d.fixtures.buyers.b1.customerId, 'LATE_GUEST_LINK_FAILED'); return ['LATER_GUEST_PROCESSING_LINKED_BY_NEW_PROOF'];
  },
};


export function assertNoEarlyRefresh(d: Driver, checkpoint: number): void { invariant(refreshes(d, checkpoint).length === 0, 'EARLY_REFRESH_DURING_WAIT'); }
const refreshes = (d: Driver, checkpoint: number) => d.appMutations.slice(checkpoint).filter(e => e.app === 'accountA' && e.operation === 'CUSTOMER_SESSION_REFRESH');
export function assertRefreshRotation(d: Driver, checkpoint: number, familyId: string): void {
  const events = refreshes(d, checkpoint);
  invariant(events.length === 1 && events[0].status === 200 && Number.isFinite(events[0].resolvedAt), 'APP_AUTOMATIC_REFRESH_NOT_OBSERVED');
  invariant(d.appResources.some(e => e.app === 'accountA' && e.type === 'customer_session' && e.id === familyId && e.timestamp >= events[0].timestamp && e.timestamp <= events[0].resolvedAt!), 'APP_REFRESH_FAMILY_CHANGED');
}
export async function replayAppRefresh(d: Driver, anonymous: Pick<Client, 'customerSessions'>, oldToken: SealedCredential, familyId: string): Promise<void> {
  const ledger = d.operator.ledger, customerId = d.fixtures.buyers.b1.customerId!;
  d.requireOwned('A', familyId); d.requireOwned('A', customerId);
  let failure: ReturnType<typeof apiFailure> | undefined;
  try {
    await ledger.action('ac15-superseded-refresh-replay', 'A', 'customerSessions.refresh', [{ credential_source: 'accountA:customer_session_vault', customer_session_id: familyId, generation: 'superseded' }], async key => {
      try { await oldToken.use(refresh_token => sessionCall(() => anonymous.customerSessions.refresh({ refresh_token }, { idempotencyKey: key }))); }
      catch (error) { const result = apiFailure(error); if (!result.status || result.status < 200 || result.status >= 300) throw result; }
      return { accepted: true };
    }, async () => {});
  } catch (error) { failure = apiFailure(error); }
  if (!failure || failure.status && failure.status >= 200 && failure.status < 300) {
    await ledger.action('ac15-accepted-replay-cleanup', 'A', 'customerSessions.revoke', [familyId, {}], async key => (await d.operator.clients.writable('A', true)).customerSessions.revoke(familyId, {}, { idempotencyKey: key }), async response => { invariant(response.revoked === true && response.customer_session_id === familyId, 'SESSION_CLEANUP_FAILED'); });
    invariant(false, 'SUPERSEDED_REFRESH_ACCEPTED');
  }
  if (ledger.state.actions['A:ac15-superseded-refresh-replay'].phase === 'unknown') {
    await ledger.action('ac15-replay-reconcile', 'A', 'customers.revokeSessions', [customerId, {}], async key => (await d.operator.clients.writable('A', true)).customers.revokeSessions(customerId, {}, { idempotencyKey: key }), async response => { invariant(typeof response.revoked_count === 'string' && /^(0|[1-9]\d*)$/.test(response.revoked_count), 'SESSION_RECONCILIATION_FAILED'); });
    await ledger.abandonUnreplayable('A:ac15-superseded-refresh-replay', 'A:ac15-replay-reconcile');
    invariant(false, 'REPLAY_OUTCOME_UNKNOWN');
  }
  invariant(failure.status === 401 && failure.code === 'CUSTOMER_SESSION_REFRESH_REUSED' && ledger.state.actions['A:ac15-superseded-refresh-replay'].phase === 'rejected', 'APP_SUPERSEDED_REFRESH_REPLAY_NOT_REUSED');
}
export async function assertAppSecretInvalid(anonymous: Pick<Client, 'me'>, secret: SealedCredential, code: string): Promise<void> {
  const invalid = await secret.use(customerToken => sessionCall(() => anonymous.me.get(undefined, { customerToken }))).then(() => undefined, apiFailure);
  invariant(invalid?.status === 404 && invalid.code === 'CUSTOMER_SESSION_NOT_FOUND', code);
}
type RowReader = Pick<AppVault, 'metadata' | 'readVault' | 'count'>;
type RefreshPorts = { reader: RowReader; anonymous: Pick<Client, 'customerSessions' | 'me'>; now: () => number; wait: (ms: number) => Promise<void>; sync: () => Promise<void>; verify: () => Promise<unknown>; scan: () => Promise<void> };
async function appRefreshAcceptance(d: Driver): Promise<string[]> {
  const reader = new AppVault(d, 'AC-15');
  return runAppRefreshTransition(d, { reader, anonymous: anonymousSessionClient(d.operator.clients.requestIds), now: () => Date.now(), wait: ms => new Promise(resolve => setTimeout(resolve, ms)), sync: () => syncAppAudit(d), verify: () => verifyVaultAuthority(d, 'AC-15'), scan: () => assertVaultScans(d, reader.scanner) });
}
// Dependency ports support local injected tests. The registered handler always uses the real gates and timers above.
export async function runAppRefreshTransition(d: Driver, ports: RefreshPorts): Promise<string[]> {
  await d.guardCheck();
  for (const context of d.contexts.values()) for (const page of context.pages()) if (Object.values(d.config.origins).some(origin => page.url().startsWith(origin + '/'))) await page.goto('about:blank');
  const rowStart = ports.now(), { reader, anonymous } = ports;
  const page = await d.page('app-vault-ac15'); await d.login(page, 'b1');
  await d.goto(page, d.config.origins.accountA, '/'); await expect(page.getByTestId('ac-home')).toBeVisible();
  await d.goto(page, d.config.origins.accountA, '/orders'); await expect(page.getByTestId('ac-orders')).toBeVisible();
  if ((await reader.metadata()).mintedAt < rowStart) {
    await d.form(page, '/sign-out'); await d.login(page, 'b1'); await d.goto(page, d.config.origins.accountA, '/'); await expect(page.getByTestId('ac-home')).toBeVisible();
  }
  let first: VaultSnapshot | undefined = await reader.readVault();
  const familyId = first.familyId, mintedAt = first.mintedAt, expiresAt = first.expiresAt;
  invariant(mintedAt >= rowStart && expiresAt - mintedAt >= 295_000 && expiresAt - mintedAt <= 305_000 && first.refreshExpiresAt > ports.now() + 3600_000, 'REAL_TTL_300_REQUIRED');
  let oldToken: SealedCredential | undefined = first.refreshToken, oldSecret: SealedCredential | undefined = first.secret; first = undefined;
  // Keep sealed values only within this row's stack frame.
  await page.goto('about:blank'); await ports.sync(); const checkpoint = d.appMutations.length;
  const wakeAt = Math.max(mintedAt + 360_000, expiresAt + 60_000);
  while (ports.now() < wakeAt) { await ports.wait(Math.min(30_000, wakeAt - ports.now())); emit({ event: 'APP_SESSION_REAL_TTL_WAIT', row: 'AC-15' }); }
  await ports.sync(); assertNoEarlyRefresh(d, checkpoint);
  await reader.metadata();
  await d.goto(page, d.config.origins.accountA, '/orders'); await expect(page.getByTestId('ac-orders')).toBeVisible();
  await d.goto(page, d.config.origins.accountA, '/'); await expect(page.getByTestId('ac-home')).toBeVisible();
  await ports.sync(); assertRefreshRotation(d, checkpoint, familyId);
  let current: VaultSnapshot | undefined = await reader.readVault();
  invariant(current.familyId === familyId && !current.refreshToken.equals(oldToken) && !current.secret.equals(oldSecret) && current.expiresAt > ports.now() + 240_000, 'APP_REFRESH_FAMILY_OR_AUTHORITY_DID_NOT_ROTATE');
  oldSecret = undefined;
  let currentSecret: SealedCredential | undefined = current.secret; current = undefined;
  await ports.verify();
  await replayAppRefresh(d, anonymous, oldToken, familyId); oldToken = undefined;
  await ports.verify();
  await assertAppSecretInvalid(anonymous, currentSecret, 'REUSE_DID_NOT_REVOKE_APP_FAMILY'); currentSecret = undefined;
  await d.goto(page, d.config.origins.accountA, '/orders');
  const destination = new URL(page.url());
  invariant(destination.pathname === '/sign-in' && destination.searchParams.get('notice') === 'session_ended' && destination.searchParams.get('next') === '/orders', 'APP_DID_NOT_END_SESSION_AFTER_FAMILY_REVOCATION');
  await expect(page.getByTestId('ac-notice')).toContainText('session');
  invariant(await reader.count('vaultCount') === 0 && await reader.count('sessionCount') === 0, 'LOCAL_SESSIONS_AND_VAULT_NOT_CLEARED');
  await ports.sync(); invariant(refreshes(d, checkpoint).filter(e => e.status === 200).length === 1, 'APP_REFRESH_AFTER_FAMILY_REVOCATION');
  await ports.scan();
  return ['APP_VAULT_RUN_OWNED_GATES_VERIFIED', 'REAL_TTL_300_OBSERVED', 'AUTOMATIC_REFRESH_AFTER_6_MINUTES_SAME_FAMILY', 'APP_SUPERSEDED_REFRESH_REPLAY_REUSED', 'APP_CURRENT_SECRET_INVALID_AFTER_REUSE', 'NEXT_PAGE_SESSION_ENDED', 'LOCAL_SESSIONS_AND_VAULT_CLEARED', 'CREDENTIAL_SCANS_CLEAN'];
}
export async function assertSignoutNegative(reader: Pick<AppVault, 'metadata' | 'readVault' | 'count'>, d: Driver, page: any, secret: SealedCredential, familyId: string, sessions: number, checkpoint: number, send: () => Promise<number>, sync: () => Promise<void> = () => syncAppAudit(d)): Promise<void> {
  invariant(await send() === 403, 'ACCOUNT_CSRF_NOT_REJECTED');
  invariant((await reader.metadata()).familyId === familyId, 'ACCOUNT_CSRF_NOT_REJECTED');
  const current = await reader.readVault();
  invariant(current.familyId === familyId && current.secret.equals(secret) && await reader.count('sessionCount') === sessions, 'ACCOUNT_CSRF_NOT_REJECTED');
  await sync(); invariant(!d.revocations.slice(checkpoint).some(e => e.app === 'accountA'), 'ACCOUNT_CSRF_NOT_REJECTED');
  await expect(page.getByTestId('ac-home')).toBeVisible();
}
export function assertSignoutRevoked(d: Driver, checkpoint: number, familyId: string, pending: number, vaults: number): void {
  assertFreshRevocation(d, checkpoint, 'accountA', { sessionId: familyId });
  invariant(pending === 0 && vaults === 0, 'APP_SIGNOUT_DID_NOT_REVOKE_EXACT_SESSION');
}
type SignoutPorts = Pick<RefreshPorts, 'reader' | 'anonymous' | 'sync' | 'verify' | 'scan'> & { boundary: () => Promise<void> };
async function appSignoutAcceptance(d: Driver): Promise<string[]> {
  const reader = new AppVault(d, 'AC-16');
  return runAppSignoutTransition(d, { reader, anonymous: anonymousSessionClient(d.operator.clients.requestIds), sync: () => syncAppAudit(d), verify: () => verifyVaultAuthority(d, 'AC-16'), scan: () => assertVaultScans(d, reader.scanner), boundary: () => runChild(process.execPath, ['--test', 'tests/unit/credential-boundary.test.ts'], join(checkoutRoot, 'headless/account'), d.scanner, {}) });
}
export async function runAppSignoutTransition(d: Driver, ports: SignoutPorts): Promise<string[]> {
  const { reader, anonymous } = ports;
  const page = await d.page('app-vault-ac16'); await d.login(page, 'b1'); await d.goto(page, d.config.origins.accountA, '/'); await expect(page.getByTestId('ac-home')).toBeVisible();
  let current: VaultSnapshot | undefined = await reader.readVault(); const familyId = current.familyId;
  let secret: SealedCredential | undefined = current.secret; current = undefined;
  const positive = await secret.use(customerToken => sessionCall(() => anonymous.me.get(undefined, { customerToken })));
  invariant(positive.customer_id === d.fixtures.buyers.b1.customerId, 'OLD_APP_SECRET_POSITIVE_CONTROL_REQUIRED');
  const sessions = await reader.count('sessionCount'), checkpoint = await ports.sync().then(() => d.revocations.length);
  const negatives = [
    () => d.job(page, '/profile', { name: 'invalid' }, { noCsrf: true }).then(r => r.status),
    () => d.job(page, '/sign-out', {}, { noCsrf: true }).then(r => r.status),
    () => d.job(page, '/sign-out', {}, { noCsrf: true, headers: { 'X-CSRF-Token': 'invalid' } }).then(r => r.status),
    async () => { const response = await page.request.post(new URL('/sign-out', d.config.origins.accountA).href, { headers: { Origin: 'http://csrf.invalid', 'X-CSRF-Token': await d.csrf(page) }, form: {}, maxRedirects: 0 }); d.scanner.scan(await response.text(), 'body'); return response.status(); },
  ];
  for (const send of negatives) await assertSignoutNegative(reader, d, page, secret, familyId, sessions, checkpoint, send, ports.sync);
  const before = await ports.sync().then(() => d.revocations.length); await d.form(page, '/sign-out'); await ports.sync();
  assertSignoutRevoked(d, before, familyId, await reader.count('pendingCount', familyId), await reader.count('vaultCount'));
  const destination = new URL(page.url()); invariant(destination.pathname === '/sign-in' && destination.searchParams.get('notice') === 'signed_out', 'APP_SIGNOUT_NOTICE_REQUIRED');
  await ports.verify();
  await assertAppSecretInvalid(anonymous, secret, 'OLD_APP_SECRET_STILL_VALID'); secret = undefined;
  await d.goto(page, d.config.origins.accountA, '/orders'); invariant(new URL(page.url()).pathname === '/sign-in', 'NEXT_PAGE_NOT_SIGNED_OUT');
  await ports.scan();
  await ports.boundary();
  await ports.scan();
  return ['APP_VAULT_RUN_OWNED_GATES_VERIFIED', 'OLD_SECRET_VALID_BEFORE_SIGNOUT', 'SIGNOUT_CSRF_AND_ORIGIN_REJECTED_WITHOUT_EFFECT', 'APP_SIGNOUT_REVOKED_EXACT_FAMILY', 'OLD_APP_SECRET_CUSTOMER_SESSION_NOT_FOUND', 'NEXT_PAGE_SIGNED_OUT', 'ACCOUNT_CREDENTIAL_BOUNDARY_TEST_PASS', 'CREDENTIAL_SCANS_CLEAN'];
}
