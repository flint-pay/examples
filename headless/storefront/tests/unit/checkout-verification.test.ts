import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Client,SdkError} from '@flintpay/node';
import type {Order} from '@flintpay/node';
import {Checkouts} from '../../src/flint/checkouts.ts';
import type {MutationContext} from '../../src/flint/checkouts.ts';
import {createAuth} from '../../src/flint/auth.ts';
import {PaymentEngine} from '../../src/payments/engine.ts';
import {Store} from '../../src/store/db.ts';
import type {ActionRecord,CheckoutRecord} from '../../src/store/db.ts';

function fixture(){
  const store=new Store(':memory:');
  const order={order_id:'ord_fixture',order_revision:'3'} as Order;
  const verification={customer_verification_id:'verification_fixture',status:'code_sent',purpose:'confirm_saved_payment_method',channel:'sms'};
  store.run('INSERT INTO checkouts(checkout_ref,session_hash,kind,order_id,checkout_session_id,checkout_auth_token,details,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)','chk_fixture','session_fixture','order',order.order_id,'checkout_fixture','local-fixture',JSON.stringify({verification}),Date.now(),Date.now());
  const payments=Object.assign(Object.create(PaymentEngine.prototype) as PaymentEngine,{store,read:async()=>order});
  const checkouts=Object.assign(Object.create(Checkouts.prototype) as Checkouts,{store,payments});
  const mutate=<T>(code:string,call:(record:CheckoutRecord,key:string,context:MutationContext)=>Promise<T>,kind='checkout_verification_confirm')=>checkouts.mutate('chk_fixture',kind,{code_hash:createHash('sha256').update(code).digest('hex')},call);
  const actions=()=>store.all<ActionRecord>('SELECT * FROM actions ORDER BY rowid');
  const savedVerification=()=>checkouts.details(checkouts.record('chk_fixture')).verification;
  return {store,order,verification,mutate,actions,savedVerification,close:()=>store.close()};
}

test('wrong and unavailable SMS checks reject their attempts so a changed code can confirm under a fresh key',async()=>{
  const f=fixture();
  const client=new Client({baseUrl:'https://sdk.example.invalid',maxAttempts:1,transport:async(input,init)=>{
    const request=new Request(input,init),body=await request.json() as {code:string};
    const wrong=body.code==='000000';
    return new Response(JSON.stringify({error:{type:wrong?'validation_error':'server_error',code:wrong?'CUSTOMER_VERIFICATION_CODE_INVALID':'CUSTOMER_VERIFICATION_UNAVAILABLE',message:'Fixture verification response'}}),{status:wrong?400:503,headers:{'Content-Type':'application/json'}});
  }});
  const auth=createAuth('local-fixture'),calls:{code:string;key:string;verification_id:string|undefined}[]=[];
  const confirm=(code:string)=>f.mutate(code,async(record,key,context)=>{
    calls.push({code,key,verification_id:context.customer_verification_id});
    if(code==='123456')return 'confirmed';
    return client.checkoutSessions.confirmCustomerVerification(record.checkout_session_id!,context.customer_verification_id!,{code,...auth.checkoutHeaders(record)},auth.checkout(record,key));
  });
  try{
    await assert.rejects(()=>confirm('000000'),error=>error instanceof SdkError&&error.outcome==='response'&&error.status===400&&error.code==='CUSTOMER_VERIFICATION_CODE_INVALID');
    assert.equal(f.actions()[0]?.status,'rejected');assert.deepEqual(f.savedVerification(),f.verification);
    await assert.rejects(()=>confirm('999999'),error=>error instanceof SdkError&&error.kind==='server'&&error.outcome==='response'&&error.status===503&&error.code==='CUSTOMER_VERIFICATION_UNAVAILABLE');
    assert.equal(f.actions()[1]?.status,'rejected');assert.deepEqual(f.savedVerification(),f.verification);
    assert.equal(await confirm('123456'),'confirmed');
    assert.deepEqual(f.actions().map(action=>action.status),['rejected','rejected','succeeded']);
    assert.equal(new Set(calls.map(call=>call.key)).size,3);
    assert.deepEqual(calls.map(call=>call.verification_id),Array(3).fill(f.verification.customer_verification_id));
  }finally{f.close();}
});

const response=(status:number,code:string,kind:SdkError['kind']='server',outcome:SdkError['outcome']='response')=>new SdkError(kind,'Fixture uncertain response',outcome,true,{status,headers:{},attempts:1,durationMs:1},code);
for(const [label,kind,error] of [
  ['another mutation with the named unavailable response','checkout_verification',response(503,'CUSTOMER_VERIFICATION_UNAVAILABLE')],
  ['an unrelated 503 response','checkout_verification_confirm',response(503,'SERVICE_UNAVAILABLE')],
  ['the named code with another 5xx status','checkout_verification_confirm',response(500,'CUSTOMER_VERIFICATION_UNAVAILABLE')],
  ['an unknown outcome with the named unavailable code','checkout_verification_confirm',response(503,'CUSTOMER_VERIFICATION_UNAVAILABLE','server','unknown')],
  ['a transport failure','checkout_verification_confirm',new SdkError('transport','Fixture lost response','unknown',true)],
  ['a protocol failure with response metadata','checkout_verification_confirm',response(503,'CUSTOMER_VERIFICATION_UNAVAILABLE','protocol')],
  ['an idempotency operation still in progress','checkout_verification_confirm',response(409,'IDEMPOTENCY_KEY_IN_PROGRESS','conflict')],
] as const)test(`${label} keeps changed input fenced and replays the original key and context`,async()=>{
  const f=fixture(),calls:{key:string;context:MutationContext}[]=[];let fail=true;
  const call=async(_record:CheckoutRecord,key:string,context:MutationContext)=>{calls.push({key,context:JSON.parse(JSON.stringify(context)) as MutationContext});if(fail)throw error;return 'confirmed';};
  try{
    await assert.rejects(()=>f.mutate('999999',call,kind),caught=>caught===error);
    const pending=f.actions()[0]!;assert.equal(pending.status,'unknown');assert.deepEqual(f.savedVerification(),f.verification);
    await assert.rejects(()=>f.mutate('123456',call,kind),{code:'ACTION_RECONCILIATION_REQUIRED'});assert.equal(calls.length,1);
    f.order.order_revision='4';fail=false;
    assert.equal(await f.mutate('999999',call,kind),'confirmed');assert.deepEqual(calls[1],calls[0]);
    assert.equal(f.actions().length,1);assert.equal(f.actions()[0]?.status,'succeeded');assert.equal(f.actions()[0]?.idempotency_key,pending.idempotency_key);
  }finally{f.close();}
});
