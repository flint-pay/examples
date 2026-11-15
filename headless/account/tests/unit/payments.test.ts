import {errors} from '@flintpay/node';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Client,Order,OrderPaymentAttempt,RequestOptions,PayOrderRequestInput} from '@flintpay/node';
import {Store} from '../../src/store/db.ts';
import type {CheckoutRecord} from '../../src/store/db.ts';
import {PaymentEngine,acceptedAllocation,collectionKind,approvalMatches} from '../../src/payments/engine.ts';
import {createAuth} from '../../src/flint/auth.ts';
import {clientAction} from '../../src/flint/projection.ts';
import {nextStep} from '../../src/payments/next-step.ts';
import {SdkError} from '@flintpay/node';
import {LocalError} from '../../src/flint/errors.ts';
function checkout(store:Store):CheckoutRecord{
  store.run('INSERT INTO payment_checkouts(checkout_ref,user_id,sandbox_id,resource_type,resource_id,order_id,checkout_session_id,checkout_auth_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)','checkout_example','user_example','sandbox_example','invoice','inv_example','ord_example','session_example','example checkout authority',Date.now(),Date.now());
  return store.checkout('user_example','sandbox_example','invoice','inv_example')!;
}
const money={amount:'1000' as const,currency:'USD'};
const order=():Order=>({order_id:'ord_example',payment_status:'unpaid',status:'open',line_items:[],buyer_actions:[],pricing_amounts:{total_money:money},settlement_amounts:{outstanding_money:money},tax:{},payment_collection:{stripe:{elements:{}}}} as unknown as Order);
const attempt=(status='processing',resumable=false):OrderPaymentAttempt=>({order_id:'ord_example',supported_actions:[],order_payment_attempt_id:'attempt_example',expected_outstanding_money:money,status,is_resumable:resumable,mode:'payment',gift_card_redemptions:[],payment_intents:[],pending_actions:[]} as unknown as OrderPaymentAttempt);
const input={credential:{kind:'confirmation_token' as const,value:'ctoken_PLACEHOLDER'},approved_collection_kind:'processor' as const,approved_outstanding_money:money};
test('concurrent duplicate pay clicks perform one charge and reuse authoritative state',async()=>{
  const store=new Store(':memory:');try{
    const record=checkout(store);let current=order(),charges=0;
    const client={orders:{get:async()=>current,pay:async(orderId:string, body:any,options:RequestOptions)=>{const request={order_id:orderId,body};
      assert.equal(options.apiKey,undefined);assert.equal(options.customerToken,undefined);assert.equal(options.checkoutToken,'example checkout authority');assert.equal(request.order_id,'ord_example');assert.ok(options.idempotencyKey);
      charges++;await new Promise(resolve=>setTimeout(resolve,30));current={...current,active_payment_attempt:attempt()};return {order:current,order_payment_attempt:current.active_payment_attempt};}},checkoutSessions:{get:async()=>({status:'open'})}} as unknown as Client;
    const engine=new PaymentEngine(client,createAuth('flint_test_PLACEHOLDER'),store,async()=>{});
    const result=await Promise.all([engine.start(record.checkout_ref,input),engine.start(record.checkout_ref,input)]);assert.equal(charges,1);assert.equal(result[1]?.attempt?.order_payment_attempt_id,'attempt_example');
  }finally{store.close();}
});
test('unknown charge without evidence blocks every new credential and keeps the same body and key',async()=>{
  const store=new Store(':memory:');try{
    const record=checkout(store),keys:string[]=[],bodies:string[]=[];let calls=0;
    const client={orders:{get:async()=>order(),pay:async(orderId:string,body:unknown,options:RequestOptions)=>{const request={order_id:orderId,body};calls++;keys.push(options.idempotencyKey!);bodies.push(JSON.stringify(request));throw new Error('local transport interrupted');}},checkoutSessions:{get:async()=>({status:'open'})}} as unknown as Client;
    const engine=new PaymentEngine(client,createAuth('flint_test_PLACEHOLDER'),store,async()=>{});
    const first=await engine.start(record.checkout_ref,input),second=await engine.start(record.checkout_ref,{...input,credential:{kind:'confirmation_token',value:'ctoken_DIFFERENT_PLACEHOLDER'}});
    assert.equal(first.unknown,true);assert.equal(second.unknown,true);assert.equal(calls,8);assert.equal(new Set(keys).size,1);assert.equal(new Set(bodies).size,1);assert.ok(engine.unresolved(record));
  }finally{store.close();}
});
test('lost charge response reconciles an active attempt and no later click starts another charge',async()=>{
  const store=new Store(':memory:');try{
    const record=checkout(store);let current=order(),calls=0;
    const client={orders:{get:async()=>current,pay:async()=>{calls++;current={...current,active_payment_attempt:attempt()};throw new Error('local response lost');}},checkoutSessions:{get:async()=>({status:'open'})}} as unknown as Client;
    const engine=new PaymentEngine(client,createAuth('flint_test_PLACEHOLDER'),store,async()=>{});
    const result=await engine.start(record.checkout_ref,input);assert.equal(result.unknown,false);assert.equal(result.attempt?.status,'processing');assert.equal(calls,4);
    await engine.start(record.checkout_ref,{...input,credential:{kind:'confirmation_token',value:'ctoken_DIFFERENT_PLACEHOLDER'}});assert.equal(calls,4);
  }finally{store.close();}
});
test('approved amount and saved method ownership are checked before a charge',async()=>{
  const store=new Store(':memory:');try{
    const record=checkout(store);let charges=0;
    const client={orders:{get:async()=>order(),pay:async()=>{charges++;}},checkoutSessions:{get:async()=>({status:'open'})},paymentMethods:{list:async()=>({data:[{payment_method_id:'method_example',status:'active'}]})}} as unknown as Client;
    const engine=new PaymentEngine(client,createAuth('flint_test_PLACEHOLDER'),store,async()=>{});
    const changed=await engine.start(record.checkout_ref,{...input,approved_outstanding_money:{amount:'900',currency:'USD'}});assert.equal(changed.totalChanged,true);
    await assert.rejects(engine.start(record.checkout_ref,{...input,credential:{kind:'saved_payment_method',value:'method_foreign'}}),{code:'PAYMENT_SOURCE_UNAVAILABLE'});assert.equal(charges,0);
  }finally{store.close();}
});
test('resume has no payment source and advances the same attempt with a durable stage key',async()=>{
  const store=new Store(':memory:');try{
    const record=checkout(store);let current={...order(),active_payment_attempt:attempt('requires_retry',true)},calls=0;
    const client={orders:{get:async()=>current,pay:async(orderId:string, body:any)=>{const request={order_id:orderId,body};assert.deepEqual(request.body,{action:'resume',order_payment_attempt_id:'attempt_example'});calls++;current={...current,active_payment_attempt:attempt('processing',false)};return {order:current,order_payment_attempt:current.active_payment_attempt};}}} as unknown as Client;
    const engine=new PaymentEngine(client,createAuth('flint_test_PLACEHOLDER'),store,async()=>{});await engine.resume(record.checkout_ref);await engine.resume(record.checkout_ref);assert.equal(calls,1);
  }finally{store.close();}
});
for(const recovery of ['settled','unavailable','forbidden'] as const)test(`unknown resume retains its payment job while reconciliation is ${recovery}`,async()=>{
  const store=new Store(':memory:');try{
    const record=checkout(store),keys:string[]=[],delays:number[]=[];let charges=0,reads=0;
    const settled={...order(),payment_status:'paid',active_payment_attempt:attempt('succeeded',false)} as Order;
    const client={orders:{
      get:async()=>{
        if(charges===0)return {...order(),active_payment_attempt:attempt('requires_action',true)};
        reads++;
        if(recovery==='forbidden')throw new LocalError('FORBIDDEN',403);
        if(recovery==='unavailable'||reads===1)throw new Error('invoice projection temporarily unreadable');
        return settled;
      },
      pay:async(orderId:string, body:any,options:RequestOptions<'checkout'>)=>{const request={order_id:orderId,body};
        assert.equal(request.body.action,'resume');charges++;keys.push(options.idempotencyKey!);
        throw new Error('settlement response lost');
      },
    }} as unknown as Client;
    const engine=new PaymentEngine(client,createAuth('flint_test_PLACEHOLDER'),store,async ms=>{delays.push(ms);});
    if(recovery==='settled'){
      const result=await engine.resume(record.checkout_ref);
      assert.equal(result.order.payment_status,'paid');assert.equal(result.unknown,false);assert.equal(engine.unresolved(record),undefined);assert.equal(reads,2);
    }else{
      await assert.rejects(engine.resume(record.checkout_ref),recovery==='forbidden'?{code:'FORBIDDEN'}:/invoice projection temporarily unreadable/);
      assert.equal(engine.unresolved(record)?.status,'unknown');assert.equal(reads,recovery==='forbidden'?1:4);
    }
    assert.equal(charges,4);assert.equal(new Set(keys).size,1);
    assert.deepEqual(delays,recovery==='settled'?[500,1000,2000,500]:recovery==='forbidden'?[500,1000,2000]:[500,1000,2000,500,1000,2000]);
  }finally{store.close();}
});
test('a declined leg is explicitly selected using a new key after its known rejection',async()=>{
  const store=new Store(':memory:');try{
    const record=checkout(store);let calls=0;const keys:string[]=[];const current={...order(),payment_collection:{stripe:{elements:{mode:'payment',next_step:'create_confirmation_token',payment_method_creation:'manual',payment_method_types:['card'],selectable_payment_intents:[{payment_intent_id:'intent_example'}]}}}} as Order;
    const client={orders:{get:async()=>current,pay:async(orderId:string, body:any,options:RequestOptions)=>{const request={order_id:orderId,body};calls++;keys.push(options.idempotencyKey!);if(calls===1)throw new LocalError('PAYMENT_LEG_SELECTION_REQUIRED',409);assert.equal(request.body.action,'confirm_payment_intents');assert.equal('payment_source'in request.body,false);return {order:current,order_payment_attempt:attempt('succeeded')};}},checkoutSessions:{get:async()=>({status:'open'})}} as unknown as Client;
    const engine=new PaymentEngine(client,createAuth('flint_test_PLACEHOLDER'),store,async()=>{});const result=await engine.start(record.checkout_ref,input);assert.equal(result.attempt?.status,'succeeded');assert.notEqual(keys[0],keys[1]);
  }finally{store.close();}
});
test('ACH processing and unfamiliar attempt states are conservative',()=>{
  const ach={...attempt('processing',false),payment_intents:[{payment_intent_id:'intent_example'}]} as OrderPaymentAttempt;
  assert.equal(nextStep(ach,new Map([['intent_example','ach_debit']])),'bank_processing');assert.equal(nextStep(attempt('future_state',false)),'wait');assert.equal(nextStep(attempt('requires_retry',true)),'resume');assert.equal(nextStep(attempt('requires_action',true)),'authenticate');
});

