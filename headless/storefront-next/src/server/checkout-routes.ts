import 'server-only';
import {SdkError} from '@flintpay/node';
import type {CreateCheckoutSessionCustomerVerificationRequestInput,CreateCustomerAddressRequestInput,DeliveryAddressRequestInput,OrderTaxLocationFullAddressRequestInput,UpdateCustomerAddressRequestInput} from '@flintpay/node';
import {LocalError,condition,facts} from './flint/errors.ts';
import type {Quote,Details} from './flint/checkouts.ts';
import {validProof} from './flint/gift-challenge.ts';
import {buyerSafe} from './flint/projection.ts';
import type {ActionRecord} from './store/db.ts';
import type {PayInput,PaymentResult} from './payments/engine.ts';
import {decimalMinor,moneyEqual} from './security/money.ts';
import {digest} from './identity/index.ts';
import {approvedMoney,asRecord,email,phone,sameBillingAddress,text} from './input.ts';
import {clientIp,json,limited,route} from './http.ts';
import type {RouteContext} from './http.ts';
import {paymentAnswer,projectState} from './checkout-view.ts';

// The JSON routes the checkout page calls. Each mirrors one buyer action and answers with the
// buyer-safe checkout state. Route files under app/checkout/[ref] only bind these to URLs.

const ref=(ctx:RouteContext)=>ctx.ref!;
const own=(ctx:RouteContext)=>ctx.rt.checkouts.owned(ref(ctx),ctx.session,ctx.user);
const state=(ctx:RouteContext,result?:PaymentResult)=>projectState(ctx.rt,ref(ctx),ctx.user,result);
const rate=async(ctx:RouteContext,kind:string,count:number,window:number)=>limited(ctx,await clientIp(),kind,count,window);

/** Runs one change after confirming the buyer owns the checkout and it is readable, then answers with fresh state. */
function job(run:(ctx:RouteContext)=>Promise<unknown>){
  return route(async ctx=>{own(ctx);await ctx.rt.checkouts.read(ref(ctx),ctx.user);await run(ctx);return json({state:(await state(ctx)).state});});
}

export const getState=route(async ctx=>{own(ctx);return json({state:(await state(ctx)).state});});

export const postContact=job(async ctx=>{
  const {client,auth,checkouts}=ctx.rt;
  const input=await ctx.body();const contact:{email?:string|null;phone?:string|null}={};
  if(input.email!==undefined)contact.email=input.email===null||input.email===''?null:email(input.email);
  if(input.phone!==undefined)contact.phone=input.phone===null?null:phone(input.phone);
  const name=input.name===undefined?undefined:text(input.name,200);
  await checkouts.mutate(ref(ctx),'contact',{buyer_contact:contact,...(name===undefined?{}:{name})},async(record,key)=>{
    if(Object.keys(contact).length)await client.checkoutSessions.update(record.checkout_session_id!,{buyer_contact:contact},auth.checkout(record,key));
    const details=checkouts.details(record);details.contact={...details.contact,...contact};if(name!==undefined)details.name=name;checkouts.saveDetails(record,details);
  });
});

export const postTimezone=job(async ctx=>{
  const {client,auth,checkouts}=ctx.rt;const timezone=text((await ctx.body()).timezone,100);
  try{await checkouts.mutate(ref(ctx),'timezone',{timezone},(record,key)=>client.checkoutSessions.update(record.checkout_session_id!,{timezone},auth.checkout(record,key)));}
  catch(error){if(condition(error)!=='INVALID_TIMEZONE')throw error;}
});

