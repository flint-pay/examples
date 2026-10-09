import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeCheckoutBuyerContactRequest,SdkError} from '@flintpay/node';
import type {Client,Order,CheckoutSession} from '@flintpay/node';
import {createApp} from '../../src/app.ts';
import type {Config} from '../../src/config.ts';
import {Store} from '../../src/store/db.ts';
import {IdentityStore} from '../../src/identity/index.ts';
import {createContactEdits,createUiJobQueue} from '../../public/js/checkout-logic.js';

type Contact={email?:string|null;phone?:string|null};
const origin='http://localhost:4100';
function fixture(){
  const money={amount:'2400',currency:'USD'};
  const remote={contact:{} as Contact,patches:[] as Contact[],quotes:0,error:undefined as SdkError|undefined};
  const order={order_id:'fixture-order',status:'open',payment_status:'unpaid',order_revision:'1',settlement_amounts:{outstanding_money:money},payment_collection:{stripe:{}}} as unknown as Order;
  const session={checkout_session_id:'fixture-session',status:'open',customer_collection:{require_email:true}} as unknown as CheckoutSession;
  const client={
    orders:{get:async()=>order},
    checkoutSessions:{
      get:async()=>session,getCurrentDeliverySelection:async()=>({}),
      update:async(_id:string,input:{buyer_contact:Contact})=>{
        makeCheckoutBuyerContactRequest(input.buyer_contact);
        if(remote.error)throw remote.error;
        remote.patches.push(input.buyer_contact);Object.assign(remote.contact,input.buyer_contact);return session;
      },
      createDeliveryQuote:async()=>{remote.quotes++;return {delivery_quote_id:'fixture-quote',expires_at:new Date(Date.now()+60_000).toISOString(),choice_groups:[]};},
    },
  } as unknown as Client;
  const config:Config={apiKey:'local-contact-fixture',apiBaseUrl:'https://api.staging.withflintpay.com',giftChallengeOrigin:'https://checkout.staging.withflintpay.com',appOrigin:origin,port:4100,identityDatabasePath:':memory:',appDatabasePath:':memory:',cookieName:'contact_session',checkoutTtl:3600,storeName:'Example store'};
  const runtime=createApp({config,client,preflight:{sandboxId:'fixture-sandbox',cards:'enabled'},store:new Store(':memory:'),identity:new IdentityStore(':memory:')});
  const owner=runtime.identity.createSession();const now=Date.now();
  runtime.store.run('INSERT INTO checkouts(checkout_ref,session_hash,kind,order_id,checkout_session_id,checkout_auth_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)','chk_fixture',owner.session.session_hash,'order',order.order_id,session.checkout_session_id,'local-checkout-fixture',now,now);
  const post=(path:string,input:unknown)=>runtime.app.request(origin+'/checkout/chk_fixture'+path,{method:'POST',headers:{Cookie:`contact_session=${owner.token}`,Origin:origin,'X-CSRF-Token':owner.session.csrf_token,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(input)});
  const quote=()=>post('/delivery/quote',{destination_address:{line1:'1 Example Street',city:'Austin',state:'TX',postal_code:'78701',country:'US'}});
  const details=()=>runtime.checkouts.details(runtime.checkouts.record('chk_fixture'));
  return {...runtime,remote,post,quote,details,close:()=>{runtime.store.close();runtime.identity.close();}};
}

test('name-only contact saves stay local and allow a later email and delivery quote',async()=>{
  const app=fixture();try{
    const response=await app.post('/contact',{name:'Example buyer'});
    assert.equal(response.status,200);assert.equal((await response.json()).state.contact_name,'Example buyer');
    assert.deepEqual(app.remote.patches,[]);assert.equal(app.details().name,'Example buyer');
    assert.equal((await app.post('/contact',{email:'buyer@example.test'})).status,200);
    assert.deepEqual(app.remote.patches,[{email:'buyer@example.test'}]);assert.equal(app.details().name,'Example buyer');
    assert.equal((await app.quote()).status,200);assert.equal(app.remote.quotes,1);
  }finally{app.close();}
});

test('partial contact patches preserve omitted fields and forward explicit null clears',async()=>{
  const app=fixture();try{
    assert.equal((await app.post('/contact',{email:'buyer@example.test',phone:'+15555550123'})).status,200);
    assert.equal((await app.post('/contact',{email:null})).status,200);
    assert.deepEqual(app.remote.contact,{email:null,phone:'+15555550123'});
    assert.equal((await app.post('/contact',{phone:null})).status,200);
    assert.deepEqual(app.remote.patches,[{email:'buyer@example.test',phone:'+15555550123'},{email:null},{phone:null}]);
    assert.deepEqual(app.details().contact,{email:null,phone:null});
  }finally{app.close();}
});

test('SDK validation rejected before dispatch returns 400 and permits a changed contact and delivery',async()=>{
  const app=fixture();try{
    app.remote.error=new SdkError('validation','fixture validation','not_sent');
    const rejected=await app.post('/contact',{email:'buyer@example.test'});
    assert.equal(rejected.status,400);assert.equal((await rejected.json()).error.kind,'validation');
    assert.equal(app.store.get<{status:string}>("SELECT status FROM actions WHERE kind='contact'")?.status,'rejected');
    app.remote.error=undefined;
    assert.equal((await app.post('/contact',{email:'another@example.test'})).status,200);
    assert.equal((await app.quote()).status,200);assert.equal(app.remote.quotes,1);
    assert.equal(app.store.all("SELECT * FROM actions WHERE status IN ('pending','unknown')").length,0);
  }finally{app.close();}
});

for(const [label,error] of [
  ['unknown transport',new SdkError('transport','fixture lost response','unknown',true)],
  ['server response',new SdkError('server','fixture unavailable','response',true,{status:503,headers:{},attempts:1,durationMs:1})],
] as const)test(`${label} keeps the contact reconciliation guard`,async()=>{
  const app=fixture();try{
    app.remote.error=error;assert.equal((await app.post('/contact',{email:'buyer@example.test'})).status,503);
    assert.equal(app.store.get<{status:string}>("SELECT status FROM actions WHERE kind='contact'")?.status,'unknown');
    assert.equal((await app.quote()).status,409);assert.equal(app.remote.quotes,0);
  }finally{app.close();}
});

const turn=()=>new Promise(resolve=>setImmediate(resolve));
function gate(){let open!:()=>void;const opened=new Promise<void>(resolve=>{open=resolve;});return {opened,open};}

test('checkout jobs reach the app one at a time in order, and a failed job does not stall the next',{timeout:2000},async()=>{
  const jobs=createUiJobQueue();const log:string[]=[];let active=0,peak=0;
  const job=(name:string,fail=false)=>async()=>{active++;peak=Math.max(peak,active);log.push(`start ${name}`);await turn();log.push(`end ${name}`);active--;if(fail)throw new Error(name);return name;};
  const results=await Promise.allSettled([jobs.run(job('timezone')),jobs.run(job('contact',true)),jobs.run(job('delivery-quote')),jobs.run(job('pay'))]);
  assert.equal(peak,1);
  assert.deepEqual(log,['start timezone','end timezone','start contact','end contact','start delivery-quote','end delivery-quote','start pay','end pay']);
  assert.deepEqual(results.map(result=>result.status),['fulfilled','rejected','fulfilled','fulfilled']);
  assert.equal(await jobs.run(async()=>'after failure'),'after failure');
});

test('overlapping contact blurs send one follow-up with the newest edit and never acknowledge it early',{timeout:2000},async()=>{
  const jobs=createUiJobQueue(),edits=createContactEdits(),fields={name:'',email:''},sent:{name:string;email:string}[]=[],server=[gate(),gate()];
  // Mirrors saveContact in public/js/checkout.js: the form is read when the job starts, and only that revision is acknowledged.
  const save=()=>jobs.coalesce('contact',async()=>{if(!edits.dirty)return;const body={...fields},revision=edits.snapshot();sent.push(body);await server[sent.length-1]!.opened;edits.acknowledge(revision);});
  fields.name='Example buyer';edits.mark();const first=save();await turn();
  assert.equal(sent.length,1);
  fields.email='first@example.test';edits.mark();fields.email='buyer@example.test';edits.mark();
  const blurEmail=save(),blurPhone=save(),beforePay=save();
  assert.equal(blurEmail,blurPhone);assert.equal(blurPhone,beforePay);assert.notEqual(first,blurEmail);
  server[0]!.open();await first;
  assert.equal(edits.dirty,true,'the first response must not acknowledge the email typed while it was in flight');
  await turn();assert.equal(sent.length,2);
  fields.name='Example buyer two';edits.mark();const queuedBehind=save();
  server[1]!.open();await beforePay;
  assert.deepEqual(sent,[{name:'Example buyer',email:''},{name:'Example buyer',email:'buyer@example.test'}]);
  assert.equal(edits.dirty,true);
  server.push(gate());server[2]!.open();await queuedBehind;
  assert.deepEqual(sent[2],{name:'Example buyer two',email:'buyer@example.test'});assert.equal(edits.dirty,false);
  await save();assert.equal(sent.length,3,'a blur with nothing new sends nothing');
});

test('a job may queue optional verification without waiting for it, and that job sees edits made meanwhile',{timeout:2000},async()=>{
  const jobs=createUiJobQueue(),log:string[]=[];let email='first@example.test';
  const contact=jobs.run(async()=>{
    log.push(`contact ${email}`);const saved=email;await turn();
    // Awaiting this here would deadlock: it can only start after the contact job ends.
    void jobs.run(async()=>{log.push(email===saved?`verify ${saved}`:`drop stale ${saved}`);});
  });
  const quote=jobs.run(async()=>{log.push('delivery-quote');email='buyer@example.test';});
  await contact;await quote;await jobs.run(async()=>{});
  assert.deepEqual(log,['contact first@example.test','delivery-quote','drop stale first@example.test']);
});
