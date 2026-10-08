import type {Client,Order,CheckoutSession,BuyerDeliveryQuoteChoiceGroupResource,DeliveryAddressRequestInput,DeliveryBuyerLocationRequestInput,Subscription} from '@flintpay/node';
import {createHash} from 'node:crypto';
import type {Auth} from './auth.ts';
import {LocalError,unknownOutcome,appError} from './errors.ts';
import {SdkError} from '@flintpay/node';
import {challengeFromError,confirmWithSession,newChallengeId,sessionTag,applyWithProof} from './gift-challenge.ts';
import type {GiftChallengeView} from '../views/types.ts';
import {logGiftChallenge,logLaunchInvalid} from '../security/log.ts';
import {buyerSafe,safeOrder,safeSession,safeAttempt} from './projection.ts';
import {Store} from '../store/db.ts';
import type {CheckoutRecord,ActionRecord,GiftChallengeRecord} from '../store/db.ts';
import {IdentityStore,randomReference} from '../identity/index.ts';
import type {User,Session} from '../identity/index.ts';
import {Carts} from '../store/cart.ts';
import type {Cart,CartLine} from '../store/cart.ts';
import type {Config} from '../config.ts';
import {PaymentEngine,collectionKind} from '../payments/engine.ts';
import type {PaymentResult} from '../payments/engine.ts';
import {attemptOpen} from '../payments/next-step.ts';

export type Quote={delivery_quote_id:string;choice_groups:BuyerDeliveryQuoteChoiceGroupResource[];expires_at:string;input_requirements:unknown[];buyer_reasons?:string[];status:string};
export type Details={name?:string;contact?:{email?:string|null;phone?:string|null};delivery_quote?:Quote;delivery_selection?:{delivery_selection_id?:string;[key:string]:unknown};pickup_locations?:unknown[];quote_input?:{destination_address?:DeliveryAddressRequestInput;buyer_location?:DeliveryBuyerLocationRequestInput};verification?:{customer_verification_id:string;status:string;channel?:string;email?:string;phone_last_digits?:string};receipt_sent_at?:number;gift_origin_replaced_at?:number};
export type ReadCheckout={record:CheckoutRecord;session:CheckoutSession;order:Order;result:PaymentResult};
export type MutationContext={order_revision?:string;delivery_selection_id:string|null;delivery_quote_id?:string;customer_verification_id?:string};
const displayNotices=new Set(['checkout_refreshed','delivery_released','total_changed','gift_card_changed','affirm_incomplete','signed_in_mid_checkout','delivery_requoted']);