export const postVerification=job(async ctx=>{
  const {client,auth,checkouts}=ctx.rt;
  const input=await ctx.body();const purpose=text(input.purpose);const channel=text(input.channel??'auto');
  if(!['use_saved_payment_methods','save_payment_method','confirm_saved_payment_method'].includes(purpose)||!['auto','email','sms'].includes(channel))throw new LocalError('INVALID_INPUT');
  // Confirming a saved card sends to the number and email from the payment, so the buyer supplies neither and `auto` is refused.
  const confirming=purpose==='confirm_saved_payment_method';if(confirming&&channel==='auto')throw new LocalError('INVALID_INPUT');
  // Codes before payment keep their own allowance, and Flint allows 3 per channel to confirm a card.
  if(confirming)await rate(ctx,'verification_confirm',6,15*60_000);else await rate(ctx,'verification',3,15*60_000);
  const address=confirming||!input.email?undefined:email(input.email);
  try{
    await checkouts.mutate(ref(ctx),'checkout_verification',{purpose,channel,email:address},async(record,key)=>{
      const verified=await client.checkoutSessions.createCustomerVerification({checkout_session_id:record.checkout_session_id!,body:{purpose,channel,...(address?{email:address}:{})} as CreateCheckoutSessionCustomerVerificationRequestInput},auth.checkout(record,key));
      const details=checkouts.details(record);details.verification={customer_verification_id:verified.checkout_session_customer_verification_id,status:'code_sent',purpose,channel:verified.channel,email:verified.email,phone_last_digits:verified.phone_last_digits};checkouts.saveDetails(record,details);
    });
  }catch(error){throw verificationRefusal(error,{confirming,channel});}
});

/** Flint refuses a code request or a saved-card confirmation with shared codes; the channel and purpose tell the cases apart. */
function verificationRefusal(error:unknown,{confirming,channel}:{confirming:boolean;channel:string}){
  if(condition(error)!=='ACTION_NOT_ALLOWED')return error;
  const reason=facts(error).reason;
  if(reason==='not_offered')return new LocalError(channel==='sms'?'CUSTOMER_VERIFICATION_TEXT_UNAVAILABLE':'PAYMENT_METHOD_SAVE_EMAIL_UNAVAILABLE',409);
  if(confirming&&reason==='unsupported_state')return new LocalError('PAYMENT_METHOD_SAVE_NOT_PENDING',409);
  if(confirming&&reason==='status_not_reached')return new LocalError('PAYMENT_METHOD_SAVE_NOT_READY',409);
  return error;
}

export const postVerificationConfirm=job(async ctx=>{
  const {client,auth,checkouts,store}=ctx.rt;
  const code=text((await ctx.body()).code,6);if(!/^\d{6}$/.test(code))throw new LocalError('CUSTOMER_VERIFICATION_CODE_INVALID');
  await checkouts.mutate(ref(ctx),'checkout_verification_confirm',{code_hash:digest(code)},async(record,key,context)=>{
    const details=checkouts.details(record);if(!details.verification)throw new LocalError('INVALID_CUSTOMER_ACCOUNT_REQUEST');
    const verified=await client.checkoutSessions.confirmCustomerVerification(record.checkout_session_id!,context.customer_verification_id!,{code},auth.checkout(record,key));
    if(verified.checkout_auth_token)store.run('UPDATE checkouts SET checkout_auth_token=? WHERE checkout_ref=?',verified.checkout_auth_token,record.checkout_ref);
    delete details.verification;checkouts.saveDetails(record,details);
  });
});

export const postDiscount=job(async ctx=>{
  const {client,auth,checkouts}=ctx.rt;
  await rate(ctx,'discount',10,10*60_000);const promotion_code=text((await ctx.body()).promotion_code,100);
  await checkouts.mutate(ref(ctx),'discount',{promotion_code},async(record,key)=>{
    await client.orders.applyDiscount(record.order_id!,{promotion:{promotion_code}},auth.checkout(record,key));
    const details=checkouts.details(record);if(details.delivery_selection)checkouts.notice(record,'delivery_released');delete details.delivery_selection;delete details.delivery_quote;checkouts.saveDetails(record,details);
  });
});

