import type {Client,MoneyValue,Order,OrderPaymentAttempt,PayOrderRequestInput,OrderGiftCardAllocationAcceptanceInput} from '@flintpay/node';
import {SdkError} from '@flintpay/node';
import {createHash} from 'node:crypto';
import type {Auth} from '../flint/auth.ts';
import {LocalError,unknownOutcome} from '../flint/errors.ts';
import {Store} from '../store/db.ts';
import type {CheckoutRecord,ActionRecord} from '../store/db.ts';
import {moneyEqual} from '../security/money.ts';
import {nextStep,attemptOpen} from './next-step.ts';

export type Credential={kind:'confirmation_token'|'payment_method_token'|'saved_payment_method';value:string};
export type CollectionKind='processor'|'settlement'|'setup'|'unavailable';
export type PayInput={credential?:Credential;approved_outstanding_money:MoneyValue;approved_order_revision?:string;approved_gift_card_money?:MoneyValue;approved_collection_kind:CollectionKind;buyer_contact?:{email:string;phone?:string};save_payment_method?:boolean;save_payment_method_phone?:string};
export type PaymentResult={order:Order;attempt?:OrderPaymentAttempt;unknown:boolean;totalChanged?:boolean};

export function collectionKind(order:Order,kind:CheckoutRecord['kind']):CollectionKind{
  if(kind==='subscription'&&BigInt(order.settlement_amounts.outstanding_money.amount)===0n)return order.setup_collection?.stripe?'setup':'unavailable';
  if(kind==='order'&&(BigInt(order.settlement_amounts.outstanding_money.amount)===0n||order.gift_cards?.length&&order.gift_card_estimate?.can_pay&&BigInt(order.gift_card_estimate.processor_money.amount)===0n))return 'settlement';
  return order.payment_collection?.stripe?'processor':'unavailable';
}
export function approvalMatches(order:Order,kind:CheckoutRecord['kind'],input:PayInput):boolean{
  if(!input.approved_outstanding_money||!moneyEqual(order.settlement_amounts.outstanding_money,input.approved_outstanding_money)||collectionKind(order,kind)!==input.approved_collection_kind)return false;
  if(order.gift_cards?.length&&(!order.gift_card_estimate?.can_pay||input.approved_order_revision!==order.order_revision||!input.approved_gift_card_money||!moneyEqual(input.approved_gift_card_money,order.gift_card_estimate.gift_card_money)))return false;
  return true;
}

export function acceptedAllocation(order:Order):OrderGiftCardAllocationAcceptanceInput|undefined {
  const estimate=order.gift_card_estimate;
  if(!order.gift_cards?.length)return undefined;
  if(!estimate?.can_pay||estimate.gift_card_money.currency!=='USD'||estimate.processor_money.currency!=='USD'||estimate.gift_cards.some(card=>card.amount_money.currency!=='USD'))throw new LocalError('GIFT_CARD_ALLOCATION_CHANGED',409);
  return {order_revision:estimate.order_revision,gift_card_money:{amount:estimate.gift_card_money.amount,currency:'USD'},processor_money:{amount:estimate.processor_money.amount,currency:'USD'},gift_cards:estimate.gift_cards.map(card=>({gift_card_id:card.gift_card_id,amount_money:{amount:card.amount_money.amount,currency:'USD'}}))};
}
export function resolvesJob(job:ActionRecord,order:Order,attempt:OrderPaymentAttempt|undefined):boolean{
  return order.payment_status==='paid'||job.kind==='pay'&&!!order.active_payment_attempt||job.kind!=='pay'&&attempt?.order_payment_attempt_id===job.attempt_id&&!attemptOpen(attempt);
}

