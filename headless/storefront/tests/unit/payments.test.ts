import {test} from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Order,OrderPaymentAttempt,PayOrderRequestInput,RequestOptions} from '@flintpay/node';
import {Client,SdkError} from '@flintpay/node';
import {Store} from '../../src/store/db.ts';
import type {CheckoutRecord,ActionRecord} from '../../src/store/db.ts';
import {createAuth} from '../../src/flint/auth.ts';
import {PaymentEngine,acceptedAllocation,approvalMatches,collectionKind,resolvesJob} from '../../src/payments/engine.ts';
import type {PayInput} from '../../src/payments/engine.ts';
import {nextStep} from '../../src/payments/next-step.ts';

const money=(amount:string)=>({amount,currency:'USD'});
function order(amount='1800'):Order{return {order_id:'example-order',payment_status:'unpaid',order_revision:'5',settlement_amounts:{outstanding_money:money(amount)},payment_collection:{stripe:{elements:{}}}} as unknown as Order;}
function attempt(status:string,is_resumable=false,id='example-attempt'):OrderPaymentAttempt{return {order_payment_attempt_id:id,status,is_resumable} as OrderPaymentAttempt;}
function input(amount='1800'):PayInput{return {approved_outstanding_money:money(amount),approved_collection_kind:'processor'};}
function giftOrder():Order{return {...order(),gift_cards:[{gift_card_id:'example-gift'}],gift_card_estimate:{can_pay:true,order_revision:'5',gift_card_money:money('1800'),processor_money:money('0'),gift_cards:[{gift_card_id:'example-gift',amount_money:money('1800')}]}} as unknown as Order;}
test('collection kind distinguishes zero-balance orders from subscription setup',()=>{
  assert.equal(collectionKind(order(),'order'),'processor');assert.equal(collectionKind(order('0'),'order'),'settlement');assert.equal(collectionKind(giftOrder(),'order'),'settlement');
  assert.equal(collectionKind(order('0'),'subscription'),'unavailable');assert.equal(collectionKind({...order('0'),setup_collection:{stripe:{}}} as Order,'subscription'),'setup');
});
test('approval rejects both increases and decreases, currency changes, and collection switches',()=>{
  assert.equal(approvalMatches(order(),'order',input()),true);assert.equal(approvalMatches(order('1700'),'order',input()),false);assert.equal(approvalMatches(order('1900'),'order',input()),false);
  assert.equal(approvalMatches(order(),'order',{...input(),approved_outstanding_money:{amount:'1800',currency:'CAD'}}),false);assert.equal(approvalMatches(order('0'),'order',input('0')),false);
});
test('gift acceptance compares server revision and gift value and copies the exact allocation',()=>{
  const current=giftOrder();const approval:PayInput={...input(),approved_collection_kind:'settlement',approved_order_revision:'5',approved_gift_card_money:money('1800')};
  assert.equal(approvalMatches(current,'order',approval),true);assert.equal(approvalMatches(current,'order',{...approval,approved_order_revision:'4'}),false);assert.equal(approvalMatches(current,'order',{...approval,approved_gift_card_money:money('1700')}),false);
  assert.deepEqual(acceptedAllocation(current),{order_revision:'5',gift_card_money:money('1800'),processor_money:money('0'),gift_cards:[{gift_card_id:'example-gift',amount_money:money('1800')}]});
  assert.equal(acceptedAllocation(order()),undefined);assert.throws(()=>acceptedAllocation({...current,gift_card_estimate:{...current.gift_card_estimate!,can_pay:false}}));
});
for(const [status,resumable,next] of [['succeeded',false,'done'],['partially_succeeded',false,'pay_remaining'],['failed',false,'new_payment'],['canceled',false,'new_payment'],['expired',false,'new_payment'],['requires_capture',false,'capture'],['requires_action',true,'authenticate'],['processing',true,'resume'],['processing',false,'wait'],['finalizing',false,'wait']] as const)test(`next step for ${status}/${resumable}`,()=>assert.equal(nextStep(attempt(status,resumable)),next));
test('ACH classification matches the real order payment source by leg ID',()=>{
  const current={...order(),payment_intents:[{payment_intent_id:'example-intent',payment_source:{type:'ach_debit'}}]} as unknown as Order;
  const pending={...attempt('processing'),payment_intents:[{payment_intent_id:'example-intent'}]} as OrderPaymentAttempt;
  assert.equal(nextStep(pending,current),'bank_processing');assert.equal(nextStep({...pending,is_resumable:true},current),'resume');assert.equal(nextStep(pending,{...current,payment_intents:[]}),'wait');
});
function record(store:Store):CheckoutRecord{
  store.run('INSERT INTO checkouts(checkout_ref,session_hash,kind,order_id,checkout_session_id,checkout_auth_token,last_attempt_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)','example-checkout','example-session','order','example-order','example-remote-session','local-token','prior-attempt',Date.now(),Date.now());
  return store.get<CheckoutRecord>('SELECT * FROM checkouts WHERE checkout_ref=?','example-checkout')!;
}
test('payment journal admits one durable body and clears the prior attempt atomically',()=>{
  const store=new Store(':memory:');try{
    const row=record(store);const engine=new PaymentEngine(new Client(),createAuth('local-fixture'),store);const body={action:'pay' as const,payment_source:{token:'pm_fixture'},expected_outstanding_money:money('1800')};
    const job=engine.job(row,'pay',body);assert.equal(engine.record(row.checkout_ref).last_attempt_id,null);assert.equal(JSON.parse(job.body!).payment_source.token,'pm_fixture');
    const duplicate=engine.job(row,'pay',{...body,expected_outstanding_money:money('1900')});assert.equal(duplicate.idempotency_key,job.idempotency_key);assert.equal(duplicate.body,job.body);
    assert.throws(()=>store.run('INSERT INTO actions(action_id,resource,kind,idempotency_key,body_hash,created_at) VALUES(?,?,?,?,?,?)','duplicate','order:example-order','pay','duplicate','hash',Date.now()));
    engine.complete(job,attempt('succeeded'));assert.equal(store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',job.action_id)?.body,null);
  }finally{store.close();}
});
test('return resume reuses a completed key without advancing sequence or admitting another call',()=>{
  const store=new Store(':memory:');try{
    const row=record(store);const engine=new PaymentEngine(new Client(),createAuth('local-fixture'),store);const body={action:'resume' as const,order_payment_attempt_id:'prior-attempt'};
    const job=engine.job(row,'resume',body,'return-key');engine.complete(job,attempt('processing',false,'prior-attempt'));const seq=engine.record(row.checkout_ref).resume_seq;
    assert.equal(engine.job(row,'resume',body,'return-key').status,'succeeded');assert.equal(engine.record(row.checkout_ref).resume_seq,seq);
    assert.throws(()=>engine.job(row,'resume',{...body,order_payment_attempt_id:'other-attempt'},'return-key'));
  }finally{store.close();}
});
test('an earlier terminal attempt does not prove a new unknown payment completed',()=>{
  const job={kind:'pay',attempt_id:null} as ActionRecord;const current=order();assert.equal(resolvesJob(job,current,attempt('succeeded',false,'prior-attempt')),false);
  assert.equal(resolvesJob(job,{...current,active_payment_attempt:attempt('processing')},attempt('processing')),true);
  assert.equal(resolvesJob({kind:'resume',attempt_id:'example-attempt'} as ActionRecord,{...current,active_payment_attempt:attempt('requires_action',true)},attempt('requires_action',true)),false);
  assert.equal(resolvesJob({kind:'cancel',attempt_id:'example-attempt'} as ActionRecord,current,attempt('canceled')),true);
});
async function paymentRetries<T>(t:TestContext,pending:Promise<T>):Promise<T>{
  for(const delay of [500,1000,2000]){
    await new Promise<void>(resolve=>setImmediate(resolve));
    t.mock.timers.tick(delay);
  }
  return pending;
}
for(const scenario of [
  {name:'request never reached Flint',status:'succeeded',accepted:false},
  {name:'attempt failed before its response was lost',status:'failed',accepted:true},
  {name:'attempt canceled before its response was lost',status:'canceled',accepted:true},
])test(`unknown payment recovers its persisted original request when ${scenario.name}`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const directory=mkdtempSync(join(tmpdir(),'storefront-payment-recovery-'));const path=join(directory,'app.sqlite');let store=new Store(path);
  const sends:{body:PayOrderRequestInput;key:string|undefined;mode:string|undefined}[]=[];
  let losing=true;let executions=0;let response:{order:Order;payment_attempt:OrderPaymentAttempt}|undefined;
  const client={orders:{
    get:async()=>order(),
    getPaymentAttempt:async()=>{throw new Error('no attempt ID should be remembered before recovery');},
    pay:async(request:{body:PayOrderRequestInput},options:RequestOptions<'checkout'>)=>{
      sends.push({body:structuredClone(request.body),key:options.idempotencyKey,mode:options.authMode});
      if(!response&&(!losing||scenario.accepted)){
        executions++;response={order:scenario.status==='succeeded'?{...order('0'),payment_status:'paid'}:order(),payment_attempt:attempt(scenario.status)};
      }
      if(losing)throw new SdkError('transport','local lost response','unknown',true);
      return response;
    },
  }} as unknown as Client;
  try{
    const row=record(store);let engine=new PaymentEngine(client,createAuth('local-fixture'),store);
    const approved={...input(),credential:{kind:'payment_method_token' as const,value:'pm_original'},buyer_contact:{email:'buyer@example.test'},save_payment_method:true};
    const first=await paymentRetries(t,engine.start(row.checkout_ref,approved));
    assert.equal(sends.length,4);assert.equal(first.attempt,undefined);assert.equal(first.unknown,true);assert.equal(engine.next(first),'resume');
    const saved=engine.unresolved(engine.record(row.checkout_ref))!;assert.equal(saved.status,'unknown');assert.ok(saved.body);
    for(let read=0;read<3;read++){
      const current=await engine.status(row.checkout_ref);assert.equal(engine.next(current),'resume');assert.equal(current.attempt,undefined);
      assert.deepEqual(engine.unresolved(engine.record(row.checkout_ref)),saved);
    }
    assert.equal(sends.length,4);
    store.close();store=new Store(path);engine=new PaymentEngine(client,createAuth('local-fixture'),store);
    assert.equal(engine.next(await engine.status(row.checkout_ref)),'resume');assert.deepEqual(engine.unresolved(engine.record(row.checkout_ref)),saved);
    losing=false;const recovered=await engine.resume(row.checkout_ref);
    assert.equal(sends.length,5);assert.equal(executions,1);
    assert.ok(sends.every(send=>send.key===saved.idempotency_key&&send.mode==='checkout'));
    assert.ok(sends.every(send=>JSON.stringify(send.body)===saved.body));
    assert.equal(recovered.unknown,false);assert.equal(recovered.attempt?.status,scenario.status);assert.equal(engine.next(recovered),scenario.status==='succeeded'?'done':'new_payment');
    assert.equal(engine.unresolved(engine.record(row.checkout_ref)),undefined);assert.equal(engine.record(row.checkout_ref).pay_seq,1);assert.equal(engine.record(row.checkout_ref).resume_seq,0);
    assert.equal(store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',saved.action_id)?.body,null);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
test('a repeated pay click replays the unknown request instead of using a new credential or approval',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const store=new Store(':memory:');const sends:{body:PayOrderRequestInput;key:string|undefined}[]=[];let losing=true;
  const client={orders:{get:async()=>order(),pay:async(request:{body:PayOrderRequestInput},options:RequestOptions<'checkout'>)=>{
    sends.push({body:structuredClone(request.body),key:options.idempotencyKey});
    if(losing)throw new SdkError('transport','local lost response','unknown',true);
    return {order:{...order('0'),payment_status:'paid'},payment_attempt:attempt('succeeded')};
  }}} as unknown as Client;
  try{
    const row=record(store);const engine=new PaymentEngine(client,createAuth('local-fixture'),store);
    await paymentRetries(t,engine.start(row.checkout_ref,{...input(),credential:{kind:'payment_method_token',value:'pm_original'}}));
    losing=false;await engine.start(row.checkout_ref,{...input('1900'),credential:{kind:'payment_method_token',value:'pm_new'}});
    assert.equal(sends.length,5);assert.ok(sends.every(send=>send.key===sends[0]!.key));assert.ok(sends.every(send=>JSON.stringify(send.body)===JSON.stringify(sends[0]!.body)));
    assert.equal(store.all('SELECT * FROM actions').length,1);
  }finally{store.close();}
});
for(const kind of ['resume','cancel'] as const)test(`unknown ${kind} remains recoverable while its known attempt is non-resumable`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const store=new Store(':memory:');let losing=true;const keys:(string|undefined)[]=[];
  const current={...order(),active_payment_attempt:attempt('processing',false,'prior-attempt')};
  const send=async(options:RequestOptions<'checkout'>)=>{keys.push(options.idempotencyKey);if(losing)throw new SdkError('transport','local lost response','unknown',true);return {order:current,payment_attempt:current.active_payment_attempt};};
  const client={orders:{get:async()=>current,pay:async(request:{body:PayOrderRequestInput},options:RequestOptions<'checkout'>)=>{assert.deepEqual(request.body,{action:'resume',order_payment_attempt_id:'prior-attempt'});return send(options);},cancelPaymentAttempt:async(orderId:string,attemptId:string,body:unknown,options:RequestOptions<'checkout'>)=>{assert.equal(orderId,'example-order');assert.equal(attemptId,'prior-attempt');assert.deepEqual(body,{cancellation_reason:'abandoned'});return send(options);}}} as unknown as Client;
  try{
    const row=record(store);const engine=new PaymentEngine(client,createAuth('local-fixture'),store);
    const job=engine.job(row,kind,kind==='resume'?{action:'resume',order_payment_attempt_id:'prior-attempt'}:{cancellation_reason:'abandoned'});
    const first=await paymentRetries(t,engine.execute(row,job,()=>{}));assert.equal(engine.next(first),'resume');assert.equal(engine.next(await engine.status(row.checkout_ref)),'resume');
    losing=false;assert.equal(engine.next(await engine.resume(row.checkout_ref)),'wait');assert.equal(keys.length,5);assert.ok(keys.every(key=>key===job.idempotency_key));
  }finally{store.close();}
});
test('a known non-resumable active attempt clears the pay journal and stays read-only waiting',async()=>{
  const store=new Store(':memory:');let mutations=0;const current={...order(),active_payment_attempt:attempt('processing')};
  const client={orders:{get:async()=>current,pay:async()=>{mutations++;throw new Error('a status read must not send a payment');}}} as unknown as Client;
  try{
    const row=record(store);const engine=new PaymentEngine(client,createAuth('local-fixture'),store);engine.job(row,'pay',{action:'pay',payment_source:{token:'pm_original'}});
    const result=await engine.status(row.checkout_ref);assert.equal(result.unknown,false);assert.equal(engine.next(result),'wait');assert.equal(engine.unresolved(row),undefined);assert.equal(mutations,0);
  }finally{store.close();}
});