export const postDiscountRemove=job(async ctx=>{
  const {client,auth,checkouts,payments}=ctx.rt;
  const values=(await ctx.body()).order_discount_ids;if(!Array.isArray(values)||!values.length||!values.every(value=>typeof value==='string'))throw new LocalError('INVALID_INPUT');
  await checkouts.mutate(ref(ctx),'discount_remove',{order_discount_ids:values},async(record,key)=>{
    const order=await payments.read(record);if(values.some(value=>!order.discounts?.some(discount=>discount.order_discount_id===value)))throw new LocalError('NOT_FOUND',404);
    await client.orders.removeDiscounts(record.order_id!,{order_discount_ids:values as string[]},auth.checkout(record,key));
    const details=checkouts.details(record);delete details.delivery_selection;delete details.delivery_quote;checkouts.notice(record,'delivery_released');checkouts.saveDetails(record,details);
  });
});

export const postDeliveryQuote=job(async ctx=>{
  const {client,auth,checkouts}=ctx.rt;const input=await ctx.body();
  const destination:DeliveryAddressRequestInput=Object.fromEntries(Object.entries(asRecord(input.destination_address)).filter(([key])=>['line1','line2','city','state','postal_code','country'].includes(key)).map(([key,value])=>[key,text(value,200)]));
  await checkouts.mutate(ref(ctx),'delivery_quote',{destination_address:destination},async(record,key,context)=>{
    const details=checkouts.details(record);const response=await client.checkoutSessions.createDeliveryQuote(record.checkout_session_id!,{expected_delivery_selection_id:context.delivery_selection_id,destination_address:destination},auth.checkout(record,key));
    details.delivery_quote=response as Quote;details.quote_input={destination_address:destination};details.quote_basis={selection_id:context.delivery_selection_id};
    checkouts.saveDetails(record,details);
  });
});

export const postPickupLocations=job(async ctx=>{
  const input=await ctx.body();
  await ctx.rt.checkouts.previewPickup(ref(ctx),{type:'address',address:{postal_code:text(input.postal_code,20),country:text(input.country??'US',2)}});
});

type Recipient={name:string;email?:string;phone?:string};
function recipientOf(value:unknown):Recipient{const raw=asRecord(value);return {name:text(raw.name,200),...(raw.email?{email:email(raw.email)}:{}),...(raw.phone?{phone:phone(raw.phone)!}:{})};}

