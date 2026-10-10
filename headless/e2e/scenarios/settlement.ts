import { expect } from '@playwright/test';
import type { Scenario } from './storefront.ts';
import { billing } from './storefront.ts';
import { invariant } from '../support/safe.ts';
import { assertOneCharge, money, giftAllocation, equalMoney } from '../support/money.ts';
import { syncAppAudit } from '../support/audit-feed.ts';
import {assertGiftChallengePersistence} from '../support/app-vault.ts';
import type {Driver} from '../support/driver.ts';
import type {Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import { providerSteps } from './provider.ts';

export const settlement: Record<string, Scenario> = {
  'SF-05Z2': async d => {
    const c = await d.checkout(await d.page('zero-balance'), 'brewing-class');
    await c.page.getByTestId('sf-discount-code').fill(d.fixtures.values.zeroBalancePromotion);
    const [discountResponse] = await Promise.all([c.page.waitForResponse(r => new URL(r.url()).pathname === `/checkout/${c.ref}/discount` && r.request().method() === 'POST', { timeout: 30000 }), c.page.getByTestId('sf-discount-apply').click()]);
    invariant(discountResponse.status() === 200, 'ZERO_BALANCE_DISCOUNT_REJECTED');
    await expect(c.page.getByTestId('sf-discount-applied-0')).toBeVisible({ timeout: 30000 }); await d.state(c);
    await billing(d, c);
    invariant(money(c.state.order.settlement_amounts.outstanding_money).amount === '0', 'ZERO_BALANCE_FIXTURE_INVALID');
    await expect(c.page.getByTestId('sf-payment')).toHaveAttribute('data-collection', 'settlement'); await expect(c.page.getByTestId('sf-settlement-explanation')).toBeVisible();
    await expect(c.page.getByTestId('sf-pay-button')).toBeEnabled();
    const [response] = await Promise.all([c.page.waitForRequest(r => new URL(r.url()).pathname === `/checkout/${c.ref}/pay` && r.method() === 'POST'), c.page.getByTestId('sf-pay-button').click()]);
    const request = response.postDataJSON(); invariant(!request.credential && request.approved_outstanding_money?.amount === '0', 'ZERO_BALANCE_PROCESSOR_SOURCE');
    await expect(c.page.getByTestId('sf-complete')).toHaveAttribute('data-state', 'paid');
    assertOneCharge(await d.trackOrder('A', c.orderId), (await d.operator.clients.clients.A.orders.listPaymentAttempts(c.orderId)).data, 0);
    return ['ZERO_BALANCE_PUBLIC_PAY_WITHOUT_PROCESSOR'];
  },
  'SF-05Z1': async d => {
    const c = await d.checkout(await d.page('gift-full'), 'house-blend'); await d.delivery(c);
    const outstanding = money(c.state.order.settlement_amounts.outstanding_money), issued = await d.operator.issueGiftCard('full-gift-funded', (BigInt(outstanding.amount) + 1000n).toString());
    invariant(issued.code, 'PUBLIC_GIFT_CODE_REQUIRED'); d.scanner.addGift(issued.code);
    await d.applyGift(c,issued.code);
    const accepted = giftAllocation(c.state.order); invariant(money(accepted.processor_money).amount === '0', 'GIFT_FULL_ALLOCATION_INVALID');
    await expect(c.page.getByTestId('sf-payment')).toHaveAttribute('data-collection', 'settlement'); await expect(c.page.getByTestId('sf-settlement-explanation')).toBeVisible();
    await expect(c.page.getByTestId('sf-pay-button')).toBeEnabled();
    const [response] = await Promise.all([c.page.waitForRequest(r => new URL(r.url()).pathname === `/checkout/${c.ref}/pay` && r.method() === 'POST'), c.page.getByTestId('sf-pay-button').click()]);
    const request = response.postDataJSON();
    invariant(!request.credential, 'GIFT_FULL_PROCESSOR_SOURCE'); equalMoney(request.approved_outstanding_money, outstanding);
    await expect(c.page.getByTestId('sf-complete')).toHaveAttribute('data-state', 'paid', { timeout: 60000 }); const order = await d.trackOrder('A', c.orderId);
    assertOneCharge(order, (await d.operator.clients.clients.A.orders.listPaymentAttempts(c.orderId)).data, 0);
    invariant(order.gift_card_settlements?.length === 1, 'FULL_GIFT_SETTLEMENT_MISSING'); return ['FULL_GIFT_EXACT_ALLOCATION_NO_PROCESSOR'];
  },
  'SF-05Z3': async d => {
    const main = await d.checkout(await d.page('gift-change-main'), 'house-blend'); await d.delivery(main);
    const spend = await d.checkout(await d.page('gift-change-spend'), 'brewing-class'); await billing(d, spend);
    const expected = money(main.state.order.settlement_amounts.outstanding_money), spending = money(spend.state.order.settlement_amounts.outstanding_money);
    invariant(expected.currency === spending.currency && BigInt(expected.amount) > 500n, 'GIFT_CONCURRENCY_MONEY_REQUIRED');
    const issued = await d.operator.issueGiftCard('gift-allocation-change', (BigInt(expected.amount) + BigInt(spending.amount) - 500n).toString());
    invariant(issued.code, 'PUBLIC_GIFT_CODE_REQUIRED'); d.scanner.addGift(issued.code);
    for (const c of [main, spend]) { await d.applyGift(c,issued.code); invariant(money(giftAllocation(c.state.order).processor_money).amount === '0', 'INITIAL_GIFT_FULL_ALLOCATION_REQUIRED'); }
    await spend.page.getByTestId('sf-pay-button').click(); await expect(spend.page.getByTestId('sf-complete')).toHaveAttribute('data-state', 'paid', { timeout: 60000 });
    assertOneCharge(await d.trackOrder('A', spend.orderId), (await d.operator.clients.clients.A.orders.listPaymentAttempts(spend.orderId)).data, 0);
    await syncAppAudit(d); const checkpoint = d.appMutations.length;
    await main.page.getByTestId('sf-pay-button').click(); await expect(main.page.getByTestId('sf-payment')).toHaveAttribute('data-state', 'total_changed', { timeout: 60000 });
    await expect(main.page.getByTestId('sf-payment-message')).toContainText('gift card balance changed'); await syncAppAudit(d);
    invariant(!d.appMutations.slice(checkpoint).some(e => e.operation === 'ORDER_PAY' && e.targetId === main.orderId), 'STALE_GIFT_MUST_NOT_CALL_PUBLIC_PAY');
    invariant((await d.operator.clients.clients.A.orders.listPaymentAttempts(main.orderId)).data.length === 0, 'STALE_GIFT_MUST_NOT_CREATE_ATTEMPT');
    await d.state(main); equalMoney(giftAllocation(main.state.order).processor_money, { amount: '500', currency: expected.currency });
    await d.pay(main); await d.settled(main, 1); return ['REAL_GIFT_CONCURRENT_REDEMPTION_REAPPROVAL_ONE_CHARGE'];
  },
  'SF-GIFTCHALLENGE': async d => {
    const c=await d.checkout(await d.page('gift-challenge'),'house-blend');await d.delivery(c);
    const url=await d.registerGiftChallenge(c.page,c.orderId,c.origin);await d.operator.tripGiftChallenge();
    const issued=await d.operator.issueGiftCard('challenge-gift-one','500');invariant(issued.code,'PUBLIC_GIFT_CODE_REQUIRED');d.scanner.addGift(issued.code);
    await challengeGift(d,c.page,c.orderId,c.origin,issued.code,url,'storefrontA',true);
    await d.state(c);invariant(c.state.order.gift_cards.length===1&&c.state.order.gift_card_estimate,'CHALLENGE_GIFT_NOT_APPLIED');
    const second=await d.operator.issueGiftCard('challenge-gift-two','500');invariant(second.code,'PUBLIC_GIFT_CODE_REQUIRED');d.scanner.addGift(second.code);
    const keys=d.appMutations.filter(event=>event.operation==='ORDER_APPLY_GIFT_CARD'&&event.targetId===c.orderId).map(event=>event.keyHash);
    await challengeGift(d,c.page,c.orderId,c.origin,second.code,url,'storefrontA');await d.state(c);invariant(c.state.order.gift_cards.length===2,'SECOND_GIFT_NOT_APPLIED');
    invariant(d.appMutations.filter(event=>event.operation==='ORDER_APPLY_GIFT_CARD'&&event.targetId===c.orderId).at(-1)?.keyHash!==keys[0],'SECOND_GIFT_REUSED_KEY');
    await d.pay(c);const settled=await d.settled(c,1);invariant(settled.gift_card_settlements?.length===2,'GIFT_SETTLEMENTS_MISSING');
    await assertGiftChallengePersistence(d,'SF-GIFTCHALLENGE',[issued.code,second.code]);
    return ['PUBLIC_GIFT_CHALLENGE_IFRAME_PROOF_RETRY','SECOND_CODE_NEW_CHALLENGE','SPOOFED_MESSAGE_IGNORED','CHALLENGE_FRAME_ONLY_FLINT_SURFACE','PROOF_NOT_PERSISTED','GIFT_CHALLENGE_ONE_CHARGE'];
  },
  'AC-GIFTCHALLENGE':async d=>{
    const page=await d.page('b1');await d.login(page,'b1');const buyer=d.fixtures.buyers.b1;invariant(buyer.customerId,'BOUND_BUYER_REQUIRED');
    const invoice=await d.operator.issueInvoice('challenge-invoice',buyer.customerId,buyer.email),root=`/invoices/${invoice.invoice_id}/pay`;
    await d.goto(page,d.config.origins.accountA,root);await d.trackOrder('A',invoice.order_id);const url=await d.registerGiftChallenge(page,invoice.order_id,d.config.origins.accountA);await d.operator.tripGiftChallenge();
    const issued=await d.operator.issueGiftCard('challenge-invoice-gift','2500');invariant(issued.code,'PUBLIC_GIFT_CODE_REQUIRED');d.scanner.addGift(issued.code);
    await challengeGift(d,page,invoice.order_id,d.config.origins.accountA,issued.code,url,'accountA');
    await expect(page.getByTestId('ac-gift-split')).toBeVisible();await d.card(page);await expect(page.getByTestId('ac-pay-button')).toBeEnabled();await page.getByTestId('ac-pay-button').click();
    await expect(page.getByTestId('ac-invoice-status')).toHaveAttribute('data-state','paid',{timeout:60000});
    const order=await d.trackOrder('A',invoice.order_id);assertOneCharge(order,(await d.operator.clients.clients.A.orders.listPaymentAttempts(invoice.order_id)).data,1);invariant(order.gift_card_settlements?.length===1,'GIFT_SETTLEMENT_MISSING');
    await assertGiftChallengePersistence(d,'AC-GIFTCHALLENGE',[issued.code]);return ['ACCOUNT_INVOICE_GIFT_CHALLENGE','GIFT_CHALLENGE_ONE_CHARGE','PROOF_NOT_PERSISTED'];
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

async function challengeGift(d:Driver,page:Page,orderId:string,origin:string,code:string,url:string,app:'storefrontA'|'accountA',spoof=false):Promise<void>{
  await syncAppAudit(d);const checkpoint=d.appMutations.length,isAccount=app==='accountA',root=isAccount?new URL(page.url()).pathname:`/checkout/${new URL(page.url()).pathname.split('/')[2]}`,prefix=isAccount?'ac':'sf',panel=isAccount?page.getByTestId('ac-gift-card'):page.locator('[data-region="gift-cards"]');
  const guard=d.guards.get(page.context());invariant(guard,'BROWSER_GUARD_REQUIRED');const release=guard.holdGiftProof();
  const applied=page.waitForResponse(response=>new URL(response.url()).origin===origin&&new URL(response.url()).pathname===root+'/gift-card'&&response.request().method()==='POST');
  let spoofPosts=0,requestListener:((request:import('@playwright/test').Request)=>void)|undefined;
  try{
    await page.getByTestId(`${prefix}-gift-card-code`).fill(code);await page.getByTestId(`${prefix}-gift-card-apply`).click();const response=await applied,body=await response.json();
    invariant(response.status()===200&&body.gift_challenge?.url===url&&!JSON.stringify(body).includes('checkout_session_id'),'CHALLENGE_NOT_REQUIRED');await expect(panel).toHaveAttribute('data-challenge-state','loading');
    const frame=panel.locator('iframe');await expect(frame).toHaveCount(1);await expect(frame).toHaveAttribute('src',url);const oldFrame=await frame.elementHandle();
    if(spoof){
      const current=await d.operator.challengeFor(orderId,origin),tag=createHash('sha256').update(`flint-examples.gift-challenge.v1\n${body.gift_challenge.challenge_id}\n${current.checkoutSessionId}`).digest('base64url');
      invariant(current.url===url&&tag===body.gift_challenge.session_tag&&oldFrame,'CHALLENGE_SPOOF_MATCHING_SESSION_REQUIRED');
      requestListener=request=>{const target=new URL(request.url());if(request.method()==='POST'&&target.origin===origin&&target.pathname===root+'/gift-card/challenge')spoofPosts++;};page.on('request',requestListener);
      await oldFrame.evaluate((element,input)=>{
        const target=window as Window&{__giftChallengeSourceEvidence?:{completed:number;stop:()=>void}},source=(element as HTMLIFrameElement).contentWindow;
        const evidence={completed:0,stop:()=>window.removeEventListener('message',listener)};
        const listener=(event:MessageEvent)=>{const data=event.data;if(event.source===source&&event.origin===input.origin&&data?.type==='flint.gift_card_challenge.completed'&&data.checkout_session_id===input.sessionId&&typeof data.proof==='string'&&/^[\x21-\x7E]{1,2048}$/.test(data.proof)&&typeof data.expires_at==='string'&&Number.isFinite(Date.parse(data.expires_at)))evidence.completed++;};
        target.__giftChallengeSourceEvidence=evidence;window.addEventListener('message',listener);
      },{origin:new URL(url).origin,sessionId:current.checkoutSessionId});
      const payload=challengeSpoofMessage(current.checkoutSessionId);
      await page.evaluate(({payload,challengeOrigin})=>{window.postMessage(payload,window.location.origin);window.dispatchEvent(new MessageEvent('message',{data:payload,origin:challengeOrigin,source:window}));},{payload,challengeOrigin:new URL(url).origin});
      await page.waitForTimeout(2000);invariant(spoofPosts===0,'SPOOFED_CHALLENGE_MESSAGE_SPENT_PROOF');await expect(panel).toHaveAttribute('data-challenge-state','loading');
    }
    release();await expect.poll(async()=>{const state=await panel.getAttribute('data-challenge-state');if(state==='failed'||state==='unavailable'||state==='expired')throw new Error('CHALLENGE_FRAME_FAILED');return state;},{timeout:60000}).toBe('none');
    if(isAccount)await expect(page.getByTestId('ac-gift-card-applied-1')).toBeVisible({timeout:60000});
    else{const current=await d.job(page,root+'/state');invariant(current.body?.state?.order?.gift_cards?.length,'CHALLENGE_GIFT_NOT_APPLIED');}
    if(oldFrame){if(!isAccount)invariant(!await oldFrame.evaluate(element=>element.isConnected),'CHALLENGE_FRAME_NOT_REMOVED');await oldFrame.dispose();}
    await syncAppAudit(d);const entries=d.appMutations.slice(checkpoint).filter(event=>event.app===app&&event.operation==='ORDER_APPLY_GIFT_CARD'&&event.targetId===orderId);
    invariant(entries.length===2&&entries[0]?.challengeProof===false&&entries[1]?.challengeProof===true&&entries.every(event=>event.authMode==='checkout')&&entries[0]?.keyHash===entries[1]?.keyHash,'CHALLENGE_CHECKOUT_AUTH_SAME_KEY_AUDIT_REQUIRED');
    if(spoof){const positive=await page.evaluate(()=>(window as Window&{__giftChallengeSourceEvidence?:{completed:number}}).__giftChallengeSourceEvidence?.completed);invariant(positive===1&&spoofPosts===1,'REAL_FRAME_CHALLENGE_SOURCE_CONTROL_REQUIRED');}
    invariant(new URL(page.url()).origin===origin,'CHALLENGE_TOP_LEVEL_NAVIGATION');await d.guardCheck();
  }finally{release();if(requestListener)page.off('request',requestListener);if(spoof&&!page.isClosed())await page.evaluate(()=>{const target=window as Window&{__giftChallengeSourceEvidence?:{stop:()=>void}};target.__giftChallengeSourceEvidence?.stop();delete target.__giftChallengeSourceEvidence;});}
}
export function challengeSpoofMessage(checkoutSessionId:string){return {type:'flint.gift_card_challenge.completed',checkout_session_id:checkoutSessionId,proof:'gccp_syntheticSpoofProof1234567890',expires_at:new Date(Date.now()+600000).toISOString()};}
