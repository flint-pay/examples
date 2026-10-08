import type {Client,MoneyValue,Order,OrderPaymentAttempt,PayOrderRequestInput,OrderGiftCardAllocationAcceptanceInput} from '@flintpay/node';
import type {Auth} from '../flint/auth.ts';
import {LocalError,unknownOutcome,appError} from '../flint/errors.ts';
import {Store} from '../store/db.ts';
import type {CheckoutRecord,ActionRecord,GiftChallengeRecord} from '../store/db.ts';
import {createHash} from 'node:crypto';
import {challengeFromError,confirmWithSession,newChallengeId,sessionTag,applyWithProof} from '../flint/gift-challenge.ts';
import type {GiftChallengeView} from '../views/types.ts';
import {logGiftChallenge} from '../security/log.ts';
import {moneyEqual} from '../security/money.ts';
import {nextStep,attemptOpen} from './next-step.ts';
import {safePaymentOrder,safeAttempt,safeMethod,clientAction} from '../flint/projection.ts';
export type Credential={kind:'confirmation_token'|'payment_method_token'|'saved_payment_method';value:string};
export type PayInput={credential?:Credential;approved_outstanding_money:MoneyValue;approved_collection_kind:'processor'|'settlement';approved_order_revision?:string;approved_gift_card_money?:MoneyValue};
export type PaymentResult={order:Order;attempt?:OrderPaymentAttempt;unknown:boolean;totalChanged?:boolean;expired?:boolean;recovery?:boolean};
export const GIFT_SETTLE_MS=600000;
export function collectionKind(order:Order):'processor'|'settlement'|'unavailable'{
  if(order.gift_cards?.length&&order.gift_card_estimate?.can_pay&&BigInt(order.gift_card_estimate.processor_money.amount)===0n)return 'settlement';
  return order.payment_collection?.stripe?'processor':'unavailable';
}
export function approvalMatches(order:Order,input:PayInput):boolean{
  if(!input.approved_outstanding_money||!moneyEqual(order.settlement_amounts.outstanding_money,input.approved_outstanding_money)||collectionKind(order)!==input.approved_collection_kind)return false;
  if(order.gift_cards?.length&&(!order.gift_card_estimate?.can_pay||input.approved_order_revision!==order.order_revision||!input.approved_gift_card_money||!moneyEqual(input.approved_gift_card_money,order.gift_card_estimate.gift_card_money)))return false;
  return true;
}
export function acceptedAllocation(order:Order):OrderGiftCardAllocationAcceptanceInput|undefined{
  const estimate=order.gift_card_estimate;
  if(!order.gift_cards?.length)return undefined;
  if(!estimate?.can_pay||estimate.gift_card_money.currency!=='USD'||estimate.processor_money.currency!=='USD'||estimate.gift_cards.some(card=>card.amount_money.currency!=='USD'))throw new LocalError('GIFT_CARD_ALLOCATION_CHANGED',409);
  return {order_revision:estimate.order_revision,gift_card_money:{amount:estimate.gift_card_money.amount,currency:'USD'},processor_money:{amount:estimate.processor_money.amount,currency:'USD'},gift_cards:estimate.gift_cards.map(card=>({gift_card_id:card.gift_card_id,amount_money:{amount:card.amount_money.amount,currency:'USD'}}))};
}
export class PaymentEngine {
  client:Client;auth:Auth;store:Store;delay:(ms:number)=>Promise<void>;
  constructor(client:Client,auth:Auth,store:Store,delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))){this.client=client;this.auth=auth;this.store=store;this.delay=delay;}
  record(ref:string):CheckoutRecord{const record=this.store.get<CheckoutRecord>('SELECT * FROM payment_checkouts WHERE checkout_ref=?',ref);if(!record)throw new LocalError('NOT_FOUND',404);return record;}
  resource(record:CheckoutRecord){return `payment:${record.sandbox_id}:${record.user_id}:${record.order_id}`;}
  async read(record:CheckoutRecord){return this.client.orders.get(record.order_id,undefined,this.auth.checkout(record));}
  unresolved(record:CheckoutRecord){return this.store.get<ActionRecord>("SELECT * FROM actions WHERE resource=? AND kind IN ('pay','resume','cancel') AND status IN ('pending','unknown')",this.resource(record));}
  giftResource(record:CheckoutRecord){return `gift:${record.sandbox_id}:${record.user_id}:${record.order_id}`;}
  unresolvedGift(record:CheckoutRecord){return this.store.get<ActionRecord>("SELECT * FROM actions WHERE resource=? AND status IN ('pending','unknown')",this.giftResource(record));}
  reconcileGift(record:CheckoutRecord,order:Order):void{
    const pending=this.unresolvedGift(record);if(!pending)return;
    const revision=pending.body?(JSON.parse(pending.body) as {order_revision?:string}).order_revision:undefined,deadline=pending.retry_after||pending.created_at+GIFT_SETTLE_MS;
    if(!revision||order.order_revision!==revision||Date.now()>=deadline){
      this.store.run("UPDATE actions SET status='rejected',body=NULL WHERE action_id=? AND status IN ('pending','unknown')",pending.action_id);this.store.closeGiftChallenges(record.checkout_ref);
    }
  }
  async giftReady(record:CheckoutRecord):Promise<Order>{
    if(this.unresolved(record))throw new LocalError('PAYMENT_ATTEMPT_IN_PROGRESS',409);
    const order=await this.read(record);this.reconcileGift(record,order);if(attemptOpen(await this.attempt(record,order)))throw new LocalError('PAYMENT_ATTEMPT_IN_PROGRESS',409);
    const session=await this.client.checkoutSessions.get(record.checkout_session_id,undefined,this.auth.checkout(record));
    if(session.status!=='open'||session.recovery_mode)throw new LocalError('CHECKOUT_SESSION_NOT_OPEN',409);
    if(order.gift_card_tender_enabled!==true||order.settlement_amounts.paid_money&&BigInt(order.settlement_amounts.paid_money.amount)!==0n)throw new LocalError('GIFT_CARDS_NOT_EDITABLE',409);
    return order;
  }
  async giftOutcome(record:CheckoutRecord,action:ActionRecord,error:unknown,expectedOrigin:string,retry=false):Promise<GiftChallengeView>{
    this.store.closeGiftChallenges(record.checkout_ref);
    const parsed=challengeFromError(error,expectedOrigin);
    if(!parsed){if(retry)logGiftChallenge({outcome:unknownOutcome(error)?'retry_unknown':'retry_rejected',cause:appError(error).code,checkout_ref:record.checkout_ref,flint_request_id:appError(error).request_id});throw error;}
    let outcome;
    try{outcome=await confirmWithSession(parsed,()=>this.client.checkoutSessions.get(record.checkout_session_id,undefined,this.auth.checkout(record)),record.checkout_session_id);}
    catch(readError){this.store.run("UPDATE actions SET status='unknown' WHERE action_id=?",action.action_id);throw readError;}
    if(outcome.kind==='challenge'){
      const challengeId=newChallengeId();this.store.issueGiftChallenge(record.checkout_ref,action.action_id,record.checkout_session_id,challengeId);
      logGiftChallenge({outcome:'issued',checkout_ref:record.checkout_ref,flint_request_id:appError(error).request_id});
      return {challenge_id:challengeId,url:outcome.url,session_tag:sessionTag(challengeId,record.checkout_session_id),reason:outcome.reason,expires_in_seconds:900};
    }
    this.store.run("UPDATE actions SET status='rejected',body=NULL WHERE action_id=?",action.action_id);
    if(outcome.kind==='origin_required'){
      const prior=this.store.get<GiftChallengeRecord>('SELECT * FROM gift_challenges WHERE checkout_ref=? AND origin_replacements>0 AND created_at>?',record.checkout_ref,Date.now()-600000);
      if(!prior){
        const now=Date.now();this.store.run("INSERT INTO gift_challenges(challenge_id,checkout_ref,action_id,checkout_session_id,status,origin_replacements,created_at,expires_at) VALUES(?,?,?,?,'closed',1,?,?)",newChallengeId(),record.checkout_ref,action.action_id,record.checkout_session_id,now,now+900000);
        logGiftChallenge({outcome:'origin_required',checkout_ref:record.checkout_ref,flint_request_id:appError(error).request_id});throw new LocalError('GIFT_CARD_CHALLENGE_ORIGIN_REQUIRED',409);
      }
    }
    logGiftChallenge({outcome:'unavailable',cause:outcome.kind==='unavailable'?outcome.cause:'origin_replacement_limit',checkout_ref:record.checkout_ref,flint_request_id:appError(error).request_id});throw new LocalError('GIFT_CARD_CHALLENGE_UNAVAILABLE',503);
  }
  async applyGift(ref:string,giftCardCode:string,expectedOrigin:string,nonce:string):Promise<GiftChallengeView|undefined>{
    const initial=this.record(ref),observedPending=this.unresolvedGift(initial);
    return this.store.locked(this.resource(initial),async()=>{
      const record=this.record(ref),resource=this.giftResource(record),order=await this.giftReady(record),pending=this.unresolvedGift(record);
      const hash=createHash('sha256').update(giftCardCode).digest('hex');
      if(pending){
        const saved=pending.body?JSON.parse(pending.body) as {code_hash:string;order_revision:string}:undefined;
        if(pending.kind!=='gift_apply'||saved?.code_hash!==hash)throw new LocalError('GIFT_CARD_CHANGE_UNCONFIRMED',409);
        this.store.abandonGiftChallenges(ref,resource);
        try{await this.store.replayAction(pending,async key=>{const result=await this.client.orders.applyGiftCard(record.order_id,{gift_card_code:giftCardCode,order_revision:saved!.order_revision},this.auth.checkout(record,key));return {order_id:result.order_id,order_revision:result.order_revision};},error=>challengeFromError(error,expectedOrigin)?'challenge':undefined,true);}
        catch(error){return this.giftOutcome(record,pending,error,expectedOrigin);}
        return;
      }
      // A request waiting behind a completed replay must not become a new gift mutation.
      if(observedPending&&this.store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',observedPending.action_id)?.status==='succeeded')throw new LocalError('ACTION_IN_PROGRESS',409);
      const actionId=createHash('sha256').update(`${resource}:gift_apply:${nonce}`).digest('hex');
      const previous=this.store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',actionId);
      const saved=previous?.body?JSON.parse(previous.body) as {code_hash:string;order_revision:string}:undefined;
      if(saved&&saved.code_hash!==hash)throw new LocalError('ACTION_BODY_MISMATCH',409);
      const revision=saved?.order_revision??order.order_revision;if(!revision)throw new LocalError('ORDER_CHANGED_REFRESH_REQUIRED',409);
      const body={code_hash:hash,order_revision:revision};
      this.store.abandonGiftChallenges(ref,resource);
      try{
        await this.store.mutate(resource,'gift_apply',body,async key=>{const result=await this.client.orders.applyGiftCard(record.order_id,{gift_card_code:giftCardCode,order_revision:body.order_revision},this.auth.checkout(record,key));return {order_id:result.order_id,order_revision:result.order_revision};},nonce,error=>challengeFromError(error,expectedOrigin)?'challenge':undefined,true);
      }catch(error){const action=this.store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',actionId);if(!action)throw error;return this.giftOutcome(record,action,error,expectedOrigin);}
    });
  }
  async retryGift(ref:string,challengeId:string,giftCardCode:string,proof:string,expectedOrigin:string):Promise<GiftChallengeView|undefined>{
    const initial=this.record(ref);
    return this.store.locked(this.resource(initial),async()=>{
      const record=this.record(ref),row=this.store.get<GiftChallengeRecord>('SELECT * FROM gift_challenges WHERE challenge_id=? AND checkout_ref=?',challengeId,ref);
      if(!row)throw new LocalError('GIFT_CHALLENGE_EXPIRED',409);
      if(record.checkout_session_id!==row.checkout_session_id){this.store.run("UPDATE gift_challenges SET status='closed' WHERE challenge_id=? AND status IN ('open','retrying')",row.challenge_id);throw new LocalError('GIFT_CHALLENGE_SESSION_CHANGED',409);}
      if(row.status!=='open'||row.expires_at<=Date.now())throw new LocalError('GIFT_CHALLENGE_EXPIRED',409);
      const reject=(code:string):never=>{this.store.closeGiftChallenges(ref);this.store.run("UPDATE actions SET status='rejected',body=NULL WHERE action_id=? AND status='challenge'",row.action_id);throw new LocalError(code,409);};
      if(this.unresolved(record))reject('PAYMENT_ATTEMPT_IN_PROGRESS');
      const action=this.store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',row.action_id),saved=action?.body?JSON.parse(action.body) as {code_hash:string;order_revision:string}:undefined;
      if(action?.kind!=='gift_apply'||action.status!=='challenge'||saved?.code_hash!==createHash('sha256').update(giftCardCode).digest('hex'))reject('GIFT_CHALLENGE_CODE_CHANGED');
      let order:Order;try{order=await this.giftReady(record);}catch(error){this.store.closeGiftChallenges(ref);throw error;}
      if(order.order_revision!==saved!.order_revision)reject('GIFT_CHALLENGE_ORDER_CHANGED');
      this.store.claimGiftChallenge(row);
      try{
        const result=await applyWithProof(this.client,this.auth,record,giftCardCode,saved!.order_revision,action!.idempotency_key,proof);
        this.store.run("UPDATE actions SET status='succeeded',result=? WHERE action_id=?",JSON.stringify({order_id:result.order_id,order_revision:result.order_revision}),action!.action_id);this.store.closeGiftChallenges(ref);logGiftChallenge({outcome:'retry_applied',checkout_ref:ref});
      }catch(error){
        const status=challengeFromError(error,expectedOrigin)?'challenge':unknownOutcome(error)?'unknown':'rejected';this.store.run('UPDATE actions SET status=?,body=CASE WHEN ? THEN body ELSE NULL END WHERE action_id=?',status,status==='unknown'||status==='challenge'?1:0,action!.action_id);
        return this.giftOutcome(record,action!,error,expectedOrigin,true);
      }
    });
  }
  async removeGift(ref:string,giftCardId:string,nonce:string){
    const initial=this.record(ref),observedPending=this.unresolvedGift(initial);
    return this.store.locked(this.resource(initial),async()=>{
      const record=this.record(ref),order=await this.giftReady(record),resource=this.giftResource(record),pending=this.unresolvedGift(record);
      if(pending){
        const saved=pending.body?JSON.parse(pending.body) as {gift_card_id:string;order_revision:string}:undefined;
        if(pending.kind!=='gift_remove'||saved?.gift_card_id!==giftCardId)throw new LocalError('GIFT_CARD_CHANGE_UNCONFIRMED',409);
        this.store.abandonGiftChallenges(ref,resource);
        await this.store.replayAction(pending,async key=>{const result=await this.client.orders.removeGiftCard(record.order_id,giftCardId,{order_revision:saved!.order_revision},this.auth.checkout(record,key));return {order_id:result.order_id,order_revision:result.order_revision};},undefined,true);return;
      }
      // Keep concurrent checks bound to the change they started while it was unresolved.
      if(observedPending&&this.store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',observedPending.action_id)?.status==='succeeded')throw new LocalError('ACTION_IN_PROGRESS',409);
      const actionId=createHash('sha256').update(`${resource}:gift_remove:${nonce}`).digest('hex');
      const prior=this.store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',actionId),saved=prior?.body?JSON.parse(prior.body) as {gift_card_id:string;order_revision:string}:undefined;
      if(saved&&saved.gift_card_id!==giftCardId)throw new LocalError('ACTION_BODY_MISMATCH',409);
      if(!saved&&!order.gift_cards?.some(card=>card.gift_card_id===giftCardId))throw new LocalError('NOT_FOUND',404);
      const revision=saved?.order_revision??order.order_revision;if(!revision)throw new LocalError('ORDER_CHANGED_REFRESH_REQUIRED',409);
      const body={gift_card_id:giftCardId,order_revision:revision};
      this.store.abandonGiftChallenges(ref,resource);
      await this.store.mutate(resource,'gift_remove',body,async key=>{const result=await this.client.orders.removeGiftCard(record.order_id,giftCardId,{order_revision:body.order_revision},this.auth.checkout(record,key));return {order_id:result.order_id,order_revision:result.order_revision};},nonce,undefined,true);
    });
  }
  async attempt(record:CheckoutRecord,order:Order):Promise<OrderPaymentAttempt|undefined>{
    if(order.active_payment_attempt)return order.active_payment_attempt;
    if(record.last_attempt_id)return this.client.orders.getPaymentAttempt(record.order_id,record.last_attempt_id,undefined,this.auth.checkout(record));
    return undefined;
  }
  remember(record:CheckoutRecord,attempt:OrderPaymentAttempt|undefined){if(attempt)this.store.run('UPDATE payment_checkouts SET last_attempt_id=?,updated_at=? WHERE checkout_ref=?',attempt.order_payment_attempt_id,Date.now(),record.checkout_ref);}
  complete(job:ActionRecord,attempt:OrderPaymentAttempt|undefined){this.store.run("UPDATE actions SET status='succeeded',attempt_id=?,body=NULL WHERE action_id=?",attempt?.order_payment_attempt_id??null,job.action_id);}
  async reconcile(record:CheckoutRecord):Promise<PaymentResult>{
    const order=await this.read(record);this.reconcileGift(record,order);const attempt=await this.attempt(record,order),pending=this.unresolved(record);
    if(pending&&(order.payment_status==='paid'||pending.kind==='pay'&&order.active_payment_attempt&&pending.attempt_id!==attempt?.order_payment_attempt_id))this.complete(pending,attempt);
    this.remember(record,attempt);
    return {order,attempt,unknown:!!this.unresolved(record)};
  }
  job(record:CheckoutRecord,kind:'pay'|'resume'|'cancel',body:unknown,nonce?:string){
    const pending=this.unresolved(record);if(pending)return pending;
    const job=this.store.action(this.resource(record),kind,body,nonce);
    if(job.status==='pending'){this.store.run('UPDATE actions SET attempt_id=? WHERE action_id=?',record.last_attempt_id,job.action_id);job.attempt_id=record.last_attempt_id;}
    return job;
  }
  async execute(record:CheckoutRecord,job:ActionRecord,assertOwnership:()=>void):Promise<PaymentResult>{
    if(['succeeded','rejected'].includes(job.status))return this.reconcile(record);
    if(!job.body)throw new LocalError('UNKNOWN_PAYMENT_OUTCOME',409);
    for(let retry=0;retry<4;retry++){
      assertOwnership();
      try{
        const response=job.kind==='cancel'
          ?await this.client.orders.cancelPaymentAttempt(record.order_id,job.attempt_id??record.last_attempt_id!,{cancellation_reason:'abandoned'},this.auth.checkout(record,job.idempotency_key))
          :await this.client.orders.pay({order_id:record.order_id,body:JSON.parse(job.body) as PayOrderRequestInput},this.auth.checkout(record,job.idempotency_key));
        assertOwnership();this.complete(job,response.payment_attempt);this.remember(record,response.payment_attempt);
        try{return await this.reconcile(this.record(record.checkout_ref));}catch{return {order:response.order,attempt:response.payment_attempt,unknown:false};}
      }catch(error){
        if(!unknownOutcome(error)){
          this.store.run("UPDATE actions SET status='rejected',body=NULL WHERE action_id=?",job.action_id);
          const code=error&&typeof error==='object'&&'code'in error?String(error.code):'';
          if(['ORDER_PAYMENT_ATTEMPT_ACTIVE','PAYMENT_ATTEMPT_STILL_PROCESSING','PAYMENT_ATTEMPT_NOT_RESUMABLE','CHECKOUT_RECOVERY_RESTRICTED'].includes(code))return this.reconcile(record);
          if(['ORDER_CHANGED_REFRESH_REQUIRED','GIFT_CARD_ALLOCATION_CHANGED','GIFT_CARD_INSUFFICIENT_VALUE'].includes(code))return {...await this.reconcile(record),totalChanged:true};
          throw error;
        }
        this.store.run("UPDATE actions SET status='unknown',retry_after=? WHERE action_id=?",Date.now()+5000,job.action_id);
        if(retry<3)await this.delay([500,1000,2000][retry]!);
      }
    }
    return this.reconcile(record);
  }
  async start(ref:string,input:PayInput,nonce?:string):Promise<PaymentResult>{
    const initial=this.record(ref);
    return this.store.locked(this.resource(initial),async assertOwnership=>{
      const record=this.record(ref),pending=this.unresolved(record);
      if(pending)return this.execute(record,pending,assertOwnership);
      const order=await this.read(record),attempt=await this.attempt(record,order);
      this.reconcileGift(record,order);
      if(order.payment_status==='paid'||attemptOpen(attempt))return {order,attempt,unknown:false};
      if(this.unresolvedGift(record))throw new LocalError('GIFT_CARD_CHANGE_UNCONFIRMED',409);
      if(!input.approved_outstanding_money||!/^\d+$/.test(input.approved_outstanding_money.amount)||!approvalMatches(order,input))return {order,attempt,unknown:false,totalChanged:true};
      if(collectionKind(order)==='unavailable')throw new LocalError('PAYMENTS_UNAVAILABLE',503);
      const session=await this.client.checkoutSessions.get(record.checkout_session_id,undefined,this.auth.checkout(record));
      if(session.status!=='open')return {order,attempt,unknown:false,expired:true};
      if(session.recovery_mode)return {order,attempt,unknown:false,recovery:true};
      const allocation=acceptedAllocation(order),processorAmount=allocation?.processor_money.amount??order.settlement_amounts.outstanding_money.amount;
      let source:{confirmation_token:string}|{token:string}|{payment_method_id:string}|undefined;
      if(BigInt(processorAmount)>0n){
        const credential=input.credential;if(!credential)throw new LocalError('PAYMENT_SOURCE_REQUIRED');
        if(credential.kind==='saved_payment_method'){
          const methods=await this.client.paymentMethods.list(undefined,this.auth.checkout(record));
          if(!methods.data.some(method=>method.payment_method_id===credential.value&&method.status==='active'))throw new LocalError('PAYMENT_SOURCE_UNAVAILABLE');
          source={payment_method_id:credential.value};
        }else if(credential.kind==='confirmation_token'&&/^ctoken_[A-Za-z0-9_]+$/.test(credential.value))source={confirmation_token:credential.value};
        else if(credential.kind==='payment_method_token'&&/^pm_[A-Za-z0-9_]+$/.test(credential.value))source={token:credential.value};
        else throw new LocalError('PAYMENT_SOURCE_REQUIRED');
      }
      const body:PayOrderRequestInput={action:'pay',...(source?{payment_source:source}:{}),expected_outstanding_money:input.approved_outstanding_money,...(allocation?{accepted_gift_card_allocation:allocation}:{})};
      try{return await this.execute(record,this.job(record,'pay',body,nonce),assertOwnership);}
      catch(error){
        if(!(error&&typeof error==='object'&&'code'in error&&error.code==='PAYMENT_LEG_SELECTION_REQUIRED')||!source)throw error;
        const fresh=await this.read(record);
        if(!approvalMatches(fresh,input))return {order:fresh,unknown:false,totalChanged:true};
        const legs=fresh.payment_collection?.stripe?.elements?.selectable_payment_intents;
        if(legs?.length!==1)throw new LocalError('PAYMENT_LEG_SELECTION_REQUIRED',409);
        const retry:PayOrderRequestInput={action:'confirm_payment_intents',payment_intents:[{payment_intent_id:legs[0]!.payment_intent_id,...source}],expected_outstanding_money:input.approved_outstanding_money,...(allocation?{accepted_gift_card_allocation:acceptedAllocation(fresh)}:{})};
        return this.execute(record,this.job(record,'pay',retry,nonce?`${nonce}:selected`:undefined),assertOwnership);
      }
    });
  }
  async resume(ref:string,nonce?:string):Promise<PaymentResult>{
    const initial=this.record(ref);
    return this.store.locked(this.resource(initial),async assertOwnership=>{
      const record=this.record(ref),pending=this.unresolved(record);
      if(pending)return this.execute(record,pending,assertOwnership);
      const current=await this.reconcile(record);
      if(!current.attempt?.is_resumable)return current;
      if(!nonce){this.store.run('UPDATE payment_checkouts SET resume_seq=resume_seq+1 WHERE checkout_ref=?',record.checkout_ref);nonce=`resume:${current.attempt.order_payment_attempt_id}:${this.record(ref).resume_seq}`;}
      return this.execute(record,this.job(record,'resume',{action:'resume',order_payment_attempt_id:current.attempt.order_payment_attempt_id},nonce),assertOwnership);
    });
  }
  async cancel(ref:string):Promise<PaymentResult>{
    const initial=this.record(ref);
    return this.store.locked(this.resource(initial),async assertOwnership=>{
      const record=this.record(ref),pending=this.unresolved(record);
      if(pending)return this.execute(record,pending,assertOwnership);
      const current=await this.reconcile(record);
      if(!current.attempt||!attemptOpen(current.attempt)||current.attempt.status==='processing'&&!current.attempt.is_resumable)return current;
      const session=await this.client.checkoutSessions.get(record.checkout_session_id,undefined,this.auth.checkout(record));
      if(session.recovery_mode||session.status!=='open')return {...current,recovery:session.recovery_mode,expired:!session.recovery_mode};
      record.last_attempt_id=current.attempt.order_payment_attempt_id;
      return this.execute(record,this.job(record,'cancel',{cancellation_reason:'abandoned'},`cancel:${record.last_attempt_id}`),assertOwnership);
    });
  }
  async status(ref:string):Promise<PaymentResult>{const record=this.record(ref);return this.store.locked(this.resource(record),()=>this.reconcile(this.record(ref)));}
  async view(record:CheckoutRecord,result:PaymentResult,returned=false){
    const options=new Map<string,string>();
    for(const intent of result.order.payment_intents??[])if(intent.payment_source?.type)options.set(intent.payment_intent_id,intent.payment_source.type);
    for(const leg of result.attempt?.payment_intents??[]){
      if(!options.has(leg.payment_intent_id)){const intent=await this.client.paymentIntents.get(leg.payment_intent_id,undefined,this.auth.checkout(record));if(intent.selected_payment_option)options.set(leg.payment_intent_id,intent.selected_payment_option);}
    }
    let sessionOpen=false;
    try{const session=await this.client.checkoutSessions.get(record.checkout_session_id,undefined,this.auth.checkout(record));sessionOpen=session.status==='open';result.recovery=session.recovery_mode;result.expired=session.status!=='open'&&!session.recovery_mode&&result.order.payment_status!=='paid';}
    catch(error){if(!['INVALID_CHECKOUT_SESSION','CHECKOUT_SESSION_NOT_OPEN','CHECKOUT_SESSION_EXPIRED','CHECKOUT_RECOVERY_RESTRICTED'].includes(appError(error).code))throw error;result.recovery=attemptOpen(result.attempt);result.expired=!result.recovery;}
    const failedLeg=result.attempt?.payment_intents?.find(leg=>leg.last_payment_error);
    const declineCode=failedLeg?.last_payment_error?.code??result.attempt?.failure_code;
    const unresolved=this.unresolved(record);
    const next=result.unknown?(unresolved&&unresolved.retry_after<=Date.now()?'resume':'wait'):result.order.payment_status==='paid'?'done':nextStep(result.attempt,options);
    const collection=collectionKind(result.order),paid=result.order.settlement_amounts.paid_money;
    const canCheck=sessionOpen&&!result.expired&&!result.recovery&&!result.unknown&&!unresolved&&!attemptOpen(result.attempt)&&result.order.gift_card_tender_enabled===true&&(!paid||BigInt(paid.amount)===0n),pendingGift=this.unresolvedGift(record);
    const savedGift=pendingGift?.body?JSON.parse(pendingGift.body) as {gift_card_id?:string}:undefined;
    const giftUnconfirmed=pendingGift?(pendingGift.kind==='gift_remove'?{kind:'remove' as const,gift_card_id:savedGift!.gift_card_id!,last_characters:result.order.gift_cards?.find(card=>card.gift_card_id===savedGift?.gift_card_id)?.last_characters??null,can_check:canCheck}:{kind:'apply' as const,can_check:canCheck}):null;
    const giftEditable=canCheck&&!pendingGift;
    const methods=collection==='processor'&&['new_payment','pay_remaining'].includes(next)&&!result.expired?(await this.client.paymentMethods.list(undefined,this.auth.checkout(record))).data.map(safeMethod):[];
    const pending=result.attempt?.status==='requires_action'?result.attempt.pending_actions?.[0]:undefined;
    const state={collection_kind:collection,gift_editable:giftEditable,gift_unconfirmed:giftUnconfirmed,order:safePaymentOrder(result.order),payment_collection:result.order.payment_collection??null,attempt:safeAttempt(result.attempt,options),next,approved_outstanding_money:result.order.settlement_amounts.outstanding_money,pending_action_id:pending?.pending_action_id,saved_methods:methods,decline:declineCode?{code:declineCode,payment_option:failedLeg?options.get(failedLeg.payment_intent_id):undefined}:null,shipping:result.order.delivery_destination?{name:result.order.delivery_destination.recipient?.name,address:result.order.delivery_destination.address}:null,recovery_mode:result.recovery,expired:result.expired,total_changed:result.totalChanged,returned,notices:[...(result.unknown?['still_confirming']:[]),...(result.totalChanged?[result.order.gift_cards?.length?'gift_card_changed':'total_changed']:[])]};
    return {state,next,client_action:clientAction(result.attempt)};
  }
}