async function pickupSelect(ctx:RouteContext,pickupLocationId:string,recipient:Recipient){
  const {client,auth,checkouts}=ctx.rt;
  const id=ref(ctx);const known=(details:Details)=>details.pickup_preview?.locations.find(location=>location.location_id===pickupLocationId);
  type PickupRequest={choices:{delivery_choice_group_id:string;delivery_option_id:string}[];delivery_quote_id:string;expected_delivery_selection_id:string|null};
  type PickupInput={pickup_location_id:string;recipient:Recipient;request?:PickupRequest};
  // A selection whose outcome is unknown may already exist remotely, so it is replayed from its journal before any new quote is considered.
  const unresolved=checkouts.pendingInput<PickupInput>(id,'delivery_select');
  const replaying=!!unresolved?.request&&unresolved.pickup_location_id===pickupLocationId&&JSON.stringify(unresolved.recipient)===JSON.stringify(recipient);
  const current=checkouts.details(checkouts.record(id));
  if(!replaying){
    if(!known(current))throw new LocalError('INVALID_DELIVERY_SELECTION');
    const quoted=current.delivery_quote;
    const reusable=current.quote_input?.pickup_location_id===pickupLocationId&&!!quoted&&Date.parse(quoted.expires_at)>Date.now()&&current.quote_basis?.selection_id===(current.delivery_selection?.delivery_selection_id??null);
    if(!reusable)await checkouts.mutate(id,'delivery_quote',{pickup_location_id:pickupLocationId},async(record,key,context)=>{
      const details=checkouts.details(record);if(!known(details))throw new LocalError('INVALID_DELIVERY_SELECTION');
      details.delivery_quote=await client.checkoutSessions.createDeliveryQuote(record.checkout_session_id!,{expected_delivery_selection_id:context.delivery_selection_id,pickup_location_id:pickupLocationId},auth.checkout(record,key)) as Quote;
      details.quote_input={pickup_location_id:pickupLocationId};details.quote_basis={selection_id:context.delivery_selection_id};checkouts.saveDetails(record,details);
    });
  }
  let sent:PickupRequest|undefined;
  // The canonical request is journaled with the action; a replay sends it unchanged, including after the quote's local expiry.
  const build=(details:Details,saved?:{input:unknown}):PickupInput=>{
    const journaled=saved?.input as PickupInput|undefined;
    if(journaled){
      if(journaled.pickup_location_id!==pickupLocationId||JSON.stringify(journaled.recipient)!==JSON.stringify(recipient)||!journaled.request)throw new LocalError('ACTION_RECONCILIATION_REQUIRED',409);
      sent=journaled.request;return journaled;
    }
    const location=known(details);const quote=details.delivery_quote;if(!quote)throw new LocalError('DELIVERY_QUOTE_STALE',409);
    if(!location)throw new LocalError('INVALID_DELIVERY_SELECTION');
    if(new Date(quote.expires_at).getTime()<Date.now())throw new LocalError('DELIVERY_QUOTE_EXPIRED',409);
    const choices=quote.choice_groups.filter(group=>group.availability_status==='ready').map(group=>{
      const options=group.options.filter(option=>option.type==='pickup'&&!!option.delivery_option_id&&option.pickup?.location?.location_id===pickupLocationId&&location.delivery_method_ids.includes(option.delivery_method_id));
      if(options.length!==1)throw new LocalError('INVALID_DELIVERY_SELECTION');
      return {delivery_choice_group_id:group.delivery_choice_group_id,delivery_option_id:options[0]!.delivery_option_id!};
    });
    if(!choices.length)throw new LocalError('INVALID_DELIVERY_SELECTION');
    sent={choices,delivery_quote_id:quote.delivery_quote_id,expected_delivery_selection_id:details.delivery_selection?.delivery_selection_id??null};
    return {pickup_location_id:pickupLocationId,recipient,request:sent};
  };
  await checkouts.mutate(id,'delivery_select',build,async(record,key)=>{
    const request=sent!;const response=await client.checkoutSessions.createDeliverySelection(record.checkout_session_id!,{choices:request.choices,recipient,delivery_quote_id:request.delivery_quote_id,expected_delivery_selection_id:request.expected_delivery_selection_id},auth.checkout(record,key));
    const details=checkouts.details(record);details.delivery_selection=(response as {delivery_selection:Details['delivery_selection']}).delivery_selection;checkouts.saveDetails(record,details);
  });
}

export const postDeliverySelect=job(async ctx=>{
  const {client,auth,checkouts}=ctx.rt;const input=await ctx.body();
  if(input.pickup_location_id!==undefined)return pickupSelect(ctx,text(input.pickup_location_id,200),recipientOf(input.recipient));
  if(!Array.isArray(input.choices))throw new LocalError('INVALID_INPUT');
  const choices=input.choices.map(value=>{const choice=asRecord(value);return {delivery_choice_group_id:text(choice.delivery_choice_group_id),delivery_option_id:text(choice.delivery_option_id)};});
  const recipient=recipientOf(input.recipient);
  await checkouts.mutate(ref(ctx),'delivery_select',{choices,recipient},async(record,key,context)=>{
    const details=checkouts.details(record);const quoted=details.delivery_quote;if(!quoted)throw new LocalError('DELIVERY_QUOTE_STALE',409);
    if(new Date(quoted.expires_at).getTime()<Date.now())throw new LocalError('DELIVERY_QUOTE_EXPIRED',409);
    if(choices.length!==new Set(choices.map(choice=>choice.delivery_choice_group_id)).size||choices.some(choice=>!quoted.choice_groups.some(group=>group.delivery_choice_group_id===choice.delivery_choice_group_id&&group.options.some(option=>option.delivery_option_id===choice.delivery_option_id)))||quoted.choice_groups.some(group=>group.availability_status==='ready'&&!choices.some(choice=>choice.delivery_choice_group_id===group.delivery_choice_group_id)))throw new LocalError('INVALID_DELIVERY_SELECTION');
    const response=await client.checkoutSessions.createDeliverySelection(record.checkout_session_id!,{choices,recipient,delivery_quote_id:context.delivery_quote_id!,expected_delivery_selection_id:context.delivery_selection_id},auth.checkout(record,key));
    details.delivery_selection=(response as {delivery_selection:Details['delivery_selection']}).delivery_selection;checkouts.saveDetails(record,details);
  });
});

