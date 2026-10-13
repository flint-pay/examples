import 'server-only';
import type {User} from './identity/index.ts';
import type {Runtime} from './runtime.ts';
import type {ReadCheckout} from './flint/checkouts.ts';
import type {PaymentResult} from './payments/engine.ts';
import {scrubForBrowser} from './scrub.ts';
import type {CheckoutState} from '../shared/types.ts';

/** Adds the catalog slug to each order line so the summary can show the product image. */
async function withSlugs(rt:Runtime,state:CheckoutState):Promise<CheckoutState>{
  let products:Awaited<ReturnType<Runtime['catalog']['read']>>['products'];
  try{products=(await rt.catalog.read()).products;}catch{return state;}
  const slugOf=(variantId?:string,productId?:string)=>products.find(item=>item.product.product_id===productId||item.variants.some(variant=>variant.variant_id===variantId))?.slug;
  return {...state,order:{...state.order,line_items:state.order.line_items.map(line=>({...line,slug:slugOf(line.variant_id,line.product_id)}))}};
}

/** The buyer-safe state for one checkout, as the page and every JSON answer show it. */
export function viewState(rt:Runtime,read:ReadCheckout):Promise<CheckoutState>{
  return withSlugs(rt,scrubForBrowser(rt.checkouts.project(read) as unknown as CheckoutState));
}

export async function projectState(rt:Runtime,ref:string,user:User|undefined,result?:PaymentResult):Promise<{read:ReadCheckout;state:CheckoutState}>{
  const read=await rt.checkouts.read(ref,user);
  if(result?.totalChanged){read.result.totalChanged=true;rt.checkouts.notice(read.record,'total_changed');if(result.order.gift_cards?.length)rt.checkouts.notice(read.record,'gift_card_changed');read.record=rt.checkouts.record(ref);}
  const state=await viewState(rt,read);
  // Each notice is shown once: the page or the JSON answer that carries it consumes it.
  rt.checkouts.consumeNotices(read.record,state.notices??[]);
  return {read,state};
}

/** The answer to pay, resume, attempt reads and cancel. The provider action travels only here, never in a page. */
export function paymentAnswer(rt:Runtime,read:ReadCheckout,state:CheckoutState){
  const current=read.result;const next=rt.payments.next(current);const action=current.attempt?.status==='requires_action'?current.attempt.pending_actions?.[0]:undefined;
  return {state,next,client_action:action?.client_action.stripe,pending_action_id:action?.pending_action_id,
    ...(current.totalChanged?{error:{kind:'conflict',code:'ORDER_CHANGED_REFRESH_REQUIRED',message_key:current.order.gift_cards?.length?'gift_card_changed':'total_changed'}}:{})};
}
