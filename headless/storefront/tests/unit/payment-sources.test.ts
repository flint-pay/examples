import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import type {Client,CheckoutSession,Order,RequestOptions} from '@flintpay/node';
import {SdkError} from '@flintpay/node';
import {Checkouts} from '../../src/flint/checkouts.ts';
import {createAuth} from '../../src/flint/auth.ts';
import {readConfig} from '../../src/config.ts';
import {Store} from '../../src/store/db.ts';
import type {CheckoutRecord} from '../../src/store/db.ts';
import {Carts} from '../../src/store/cart.ts';
import type {Catalog} from '../../src/flint/catalog.ts';
import {IdentityStore} from '../../src/identity/index.ts';
import {PaymentEngine} from '../../src/payments/engine.ts';

const money={amount:'1800',currency:'USD'};
const MERCHANT_KEY='flint_test_FIXTURE';
type Call={id:string;expand?:string[];authMode:string;apiKey?:string};

// The public intent identifies its selected option. Order expansions omit it,
// and neither read may expose merchant-only details to the buyer.
function fixture(t:TestContext,type='affirm'){
  const store=new Store(':memory:'),identity=new IdentityStore(':memory:');
  const config=readConfig({FLINT_API_KEY:MERCHANT_KEY,FLINT_API_BASE_URL:'https://api.staging.withflintpay.com',APP_ORIGIN:'http://localhost:4100',PORT:'4100'});
  const order={order_id:'ord_fixture',status:'open',payment_status:'unpaid',order_revision:'1',line_items:[],payment_intent_ids:['pi_leg'],settlement_amounts:{outstanding_money:money,paid_money:{amount:'0',currency:'USD'}},
    active_payment_attempt:{order_payment_attempt_id:'opa_fixture',status:type==='affirm'?'requires_action':'processing',is_resumable:type==='affirm',pending_actions:[],payment_intents:[{payment_intent_id:'pi_leg',status:type==='affirm'?'requires_action':'processing',amount_money:money}]}} as unknown as Order;
  const session={checkout_session_id:'cs_fixture',order_id:order.order_id,status:'open',page_origin:config.appOrigin} as CheckoutSession;
  const calls:Call[]=[];
  const state:{expansion?:Record<string,unknown>;fail?:Error}={};
  const expandedRow={payment_intent_id:'pi_leg',status:'requires_action',selected_payment_option:type,amount_money:money,customer_id:'cus_private',order_id:'ord_fixture',client_secret:'pi_leg_secret_PRIVATE'};
  const client={
    orders:{get:async(id:string,params:{expand?:string[]}|undefined,options:RequestOptions)=>{
      const authMode=options.authMode??'merchant';calls.push({id,expand:params?.expand,authMode,apiKey:(options as {apiKey?:string}).apiKey});
      if(!params?.expand)return order;
      if(authMode==='checkout')throw new SdkError('validation','Expansion refused','response',false,{status:400,headers:{},attempts:1,durationMs:1},'EXPANSION_NOT_ALLOWED');
      return {...order,order_id:'ord_fixture',customer_id:'cus_private',metadata:{internal:'x'},payment_intents:[expandedRow],...state.expansion};
    },getPaymentAttempt:async()=>order.active_payment_attempt},
    paymentIntents:{get:async(id:string,_params:unknown,options:RequestOptions)=>{
      const authMode=options.authMode??'merchant';calls.push({id,authMode,apiKey:(options as {apiKey?:string}).apiKey});
      if(state.fail)throw state.fail;
      return {...expandedRow,...state.expansion};
    }},
    checkoutSessions:{get:async()=>session,getCurrentDeliverySelection:async()=>({})},
  } as unknown as Client;
  const auth=createAuth(config.apiKey),carts=new Carts(store,{} as Catalog);
  store.run('INSERT INTO checkouts(checkout_ref,session_hash,kind,order_id,checkout_session_id,checkout_auth_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)','chk_fixture',identity.createSession().session.session_hash,'order',order.order_id,session.checkout_session_id,'fixture checkout credential',Date.now(),Date.now());
  const engine=new PaymentEngine(client,auth,store),app=new Checkouts(client,auth,store,identity,config,'sandbox_fixture',carts,engine);
  const warnings:string[]=[];t.mock.method(console,'warn',(line:string)=>{warnings.push(String(line));});
  t.after(()=>{store.close();identity.close();});
  return {order,calls,state,engine,app,warnings,record:():CheckoutRecord=>app.record('chk_fixture')};
}

test('the source lookup uses the merchant key and the session order intent ID',async t=>{
  const f=fixture(t);
  await f.engine.withPaymentSources(f.record(),f.order);
  assert.deepEqual(f.calls,[{id:'pi_leg',authMode:'merchant',apiKey:MERCHANT_KEY}]);
});