export const postBillingAddress=job(async ctx=>{
  const {client,auth,checkouts,payments,identity,store,preflight}=ctx.rt;
  const input=await ctx.body();const line1=text(input.line1,200),city=text(input.city,200),stateCode=text(input.state,2),postal_code=text(input.postal_code,200),country=text(input.country,2),line2=input.line2===undefined?'':text(input.line2,200);
  if(!line1||!city||!stateCode||!/^\d{5}(-\d{4})?$/.test(postal_code)||country!=='US')throw new LocalError('INVALID_INPUT');
  const address:OrderTaxLocationFullAddressRequestInput={line1,city,state:stateCode,postal_code,country,...(line2?{line2}:{})};
  await checkouts.mutate(ref(ctx),'tax_location',{address},async(record,key)=>{
    const session=await client.checkoutSessions.get(record.checkout_session_id!,undefined,auth.checkout(record));const order=await payments.read(record);const details=checkouts.details(record);
    if(session.delivery_selection_required||details.delivery_quote||details.delivery_selection||order.tax?.enabled!==true)throw new LocalError('INVALID_INPUT');
    const user=ctx.user;
    if(record.kind==='subscription'&&identity.isBound(user,preflight.sandboxId)&&record.user_id===user.user_id&&order.customer_id===user.flint_customer_id){
      const customer=await client.customers.get(user.flint_customer_id!,undefined,auth.merchant());const customerKey=`${key}-customer`;
      const previous=store.get<ActionRecord>('SELECT * FROM actions WHERE idempotency_key=?',customerKey);
      const ownedBilling=details.customer_billing_address&&sameBillingAddress(customer.billing_address,details.customer_billing_address);
      if(previous||!sameBillingAddress(customer.billing_address,address)&&(!customer.billing_address&&!customer.shipping_address||ownedBilling)){
        // The customer's billing address is a copy of its default saved address: the first one is created as that default, and a correction replaces the saved address this checkout made.
        // Keep the original target and version when recovering a lost response.
        type Saved={customer_id:string}&({create:CreateCustomerAddressRequestInput}|{customer_address_id:string;update:UpdateCustomerAddressRequestInput});
        let update:Saved;
        if(previous?.body)update=JSON.parse(previous.body) as Saved;
        else if(ownedBilling){
          const saved=(await client.customers.listAddresses(customer.customer_id,{page_size:100},auth.merchant())).data.find(item=>item.is_default_billing);
          if(!saved)throw new LocalError('ACTION_RECONCILIATION_REQUIRED',409);
          update={customer_id:customer.customer_id,customer_address_id:saved.customer_address_id,update:{address,expected_version:saved.version}};
        }else update={customer_id:customer.customer_id,create:{address,recipient_name:user.name,is_default_billing:true}};
        if(update.customer_id!==user.flint_customer_id)throw new LocalError('ACTION_RECONCILIATION_REQUIRED',409);
        await checkouts.action(record,'tax_location_customer',update,async customerKey=>{
          if(sameBillingAddress(customer.billing_address,address))return customer;
          return 'create'in update?client.customers.createAddress(update.customer_id,update.create,auth.merchant(customerKey)):client.customers.updateAddress(update.customer_id,update.customer_address_id,update.update,auth.merchant(customerKey));
        },customerKey,undefined,`action:${key}`);
        details.customer_billing_address=address;checkouts.saveDetails(record,details);
      }
    }
    await client.orders.update(record.order_id!,{tax:{enabled:true,location:{address_source:'provided',address_type:'billing_address',address}}},auth.checkout(record,key));
    details.billing_address=address;checkouts.saveDetails(record,details);
  });
});