export class PaymentEngine {
  client:Client;auth:Auth;store:Store;
  constructor(client:Client,auth:Auth,store:Store){this.client=client;this.auth=auth;this.store=store;}
  record(ref:string):CheckoutRecord{const record=this.store.get<CheckoutRecord>('SELECT * FROM checkouts WHERE checkout_ref=?',ref);if(!record?.order_id)throw new LocalError('NOT_FOUND',404);return record;}
  resource(record:CheckoutRecord):string{return `order:${record.order_id}`;}
  async read(record:CheckoutRecord):Promise<Order>{
    if(!record.checkout_auth_token)return this.client.orders.get(record.order_id!,undefined,this.auth.merchant());
    try{return await this.client.orders.get(record.order_id!,undefined,this.auth.checkout(record));}
    catch(error){const code=error&&typeof error==='object'&&'code'in error?String(error.code):'';if(!['INVALID_CHECKOUT_SESSION','CHECKOUT_SESSION_EXPIRED','CHECKOUT_SESSION_NOT_OPEN'].includes(code))throw error;return this.client.orders.get(record.order_id!,undefined,this.auth.merchant());}
  }
  unresolved(record:CheckoutRecord):ActionRecord|undefined{return this.store.get<ActionRecord>("SELECT * FROM actions WHERE resource=? AND kind IN ('pay','resume','cancel') AND status IN ('pending','unknown')",this.resource(record));}
  job(record:CheckoutRecord,kind:'pay'|'resume'|'cancel',body:PayOrderRequestInput|{cancellation_reason:'abandoned'},fixedKey?:string):ActionRecord {
    return this.store.transaction(()=>{
      const pending=this.unresolved(record);if(pending)return pending;
      const json=JSON.stringify(body);const hash=createHash('sha256').update(json).digest('hex');
      if(fixedKey){const existing=this.store.get<ActionRecord>('SELECT * FROM actions WHERE idempotency_key=?',fixedKey);if(existing){if(existing.body_hash!==hash)throw new LocalError('ACTION_BODY_MISMATCH',409);return existing;}}
      const field=kind==='resume'?'resume_seq':'pay_seq';
      this.store.run(`UPDATE checkouts SET ${field}=${field}+1 WHERE checkout_ref=?`,record.checkout_ref);
      const fresh=this.record(record.checkout_ref);const seq=kind==='resume'?fresh.resume_seq:fresh.pay_seq;
      const key=fixedKey??`${kind}-${record.checkout_ref}-${seq}`;
      const existing=this.store.get<ActionRecord>('SELECT * FROM actions WHERE idempotency_key=?',key);
      if(existing){if(existing.body_hash!==hash)throw new LocalError('ACTION_BODY_MISMATCH',409);return existing;}
      this.store.run('INSERT INTO actions(action_id,resource,kind,idempotency_key,body,body_hash,attempt_id,created_at) VALUES(?,?,?,?,?,?,?,?)',key,this.resource(record),kind,key,json,hash,kind==='pay'?null:record.last_attempt_id,Date.now());
      if(kind==='pay'){this.store.run('UPDATE checkouts SET last_attempt_id=NULL WHERE checkout_ref=?',record.checkout_ref);record.last_attempt_id=null;}
      return this.store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',key)!;
    });
  }
  complete(job:ActionRecord,attempt:OrderPaymentAttempt|undefined){
    this.store.run("UPDATE actions SET status='succeeded',attempt_id=?,body=NULL WHERE action_id=?",attempt?.order_payment_attempt_id??null,job.action_id);
  }
  async attempt(record:CheckoutRecord,order:Order,managedRead=false):Promise<OrderPaymentAttempt|undefined>{
    if(order.active_payment_attempt)return order.active_payment_attempt;
    if(!record.last_attempt_id)return undefined;
    if(!record.checkout_auth_token||managedRead)return this.client.orders.getPaymentAttempt(record.order_id!,record.last_attempt_id,undefined,this.auth.merchant());
    try{return await this.client.orders.getPaymentAttempt(record.order_id!,record.last_attempt_id,undefined,this.auth.checkout(record));}
    catch(error){const code=error&&typeof error==='object'&&'code'in error?String(error.code):'';if(!['INVALID_CHECKOUT_SESSION','CHECKOUT_SESSION_EXPIRED','CHECKOUT_SESSION_NOT_OPEN'].includes(code))throw error;return this.client.orders.getPaymentAttempt(record.order_id!,record.last_attempt_id,undefined,this.auth.merchant());}
  }
  remember(record:CheckoutRecord,attempt:OrderPaymentAttempt|undefined){
    if(attempt)this.store.run('UPDATE checkouts SET last_attempt_id=?,updated_at=? WHERE checkout_ref=?',attempt.order_payment_attempt_id,Date.now(),record.checkout_ref);
  }
  async execute(record:CheckoutRecord,job:ActionRecord,assertOwnership:()=>void):Promise<PaymentResult>{
    if(job.status==='succeeded'||job.status==='rejected')return this.reconcile(record);
    if(!job.body)throw new LocalError('UNKNOWN_PAYMENT_OUTCOME',409);
    for(let retry=0;retry<4;retry++){
      assertOwnership();
      try{
        const response=job.kind==='cancel'
          ? await this.client.orders.cancelPaymentAttempt(record.order_id!,job.attempt_id!,JSON.parse(job.body) as {cancellation_reason:'abandoned'},this.auth.checkout(record,job.idempotency_key))
          : await this.client.orders.pay({order_id:record.order_id!,body:JSON.parse(job.body) as PayOrderRequestInput},this.auth.checkout(record,job.idempotency_key));
        this.complete(job,response.payment_attempt);this.remember(record,response.payment_attempt);
        return {order:response.order,attempt:response.payment_attempt,unknown:false};
      }catch(error){
        if(!unknownOutcome(error)){
          if(error instanceof SdkError&&(error.outcome!=='response'||[401,403].includes(error.status??0))){this.store.run("UPDATE actions SET status='unknown' WHERE action_id=?",job.action_id);return this.reconcile(record);}
          this.store.run("UPDATE actions SET status='rejected',body=NULL WHERE action_id=?",job.action_id);
          const code=error&&typeof error==='object'&&'code'in error?error.code:undefined;
          if(['ORDER_PAYMENT_ATTEMPT_ACTIVE','PAYMENT_ATTEMPT_STILL_PROCESSING','PAYMENT_ATTEMPT_NOT_RESUMABLE'].includes(String(code)))return this.reconcile(record);
          throw error;
        }
        this.store.run("UPDATE actions SET status='unknown' WHERE action_id=?",job.action_id);
        if(retry<3)await new Promise(resolve=>setTimeout(resolve,[500,1000,2000][retry]));
      }
    }
    return this.reconcile(record);
  }
  async reconcile(record:CheckoutRecord):Promise<PaymentResult>{
    const order=await this.read(record);const attempt=await this.attempt(record,order);
    return this.observe(record,order,attempt);
  }
  observe(record:CheckoutRecord,order:Order,attempt:OrderPaymentAttempt|undefined):PaymentResult{
    this.remember(record,attempt);
    const pending=this.unresolved(record);
    if(pending&&resolvesJob(pending,order,attempt))this.complete(pending,attempt);
    return {order,attempt,unknown:!!this.unresolved(record)};
  }
  async start(ref:string,input:PayInput):Promise<PaymentResult>{
    const initial=this.record(ref);
    return this.store.locked(this.resource(initial),async assertOwnership=>{
      const record=this.record(ref);const pending=this.unresolved(record);
      if(pending)return this.execute(record,pending,assertOwnership);
      if(this.store.get("SELECT action_id FROM actions WHERE resource=? AND kind NOT IN ('pay','resume','cancel') AND status IN ('pending','unknown')",this.resource(record)))throw new LocalError('ACTION_RECONCILIATION_REQUIRED',409);
      if(record.cart_dirty)throw new LocalError('CART_RECONCILIATION_REQUIRED',409);
      const order=await this.read(record);
      if(order.payment_status==='paid')return {order,attempt:await this.attempt(record,order),unknown:false};
      if(attemptOpen(order.active_payment_attempt)){this.remember(record,order.active_payment_attempt);return {order,attempt:order.active_payment_attempt,unknown:false};}
      if(!approvalMatches(order,record.kind,input))return {order,unknown:false,totalChanged:true};
      if(collectionKind(order,record.kind)==='unavailable')throw new LocalError('PAYMENTS_UNAVAILABLE',503);
      const allocation=acceptedAllocation(order);
      const processorAmount=allocation?.processor_money.amount??order.settlement_amounts.outstanding_money.amount;
      let body:PayOrderRequestInput;
      if(record.kind==='subscription'&&BigInt(order.settlement_amounts.outstanding_money.amount)===0n){
        if(input.credential?.kind!=='payment_method_token')throw new LocalError('SETUP_PAYMENT_SOURCE_REQUIRED');
        body={action:'setup',setup_payment_source:{token:input.credential.value},expected_outstanding_money:input.approved_outstanding_money,buyer_contact:input.buyer_contact};
      }else{
        let source: {confirmation_token:string}|{token:string}|{payment_method_id:string}|undefined;
        if(BigInt(processorAmount)>0n){
          if(!input.credential)throw new LocalError('PAYMENT_SOURCE_REQUIRED');
          if(input.credential.kind==='saved_payment_method'){
            const methods=await this.client.paymentMethods.list(undefined,this.auth.checkout(record));
            if(!methods.data.some(method=>method.payment_method_id===input.credential!.value))throw new LocalError('PAYMENT_SOURCE_UNAVAILABLE');
            source={payment_method_id:input.credential.value};
          }else if(input.credential.kind==='confirmation_token'){
            if(!input.credential.value.startsWith('ctoken_'))throw new LocalError('PAYMENT_SOURCE_REQUIRED');
            source={confirmation_token:input.credential.value};
          }else{
            if(!input.credential.value.startsWith('pm_'))throw new LocalError('PAYMENT_SOURCE_REQUIRED');
            source={token:input.credential.value};
          }
        }
        body={action:'pay',payment_source:source,expected_outstanding_money:input.approved_outstanding_money,accepted_gift_card_allocation:allocation,buyer_contact:input.buyer_contact,
          ...(source?{save_payment_method:input.save_payment_method,save_payment_method_phone:input.save_payment_method_phone}:{})};
      }
      const job=this.job(record,'pay',body);
      try{return await this.execute(record,job,assertOwnership);}
      catch(error){
        if(error&&typeof error==='object'&&'code'in error&&['GIFT_CARD_INSUFFICIENT_VALUE','GIFT_CARD_ALLOCATION_CHANGED','ORDER_CHANGED_REFRESH_REQUIRED'].includes(String(error.code)))return {order:await this.read(record),unknown:false,totalChanged:true};
        if(!(error&&typeof error==='object'&&'code'in error&&error.code==='PAYMENT_LEG_SELECTION_REQUIRED')||body.action!=='pay'||!body.payment_source)throw error;
        const fresh=await this.read(record);const selectable=fresh.payment_collection?.stripe?.elements?.selectable_payment_intents;
        if(!approvalMatches(fresh,record.kind,input))return {order:fresh,unknown:false,totalChanged:true};
        if(selectable?.length!==1)throw new LocalError('PAYMENT_LEG_SELECTION_REQUIRED',409);
        const retryBody:PayOrderRequestInput={...body,action:'confirm_payment_intents',payment_intents:[{payment_intent_id:selectable[0]!.payment_intent_id,...body.payment_source}]};
        delete (retryBody as unknown as {payment_source?:unknown}).payment_source;
        return this.execute(record,this.job(record,'pay',retryBody),assertOwnership);
      }
    });
  }
  async resume(ref:string,fromReturn=false):Promise<PaymentResult>{
    const initial=this.record(ref);
    return this.store.locked(this.resource(initial),async assertOwnership=>{
      const record=this.record(ref);const pending=this.unresolved(record);
      if(pending)return this.execute(record,pending,assertOwnership);
      const current=await this.reconcile(record);
      if(!current.attempt?.is_resumable)return current;
      record.last_attempt_id=current.attempt.order_payment_attempt_id;
      const body:PayOrderRequestInput={action:'resume',order_payment_attempt_id:current.attempt.order_payment_attempt_id};
      const fixed=fromReturn?`resume-return-${current.attempt.order_payment_attempt_id}-${current.attempt.pending_actions?.map(action=>action.pending_action_id).join('.')??'none'}`:undefined;
      return this.execute(record,this.job(record,'resume',body,fixed),assertOwnership);
    });
  }
  async cancel(ref:string):Promise<PaymentResult>{
    const initial=this.record(ref);
    return this.store.locked(this.resource(initial),async assertOwnership=>{
      const record=this.record(ref);const pending=this.unresolved(record);
      if(pending)return this.execute(record,pending,assertOwnership);
      const current=await this.reconcile(record);
      if(!current.attempt||!attemptOpen(current.attempt))return current;
      record.last_attempt_id=current.attempt.order_payment_attempt_id;
      return this.execute(record,this.job(record,'cancel',{cancellation_reason:'abandoned'},`cancel-${record.last_attempt_id}`),assertOwnership);
    });
  }
  async status(ref:string):Promise<PaymentResult>{const record=this.record(ref);return this.store.locked(this.resource(record),()=>this.reconcile(this.record(ref)));}
  next(result:PaymentResult){return result.unknown?'resume':result.order.payment_status==='paid'?'done':nextStep(result.attempt,result.order);}
}
