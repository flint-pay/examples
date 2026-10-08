import type {Client,MoneyValue,Order,OrderPaymentAttempt,PayOrderRequestInput} from '@flintpay/node';
import type {Auth} from '../flint/auth.ts';
import {LocalError,unknownOutcome,appError} from '../flint/errors.ts';
import {Store} from '../store/db.ts';
import type {CheckoutRecord,ActionRecord} from '../store/db.ts';
import {moneyEqual} from '../security/money.ts';
import {nextStep,attemptOpen} from './next-step.ts';
import {safePaymentOrder,safeAttempt,safeMethod,clientAction} from '../flint/projection.ts';
export type Credential={kind:'confirmation_token'|'payment_method_token'|'saved_payment_method';value:string};
export type PayInput={credential?:Credential;approved_outstanding_money:MoneyValue};
export type PaymentResult={order:Order;attempt?:OrderPaymentAttempt;unknown:boolean;totalChanged?:boolean;expired?:boolean;recovery?:boolean};
export class PaymentEngine {
  client:Client;auth:Auth;store:Store;delay:(ms:number)=>Promise<void>;
  constructor(client:Client,auth:Auth,store:Store,delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))){this.client=client;this.auth=auth;this.store=store;this.delay=delay;}
  record(ref:string):CheckoutRecord{const record=this.store.get<CheckoutRecord>('SELECT * FROM payment_checkouts WHERE checkout_ref=?',ref);if(!record)throw new LocalError('NOT_FOUND',404);return record;}
  resource(record:CheckoutRecord){return `payment:${record.sandbox_id}:${record.user_id}:${record.order_id}`;}
  async read(record:CheckoutRecord){return this.client.orders.get(record.order_id,undefined,this.auth.checkout(record));}
  unresolved(record:CheckoutRecord){return this.store.get<ActionRecord>("SELECT * FROM actions WHERE resource=? AND kind IN ('pay','resume','cancel') AND status IN ('pending','unknown')",this.resource(record));}
  async attempt(record:CheckoutRecord,order:Order):Promise<OrderPaymentAttempt|undefined>{
    if(order.active_payment_attempt)return order.active_payment_attempt;
    if(record.last_attempt_id)return this.client.orders.getPaymentAttempt(record.order_id,record.last_attempt_id,undefined,this.auth.checkout(record));
    return undefined;
  }
  remember(record:CheckoutRecord,attempt:OrderPaymentAttempt|undefined){if(attempt)this.store.run('UPDATE payment_checkouts SET last_attempt_id=?,updated_at=? WHERE checkout_ref=?',attempt.order_payment_attempt_id,Date.now(),record.checkout_ref);}
  complete(job:ActionRecord,attempt:OrderPaymentAttempt|undefined){this.store.run("UPDATE actions SET status='succeeded',attempt_id=?,body=NULL WHERE action_id=?",attempt?.order_payment_attempt_id??null,job.action_id);}
  async reconcile(record:CheckoutRecord):Promise<PaymentResult>{
    const order=await this.read(record),attempt=await this.attempt(record,order),pending=this.unresolved(record);
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
          if(code==='ORDER_CHANGED_REFRESH_REQUIRED')return {...await this.reconcile(record),totalChanged:true};
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
      if(order.payment_status==='paid'||attemptOpen(attempt))return {order,attempt,unknown:false};
      if(!input.approved_outstanding_money||!/^\d+$/.test(input.approved_outstanding_money.amount)||!moneyEqual(order.settlement_amounts.outstanding_money,input.approved_outstanding_money))return {order,attempt,unknown:false,totalChanged:true};
      const session=await this.client.checkoutSessions.get(record.checkout_session_id,undefined,this.auth.checkout(record));
      if(session.status!=='open')return {order,attempt,unknown:false,expired:true};
      let source:{confirmation_token:string}|{token:string}|{payment_method_id:string}|undefined;
      if(BigInt(order.settlement_amounts.outstanding_money.amount)>0n){
        const credential=input.credential;if(!credential)throw new LocalError('PAYMENT_SOURCE_REQUIRED');
        if(credential.kind==='saved_payment_method'){
          const methods=await this.client.paymentMethods.list(undefined,this.auth.checkout(record));
          if(!methods.data.some(method=>method.payment_method_id===credential.value&&method.status==='active'))throw new LocalError('PAYMENT_SOURCE_UNAVAILABLE');
          source={payment_method_id:credential.value};
        }else if(credential.kind==='confirmation_token'&&/^ctoken_[A-Za-z0-9_]+$/.test(credential.value))source={confirmation_token:credential.value};
        else if(credential.kind==='payment_method_token'&&/^pm_[A-Za-z0-9_]+$/.test(credential.value))source={token:credential.value};
        else throw new LocalError('PAYMENT_SOURCE_REQUIRED');
      }
      const body:PayOrderRequestInput={action:'pay',payment_source:source,expected_outstanding_money:input.approved_outstanding_money};
      try{return await this.execute(record,this.job(record,'pay',body,nonce),assertOwnership);}
      catch(error){
        if(!(error&&typeof error==='object'&&'code'in error&&error.code==='PAYMENT_LEG_SELECTION_REQUIRED')||!source)throw error;
        const fresh=await this.read(record);
        if(!moneyEqual(fresh.settlement_amounts.outstanding_money,input.approved_outstanding_money))return {order:fresh,unknown:false,totalChanged:true};
        const legs=fresh.payment_collection?.stripe?.elements?.selectable_payment_intents;
        if(legs?.length!==1)throw new LocalError('PAYMENT_LEG_SELECTION_REQUIRED',409);
        const retry:PayOrderRequestInput={action:'confirm_payment_intents',payment_intents:[{payment_intent_id:legs[0]!.payment_intent_id,...source}],expected_outstanding_money:input.approved_outstanding_money};
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
    try{const session=await this.client.checkoutSessions.get(record.checkout_session_id,undefined,this.auth.checkout(record));result.recovery=session.recovery_mode;result.expired=session.status!=='open'&&!session.recovery_mode&&result.order.payment_status!=='paid';}
    catch(error){if(!['INVALID_CHECKOUT_SESSION','CHECKOUT_SESSION_NOT_OPEN','CHECKOUT_SESSION_EXPIRED','CHECKOUT_RECOVERY_RESTRICTED'].includes(appError(error).code))throw error;result.recovery=attemptOpen(result.attempt);result.expired=!result.recovery;}
    const failedLeg=result.attempt?.payment_intents?.find(leg=>leg.last_payment_error);
    const declineCode=failedLeg?.last_payment_error?.code??result.attempt?.failure_code;
    const unresolved=this.unresolved(record);
    const next=result.unknown?(unresolved&&unresolved.retry_after<=Date.now()?'resume':'wait'):result.order.payment_status==='paid'?'done':nextStep(result.attempt,options);
    const methods=['new_payment','pay_remaining'].includes(next)&&!result.expired?(await this.client.paymentMethods.list(undefined,this.auth.checkout(record))).data.map(safeMethod):[];
    const pending=result.attempt?.status==='requires_action'?result.attempt.pending_actions?.[0]:undefined;
    const state={order:safePaymentOrder(result.order),payment_collection:result.order.payment_collection??null,attempt:safeAttempt(result.attempt,options),next,approved_outstanding_money:result.order.settlement_amounts.outstanding_money,pending_action_id:pending?.pending_action_id,saved_methods:methods,decline:declineCode?{code:declineCode,payment_option:failedLeg?options.get(failedLeg.payment_intent_id):undefined}:null,shipping:result.order.delivery_destination?{name:result.order.delivery_destination.recipient?.name,address:result.order.delivery_destination.address}:null,recovery_mode:result.recovery,expired:result.expired,total_changed:result.totalChanged,returned,notices:[...(result.unknown?['still_confirming']:[]),...(result.totalChanged?['total_changed']:[])]};
    return {state,next,client_action:clientAction(result.attempt)};
  }
}
