import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client,SdkError} from '@flintpay/node';
import type {Order,CheckoutSession,RequestOptions} from '@flintpay/node';
import {createApp} from '../../src/app.ts';
import type {Config} from '../../src/config.ts';
import {Store} from '../../src/store/db.ts';
import type {ActionRecord} from '../../src/store/db.ts';
import {IdentityStore} from '../../src/identity/index.ts';

const origin='http://localhost:4100';
const address={line1:'1 Example Street',city:'Austin',state:'TX',postal_code:'78701',country:'US' as const};
const taxRequest={tax:{enabled:true,location:{address_source:'provided',address_type:'billing_address',address}}};
function fixture(kind:'order'|'subscription'='order'){
  const money={amount:'2400',currency:'USD'};
  const order={order_id:'fixture-order',status:'open',payment_status:'unpaid',order_revision:'1',settlement_amounts:{outstanding_money:money},tax:{enabled:true,status:'requires_location',available_location_inputs:['provided']},payment_collection:{stripe:{}}} as unknown as Order;
  const session={checkout_session_id:'fixture-session',order_id:order.order_id,status:'open',customer_collection:{require_email:true},delivery_selection_required:false} as CheckoutSession;
  const remote={updates:[] as {body:unknown;key:string|undefined;authMode:unknown}[],error:undefined as SdkError|undefined,selection:undefined as unknown,order,session};
  const client={
    orders:{get:async()=>order,update:async(_id:string,body:unknown,options:RequestOptions<'checkout'>)=>{
      remote.updates.push({body:structuredClone(body),key:options.idempotencyKey,authMode:options.authMode});
      if(remote.error)throw remote.error;
      return order;
    }},
    checkoutSessions:{get:async()=>session,getCurrentDeliverySelection:async()=>({delivery_selection:remote.selection})},
  } as unknown as Client;
  const config:Config={apiKey:'local-billing-fixture',apiBaseUrl:'https://api.staging.withflintpay.com',giftChallengeOrigin:'https://checkout.staging.withflintpay.com',appOrigin:origin,port:4100,identityDatabasePath:':memory:',appDatabasePath:':memory:',cookieName:'billing_session',checkoutTtl:3600,storeName:'Example store'};
  const runtime=createApp({config,client,preflight:{sandboxId:'fixture-sandbox',cards:'enabled'},store:new Store(':memory:'),identity:new IdentityStore(':memory:')});
  const owner=runtime.identity.createSession();const now=Date.now();
  runtime.store.run('INSERT INTO checkouts(checkout_ref,session_hash,kind,order_id,checkout_session_id,checkout_auth_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)','chk_fixture',owner.session.session_hash,kind,order.order_id,session.checkout_session_id,'local-checkout-fixture',now,now);
  const post=(input:unknown)=>runtime.app.request(origin+'/checkout/chk_fixture/billing-address',{method:'POST',headers:{Cookie:`billing_session=${owner.token}`,Origin:origin,'X-CSRF-Token':owner.session.csrf_token,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(input)});
  const details=()=>runtime.checkouts.details(runtime.checkouts.record('chk_fixture'));
  return {...runtime,remote,post,details,close:()=>{runtime.store.close();runtime.identity.close();}};
}

for(const kind of ['order','subscription'] as const)test(`a no-delivery ${kind} saves only a provided billing tax address and projects prefill`,async()=>{
  const app=fixture(kind);try{
    const initial=app.checkouts.project(await app.checkouts.read('chk_fixture'));assert.equal(initial.billing_address,null);
    const response=await app.post({...address,line1:'  '+address.line1+'  ',line2:'  '});assert.equal(response.status,200);
    assert.deepEqual(app.remote.updates[0]?.body,taxRequest);assert.equal(app.remote.updates[0]?.authMode,'checkout');assert.ok(app.remote.updates[0]?.key);
    assert.deepEqual(app.details().billing_address,address);assert.deepEqual((await response.json()).state.billing_address,address);
  }finally{app.close();}
});

test('billing tax input rejects incomplete, oversized, foreign and malformed postal addresses without dispatch',async()=>{
  const app=fixture();try{
    for(const input of [{...address,line1:''},{...address,city:' '},{...address,state:''},{...address,state:'Texas'},{...address,postal_code:'7870'},{...address,postal_code:'78701-'},{...address,country:'CA'},{...address,line1:'x'.repeat(201)},{...address,line2:null}]){
      const response=await app.post(input);assert.equal(response.status,400);assert.equal((await response.json()).error.code,'INVALID_INPUT');
    }
    assert.equal(app.remote.updates.length,0);assert.equal(app.details().billing_address,undefined);
    assert.equal((await app.post({...address,line2:' Suite 2 ',postal_code:'78701-1234'})).status,200);
    assert.deepEqual(app.details().billing_address,{...address,line2:'Suite 2',postal_code:'78701-1234'});
  }finally{app.close();}
});

for(const guard of ['delivery_required','delivery_quote','delivery_selection','tax_disabled'] as const)test(`billing tax input refuses ${guard} on the server`,async()=>{
  const app=fixture();try{
    if(guard==='delivery_required')app.remote.session.delivery_selection_required=true;
    if(guard==='tax_disabled')app.remote.order.tax!.enabled=false;
    const record=app.checkouts.record('chk_fixture'),details=app.details();
    if(guard==='delivery_quote')details.delivery_quote={delivery_quote_id:'quote_fixture',choice_groups:[],expires_at:new Date(Date.now()+60_000).toISOString(),input_requirements:[],status:'active'};
    if(guard==='delivery_selection'){details.delivery_selection={delivery_selection_id:'selection_fixture'};app.remote.selection=details.delivery_selection;}
    app.checkouts.saveDetails(record,details);
    const response=await app.post(address);assert.equal(response.status,400);assert.equal((await response.json()).error.code,'INVALID_INPUT');
    assert.equal(app.remote.updates.length,0);assert.equal(app.details().billing_address,undefined);
  }finally{app.close();}
});

for(const guard of ['unknown_payment','active_attempt'] as const)test(`billing tax input keeps the existing ${guard} mutation fence`,async()=>{
  const app=fixture();try{
    if(guard==='unknown_payment')app.payments.job(app.checkouts.record('chk_fixture'),'pay',{action:'pay',payment_source:{token:'pm_fixture'}});
    else app.remote.order.active_payment_attempt={order_payment_attempt_id:'attempt_fixture',status:'processing',is_resumable:false} as Order['active_payment_attempt'];
    const response=await app.post(address);assert.equal(response.status,409);assert.equal((await response.json()).error.code,guard==='unknown_payment'?'CHECKOUT_PAYMENT_RESOLVING':'PAYMENT_ATTEMPT_IN_PROGRESS');
    assert.equal(app.remote.updates.length,0);assert.equal(app.details().billing_address,undefined);
  }finally{app.close();}
});

test('unknown billing tax mutation replays the exact request and key and saves prefill only after success',async()=>{
  const app=fixture();try{
    const previous={...address,line1:'Previous address'};app.checkouts.saveDetails(app.checkouts.record('chk_fixture'),{billing_address:previous});
    app.remote.error=new SdkError('transport','fixture lost response','unknown',true);
    assert.equal((await app.post(address)).status,503);assert.deepEqual(app.details().billing_address,previous);
    const pending=app.store.get<ActionRecord>("SELECT * FROM actions WHERE kind='tax_location'")!;assert.equal(pending.status,'unknown');
    const changed=await app.post({...address,line1:'Different address'});assert.equal(changed.status,409);assert.equal((await changed.json()).error.code,'ACTION_RECONCILIATION_REQUIRED');assert.equal(app.remote.updates.length,1);
    app.remote.error=undefined;const recovered=await app.post({...address,line2:''});assert.equal(recovered.status,200);
    assert.deepEqual(app.remote.updates[1],app.remote.updates[0]);assert.deepEqual(app.details().billing_address,address);
    assert.equal(app.store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',pending.action_id)?.status,'succeeded');
    assert.equal(app.store.all("SELECT * FROM actions WHERE kind='tax_location'").length,1);
  }finally{app.close();}
});

test('an authoritative tax validation rejection preserves the prior prefill and surfaces the existing error',async()=>{
  const app=fixture();try{
    app.remote.error=new SdkError('validation','fixture invalid address','response',false,{status:400,headers:{},attempts:1,durationMs:1},'ORDER_TAX_LOCATION_INVALID');
    const response=await app.post(address);assert.equal(response.status,400);assert.equal((await response.json()).error.code,'ORDER_TAX_LOCATION_INVALID');
    assert.equal(app.details().billing_address,undefined);assert.equal(app.remote.updates.length,1);
    assert.equal(app.store.get<ActionRecord>("SELECT * FROM actions WHERE kind='tax_location'")?.status,'rejected');
  }finally{app.close();}
});

test('the installed SDK serializes the existing sparse tax update and checkout idempotency headers',async()=>{
  let request:Request|undefined;
  const client=new Client({baseUrl:'https://sdk.example.invalid',maxAttempts:1,transport:async(input,init)=>{
    request=new Request(input,init);
    return new Response(JSON.stringify({error:{type:'validation_error',code:'ORDER_TAX_LOCATION_INVALID',message:'fixture rejection'}}),{status:400,headers:{'Content-Type':'application/json'}});
  }});
  await assert.rejects(()=>client.orders.update('fixture-order',{tax:{enabled:true,location:{address_source:'provided',address_type:'billing_address',address}}},{authMode:'checkout',credentials:{CheckoutSessionIDHeader:'fixture-session',CheckoutSessionSecretHeader:'local-fixture'},idempotencyKey:'billing-fixture-key'}),{code:'ORDER_TAX_LOCATION_INVALID'});
  assert.ok(request);assert.equal(request.method,'PATCH');assert.equal(new URL(request.url).pathname,'/v1/orders/fixture-order');
  assert.deepEqual(await request.json(),taxRequest);assert.equal(request.headers.get('Idempotency-Key'),'billing-fixture-key');assert.equal(request.headers.get('X-Checkout-Session-ID'),'fixture-session');assert.equal(request.headers.get('X-Checkout-Session-Secret'),'local-fixture');
});
