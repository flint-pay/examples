import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {Client,CheckoutSession,Order,RequestOptions} from '@flintpay/node';
import {SdkError} from '@flintpay/node';
import {Checkouts} from '../../src/flint/checkouts.ts';
import {createAuth} from '../../src/flint/auth.ts';
import {readConfig} from '../../src/config.ts';
import {Store} from '../../src/store/db.ts';
import type {ActionRecord} from '../../src/store/db.ts';
import {Carts} from '../../src/store/cart.ts';
import type {Catalog} from '../../src/flint/catalog.ts';
import {IdentityStore} from '../../src/identity/index.ts';
import {PaymentEngine} from '../../src/payments/engine.ts';

function conflict(code:string){return new SdkError('conflict','Fixture lifecycle conflict','response',false,{status:409,headers:{},attempts:1,durationMs:1},code);}
function restricted(){return new SdkError('authentication','Fixture recovery restriction','response',false,{status:403,headers:{},attempts:1,durationMs:1},'CHECKOUT_RECOVERY_RESTRICTED');}
function fixture(){
  const store=new Store(':memory:'),identity=new IdentityStore(':memory:');
  const config=readConfig({FLINT_API_KEY:'flint_test_FIXTURE',FLINT_API_BASE_URL:'https://api.staging.withflintpay.com',APP_ORIGIN:'http://localhost:4100',PORT:'4100'});
  const money={amount:'1000',currency:'USD'};
  const order={order_id:'ord_fixture',status:'open',payment_status:'unpaid',order_revision:'1',line_items:[{order_line_item_id:'line_initial',variant_id:'variant_initial',quantity:'1'}],settlement_amounts:{outstanding_money:money,paid_money:{amount:'0',currency:'USD'}}} as unknown as Order;
  let session={checkout_session_id:'cs_initial',order_id:order.order_id,status:'open',page_origin:config.appOrigin} as CheckoutSession;
  const launches:{body:Record<string,unknown>;key:string|undefined}[]=[],reads:string[]=[],blocked:string[]=[],updates:{id:string;body:Record<string,unknown>;key:string|undefined;authMode:string|undefined}[]=[];
  let failUpdate:Error|undefined;
  const client={
    orders:{get:async()=>order,addLineItems:async(_id:string,body:{line_items:{variant_id:string;quantity:string}[]})=>{
      order.line_items.push(...body.line_items.map(line=>({order_line_item_id:'line_added',...line}) as Order['line_items'][number]));
      order.order_revision='2';session={...session,status:'invalidated',terminal_reason:'order_mutated'};return order;
    }},
    checkoutSessions:{get:async(_id:string,_params:unknown,options:RequestOptions)=>{
      reads.push(options.authMode??'merchant');
      if(options.authMode==='checkout'&&session.status!=='open')throw conflict('CHECKOUT_SESSION_NOT_OPEN');
      return session;
    },update:async(id:string,body:{buyer_contact:{email?:string|null;phone?:string|null}},options:RequestOptions)=>{
      if(session.recovery_mode){blocked.push('update');throw restricted();}
      updates.push({id,body,key:options.idempotencyKey,authMode:options.authMode});
      if(failUpdate){const error=failUpdate;failUpdate=undefined;throw error;}
      session={...session,buyer_contact:{...session.buyer_contact,...body.buyer_contact}} as CheckoutSession;return session;
    },getCurrentDeliverySelection:async()=>{if(session.recovery_mode){blocked.push('delivery_selection');throw restricted();}return {};},createDeliveryQuote:async()=>{blocked.push('delivery_quote');throw restricted();},create:async(body:Record<string,unknown>,options:RequestOptions)=>{
      launches.push({body,key:options.idempotencyKey});
      if(body.replace_checkout_session_id&&session.status!=='open')throw conflict('ORDER_COLLECTION_IN_PROGRESS');
      if(session.status==='open')assert.equal(body.replace_checkout_session_id,session.checkout_session_id);
      session={...session,checkout_session_id:'cs_fresh',status:'open',page_origin:body.page_origin as string};
      return {checkout_session:session,checkout_access:{checkout_auth_token:'fixture checkout credential'}};
    }},
  } as unknown as Client;
  const auth=createAuth(config.apiKey),carts=new Carts(store,{} as Catalog),cart=carts.current(identity.createSession().session);
  store.run('INSERT INTO cart_lines VALUES(?,?,?,?,?)','line_initial',cart.cart_id,'product_initial','variant_initial',1);
  store.run('INSERT INTO checkouts(checkout_ref,cart_id,session_hash,kind,order_id,checkout_session_id,checkout_auth_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)','chk_fixture',cart.cart_id,cart.session_hash,'order',order.order_id,session.checkout_session_id,'fixture checkout credential',Date.now(),Date.now());
  const app=new Checkouts(client,auth,store,identity,config,'sandbox_fixture',carts,new PaymentEngine(client,auth,store));
  const record=()=>app.record('chk_fixture');
  const endSession=(status:CheckoutSession['status']='invalidated')=>{session={...session,status};store.run('UPDATE checkouts SET needs_replacement=1 WHERE checkout_ref=?','chk_fixture');};
  const saveContact=(contact:unknown)=>{const details=app.details(record());details.contact=contact as typeof details.contact;details.delivery_quote={delivery_quote_id:'quote_old'} as typeof details.delivery_quote;app.saveDetails(record(),details);};
  // The backend keeps an expired session open in recovery mode while a 3DS attempt is active, and allows only reads there.
  const enterRecovery=()=>{session={...session,status:'open',recovery_mode:true} as CheckoutSession;order.active_payment_attempt={order_payment_attempt_id:'attempt_fixture',status:'requires_action',is_resumable:true,pending_actions:[]} as unknown as Order['active_payment_attempt'];};
  return {store,identity,app,cart,order,launches,reads,blocked,updates,enterRecovery,record,endSession,saveContact,failNextUpdate(error:Error){failUpdate=error;},client,close(){store.close();identity.close();}};
}
async function use(fn:(f:ReturnType<typeof fixture>)=>Promise<void>){const f=fixture();try{await fn(f);}finally{f.close();}}