test('only the intent ID, status, and source type are taken from the merchant read',async t=>{
  const f=fixture(t);
  const sourced=await f.engine.withPaymentSources(f.record(),f.order);
  assert.deepEqual(sourced.payment_intents,[{payment_intent_id:'pi_leg',status:'requires_action',payment_source:{type:'affirm'}}]);
  assert.equal(sourced.customer_id,f.order.customer_id);assert.equal(sourced.metadata,f.order.metadata);
  assert.deepEqual(sourced.active_payment_attempt,f.order.active_payment_attempt);
  assert.equal(f.order.payment_intents,undefined);
});

test('a response for a different order is ignored',async t=>{
  const f=fixture(t);f.state.expansion={order_id:'ord_other'};
  assert.equal(await f.engine.withPaymentSources(f.record(),f.order),f.order);
});

test('a response for a different intent is ignored',async t=>{
  const f=fixture(t);f.state.expansion={payment_intent_id:'pi_other'};
  assert.equal(await f.engine.withPaymentSources(f.record(),f.order),f.order);
});

test('no lookup is made when the order has no payment intents',async t=>{
  const f=fixture(t);
  for(const none of [undefined,[]]){assert.equal(await f.engine.withPaymentSources(f.record(),{...f.order,payment_intent_ids:none} as Order).then(order=>order.payment_intents),undefined);}
  assert.equal(f.calls.length,0);
});

test('a failed lookup leaves the session read intact and logs only a safe code',async t=>{
  const f=fixture(t);
  f.state.fail=new SdkError('server','GET https://api.staging.withflintpay.com/v1/orders/ord_fixture?expand=payment_intents with flint_test_SECRETVALUE','response',true,{status:503,headers:{authorization:'Bearer flint_test_SECRETVALUE'},attempts:1,durationMs:1},'EXPANSION_DEPENDENCY_UNAVAILABLE');
  assert.equal(await f.engine.withPaymentSources(f.record(),f.order),f.order);
  f.state.fail=new Error('socket closed at https://api.staging.withflintpay.com flint_test_SECRETVALUE');
  assert.equal(await f.engine.withPaymentSources(f.record(),f.order),f.order);
  assert.deepEqual(f.warnings.map(line=>JSON.parse(line)),[{event:'payment_source_lookup_failed',code:'EXPANSION_DEPENDENCY_UNAVAILABLE'},{event:'payment_source_lookup_failed',code:'UNKNOWN'}]);
  assert.doesNotMatch(f.warnings.join(),/flint_test_|https?:|Bearer/);
});

test('the session read uses the checkout credential without the expansion, so it stays source-free',async t=>{
  const f=fixture(t);
  assert.equal((await f.engine.read(f.record())).payment_intents,undefined);
  assert.deepEqual(f.calls.map(({id,expand,authMode})=>({id,expand,authMode})),[{id:'ord_fixture',expand:undefined,authMode:'checkout'}]);
});

test('a fresh checkout read knows an Affirm leg is Affirm and projects only the safe fields',async t=>{
  const f=fixture(t);
  const read=await f.app.read('chk_fixture');
  assert.equal(read.result.attempt?.order_payment_attempt_id,'opa_fixture');
  assert.deepEqual(read.order.payment_intents,[{payment_intent_id:'pi_leg',status:'requires_action',payment_source:{type:'affirm'}}]);
  assert.equal(f.record().status,'open');assert.equal(f.engine.next(read.result),'authenticate');
  assert.deepEqual(f.calls.filter(call=>call.id==='pi_leg').map(call=>call.authMode),['merchant']);
  const state=f.app.project(read) as {order:{payment_intents:unknown;customer_id?:unknown;metadata?:unknown}};
  assert.deepEqual(state.order.payment_intents,[{payment_intent_id:'pi_leg',status:'requires_action',payment_source:{type:'affirm'}}]);
  const json=JSON.stringify(state);
  assert.doesNotMatch(json,/client_secret|_secret_|cus_private|flint_test_|fixture checkout credential|last4/);
});

test('a bank debit leg reaches bank processing through the same lookup',async t=>{
  const f=fixture(t,'ach_debit');
  const read=await f.app.read('chk_fixture');
  assert.equal(f.engine.next(read.result),'bank_processing');assert.equal(f.record().status,'bank_processing');
});

test('a failed lookup during a checkout read still loads the checkout as before',async t=>{
  const f=fixture(t);f.state.fail=new SdkError('server','Dependency down','response',true,{status:503,headers:{},attempts:1,durationMs:1},'EXPANSION_DEPENDENCY_UNAVAILABLE');
  const read=await f.app.read('chk_fixture');
  assert.equal(read.order.payment_intents,undefined);assert.equal(f.engine.next(read.result),'authenticate');
});