test('an unknown payment survives a process restart and another credential cannot replace its request',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'account-payment-')),path=join(dir,'local.sqlite');let store=new Store(path);const keys:string[]=[];const bodies:string[]=[];
  try{
    const record=checkout(store);
    const client={orders:{get:async()=>order(),pay:async(orderId:string,body:unknown,options:RequestOptions)=>{const request={order_id:orderId,body};keys.push(options.idempotencyKey!);bodies.push(JSON.stringify(request));throw new Error('local transport interrupted');}},checkoutSessions:{get:async()=>({status:'open'})}} as unknown as Client;
    let engine=new PaymentEngine(client,createAuth('flint_test_PLACEHOLDER'),store,async()=>{});assert.equal((await engine.start(record.checkout_ref,input)).unknown,true);
    store.close();store=new Store(path);engine=new PaymentEngine(client,createAuth('flint_test_PLACEHOLDER'),store,async()=>{});
    assert.equal((await engine.start(record.checkout_ref,{...input,credential:{kind:'confirmation_token',value:'ctoken_DIFFERENT_PLACEHOLDER'}})).unknown,true);assert.equal(new Set(keys).size,1);assert.equal(new Set(bodies).size,1);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('an uncertain job waits briefly, then offers resume to replay the persisted request without a new charge',async()=>{
  const store=new Store(':memory:');try{
    const record=checkout(store);let calls=0;
    const client={orders:{get:async()=>order(),pay:async()=>{calls++;throw new Error('local transport interrupted');}},checkoutSessions:{get:async()=>({status:'open',is_in_recovery:false})}} as unknown as Client;
    const engine=new PaymentEngine(client,createAuth('flint_test_PLACEHOLDER'),store,async()=>{}),result=await engine.start(record.checkout_ref,input);
    assert.equal((await engine.view(record,result)).next,'wait');store.run('UPDATE actions SET retry_after=0 WHERE resource=?',engine.resource(record));
    assert.equal((await engine.view(record,result)).next,'resume');const key=engine.unresolved(record)!.idempotency_key;await engine.resume(record.checkout_ref);assert.equal(engine.unresolved(record)!.idempotency_key,key);assert.equal(calls,8);
  }finally{store.close();}
});
test('explicit resume nonces replay a logical step and a later step gets a fresh key',async()=>{
  const store=new Store(':memory:');try{
    const record=checkout(store),current={...order(),active_payment_attempt:attempt('requires_retry',true)},keys:string[]=[];
    const client={orders:{get:async()=>current,pay:async(_orderId:string,_request:unknown,options:RequestOptions)=>{keys.push(options.idempotencyKey!);return {order:current,order_payment_attempt:current.active_payment_attempt};}}} as unknown as Client;
    const engine=new PaymentEngine(client,createAuth('flint_test_PLACEHOLDER'),store,async()=>{});await engine.resume(record.checkout_ref,'example-step');await engine.resume(record.checkout_ref,'example-step');await engine.resume(record.checkout_ref,'example-next-step');assert.equal(keys.length,2);assert.notEqual(keys[0],keys[1]);
  }finally{store.close();}
});

function giftOrder(processor='0'):Order{return {...order(),version:5,gift_card_tender_enabled:true,gift_cards:[{gift_card_id:'gift_fixture',last4:'1234'}],gift_card_estimate:{can_pay:true,order_version:5,gift_card_money:{amount:processor==='0'?'1000':'600',currency:'USD'},processor_money:{amount:processor,currency:'USD'},gift_cards:[{gift_card_id:'gift_fixture',amount_money:{amount:processor==='0'?'1000':'600',currency:'USD'}}]}} as unknown as Order;}
function giftInput(processor='0'){return {approved_outstanding_money:money,approved_collection_kind:processor==='0'?'settlement' as const:'processor' as const,approved_order_revision:5,approved_gift_card_money:{amount:(processor==='0'?'1000':'600') as '1000'|'600',currency:'USD'},...(processor==='0'?{}:{credential:input.credential})};}
for(const processor of ['0','400'])test(`I17 fresh gift allocation with ${processor} processor amount is accepted exactly`,async()=>{
 const store=new Store(':memory:');try{const record=checkout(store),current=giftOrder(processor),requests:PayOrderRequestInput[]=[];
 const client={orders:{get:async()=>current,pay:async(orderId:string, body:any)=>{const request={order_id:orderId,body};requests.push(request.body);current.payment_status='paid';return {order:current,order_payment_attempt:attempt('succeeded')};}},checkoutSessions:{get:async()=>({status:'open'})}} as unknown as Client;
 const engine=new PaymentEngine(client,createAuth('fixture'),store,async()=>{});await engine.start(record.checkout_ref,giftInput(processor));assert.equal(requests.length,1);const sent=requests[0]!;assert.equal(sent.action,'pay');if(sent.action!=='pay')throw new Error('pay action required');assert.deepEqual(sent.accepted_gift_card_allocation,acceptedAllocation(giftOrder(processor)));assert.equal('payment_source'in sent,processor!=='0');
 }finally{store.close();}
});
test('I17 concurrent gift-funded submissions settle once without a processor source',async()=>{
 const store=new Store(':memory:');try{const record=checkout(store),current=giftOrder(),requests:PayOrderRequestInput[]=[];
 const client={orders:{get:async()=>current,getPaymentAttempt:async()=>attempt('succeeded'),pay:async(orderId:string, body:any)=>{const request={order_id:orderId,body};requests.push(request.body);current.payment_status='paid';return {order:current,order_payment_attempt:attempt('succeeded')};}},checkoutSessions:{get:async()=>({status:'open'})}} as unknown as Client,engine=new PaymentEngine(client,createAuth('fixture'),store,async()=>{});
 const outcomes=await Promise.all([engine.start(record.checkout_ref,giftInput(),'one'),engine.start(record.checkout_ref,giftInput(),'two')]);assert.equal(requests.length,1);assert.equal('payment_source'in requests[0]!,false);assert.ok(outcomes.every(result=>result.order.payment_status==='paid'));assert.equal(store.all("SELECT * FROM actions WHERE kind='pay'").length,1);
 }finally{store.close();}
});
test('I17 gift approval fences reject changed collection, revision, value and outstanding without paying',async()=>{
 const store=new Store(':memory:');try{const record=checkout(store),current=giftOrder(),client={orders:{get:async()=>current,pay:async()=>{throw new Error('pay must not run');}}} as unknown as Client,engine=new PaymentEngine(client,createAuth('fixture'),store,async()=>{});
 const valid=giftInput();assert.equal(collectionKind(current),'settlement');assert.equal(approvalMatches(current,valid),true);
 for(const changed of [{...valid,approved_collection_kind:'processor' as const},{...valid,approved_order_revision:4},{...valid,approved_gift_card_money:{amount:'999' as const,currency:'USD'}},{...valid,approved_outstanding_money:{amount:'1001' as const,currency:'USD'}}])assert.equal((await engine.start(record.checkout_ref,changed)).totalChanged,true);
 }finally{store.close();}
});
for(const code of ['VERSION_CONFLICT','CONCURRENT_MODIFICATION'])test(`I17 ${code} returns a new approval state`,async()=>{
 const store=new Store(':memory:');try{const record=checkout(store),current=giftOrder(),client={orders:{get:async()=>current,pay:async()=>{throw new errors.InvalidRequestError('fixture',{outcome:'response',retryAllowed:false,...({status:409,headers:{},attempts:1,durationMs:1}),code:code});}},checkoutSessions:{get:async()=>({status:'open'})}} as unknown as Client,engine=new PaymentEngine(client,createAuth('fixture'),store,async()=>{});assert.equal((await engine.start(record.checkout_ref,giftInput())).totalChanged,true);
 }finally{store.close();}
});
test('I17 unavailable gift backing retries the original settlement key and body',async()=>{
 const store=new Store(':memory:');try{const record=checkout(store),current=giftOrder(),keys:string[]=[],bodies:string[]=[];
 const client={orders:{get:async()=>current,pay:async(orderId:string,body:unknown,options:RequestOptions)=>{const request={order_id:orderId,body};keys.push(options.idempotencyKey!);bodies.push(JSON.stringify(request));if(keys.length<3)throw new errors.ServerError('fixture',{outcome:'response',retryAllowed:true,...({status:503,headers:{},attempts:1,durationMs:1}),code:'GIFT_CARDS_UNAVAILABLE'});current.payment_status='paid';return {order:current,order_payment_attempt:attempt('succeeded')};}},checkoutSessions:{get:async()=>({status:'open'})}} as unknown as Client,engine=new PaymentEngine(client,createAuth('fixture'),store,async()=>{});await engine.start(record.checkout_ref,giftInput());assert.equal(keys.length,3);assert.equal(new Set(keys).size,1);assert.equal(new Set(bodies).size,1);
 }finally{store.close();}
});
test('I17 pending gift writes fence payment and closed sessions disable gift editing',async()=>{
 const store=new Store(':memory:');try{const record=checkout(store),current=giftOrder(),client={orders:{get:async()=>current},checkoutSessions:{get:async()=>({status:'closed'})}} as unknown as Client,engine=new PaymentEngine(client,createAuth('fixture'),store,async()=>{});
 store.action(engine.giftResource(record),'gift_apply',{code_hash:'hash',order_revision:5},'nonce');await assert.rejects(()=>engine.start(record.checkout_ref,giftInput()),{code:'GIFT_CARD_CHANGE_UNCONFIRMED'});
 const view=await engine.view(record,{order:current,unknown:false});assert.equal(view.state.gift_editable,false);const serialized=JSON.stringify(view);for(const field of ['gift_card_challenge','page_origin','checkout_session_id'])assert.equal(serialized.includes(field),false);
 }finally{store.close();}
});


test('URL action refusal continues the holding attempt with Stripe and a journaled fallback key',async()=>{
  const store=new Store(':memory:');try{
    const row=checkout(store);let current=order();const sent:{body:PayOrderRequestInput;key?:string}[]=[];
    const client={orders:{get:async()=>current,pay:async(_id:string,body:PayOrderRequestInput,options:RequestOptions)=>{
      sent.push({body,key:options.idempotencyKey});
      if(sent.length===1){current={...current,active_payment_attempt:{...attempt('requires_action',true),pending_actions:[]}};throw new errors.ConflictError('URL unsupported',{status:409,code:'ACTION_NOT_ALLOWED',outcome:'response',details:[{code:'ACTION_NOT_ALLOWED',message:'URL unsupported',reason:'provider_action_unsupported'}]});}
      current={...current,payment_status:'paid',active_payment_attempt:attempt('succeeded')};
      return {order:current,order_payment_attempt:current.active_payment_attempt};
    }}} as unknown as Client;
    const engine=new PaymentEngine(client,createAuth('fixture'),store);
    const job=engine.job(row,'pay',{action:'pay',client_action_type:'url',payment_source:{credential_type:'stripe_confirmation_token',stripe:{confirmation_token:'ctoken_example'}}});
    await engine.execute(row,job,()=>{});
    assert.equal(sent.length,2);assert.equal(sent[0]!.body.client_action_type,'url');
    assert.deepEqual(sent[1]!.body,{action:'resume',order_payment_attempt_id:current.active_payment_attempt!.order_payment_attempt_id,client_action_type:'stripe'});
    assert.equal(sent[1]!.key,sent[0]!.key+'-stripe');assert.equal('payment_source'in sent[1]!.body,false);
  }finally{store.close();}
});

for(const recover of ['status','pay'] as const)test(`Stripe fallback survives a read failure and recovers through ${recover}`,async()=>{
  const store=new Store(':memory:');try{
    const row=checkout(store);let current=order(),failRead=false;
    const sent:{body:PayOrderRequestInput;key?:string}[]=[];
    const client={orders:{get:async()=>{if(failRead){failRead=false;throw new Error('read failed after refusal');}return current;},pay:async(_id:string,body:PayOrderRequestInput,options:RequestOptions)=>{
      sent.push({body,key:options.idempotencyKey});
      if(sent.length===1){
        current={...current,active_payment_attempt:{...attempt('requires_action',true),pending_actions:[]}};failRead=true;
        throw new errors.ConflictError('URL unsupported',{status:409,code:'ACTION_NOT_ALLOWED',outcome:'response',details:[{code:'ACTION_NOT_ALLOWED',message:'URL unsupported',reason:'provider_action_unsupported'}]});
      }
      const pending={...attempt('requires_action',true),pending_actions:[{pending_action_id:'action_example',client_action:{type:'stripe',stripe:{publishable_key:'pk_example',payment_intent:{client_secret:'pi_example_secret',stripe_js_call:'handle_next_action'}}}}]} as unknown as OrderPaymentAttempt;
      current={...current,active_payment_attempt:pending};return {order:current,order_payment_attempt:pending};
    }}} as unknown as Client;
    let engine=new PaymentEngine(client,createAuth('fixture'),store);
    const job=engine.job(row,'pay',{action:'pay',client_action_type:'url',payment_source:{credential_type:'stripe_confirmation_token',stripe:{confirmation_token:'ctoken_example'}}});
    await assert.rejects(()=>engine.execute(row,job,()=>{}),/read failed after refusal/);
    // A fresh engine sees the durable intent, and ordinary reconciliation cannot discard it.
    engine=new PaymentEngine(client,createAuth('fixture'),store);
    assert.equal((await engine.reconcile(engine.record(row.checkout_ref))).unknown,true);
    assert.ok(engine.unresolved(row)?.body);
    const result=recover==='status'?await engine.status(row.checkout_ref):await engine.start(row.checkout_ref,input);
    assert.equal(result.unknown,false);assert.equal(nextStep(result.attempt),'authenticate');
    assert.equal(clientAction(result.attempt)?.type,'stripe');
    assert.equal(sent.length,2);
    assert.deepEqual(sent[1]!.body,{action:'resume',order_payment_attempt_id:result.attempt!.order_payment_attempt_id,client_action_type:'stripe'});
    assert.equal(sent[1]!.key,`${sent[0]!.key}-stripe`);
    assert.equal(engine.unresolved(row),undefined);
    await engine.start(row.checkout_ref,input);assert.equal(sent.length,2);
  }finally{store.close();}
});


test('a second provider refusal rejects the Stripe fallback instead of retrying it on later status reads',async()=>{
  const store=new Store(':memory:');try{
    const row=checkout(store);let calls=0;
    const current={...order(),active_payment_attempt:{...attempt('requires_action',true),pending_actions:[]}};
    const client={orders:{get:async()=>current,pay:async()=>{
      calls++;throw new errors.ConflictError('Provider action unsupported',{status:409,code:'ACTION_NOT_ALLOWED',outcome:'response',details:[{code:'ACTION_NOT_ALLOWED',message:'Provider action unsupported',reason:'provider_action_unsupported'}]});
    }}} as unknown as Client;
    const engine=new PaymentEngine(client,createAuth('fixture'),store);
    const job=engine.job(row,'pay',{action:'pay',client_action_type:'url',payment_source:{credential_type:'stripe_confirmation_token',stripe:{confirmation_token:'ctoken_example'}}});
    await assert.rejects(()=>engine.execute(row,job,()=>{}),{code:'ACTION_NOT_ALLOWED'});
    assert.equal(calls,2);assert.equal(engine.unresolved(row),undefined);
    assert.equal(store.get<{status:string;body:string|null}>('SELECT status,body FROM actions WHERE action_id=?',job.action_id)?.status,'rejected');
    assert.equal(store.get<{body:string|null}>('SELECT body FROM actions WHERE action_id=?',job.action_id)?.body,null);
    await engine.status(row.checkout_ref);await engine.status(row.checkout_ref);assert.equal(calls,2);
  }finally{store.close();}
});
