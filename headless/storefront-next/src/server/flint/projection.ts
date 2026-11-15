import type {PendingPaymentAction,StripePaymentClientAction} from '@flintpay/node';
import type {CheckoutSession,Order,OrderPaymentAttempt} from '@flintpay/node';
import type {SourcedOrder} from '../payments/engine.ts';
import {Model} from '@flintpay/node';
const denied=new Set(['checkout_session_id','checkout_session_ids','superseding_checkout_session_id','recovery_payment_attempt_id','checkout_auth_token','secret','refresh_token','client_secret','client_action','customer_verification_id','internal_note','closed_reason','metadata','merchant_diagnostics','delivery_pinned_dependencies','external_reference_id','gift_card_challenge','page_origin']);
const credential=/(?:flint_(?:test|live|cses|cref)_|ck(?:at|lt)_|whsec_|_secret_)/;
export function buyerSafe(value:unknown):unknown {
  if(value instanceof Model)return buyerSafe(value.toJSON());
  if(typeof value==='string')return credential.test(value)||/^cs_/.test(value)?undefined:value;
  if(Array.isArray(value))return value.map(buyerSafe).filter(item=>item!==undefined);
  if(value&&typeof value==='object'){
    const out:Record<string,unknown>={};
    for(const [key,item] of Object.entries(value))if(!denied.has(key)){const safe=buyerSafe(item);if(safe!==undefined)out[key]=safe;}
    return out;
  }
  return value;
}
export function safeAttempt(attempt:OrderPaymentAttempt|undefined):unknown {
  if(!attempt)return undefined;
  return buyerSafe({...attempt,pending_actions:attempt.status==='requires_action'?attempt.pending_actions:undefined});
}
export function safeOrder(order:SourcedOrder):unknown {
  return buyerSafe({...order,active_payment_attempt:safeAttempt(order.active_payment_attempt),customer:undefined,merchant_id:undefined,inventory_reservation_id:undefined,inventory_routing_source:undefined});
}
export function safeSession(session:CheckoutSession):unknown {
  return buyerSafe({...session,gift_card_challenge:undefined,page_origin:undefined,url:undefined,redirects:undefined,payment_return_url:undefined,customer:undefined,merchant_id:undefined,active_payment_attempt:safeAttempt(session.active_payment_attempt)});
}

/** Action authority is returned only by payment JSON jobs, never embedded in HTML. */
export type BrowserClientAction =
  | {type:'url';url:string;expiresAt:string}
  | {type:'stripe';stripe:StripePaymentClientAction;expiresAt:string};
export function projectClientAction(pending:PendingPaymentAction|undefined):BrowserClientAction|undefined {
  if(!pending)return undefined;
  const action=pending.client_action;
  if(action.type==='url'&&'url'in action&&typeof action.url==='string')return {type:'url',url:action.url,expiresAt:pending.expires_at};
  if(action.type!=='stripe'||!('stripe'in action)||!action.stripe)return undefined;
  const stripe=action.stripe as StripePaymentClientAction;
  return {type:'stripe',expiresAt:pending.expires_at,stripe:{account_id:stripe.account_id,publishable_key:stripe.publishable_key,
    ...(stripe.payment_intent?{payment_intent:{client_secret:stripe.payment_intent.client_secret,stripe_js_call:stripe.payment_intent.stripe_js_call}}:{}),
    ...(stripe.setup_intent?{setup_intent:{client_secret:stripe.setup_intent.client_secret,stripe_js_call:stripe.setup_intent.stripe_js_call}}:{})}};
}