test('cart edits create a fresh session after the merchant mutation invalidates checkout',async()=>use(async f=>{
  await f.app.editCart(f.cart,async()=>f.store.run('INSERT INTO cart_lines VALUES(?,?,?,?,?)','line_added',f.cart.cart_id,'product_added','variant_added',1));
  assert.equal(f.record().needs_replacement,1);assert.equal(f.order.line_items.length,2);
  const read=await f.app.read('chk_fixture');
  assert.equal(f.launches.length,1);assert.equal('replace_checkout_session_id'in f.launches[0]!.body,false);
  assert.ok(f.reads.includes('merchant'));assert.equal(read.record.checkout_session_id,'cs_fresh');
  assert.equal(read.record.needs_replacement,0);assert.equal(read.record.cart_dirty,0);assert.equal(read.order.line_items.length,2);
}));

test('a definitely rejected stale replacement gets a fresh creation key after verified invalidation',async()=>use(async f=>{
  f.endSession();await assert.rejects(()=>f.app.launch(f.record()),{code:'ORDER_COLLECTION_IN_PROGRESS'});
  const rejected=f.store.get<ActionRecord>("SELECT * FROM actions WHERE kind='session_create'")!;
  assert.equal(rejected.status,'rejected');
  await f.app.read('chk_fixture');
  assert.equal(f.launches.length,2);assert.notEqual(f.launches[1]!.key,rejected.idempotency_key);
  assert.equal('replace_checkout_session_id'in f.launches[1]!.body,false);
  assert.deepEqual(f.store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',rejected.action_id),rejected);
}));

test('a still-open checkout keeps exact current-session replacement',async()=>use(async f=>{
  f.store.run('UPDATE checkouts SET needs_replacement=1 WHERE checkout_ref=?','chk_fixture');
  const read=await f.app.read('chk_fixture');
  assert.equal(f.launches[0]!.body.replace_checkout_session_id,'cs_initial');assert.equal(read.record.checkout_session_id,'cs_fresh');
}));

for(const status of ['pending','unknown'])test(`a ${status} replacement replays its body and key after invalidation`,async()=>use(async f=>{
  f.endSession();await assert.rejects(()=>f.app.launch(f.record()),{code:'ORDER_COLLECTION_IN_PROGRESS'});
  const original=f.launches[0]!;f.store.run('UPDATE actions SET status=? WHERE idempotency_key=?',status,original.key!);
  await assert.rejects(()=>f.app.read('chk_fixture'),{code:'ORDER_COLLECTION_IN_PROGRESS'});
  assert.equal(f.launches.length,2);assert.deepEqual(f.launches[1],original);assert.equal(f.record().checkout_session_id,'cs_initial');
}));

for(const status of ['closed','expired'] as const)test(`a verified ${status} checkout starts a new session`,async()=>use(async f=>{
  f.endSession(status);await f.app.read('chk_fixture');
  assert.equal(f.launches.length,1);assert.equal('replace_checkout_session_id'in f.launches[0]!.body,false);
}));

test('an active payment attempt keeps an invalidated checkout from launching again',async()=>use(async f=>{
  f.endSession();f.order.active_payment_attempt={order_payment_attempt_id:'attempt_fixture',status:'processing',is_resumable:false} as Order['active_payment_attempt'];
  await f.app.read('chk_fixture');assert.equal(f.launches.length,0);assert.equal(f.record().checkout_session_id,'cs_initial');
}));

for(const status of ['pending','unknown'])test(`an unresolved ${status} payment keeps an invalidated checkout from launching again`,async()=>use(async f=>{
  f.endSession();f.store.run('INSERT INTO actions(action_id,resource,kind,idempotency_key,body,body_hash,status,created_at) VALUES(?,?,?,?,?,?,?,?)','pay_fixture','order:ord_fixture','pay','pay_fixture','{}','fixture',status,Date.now());
  await f.app.read('chk_fixture');assert.equal(f.launches.length,0);assert.equal(f.record().checkout_session_id,'cs_initial');
  assert.equal(f.store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?','pay_fixture')?.status,status);
}));

test('a failed authoritative session read cannot turn replacement into creation',async()=>use(async f=>{
  f.endSession();Object.assign(f.client.checkoutSessions,{get:async(_id:string,_params:unknown,options:RequestOptions)=>{
    if(options.authMode==='checkout')throw conflict('CHECKOUT_SESSION_NOT_OPEN');throw new Error('Fixture merchant read unavailable');
  }});
  await assert.rejects(()=>f.app.read('chk_fixture'),/Fixture merchant read unavailable/);assert.equal(f.launches.length,0);
}));

const lost=()=>new SdkError('transport','Fixture transport lost','unknown',true,{status:0,headers:{},attempts:1,durationMs:1});
const sessionContact=(read:{session:unknown})=>(read.session as {buyer_contact?:unknown}).buyer_contact;

for(const [label,end] of [['an invalidated',true],['a still-open',false]] as const)test(`${label} replacement restores explicitly saved contact, including cleared fields`,async()=>use(async f=>{
  f.saveContact({email:'buyer@example.com',phone:null});
  if(end)f.endSession();else f.store.run('UPDATE checkouts SET needs_replacement=1 WHERE checkout_ref=?','chk_fixture');
  const read=await f.app.read('chk_fixture');
  assert.equal(f.launches.length,1);assert.equal(f.updates.length,1);
  assert.deepEqual(f.updates[0],{id:'cs_fresh',body:{buyer_contact:{email:'buyer@example.com',phone:null}},key:f.updates[0]!.key,authMode:'checkout'});
  assert.deepEqual(sessionContact(read),{email:'buyer@example.com',phone:null});
  assert.equal(read.record.needs_replacement,0);assert.equal(f.app.details(read.record).delivery_quote,undefined);assert.deepEqual(f.app.details(read.record).contact,{email:'buyer@example.com',phone:null});
  assert.deepEqual(f.app.displayNotices(read.record),['checkout_refreshed']);
  await f.app.read('chk_fixture');assert.equal(f.updates.length,1);assert.equal(f.launches.length,1);
}));

for(const saved of [undefined,{}])test(`a replacement without saved contact sends no contact update (${JSON.stringify(saved)})`,async()=>use(async f=>{
  f.saveContact(saved);f.endSession();await f.app.read('chk_fixture');
  assert.equal(f.updates.length,0);assert.equal(f.store.get<ActionRecord>("SELECT * FROM actions WHERE kind='contact_restore'"),undefined);
}));

test('an unknown restoration outcome replays its key and body on the next read without creating another session',async()=>use(async f=>{
  f.saveContact({email:null,phone:'+15555550100'});f.endSession();f.failNextUpdate(lost());
  await assert.rejects(()=>f.app.read('chk_fixture'),{message:/Fixture transport lost/});
  const journal=f.store.get<ActionRecord>("SELECT * FROM actions WHERE kind='contact_restore'")!;
  assert.equal(journal.status,'unknown');assert.equal(f.record().needs_replacement,0);assert.equal(f.record().checkout_session_id,'cs_fresh');
  assert.equal(f.app.details(f.record()).delivery_quote,undefined);assert.deepEqual(f.app.displayNotices(f.record()),['checkout_refreshed']);
  await assert.rejects(()=>f.app.mutate('chk_fixture','gift',{},async()=>undefined),{code:'ACTION_RECONCILIATION_REQUIRED'});
  const read=await f.app.read('chk_fixture');
  assert.equal(f.launches.length,1);assert.equal(f.updates.length,2);assert.deepEqual(f.updates[1],f.updates[0]);assert.equal(f.updates[0]!.key,journal.idempotency_key);
  assert.deepEqual(f.updates[1]!.body,{buyer_contact:{email:null,phone:'+15555550100'}});
  assert.equal(f.store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',journal.action_id)?.status,'succeeded');
  assert.deepEqual(sessionContact(read),{email:null,phone:'+15555550100'});
}));

test('a restoration left pending for a session that was replaced again is superseded',async()=>use(async f=>{
  f.saveContact({email:'buyer@example.com'});f.endSession();f.failNextUpdate(lost());
  await assert.rejects(()=>f.app.read('chk_fixture'),{message:/Fixture transport lost/});
  const first=f.store.get<ActionRecord>("SELECT * FROM actions WHERE kind='contact_restore'")!;
  f.endSession();
  const read=await f.app.read('chk_fixture');
  assert.equal(f.launches.length,2);assert.equal(f.store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',first.action_id)?.status,'rejected');
  assert.equal(f.store.all<ActionRecord>("SELECT * FROM actions WHERE kind='contact_restore' AND status IN ('pending','unknown')").length,0);
  assert.deepEqual(sessionContact(read),{email:'buyer@example.com'});
}));

// Journals the restoration exactly as launch does for the current generation.
const journalContact=(f:ReturnType<typeof fixture>,contact:{email:string|null;phone:string|null})=>{
  f.saveContact(contact);
  const key='contact-restore-chk_fixture-1',body={buyer_contact:contact};
  f.store.run('INSERT INTO actions(action_id,resource,kind,idempotency_key,body,body_hash,status,created_at) VALUES(?,?,?,?,?,?,?,?)',key,'order:ord_fixture','contact_restore',key,JSON.stringify(body),createHash('sha256').update(JSON.stringify(body)).digest('hex'),'pending',Date.now());
  return key;
};

const recoveryRead=async(f:ReturnType<typeof fixture>)=>{
  const read=await f.app.read('chk_fixture');
  assert.deepEqual(f.blocked,[]);assert.equal(f.updates.length,0);assert.equal(f.launches.length,0);
  assert.equal(read.session.status,'open');assert.equal(read.session.recovery_mode,true);
  assert.equal(read.record.checkout_session_id,'cs_initial');assert.equal(read.record.generation,f.record().generation);assert.equal(read.record.needs_replacement,0);
  assert.equal(read.order.active_payment_attempt?.order_payment_attempt_id,'attempt_fixture');assert.equal(read.result.attempt?.status,'requires_action');assert.equal(read.result.attempt?.is_resumable,true);
  assert.equal(f.record().last_attempt_id,'attempt_fixture');
  return read;
};

test('a recovery-mode read keeps its session and active attempt without restricted delivery, quote or contact calls',async()=>use(async f=>{
  const generation=f.record().generation;f.enterRecovery();
  const read=await recoveryRead(f);
  assert.equal(read.record.generation,generation);assert.equal(read.record.status,'open');assert.equal(f.app.project(read).next,'authenticate');
  await recoveryRead(f);
}));

test('a recovery-mode read leaves a pending contact restoration pending for the normal session',async()=>use(async f=>{
  const key=journalContact(f,{email:'buyer@example.com',phone:null});
  f.enterRecovery();await recoveryRead(f);
  assert.equal(f.store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',key)?.status,'pending');
  assert.deepEqual(f.app.details(f.record()).contact,{email:'buyer@example.com',phone:null});assert.equal(f.app.details(f.record()).delivery_selection,undefined);
}));

test('a normal open session still restores pending contact and reads its delivery selection',async()=>use(async f=>{
  const selection={delivery_selection_id:'selection_fixture',status:'active'};
  Object.assign(f.client.checkoutSessions,{getCurrentDeliverySelection:async()=>({delivery_selection:selection})});
  const key=journalContact(f,{email:'buyer@example.com',phone:null});
  const read=await f.app.read('chk_fixture');
  assert.equal(f.updates.length,1);assert.deepEqual(f.updates[0],{id:'cs_initial',body:{buyer_contact:{email:'buyer@example.com',phone:null}},key,authMode:'checkout'});
  assert.deepEqual(sessionContact(read),{email:'buyer@example.com',phone:null});
  assert.equal(f.store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',key)?.status,'succeeded');
  assert.deepEqual(f.app.details(read.record).delivery_selection,selection);assert.equal(f.launches.length,0);
}));