export class Checkouts {
  client:Client;auth:Auth;store:Store;identity:IdentityStore;config:Config;sandboxId:string;carts:Carts;payments:PaymentEngine;
  constructor(client:Client,auth:Auth,store:Store,identity:IdentityStore,config:Config,sandboxId:string,carts:Carts,payments:PaymentEngine){Object.assign(this,{client,auth,store,identity,config,sandboxId,carts,payments});this.client=client;this.auth=auth;this.store=store;this.identity=identity;this.config=config;this.sandboxId=sandboxId;this.carts=carts;this.payments=payments;}
  record(ref:string):CheckoutRecord{const row=this.store.get<CheckoutRecord>('SELECT * FROM checkouts WHERE checkout_ref=?',ref);if(!row)throw new LocalError('NOT_FOUND',404);return row;}
  owned(ref:string,session:Session,user?:User):CheckoutRecord{
    const row=this.record(ref);
    if(row.session_hash!==session.session_hash&&(!user||row.user_id!==user.user_id))throw new LocalError('NOT_FOUND',404);
    return row;
  }
  details(record:CheckoutRecord):Details{return JSON.parse(record.details) as Details;}
  saveDetails(record:CheckoutRecord,details:Details){this.store.run('UPDATE checkouts SET details=?,updated_at=? WHERE checkout_ref=?',JSON.stringify(details),Date.now(),record.checkout_ref);record.details=JSON.stringify(details);}
  notice(record:CheckoutRecord,key:string){
    this.store.transaction(()=>{const keys=JSON.parse(this.record(record.checkout_ref).flash) as string[];if(!keys.includes(key))keys.push(key);record.flash=JSON.stringify(keys);this.store.run('UPDATE checkouts SET flash=? WHERE checkout_ref=?',record.flash,record.checkout_ref);});
  }
  displayNotices(record:CheckoutRecord):string[]{return (JSON.parse(record.flash) as string[]).filter(key=>displayNotices.has(key));}
  consumeNotices(record:CheckoutRecord,shown:readonly string[]){
    const consumed=new Set(shown.filter(key=>displayNotices.has(key)));if(!consumed.size)return;
    this.store.transaction(()=>{
      const current=this.record(record.checkout_ref);const remaining=(JSON.parse(current.flash) as string[]).filter(key=>!consumed.has(key));
      record.flash=JSON.stringify(remaining);this.store.run('UPDATE checkouts SET flash=? WHERE checkout_ref=?',record.flash,record.checkout_ref);
    });
  }
  async action<T>(record:CheckoutRecord,kind:string,body:unknown,call:(key:string)=>Promise<T>,fixedKey?:string,classifyError?:(error:unknown)=>'challenge'|undefined):Promise<T>{
    const hash=createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const resource=`order:${record.order_id??record.checkout_ref}`;
    let row=fixedKey?this.store.get<ActionRecord>('SELECT * FROM actions WHERE idempotency_key=?',fixedKey):this.store.get<ActionRecord>("SELECT * FROM actions WHERE resource=? AND kind=? AND status IN ('pending','unknown')",resource,kind);
    if(row&&row.body_hash!==hash)throw new LocalError('ACTION_RECONCILIATION_REQUIRED',409);
    if(!row){const key=fixedKey??`${kind}-${record.checkout_ref}-${randomReference('')}`;this.store.run('INSERT INTO actions(action_id,resource,kind,idempotency_key,body,body_hash,created_at) VALUES(?,?,?,?,?,?,?)',key,resource,kind,key,JSON.stringify(body),hash,Date.now());row=this.store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',key)!;}
    try{const response=await call(row.idempotency_key);this.store.run("UPDATE actions SET status='succeeded' WHERE action_id=?",row.action_id);return response;}
    catch(error){const uncertain=unknownOutcome(error)||error instanceof SdkError&&(error.outcome!=='response'||[401,403].includes(error.status??0))||!(error instanceof SdkError||error instanceof LocalError);this.store.run('UPDATE actions SET status=? WHERE action_id=?',classifyError?.(error)??(uncertain?'unknown':'rejected'),row.action_id);throw error;}
  }
  async launch(record:CheckoutRecord,customerId?:string):Promise<CheckoutRecord>{
    const common={surface:'embedded' as const,page_origin:this.config.appOrigin,customer_collection:{require_email:true,...(customerId?{customer_id:customerId}:{})},expiration:{expires_in_seconds:String(this.config.checkoutTtl)},redirects:{success_redirect_url:`${this.config.appOrigin}/checkout/${record.checkout_ref}/return`},external_reference_id:record.checkout_ref};
    const freshInput=record.order_id?{...common,order_id:record.order_id,...(record.checkout_session_id?{replace_checkout_session_id:record.checkout_session_id}:{})}:{...common,subscription_plan_id:record.subscription_plan_id!};
    const previous=this.store.get<ActionRecord>('SELECT * FROM actions WHERE idempotency_key=?',`session-${record.checkout_ref}-${record.generation}`);
    const input=previous?.body?JSON.parse(previous.body) as typeof freshInput:freshInput;
    const launched=await this.action(record,'session_create',input,key=>this.client.checkoutSessions.create(input,this.auth.merchant(key)),`session-${record.checkout_ref}-${record.generation}`);
    if(input.page_origin&&launched.checkout_session.page_origin!==input.page_origin){logLaunchInvalid('page_origin_mismatch');throw new LocalError('CHECKOUT_LAUNCH_INVALID',503);}
    this.store.run('UPDATE checkouts SET order_id=?,checkout_session_id=?,checkout_auth_token=?,needs_replacement=0,updated_at=? WHERE checkout_ref=?',launched.checkout_session.order_id??record.order_id,launched.checkout_session.checkout_session_id,launched.checkout_access.checkout_auth_token,Date.now(),record.checkout_ref);
    return this.record(record.checkout_ref);
  }
  async start(cart:Cart,session:Session,user?:User):Promise<CheckoutRecord>{
    return this.store.locked(`cart:${cart.cart_id}`,async()=>{
      let record=this.store.get<CheckoutRecord>("SELECT * FROM checkouts WHERE cart_id=? AND status='open' ORDER BY created_at DESC LIMIT 1",cart.cart_id);
      if(record){if(!record.checkout_auth_token)record=await this.finishStart(record,cart,user);if(record.cart_dirty)record=(await this.read(record.checkout_ref,user)).record;return record;}
      if(!this.carts.lines(cart).length)throw new LocalError('CART_EMPTY');
      const ref=randomReference('chk_');this.store.run('INSERT INTO checkouts(checkout_ref,cart_id,session_hash,user_id,kind,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',ref,cart.cart_id,session.session_hash,user?.user_id??null,'order',Date.now(),Date.now());
      record=this.record(ref);return this.finishStart(record,cart,user);
    });
  }
  async finishStart(record:CheckoutRecord,cart:Cart,user?:User):Promise<CheckoutRecord>{
    const bound=this.identity.isBound(user,this.sandboxId)?user.flint_customer_id!:undefined;
    if(!record.order_id){
      const freshInput={line_items:this.carts.lines(cart).map(line=>({variant_id:line.variant_id,quantity:String(line.quantity)})),...(bound?{customer_id:bound}:{}),external_reference_id:record.checkout_ref,metadata:{example_checkout_ref:record.checkout_ref}};
      const previous=this.store.get<ActionRecord>('SELECT * FROM actions WHERE idempotency_key=?',`order-${record.checkout_ref}`);
      const input=previous?.body?JSON.parse(previous.body) as typeof freshInput:freshInput;
      const order=await this.action(record,'order_create',input,key=>this.client.orders.create(input,this.auth.merchant(key)),`order-${record.checkout_ref}`);
      this.store.run('UPDATE checkouts SET order_id=? WHERE checkout_ref=?',order.order_id,record.checkout_ref);record=this.record(record.checkout_ref);
    }
    return this.launch(record,bound);
  }
  async subscribe(planId:string,session:Session,user?:User):Promise<CheckoutRecord>{
    const ref=randomReference('chk_');this.store.run('INSERT INTO checkouts(checkout_ref,session_hash,user_id,kind,subscription_plan_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',ref,session.session_hash,user?.user_id??null,'subscription',planId,Date.now(),Date.now());
    return this.launch(this.record(ref),this.identity.isBound(user,this.sandboxId)?user.flint_customer_id!:undefined);
  }
  async read(ref:string,user?:User):Promise<ReadCheckout>{
    const initial=this.record(ref);
    if(!initial.order_id||!initial.checkout_session_id)throw new LocalError('CHECKOUT_SETUP_INCOMPLETE',409);
    return this.store.locked(`order:${initial.order_id}`,async()=>{
      let record=this.record(ref);let session:CheckoutSession;let credentialsStale=false;
      if(record.cart_dirty){await this.syncRecord(record);record=this.record(ref);}
      try{session=await this.client.checkoutSessions.get(record.checkout_session_id!,undefined,record.checkout_auth_token?this.auth.checkout(record):this.auth.merchant());}
      catch(error){
        const code=error&&typeof error==='object'&&'code'in error?error.code:undefined;
        if(!['INVALID_CHECKOUT_SESSION','CHECKOUT_SESSION_EXPIRED','CHECKOUT_SESSION_NOT_OPEN'].includes(String(code)))throw error;
        credentialsStale=true;
        session=await this.client.checkoutSessions.get(record.checkout_session_id!,undefined,this.auth.merchant());
      }
      const managedRead=['paid','partially_paid'].includes(session.status)||['invalidated','expired','closed'].includes(session.status)&&!session.recovery_mode;
      let order=managedRead?await this.client.orders.get(record.order_id!,undefined,this.auth.merchant()):await this.payments.read(record);
      const unresolved=this.payments.unresolved(record);
      const unresolvedMutation=this.store.get<ActionRecord>("SELECT * FROM actions WHERE resource=? AND kind NOT IN ('pay','resume','cancel','session_create') AND status IN ('pending','unknown')",`order:${record.order_id}`);
      if(this.identity.isBound(user,this.sandboxId)&&order.customer_id!==user.flint_customer_id&&record.user_id===user.user_id){
        if(attemptOpen(order.active_payment_attempt)||unresolved||unresolvedMutation)this.notice(record,'signed_in_mid_checkout');
        else if(session.status==='open'&&record.kind==='order'){
          await this.action(record,'session_close',{},key=>this.client.checkoutSessions.closeSession(record.checkout_session_id!,{},this.auth.merchant(key)));
          await this.action(record,'customer_bind',{customer_id:user.flint_customer_id},key=>this.client.orders.update(record.order_id!,{customer_id:user.flint_customer_id!},this.auth.merchant(key)));
          this.store.run('UPDATE checkouts SET needs_replacement=1 WHERE checkout_ref=?',ref);record.needs_replacement=1;
        }
      }
      if((credentialsStale||record.needs_replacement||['invalidated','expired','closed'].includes(session.status))&&!session.recovery_mode&&!attemptOpen(order.active_payment_attempt)&&!unresolved&&!unresolvedMutation&&order.payment_status!=='paid'&&order.status==='open'){
        const previous=this.store.get<ActionRecord>('SELECT * FROM actions WHERE idempotency_key=?',`session-${record.checkout_ref}-${record.generation}`);
        const replay=previous&&(previous.status==='pending'||previous.status==='unknown'||previous.body&&JSON.parse(previous.body).replace_checkout_session_id===record.checkout_session_id);
        if(!replay){this.store.run('UPDATE checkouts SET generation=generation+1 WHERE checkout_ref=?',ref);record=this.record(ref);}
        record=await this.launch(record,this.identity.isBound(user,this.sandboxId)?user.flint_customer_id!:undefined);
        const details=this.details(record);delete details.delivery_quote;delete details.delivery_selection;delete details.pickup_locations;delete details.verification;this.saveDetails(record,details);
        this.notice(record,'checkout_refreshed');
        session=await this.client.checkoutSessions.get(record.checkout_session_id!,undefined,this.auth.checkout(record));order=await this.client.orders.get(record.order_id!,undefined,this.auth.checkout(record));
        credentialsStale=false;
      }
      if(session.status==='open'&&!credentialsStale){
        const selected=await this.client.checkoutSessions.getCurrentDeliverySelection(record.checkout_session_id!,undefined,this.auth.checkout(record)) as {delivery_selection?:Details['delivery_selection']};
        const details=this.details(record);details.delivery_selection=selected.delivery_selection;this.saveDetails(record,details);
        const stale=details.delivery_selection&&['expired','released','superseded'].includes(String(details.delivery_selection.status));
        const expiredQuote=details.delivery_quote&&Date.parse(details.delivery_quote.expires_at)<=Date.now();
        if((stale||expiredQuote||!details.delivery_selection&&!details.delivery_quote)&&details.quote_input&&!unresolved&&!unresolvedMutation&&!attemptOpen(order.active_payment_attempt)){
          await this.refreshQuote(record,details);order=await this.client.orders.get(record.order_id!,undefined,this.auth.checkout(record));
        }
      }
      const attempt=await this.payments.attempt(record,order,managedRead);this.payments.remember(record,attempt);
      const result=this.payments.observe(record,order,attempt);
      const status=order.payment_status==='paid'?'paid':this.payments.next(result)==='bank_processing'?'bank_processing':'open';
      if(status!=='open')this.store.run('UPDATE checkouts SET status=?,completed_at=COALESCE(completed_at,?),updated_at=? WHERE checkout_ref=?',status,Date.now(),Date.now(),ref);
      return {record,session,order,result};
    });
  }
  async refreshQuote(record:CheckoutRecord,details:Details){
    const input={expected_delivery_selection_id:details.delivery_selection?.delivery_selection_id??null,...details.quote_input};
    const quoted=await this.action(record,'delivery_requote',input,key=>this.client.checkoutSessions.createDeliveryQuote(record.checkout_session_id!,input,this.auth.checkout(record,key))) as Quote;
    details.delivery_quote=quoted;delete details.delivery_selection;
    details.pickup_locations=details.quote_input?.buyer_location?quoted.choice_groups.flatMap(group=>group.options.filter(option=>option.type==='pickup').map(option=>({...option,delivery_choice_group_id:group.delivery_choice_group_id,availability_status:group.availability_status,input_requirements:group.input_requirements,expires_at:quoted.expires_at}))).sort((a,b)=>a.display_position-b.display_position):undefined;
    this.saveDetails(record,details);this.notice(record,'delivery_requoted');
  }
  project(read:ReadCheckout){
    const details=this.details(read.record);const next=this.payments.next(read.result);
    const verification=details.verification?{status:'code_sent',delivery_channel:details.verification.channel,masked_email:details.verification.email,phone_last_digits:details.verification.phone_last_digits}:undefined;
    return {checkout_ref:read.record.checkout_ref,kind:read.record.kind,collection_kind:collectionKind(read.order,read.record.kind),session:safeSession(read.session),order:safeOrder(read.order),attempt:safeAttempt(read.result.attempt),next,
      payment_collection:buyerSafe(read.order.payment_collection??read.session.payment_collection),setup_collection:buyerSafe(read.order.setup_collection??read.session.setup_collection),
      delivery_quote:buyerSafe(details.delivery_quote),delivery_selection:buyerSafe(details.delivery_selection),pickup_locations:buyerSafe(details.pickup_locations),verification,
      contact_name:details.name,notices:this.displayNotices(read.record),approved_outstanding_money:read.order.settlement_amounts.outstanding_money};
  }
  async cartLock(cart:Cart,session:Session,user?:User):Promise<CheckoutRecord|undefined>{
    return this.store.locked(`cart:${cart.cart_id}`,async()=>{
      const records=this.store.all<CheckoutRecord>("SELECT * FROM checkouts WHERE cart_id=? AND status='open' AND order_id IS NOT NULL ORDER BY order_id",cart.cart_id).filter(record=>record.session_hash===session.session_hash||!!user&&record.user_id===user.user_id);
      const read=async(index:number):Promise<CheckoutRecord|undefined>=>{
        if(index<records.length)return this.store.locked(`order:${records[index]!.order_id}`,()=>read(index+1));
        for(const stale of records){
          const record=this.record(stale.checkout_ref);
          if(this.payments.unresolved(record))return record;
          const order=await this.client.orders.get(record.order_id!,undefined,this.auth.merchant());
          if(attemptOpen(order.active_payment_attempt))return record;
        }
      };
      return read(0);
    });
  }
  async mutate<T>(ref:string,kind:string,body:unknown,call:(record:CheckoutRecord,key:string,context:MutationContext)=>Promise<T>):Promise<T>{
    const initial=this.record(ref);
    return this.store.locked(`order:${initial.order_id}`,async()=>{
      const record=this.record(ref);
      if(this.payments.unresolved(record))throw new LocalError('CHECKOUT_PAYMENT_RESOLVING',409);
      const pending=this.store.get<ActionRecord>("SELECT * FROM actions WHERE resource=? AND kind NOT IN ('pay','resume','cancel') AND status IN ('pending','unknown')",`order:${record.order_id}`);
      if(pending&&pending.kind!==kind)throw new LocalError('ACTION_RECONCILIATION_REQUIRED',409);
      const order=await this.payments.read(record);
      if(attemptOpen(order.active_payment_attempt))throw new LocalError('PAYMENT_ATTEMPT_IN_PROGRESS',409);
      const details=this.details(record);
      const saved=pending?.body?JSON.parse(pending.body) as {input:unknown;context:MutationContext}:undefined;
      if(saved&&JSON.stringify(saved.input)!==JSON.stringify(body))throw new LocalError('ACTION_RECONCILIATION_REQUIRED',409);
      const context=saved?.context??{order_revision:order.order_revision,delivery_selection_id:details.delivery_selection?.delivery_selection_id??null,delivery_quote_id:details.delivery_quote?.delivery_quote_id,customer_verification_id:details.verification?.customer_verification_id};
      if(kind==='gift_remove')this.store.abandonGiftChallenges(ref,`order:${record.order_id}`);
      return this.action(record,kind,{input:body,context},key=>call(record,key,context));
    });
  }
  async giftOutcome(record:CheckoutRecord,action:ActionRecord,error:unknown,retry=false):Promise<GiftChallengeView>{
    this.store.closeGiftChallenges(record.checkout_ref);
    const parsed=challengeFromError(error,this.config.giftChallengeOrigin);
    if(!parsed){
      if(retry)logGiftChallenge({outcome:unknownOutcome(error)?'retry_unknown':'retry_rejected',cause:appError(error).code,checkout_ref:record.checkout_ref,flint_request_id:appError(error).request_id});
      throw error;
    }
    let outcome;
    try{outcome=await confirmWithSession(parsed,()=>this.client.checkoutSessions.get(record.checkout_session_id!,undefined,this.auth.checkout(record)),record.checkout_session_id!);}
    catch(readError){this.store.run("UPDATE actions SET status='unknown' WHERE action_id=?",action.action_id);throw readError;}
    if(outcome.kind==='challenge'){
      const challengeId=newChallengeId();this.store.issueGiftChallenge(record.checkout_ref,action.action_id,record.checkout_session_id!,challengeId);
      logGiftChallenge({outcome:'issued',checkout_ref:record.checkout_ref,flint_request_id:appError(error).request_id});
      return {challenge_id:challengeId,url:outcome.url,session_tag:sessionTag(challengeId,record.checkout_session_id!),reason:outcome.reason,expires_in_seconds:900};
    }
    this.store.run("UPDATE actions SET status='rejected' WHERE action_id=?",action.action_id);
    if(outcome.kind==='origin_required'){
      const details=this.details(record),now=Date.now();
      if(!details.gift_origin_replaced_at||now-details.gift_origin_replaced_at>=600000){
        details.gift_origin_replaced_at=now;this.saveDetails(record,details);this.store.run('UPDATE checkouts SET needs_replacement=1 WHERE checkout_ref=?',record.checkout_ref);
        logGiftChallenge({outcome:'origin_required',checkout_ref:record.checkout_ref,flint_request_id:appError(error).request_id});
        throw new LocalError('GIFT_CARD_CHALLENGE_ORIGIN_REQUIRED',409);
      }
    }
    logGiftChallenge({outcome:'unavailable',cause:outcome.kind==='unavailable'?outcome.cause:'origin_replacement_limit',checkout_ref:record.checkout_ref,flint_request_id:appError(error).request_id});
    throw new LocalError('GIFT_CARD_CHALLENGE_UNAVAILABLE',503);
  }
  async applyGift(ref:string,giftCardCode:string):Promise<GiftChallengeView|undefined>{
    const initial=this.record(ref);
    return this.store.locked(`order:${initial.order_id}`,async()=>{
      const record=this.record(ref),resource=`order:${record.order_id}`;
      if(this.payments.unresolved(record))throw new LocalError('CHECKOUT_PAYMENT_RESOLVING',409);
      const pending=this.store.get<ActionRecord>("SELECT * FROM actions WHERE resource=? AND kind NOT IN ('pay','resume','cancel') AND status IN ('pending','unknown')",resource);
      if(pending&&pending.kind!=='gift')throw new LocalError('ACTION_RECONCILIATION_REQUIRED',409);
      const order=await this.payments.read(record);if(attemptOpen(order.active_payment_attempt))throw new LocalError('PAYMENT_ATTEMPT_IN_PROGRESS',409);
      const input={code_hash:createHash('sha256').update(giftCardCode).digest('hex')},details=this.details(record);
      const saved=pending?.body?JSON.parse(pending.body) as {input:{code_hash:string};context:MutationContext}:undefined;
      if(saved&&saved.input.code_hash!==input.code_hash)throw new LocalError('ACTION_RECONCILIATION_REQUIRED',409);
      const context=saved?.context??{order_revision:order.order_revision,delivery_selection_id:details.delivery_selection?.delivery_selection_id??null,delivery_quote_id:details.delivery_quote?.delivery_quote_id,customer_verification_id:details.verification?.customer_verification_id};
      if(!context.order_revision)throw new LocalError('ORDER_CHANGED_REFRESH_REQUIRED',409);
      this.store.abandonGiftChallenges(ref,resource);
      let action:ActionRecord|undefined;
      try{
        await this.action(record,'gift',{input,context},key=>{action=this.store.get<ActionRecord>('SELECT * FROM actions WHERE idempotency_key=?',key);return this.client.orders.applyGiftCard(record.order_id!,{gift_card_code:giftCardCode,order_revision:context.order_revision!},this.auth.checkout(record,key));},undefined,error=>challengeFromError(error,this.config.giftChallengeOrigin)?'challenge':undefined);
      }catch(error){if(!action)throw error;return this.giftOutcome(record,action,error);}
    });
  }
  async retryGift(ref:string,challengeId:string,giftCardCode:string,proof:string):Promise<GiftChallengeView|undefined>{
    const initial=this.record(ref);
    return this.store.locked(`order:${initial.order_id}`,async()=>{
      const record=this.record(ref),row=this.store.get<GiftChallengeRecord>('SELECT * FROM gift_challenges WHERE challenge_id=? AND checkout_ref=?',challengeId,ref);
      if(!row)throw new LocalError('GIFT_CHALLENGE_EXPIRED',409);
      if(record.checkout_session_id!==row.checkout_session_id){this.store.run("UPDATE gift_challenges SET status='closed' WHERE challenge_id=? AND status IN ('open','retrying')",row.challenge_id);throw new LocalError('GIFT_CHALLENGE_SESSION_CHANGED',409);}
      if(row.status!=='open'||row.expires_at<=Date.now())throw new LocalError('GIFT_CHALLENGE_EXPIRED',409);
      const reject=(code:string):never=>{this.store.closeGiftChallenges(ref);this.store.run("UPDATE actions SET status='rejected' WHERE action_id=? AND status='challenge'",row.action_id);throw new LocalError(code,409);};
      if(this.payments.unresolved(record))reject('CHECKOUT_PAYMENT_RESOLVING');
      const action=this.store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',row.action_id);
      const saved=action?.body?JSON.parse(action.body) as {input:{code_hash:string};context:MutationContext}:undefined;
      if(action?.kind!=='gift'||action.status!=='challenge'||saved?.input.code_hash!==createHash('sha256').update(giftCardCode).digest('hex'))reject('GIFT_CHALLENGE_CODE_CHANGED');
      let order:Order;try{order=await this.payments.read(record);}catch(error){this.store.closeGiftChallenges(ref);throw error;}
      if(attemptOpen(order.active_payment_attempt))reject('PAYMENT_ATTEMPT_IN_PROGRESS');
      if(order.order_revision!==saved!.context.order_revision)reject('GIFT_CHALLENGE_ORDER_CHANGED');
      this.store.claimGiftChallenge(row);
      try{
        await applyWithProof(this.client,this.auth,record,giftCardCode,saved!.context.order_revision!,action!.idempotency_key,proof);
        this.store.run("UPDATE actions SET status='succeeded' WHERE action_id=?",action!.action_id);this.store.closeGiftChallenges(ref);
        logGiftChallenge({outcome:'retry_applied',checkout_ref:ref});
      }catch(error){
        this.store.run('UPDATE actions SET status=? WHERE action_id=?',challengeFromError(error,this.config.giftChallengeOrigin)?'challenge':unknownOutcome(error)?'unknown':'rejected',action!.action_id);
        return this.giftOutcome(record,action!,error,true);
      }
    });
  }
  async editCart<T>(cart:Cart,edit:()=>Promise<T>):Promise<T>{
    return this.store.locked(`cart:${cart.cart_id}`,async()=>{
      const records=this.store.all<CheckoutRecord>("SELECT * FROM checkouts WHERE cart_id=? AND status='open' AND order_id IS NOT NULL ORDER BY order_id",cart.cart_id);
      const run=async(index:number):Promise<T>=>{
        if(index<records.length)return this.store.locked(`order:${records[index]!.order_id}`,()=>run(index+1));
        for(const record of records){if(this.payments.unresolved(record))throw new LocalError('CHECKOUT_PAYMENT_RESOLVING',409);const order=await this.client.orders.get(record.order_id!,undefined,this.auth.merchant());if(attemptOpen(order.active_payment_attempt))throw new LocalError('PAYMENT_ATTEMPT_IN_PROGRESS',409);}
        this.dirty(cart);const result=await edit();for(const record of records)await this.syncRecord(this.record(record.checkout_ref));return result;
      };
      return run(0);
    });
  }
  async mergeCart(session:Session,user:User){
    const carts=this.store.all<Cart>("SELECT * FROM carts WHERE status='open' AND (user_id=? OR (session_hash=? AND user_id IS NULL)) ORDER BY cart_id",user.user_id,session.session_hash);
    const run=async(index:number):Promise<void>=>{
      if(index<carts.length)return this.store.locked(`cart:${carts[index]!.cart_id}`,()=>run(index+1));
      this.carts.merge(session,user);
    };
    return this.store.locked(`cart-merge:${user.user_id}`,()=>run(0));
  }
  dirty(cart:Cart){this.store.run("UPDATE checkouts SET cart_dirty=1 WHERE cart_id=? AND status='open'",cart.cart_id);}
  async syncCart(cart:Cart){
    for(const record of this.store.all<CheckoutRecord>("SELECT * FROM checkouts WHERE cart_id=? AND status='open' AND cart_dirty=1",cart.cart_id)){
      await this.store.locked(`order:${record.order_id}`,()=>this.syncRecord(this.record(record.checkout_ref)));
    }
  }
  async syncRecord(record:CheckoutRecord){
    if(!record.cart_id||!record.order_id)return;
    if(this.payments.unresolved(record))return;
    const cart=this.store.get<Cart>('SELECT * FROM carts WHERE cart_id=?',record.cart_id)!;
    for(let count=0;count<64;count++){
      const order=await this.client.orders.get(record.order_id,undefined,this.auth.merchant());
      if(attemptOpen(order.active_payment_attempt)){this.notice(record,'signed_in_mid_checkout');return;}
      if(order.payment_status==='paid'||order.status!=='open'){this.store.run('UPDATE checkouts SET cart_dirty=0 WHERE checkout_ref=?',record.checkout_ref);return;}
      const pending=this.store.get<ActionRecord>("SELECT * FROM actions WHERE resource=? AND status IN ('pending','unknown')",`order:${record.order_id}`);
      if(pending&&pending.kind!=='cart_sync')throw new LocalError('ACTION_RECONCILIATION_REQUIRED',409);
      type Change={type:'add'|'update'|'delete';variant_id:string;line_id?:string;quantity?:number};
      let change=pending?.body?JSON.parse(pending.body) as Change:undefined;
      if(!change){
        const desired=this.carts.lines(cart);
        const extra=order.line_items.find(item=>!desired.some(line=>line.variant_id===item.variant_id));
        const different=desired.find(line=>!order.line_items.some(item=>item.variant_id===line.variant_id&&Number(item.quantity)===line.quantity));
        if(extra)change={type:'delete',variant_id:extra.variant_id!,line_id:extra.order_line_item_id};
        else if(different){const remote=order.line_items.find(item=>item.variant_id===different.variant_id);change={type:remote?'update':'add',variant_id:different.variant_id,line_id:remote?.order_line_item_id,quantity:different.quantity};}
      }
      if(!change){this.store.run('UPDATE checkouts SET cart_dirty=0,needs_replacement=1 WHERE checkout_ref=?',record.checkout_ref);return;}
      const input=change;
      await this.action(record,'cart_sync',input,key=>input.type==='delete'
        ?this.client.orders.deleteLineItem(record.order_id!,input.line_id!,undefined,this.auth.merchant(key))
        :input.type==='update'?this.client.orders.updateLineItem(record.order_id!,input.line_id!,{quantity:String(input.quantity)},this.auth.merchant(key))
        :this.client.orders.addLineItems(record.order_id!,{line_items:[{variant_id:input.variant_id,quantity:String(input.quantity)}]},this.auth.merchant(key)));
    }
    throw new LocalError('CART_RECONCILIATION_REQUIRED',409);
  }
  async cartChange(cart:Cart,line:CartLine|undefined,variantId:string,quantity:number|null){
    const record=this.store.get<CheckoutRecord>("SELECT * FROM checkouts WHERE cart_id=? AND status='open' ORDER BY created_at DESC LIMIT 1",cart.cart_id);
    if(!record?.order_id)return;
    await this.mutate(record.checkout_ref,'cart_change',{variant_id:variantId,quantity},async(record,key)=>{
      const order=await this.client.orders.get(record.order_id!,undefined,this.auth.merchant());
      const remote=order.line_items.find(item=>item.variant_id===variantId);
      if(quantity===null&&remote)await this.client.orders.deleteLineItem(record.order_id!,remote.order_line_item_id,undefined,this.auth.merchant(key));
      else if(remote)await this.client.orders.updateLineItem(record.order_id!,remote.order_line_item_id,{quantity:String(quantity)},this.auth.merchant(key));
      else if(quantity!==null)await this.client.orders.addLineItems(record.order_id!,{line_items:[{variant_id:variantId,quantity:String(quantity)}]},this.auth.merchant(key));
      this.store.run('UPDATE checkouts SET needs_replacement=1 WHERE checkout_ref=?',record.checkout_ref);
    });
  }
  async subscription(read:ReadCheckout):Promise<Subscription|undefined>{
    if(read.record.kind!=='subscription'||!read.order.subscription_id)return undefined;
    if(!read.record.checkout_auth_token)return this.client.subscriptions.get(read.order.subscription_id,undefined,this.auth.merchant());
    try{return await this.client.subscriptions.get(read.order.subscription_id,undefined,this.auth.checkout(read.record));}
    catch(error){
      const code=error&&typeof error==='object'&&'code'in error?String(error.code):'';
      if(read.order.payment_status==='paid'&&['INVALID_CHECKOUT_SESSION','CHECKOUT_SESSION_EXPIRED','CHECKOUT_SESSION_NOT_OPEN'].includes(code))return this.client.subscriptions.get(read.order.subscription_id,undefined,this.auth.merchant());
      throw error;
    }
  }
}