export const postGiftCard=route(async ctx=>{
  own(ctx);await rate(ctx,'gift',5,3600000);await ctx.rt.checkouts.read(ref(ctx),ctx.user);
  const giftCardCode=text((await ctx.body()).gift_card_code,200);if(!giftCardCode)throw new LocalError('INVALID_INPUT');
  const giftChallenge=await ctx.rt.checkouts.applyGift(ref(ctx),giftCardCode);
  return json({state:(await state(ctx)).state,...(giftChallenge?{gift_challenge:giftChallenge}:{})});
});

export const postGiftChallenge=route(async ctx=>{
  own(ctx);await rate(ctx,'gift_challenge',10,3600000);
  const input=await ctx.body(),challengeId=input.challenge_id,proof=input.proof,giftCardCode=text(input.gift_card_code,200);
  if(typeof challengeId!=='string'||!/^gch_[A-Za-z0-9_-]{32}$/.test(challengeId)||!giftCardCode||!validProof(proof))throw new LocalError('INVALID_INPUT');
  const giftChallenge=await ctx.rt.checkouts.retryGift(ref(ctx),challengeId,giftCardCode,proof);
  return json({state:(await state(ctx)).state,...(giftChallenge?{gift_challenge:giftChallenge}:{})});
});

export function postGiftCardRemove(giftCardId:(ctx:RouteContext)=>Promise<string>){
  return job(async ctx=>{
    const {client,auth,checkouts}=ctx.rt;const id=await giftCardId(ctx);
    await checkouts.mutate(ref(ctx),'gift_remove',{gift_card_id:id},async(record,key,context)=>{if(!context.order_version)throw new LocalError('NOT_FOUND',404);return client.orders.removeGiftCard(record.order_id!,id,{expected_version:context.order_version},auth.checkout(record,key));});
  });
}

export const postTip=job(async ctx=>{
  const {client,auth,checkouts}=ctx.rt;
  const input=await ctx.body();let requested_tip:{calculation_type:'percent';percent:number}|{calculation_type:'amount';amount_money:{amount:`${bigint}`;currency:string}}|null;
  if(input.clear===true)requested_tip=null;
  else if(input.percent!==undefined){const percent=Number(input.percent);if(!Number.isFinite(percent)||percent<1||percent>100)throw new LocalError('INVALID_TIP');requested_tip={calculation_type:'percent',percent};}
  else{let amount:string;try{amount=decimalMinor(text(input.amount,20));}catch{throw new LocalError('INVALID_TIP');}requested_tip={calculation_type:'amount',amount_money:{amount:amount as `${bigint}`,currency:'USD'}};}
  await checkouts.mutate(ref(ctx),'tip',{requested_tip},(record,key)=>client.orders.update(record.order_id!,{requested_tip},auth.checkout(record,key)));
});

export const getSavedMethods=route(async ctx=>{
  own(ctx);const current=await state(ctx);const methods=await ctx.rt.client.paymentMethods.list({status:['active']},ctx.rt.auth.checkout(current.read.record));
  return json({state:{...current.state,saved_methods:buyerSafe(methods.data)}});
});

