import { expect } from '@playwright/test';
import type { Scenario } from './storefront.ts';
import { invariant } from '../support/safe.ts';
import { assertOneCharge, money, giftAllocation, equalMoney } from '../support/money.ts';
import { syncAppAudit } from '../support/audit-feed.ts';
import { providerSteps } from './provider.ts';

export const settlement: Record<string, Scenario> = {
  'SF-05Z2': async d => {
    const c = await d.checkout(await d.page('zero-balance'), 'brewing-class');
    await c.page.getByTestId('sf-discount-code').fill(d.fixtures.values.zeroBalancePromotion); await c.page.getByTestId('sf-discount-apply').click(); await d.state(c);
    invariant(money(c.state.order.settlement_amounts.outstanding_money).amount === '0', 'ZERO_BALANCE_FIXTURE_INVALID');
    const response = c.page.waitForRequest(r => new URL(r.url()).pathname === `/checkout/${c.ref}/pay` && r.method() === 'POST');
    await expect(c.page.getByTestId('sf-payment')).toHaveAttribute('data-collection', 'settlement'); await expect(c.page.getByTestId('sf-settlement-explanation')).toBeVisible();
    await expect(c.page.getByTestId('sf-pay-button')).toBeEnabled(); await c.page.getByTestId('sf-pay-button').click();
    const request = (await response).postDataJSON(); invariant(!request.credential && request.approved_outstanding_money?.amount === '0', 'ZERO_BALANCE_PROCESSOR_SOURCE');
    await expect(c.page.getByTestId('sf-complete')).toHaveAttribute('data-state', 'paid');
    assertOneCharge(await d.trackOrder('A', c.orderId), (await d.operator.clients.clients.A.orders.listPaymentAttempts(c.orderId)).data, 0);
    return ['ZERO_BALANCE_PUBLIC_PAY_WITHOUT_PROCESSOR'];
  },
  'SF-05Z1': async d => {
    const c = await d.checkout(await d.page('gift-full'), 'house-blend'); await d.delivery(c, true);
    const outstanding = money(c.state.order.settlement_amounts.outstanding_money), issued = await d.operator.issueGiftCard('full-gift-funded', (BigInt(outstanding.amount) + 1000n).toString());
    invariant(issued.code, 'PUBLIC_GIFT_CODE_REQUIRED'); d.scanner.addGift(issued.code);
    await c.page.getByTestId('sf-gift-card-code').fill(issued.code); await c.page.getByTestId('sf-gift-card-apply').click(); await d.state(c);
    const accepted = giftAllocation(c.state.order); invariant(money(accepted.processor_money).amount === '0', 'GIFT_FULL_ALLOCATION_INVALID');
    const response = c.page.waitForRequest(r => new URL(r.url()).pathname === `/checkout/${c.ref}/pay` && r.method() === 'POST');
    await expect(c.page.getByTestId('sf-payment')).toHaveAttribute('data-collection', 'settlement'); await expect(c.page.getByTestId('sf-settlement-explanation')).toBeVisible();
    await expect(c.page.getByTestId('sf-pay-button')).toBeEnabled(); await c.page.getByTestId('sf-pay-button').click(); const request = (await response).postDataJSON();
    invariant(!request.credential, 'GIFT_FULL_PROCESSOR_SOURCE'); equalMoney(request.approved_outstanding_money, outstanding);
    await expect(c.page.getByTestId('sf-complete')).toHaveAttribute('data-state', 'paid'); const order = await d.trackOrder('A', c.orderId);
    assertOneCharge(order, (await d.operator.clients.clients.A.orders.listPaymentAttempts(c.orderId)).data, 0);
    invariant(order.gift_card_settlements?.length === 1, 'FULL_GIFT_SETTLEMENT_MISSING'); return ['FULL_GIFT_EXACT_ALLOCATION_NO_PROCESSOR'];
  },
  'SF-05Z3': async d => {
    const main = await d.checkout(await d.page('gift-change-main'), 'house-blend'); await d.delivery(main, true);
    const spend = await d.checkout(await d.page('gift-change-spend'), 'brewing-class');
    const expected = money(main.state.order.settlement_amounts.outstanding_money), spending = money(spend.state.order.settlement_amounts.outstanding_money);
    invariant(expected.currency === spending.currency && BigInt(expected.amount) > 500n, 'GIFT_CONCURRENCY_MONEY_REQUIRED');
    const issued = await d.operator.issueGiftCard('gift-allocation-change', (BigInt(expected.amount) + BigInt(spending.amount) - 500n).toString());
    invariant(issued.code, 'PUBLIC_GIFT_CODE_REQUIRED'); d.scanner.addGift(issued.code);
    for (const c of [main, spend]) { await c.page.getByTestId('sf-gift-card-code').fill(issued.code); await c.page.getByTestId('sf-gift-card-apply').click(); await d.state(c); invariant(money(giftAllocation(c.state.order).processor_money).amount === '0', 'INITIAL_GIFT_FULL_ALLOCATION_REQUIRED'); }
    await spend.page.getByTestId('sf-pay-button').click(); await expect(spend.page.getByTestId('sf-complete')).toHaveAttribute('data-state', 'paid');
    assertOneCharge(await d.trackOrder('A', spend.orderId), (await d.operator.clients.clients.A.orders.listPaymentAttempts(spend.orderId)).data, 0);
    await syncAppAudit(d); const checkpoint = d.appMutations.length;
    await main.page.getByTestId('sf-pay-button').click(); await expect(main.page.getByTestId('sf-payment')).toHaveAttribute('data-state', 'total_changed');
    await expect(main.page.getByTestId('sf-payment-message')).toContainText('gift card balance changed'); await syncAppAudit(d);
    invariant(!d.appMutations.slice(checkpoint).some(e => e.operation === 'ORDER_PAY' && e.targetId === main.orderId), 'STALE_GIFT_MUST_NOT_CALL_PUBLIC_PAY');
    invariant((await d.operator.clients.clients.A.orders.listPaymentAttempts(main.orderId)).data.length === 0, 'STALE_GIFT_MUST_NOT_CREATE_ATTEMPT');
    await d.state(main); equalMoney(giftAllocation(main.state.order).processor_money, { amount: '500', currency: expected.currency });
    await d.pay(main); await d.settled(main, 1); return ['REAL_GIFT_CONCURRENT_REDEMPTION_REAPPROVAL_ONE_CHARGE'];
  },
  'SF-GIFTCHALLENGE': async d => {
    // Use a sanctioned challenge-needed checkout. Do not create it with repeated guesses.
    const ref = d.fixtures.values.challengeCheckoutRef; invariant(ref, 'SANCTIONED_CHALLENGE_CHECKOUT_REQUIRED');
    const page = await d.page('gift-challenge'); await d.goto(page, d.sf(), `/checkout/${ref}`);
    await providerSteps(d, page, 'gift-public-challenge');
    const state = await d.job(page, `/checkout/${ref}/state`); invariant(state.body?.state?.order?.gift_cards?.length, 'PUBLIC_GIFT_CHALLENGE_NOT_COMPLETED');
    return ['PUBLIC_GIFT_CHALLENGE_REDEMPTION_NO_MERCHANT_BYPASS'];
  },
  'SF-ACH-MICRODEP': async d => {
    const c = await d.checkout(await d.page('ach-microdeposit'), 'brewing-class');
    await providerSteps(d, c.page, 'ach-microdeposit-attempt');
    // Settled product support is instant verification only. Verify the real failure
    // and recovery state rather than fabricate a microdeposit settlement.
    await expect(c.page.getByRole('alert')).toBeVisible();
    const order = await d.operator.clients.clients.A.orders.get(c.orderId);
    invariant(order.payment_status === 'unpaid' && !order.active_payment_attempt?.payment_intents?.some(p => p.status === 'succeeded'), 'UNSUPPORTED_BANK_FLOW_MUST_NOT_SETTLE');
    await d.card(c.page); await expect(c.page.getByTestId('sf-pay-button')).toBeEnabled();
    return ['MICRODEPOSIT_UNSUPPORTED_TRUTHFUL_RECOVERY'];
  },
};
