import test from 'node:test';
import assert from 'node:assert/strict';
import type {Client,Order,OrderPaymentAttempt,PayOrderRequestInput,RequestOptions} from '@flintpay/node';
import {Store} from '../../src/server/store/db.ts';
import {IdentityStore} from '../../src/server/identity/index.ts';
import {readConfig} from '../../src/server/config.ts';
import {flintError} from './support/flint-error.ts';
import {registerHooks} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Checkouts} from '../../src/server/flint/checkouts.ts';
import {PaymentEngine} from '../../src/server/payments/engine.ts';
import {Carts} from '../../src/server/store/cart.ts';
import {createAuth} from '../../src/server/flint/auth.ts';
import type {Catalog} from '../../src/server/flint/catalog.ts';
import type {Visitor} from '../../src/server/session.ts';

// Supply only the request's visitor. The route, checkout reader and payment engine are real.
const holder=globalThis as typeof globalThis&{__returnRouteVisitor?:Visitor};
const source=fileURLToPath(new URL('../../src/',import.meta.url));
registerHooks({resolve(specifier,context,nextResolve){
  if(specifier==='server-only')return {url:'data:text/javascript,export {}',shortCircuit:true};
  if(specifier==='@/server/session.ts')return {url:'data:text/javascript,export async function visitor(){return globalThis.__returnRouteVisitor}',shortCircuit:true};
  if(specifier==='next/server')return nextResolve('next/server.js',context);
  return nextResolve(specifier.startsWith('@/')?pathToFileURL(source+specifier.slice(2)).href:specifier,context);
}});
const {GET}=await import('../../src/app/checkout/[ref]/return/route.ts');

test('a provider return leaves the durable Stripe fallback untouched until the next status read',async()=>{
  const store=new Store(':memory:'),identity=new IdentityStore(':memory:');
  try{
    const config=readConfig({FLINT_API_KEY:'flint_test_FIXTURE',FLINT_API_BASE_URL:'https://api.staging.withflintpay.com',APP_ORIGIN:'http://localhost:4100',PORT:'4100'});
    const owner=identity.createSession(),money={amount:'1000' as const,currency:'USD'};
    const order={order_id:'ord_fixture',status:'open',payment_status:'unpaid',version:1,line_items:[],settlement_amounts:{outstanding_money:money},payment_collection:{stripe:{elements:{}}}} as unknown as Order;
    const checkout={checkout_session_id:'cs_fixture',status:'open',is_in_recovery:true};
    const sent:{body:PayOrderRequestInput;key?:string}[]=[];let failRead=false;
    const client={orders:{get:async()=>{if(failRead){failRead=false;throw new Error('refusal read failed');}return order;},pay:async(_id:string,body:PayOrderRequestInput,options:RequestOptions)=>{
      sent.push({body,key:options.idempotencyKey});
      if(sent.length===1){
        order.active_payment_attempt={order_id:order.order_id,order_payment_attempt_id:'attempt_fixture',status:'requires_action',is_resumable:true,pending_actions:[],payment_intents:[]} as unknown as OrderPaymentAttempt;
        failRead=true;throw flintError(409,'ACTION_NOT_ALLOWED',{reason:'provider_action_unsupported'});
      }
      order.active_payment_attempt={...order.active_payment_attempt,status:'processing',is_resumable:false} as OrderPaymentAttempt;
      return {order,order_payment_attempt:order.active_payment_attempt};
    }},checkoutSessions:{get:async()=>checkout}} as unknown as Client;
    store.run('INSERT INTO checkouts(checkout_ref,session_hash,kind,order_id,checkout_session_id,checkout_auth_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)','chk_fixture',owner.session.session_hash,'order',order.order_id,checkout.checkout_session_id,'fixture checkout authority',Date.now(),Date.now());
    const auth=createAuth(config.apiKey),payments=new PaymentEngine(client,auth,store);
    const checkouts=new Checkouts(client,auth,store,identity,config,'sandbox_fixture',new Carts(store,{} as Catalog),payments);
    holder.__returnRouteVisitor={rt:{config,checkouts,payments,catalog:{read:async()=>({products:[]})}} as unknown as Visitor['rt'],session:owner.session,user:undefined};
    const row=payments.record('chk_fixture'),job=payments.job(row,'pay',{action:'pay',client_action_type:'url',payment_source:{credential_type:'stripe_confirmation_token',stripe:{confirmation_token:'ctoken_fixture'}}});
    await assert.rejects(()=>payments.execute(row,job,()=>{}),/refusal read failed/);
    const pending=payments.unresolved(row)!;
    const returned=await GET(new Request(config.appOrigin+'/checkout/chk_fixture/return'),{params:Promise.resolve({ref:'chk_fixture'})});
    assert.equal(returned.status,303);assert.equal(new URL(returned.headers.get('Location')!,config.appOrigin).pathname,'/checkout/chk_fixture');
    assert.equal(sent.length,1,'the return request must not call orders.pay');
    assert.deepEqual(payments.unresolved(row),pending,'the return must preserve the fallback body, key and status');
    const read=await checkouts.read(row.checkout_ref);assert.equal(read.result.unknown,false);
    assert.equal(sent.length,2);
    assert.deepEqual(sent[1]!.body,{action:'resume',order_payment_attempt_id:'attempt_fixture',client_action_type:'stripe'});
    assert.equal(sent[1]!.key,`${sent[0]!.key}-stripe`);assert.equal(payments.unresolved(row),undefined);
  }finally{delete holder.__returnRouteVisitor;store.close();identity.close();}
});