export const postPay=route(async ctx=>{
  const {client,auth,checkouts,payments}=ctx.rt;
  own(ctx);await rate(ctx,'pay',10,60_000);await checkouts.read(ref(ctx),ctx.user);const raw=await ctx.body();
  const credential=raw.credential?asRecord(raw.credential):undefined;
  if(credential&&!['confirmation_token','payment_method_token','saved_payment_method'].includes(String(credential.kind)))throw new LocalError('PAYMENT_SOURCE_REQUIRED');
  if(!['processor','settlement','setup','unavailable'].includes(String(raw.approved_collection_kind)))throw new LocalError('INVALID_PAYMENT_APPROVAL');
  const contact=raw.buyer_contact?asRecord(raw.buyer_contact):undefined;
  const input:PayInput={approved_outstanding_money:approvedMoney(raw.approved_outstanding_money),approved_collection_kind:raw.approved_collection_kind as PayInput['approved_collection_kind'],
    ...(credential?{credential:{kind:credential.kind as NonNullable<PayInput['credential']>['kind'],value:text(credential.value,400)}}:{}),
    ...(raw.approved_order_version?{approved_order_version:text(raw.approved_order_version,20)}:{}),
    ...(raw.approved_gift_card_money?{approved_gift_card_money:approvedMoney(raw.approved_gift_card_money)}:{}),
    ...(contact?{buyer_contact:{email:email(contact.email),...(contact.phone?{phone:phone(contact.phone)!}:{})}}:{}),
    save_payment_method:raw.save_payment_method===true,save_payment_method_phone:raw.save_payment_method_phone?phone(raw.save_payment_method_phone)??undefined:undefined};
  const id=ref(ctx);
  // Flint refuses tax older than its freshness window before it creates an attempt, so nothing was charged.
  // Tax is worked out again at the order's saved location, and the buyer approves the result with a new press.
  const refreshTax=()=>checkouts.mutate(id,'tax_refresh',{},(record,key)=>client.orders.update(record.order_id!,{tax:{enabled:true}},auth.checkout(record,key)));
  const refreshed=async()=>{
    const current=await state(ctx);const same=moneyEqual(current.read.order.settlement_amounts.outstanding_money,input.approved_outstanding_money);
    return json({state:current.state,next:payments.next(current.read.result),error:{kind:'conflict',code:'ORDER_CHANGED_REFRESH_REQUIRED',message_key:same?'tax_updated':'total_changed'}});
  };
  // A refresh whose outcome is unknown is replayed with its own key before anything else, or it blocks every later pay.
  if(checkouts.pendingInput(id,'tax_refresh')){
    // No payment was sent on this press, so a failed replay gets the tax message; the journal keeps the refresh's own outcome.
    try{await refreshTax();}catch(error){if(error instanceof SdkError)throw new LocalError('ORDER_TAX_NOT_READY',409);throw error;}
    return refreshed();
  }
  let result:PaymentResult;
  try{result=await payments.start(id,input);}
  catch(error){
    if(condition(error,'payment')!=='ORDER_TAX_NOT_READY')throw error;
    // The refresh runs after the engine releases the order lock; the buyer sees the specific message if it fails.
    try{await refreshTax();}catch{throw error;}
    return refreshed();
  }
  const current=await state(ctx,result);return json(paymentAnswer(ctx.rt,current.read,current.state));
});

export const postResume=route(async ctx=>{own(ctx);await rate(ctx,'pay',10,60_000);const result=await ctx.rt.payments.resume(ref(ctx));const current=await state(ctx,result);return json(paymentAnswer(ctx.rt,current.read,current.state));});
export const getAttempt=route(async ctx=>{own(ctx);const current=await state(ctx);return json(paymentAnswer(ctx.rt,current.read,current.state));});
export const postCancelAttempt=route(async ctx=>{own(ctx);const result=await ctx.rt.payments.cancel(ref(ctx));const current=await state(ctx,result);return json(paymentAnswer(ctx.rt,current.read,current.state));});

export const postReceipt=job(async ctx=>{
  const {client,auth,checkouts}=ctx.rt;
  const record=own(ctx);const details=checkouts.details(record);
  if(details.receipt_sent_at&&Date.now()-details.receipt_sent_at<5*60_000)throw new LocalError('RECEIPT_JUST_SENT',429);
  const current=await checkouts.read(record.checkout_ref,ctx.user);
  await checkouts.action(record,'receipt',{},key=>client.orders.sendReceipt(record.order_id!,{},current.session.status!=='open'||!record.checkout_auth_token?auth.merchant(key):auth.checkout(record,key)));
  details.receipt_sent_at=Date.now();checkouts.saveDetails(record,details);
});
