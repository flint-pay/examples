import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Client,Order,OrderPaymentAttempt,RequestOptions,PayOrderRequestInput} from '@flintpay/node';
import {Store} from '../../src/store/db.ts';
import type {CheckoutRecord} from '../../src/store/db.ts';
import {PaymentEngine} from '../../src/payments/engine.ts';
import {createAuth} from '../../src/flint/auth.ts';
import {nextStep} from '../../src/payments/next-step.ts';
import {LocalError} from '../../src/flint/errors.ts';
function checkout(store:Store):CheckoutRecord{
  store.run('INSERT INTO payment_checkouts(checkout_ref,user_id,sandbox_id,resource_type,resource_id,order_id,checkout_session_id,checkout_auth_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)','checkout_example','user_example','sandbox_example','invoice','inv_example','ord_example','session_example','example checkout authority',Date.now(),Date.now());
  return store.checkout('user_example','sandbox_example','invoice','inv_example')!;
}
const money={amount:'1000',currency:'USD'};
const order=():Order=>({order_id:'ord_example',payment_status:'unpaid',status:'open',line_items:[],buyer_actions:[],pricing_amounts:{total_money:money},settlement_amounts:{outstanding_money:money},tax:{}} as unknown as Order);
const attempt=(status='processing',resumable=false):OrderPaymentAttempt=>({order_payment_attempt_id:'attempt_example',expected_outstanding_money:money,status,is_resumable:resumable,mode:'payment'});
const input={credential:{kind:'confirmation_token' as const,value:'ctoken_PLACEHOLDER'},approved_outstanding_money:money};
test('concurrent duplicate pay clicks perform one charge and reuse authoritative state',async()=>{
  const store=new Store(':memory:');try{
    const record=checkout(store);let current=order(),charges=0;
    const client={orders:{get:async()=>current,pay:async(request:{order_id:string;body:PayOrderRequestInput},options:RequestOptions)=>{
      assert.equal(options.apiKey,undefined);assert.equal(options.customerToken,undefined);assert.equal(options.authMode,'checkout');assert.equal(request.order_id,'ord_example');assert.ok(options.idempotencyKey);
      charges++;await new Promise(resolve=>setTimeout(resolve,30));current={...current,active_payment_attempt:attempt()};return {order:current,payment_attempt:current.active_payment_attempt};}},checkoutSessions:{get:async()=>({status:'open'})}} as unknown as Client;
    const engine=new PaymentEngine(client,createAuth('flint_test_PLACEHOLDER'),store,async()=>{});
    const result=await Promise.all([engine.start(record.checkout_ref,input),engine.start(record.checkout_ref,input)]);assert.equal(charges,1);assert.equal(result[1]?.attempt?.order_payment_attempt_id,'attempt_example');
  }finally{store.close();}
});
test('unknown charge without evidence blocks every new credential and keeps the same body and key',async()=>{
  const store=new Store(':memory:');try{
    const record=checkout(store),keys:string[]=[],bodies:string[]=[];let calls=0;
    const client={orders:{get:async()=>order(),pay:async(request:unknown,options:RequestOptions)=>{calls++;keys.push(options.idempotencyKey!);bodies.push(JSON.stringify(request));throw new Error('local transport interrupted');}},checkoutSessions:{get:async()=>({status:'open'})}} as unknown as Client;
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
    const client={orders:{get:async()=>current,pay:async(request:{body:PayOrderRequestInput})=>{assert.deepEqual(request.body,{action:'resume',order_payment_attempt_id:'attempt_example'});calls++;current={...current,active_payment_attempt:attempt('processing',false)};return {order:current,payment_attempt:current.active_payment_attempt};}}} as unknown as Client;
    const engine=new PaymentEngine(client,createAuth('flint_test_PLACEHOLDER'),store,async()=>{});await engine.resume(record.checkout_ref);await engine.resume(record.checkout_ref);assert.equal(calls,1);
  }finally{store.close();}
});
test('a declined leg is explicitly selected using a new key after its known rejection',async()=>{
  const store=new Store(':memory:');try{
    const record=checkout(store);let calls=0;const keys:string[]=[];const current={...order(),payment_collection:{stripe:{elements:{mode:'payment',next_step:'create_confirmation_token',payment_method_creation:'manual',payment_method_types:['card'],selectable_payment_intents:[{payment_intent_id:'intent_example'}]}}}} as Order;
    const client={orders:{get:async()=>current,pay:async(request:{body:PayOrderRequestInput},options:RequestOptions)=>{calls++;keys.push(options.idempotencyKey!);if(calls===1)throw new LocalError('PAYMENT_LEG_SELECTION_REQUIRED',409);assert.equal(request.body.action,'confirm_payment_intents');assert.equal('payment_source'in request.body,false);return {order:current,payment_attempt:attempt('succeeded')};}},checkoutSessions:{get:async()=>({status:'open'})}} as unknown as Client;
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
    const client={orders:{get:async()=>order(),pay:async(request:unknown,options:RequestOptions)=>{keys.push(options.idempotencyKey!);bodies.push(JSON.stringify(request));throw new Error('local transport interrupted');}},checkoutSessions:{get:async()=>({status:'open'})}} as unknown as Client;
    let engine=new PaymentEngine(client,createAuth('flint_test_PLACEHOLDER'),store,async()=>{});assert.equal((await engine.start(record.checkout_ref,input)).unknown,true);
    store.close();store=new Store(path);engine=new PaymentEngine(client,createAuth('flint_test_PLACEHOLDER'),store,async()=>{});
    assert.equal((await engine.start(record.checkout_ref,{...input,credential:{kind:'confirmation_token',value:'ctoken_DIFFERENT_PLACEHOLDER'}})).unknown,true);assert.equal(new Set(keys).size,1);assert.equal(new Set(bodies).size,1);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('an uncertain job waits briefly, then offers resume to replay the persisted request without a new charge',async()=>{
  const store=new Store(':memory:');try{
    const record=checkout(store);let calls=0;
    const client={orders:{get:async()=>order(),pay:async()=>{calls++;throw new Error('local transport interrupted');}},checkoutSessions:{get:async()=>({status:'open',recovery_mode:false})}} as unknown as Client;
    const engine=new PaymentEngine(client,createAuth('flint_test_PLACEHOLDER'),store,async()=>{}),result=await engine.start(record.checkout_ref,input);
    assert.equal((await engine.view(record,result)).next,'wait');store.run('UPDATE actions SET retry_after=0 WHERE resource=?',engine.resource(record));
    assert.equal((await engine.view(record,result)).next,'resume');const key=engine.unresolved(record)!.idempotency_key;await engine.resume(record.checkout_ref);assert.equal(engine.unresolved(record)!.idempotency_key,key);assert.equal(calls,8);
  }finally{store.close();}
});
test('explicit resume nonces replay a logical step and a later step gets a fresh key',async()=>{
  const store=new Store(':memory:');try{
    const record=checkout(store),current={...order(),active_payment_attempt:attempt('requires_retry',true)},keys:string[]=[];
    const client={orders:{get:async()=>current,pay:async(_request:unknown,options:RequestOptions)=>{keys.push(options.idempotencyKey!);return {order:current,payment_attempt:current.active_payment_attempt};}}} as unknown as Client;
    const engine=new PaymentEngine(client,createAuth('flint_test_PLACEHOLDER'),store,async()=>{});await engine.resume(record.checkout_ref,'example-step');await engine.resume(record.checkout_ref,'example-step');await engine.resume(record.checkout_ref,'example-next-step');assert.equal(keys.length,2);assert.notEqual(keys[0],keys[1]);
  }finally{store.close();}
});
