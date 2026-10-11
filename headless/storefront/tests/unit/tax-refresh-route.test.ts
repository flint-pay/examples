import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SdkError} from '@flintpay/node';
import type {Client,Order,CheckoutSession,RequestOptions} from '@flintpay/node';
import {createApp} from '../../src/app.ts';
import type {Config} from '../../src/config.ts';
import {Store} from '../../src/store/db.ts';
import type {ActionRecord} from '../../src/store/db.ts';
import {IdentityStore} from '../../src/identity/index.ts';

const origin='http://localhost:4100';
const money=(amount:string)=>({amount,currency:'USD'});
const sdkError=(code:string,status:number)=>new SdkError('conflict','fixture rejection','response',false,{status,headers:{},attempts:1,durationMs:1},code);
function fixture(){
  const order={order_id:'fixture-order',status:'open',payment_status:'unpaid',order_revision:'1',settlement_amounts:{outstanding_money:money('2400')},tax:{enabled:true,status:'calculated'},payment_collection:{stripe:{}}} as unknown as Order;
  const session={checkout_session_id:'fixture-session',order_id:order.order_id,status:'open',customer_collection:{require_email:true},delivery_selection_required:false} as CheckoutSession;
  const remote={pays:[] as {body:unknown;key:string|undefined}[],updates:[] as {body:unknown;key:string|undefined;authMode:unknown}[],staleTax:true,refreshedTotal:'2400',refreshError:undefined as SdkError|undefined,refreshLosesResponse:false};
  const client={
    orders:{get:async()=>order,
      pay:async(request:{body:unknown},options:RequestOptions<'checkout'>)=>{
        remote.pays.push({body:structuredClone(request.body),key:options.idempotencyKey});
        if(remote.staleTax)throw sdkError('ORDER_TAX_NOT_READY',409);
        return {order,payment_attempt:{order_payment_attempt_id:'fixture-attempt',status:'succeeded'}};
      },
      update:async(_id:string,body:unknown,options:RequestOptions<'checkout'>)=>{
        remote.updates.push({body:structuredClone(body),key:options.idempotencyKey,authMode:options.authMode});
        if(remote.refreshError)throw remote.refreshError;
        remote.staleTax=false;order.settlement_amounts.outstanding_money=money(remote.refreshedTotal);
        if(remote.refreshLosesResponse)throw new SdkError('transport','fixture lost response','unknown',true);
        return order;
      },
      getPaymentAttempt:async()=>({order_payment_attempt_id:'fixture-attempt',status:'succeeded'})},
    checkoutSessions:{get:async()=>session,getCurrentDeliverySelection:async()=>({delivery_selection:undefined})},
  } as unknown as Client;
  const config:Config={apiKey:'local-tax-fixture',apiBaseUrl:'https://api.staging.withflintpay.com',giftChallengeOrigin:'https://checkout.staging.withflintpay.com',appOrigin:origin,port:4100,identityDatabasePath:':memory:',appDatabasePath:':memory:',cookieName:'tax_session',checkoutTtl:3600,storeName:'Example store'};
  const runtime=createApp({config,client,preflight:{sandboxId:'fixture-sandbox',cards:'enabled'},store:new Store(':memory:'),identity:new IdentityStore(':memory:')});
  const owner=runtime.identity.createSession();const now=Date.now();
  runtime.store.run('INSERT INTO checkouts(checkout_ref,session_hash,kind,order_id,checkout_session_id,checkout_auth_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)','chk_fixture',owner.session.session_hash,'order',order.order_id,session.checkout_session_id,'local-checkout-fixture',now,now);
  const pay=async(approved='2400')=>{
    const response=await runtime.app.request(origin+'/checkout/chk_fixture/pay',{method:'POST',headers:{Cookie:`tax_session=${owner.token}`,Origin:origin,'X-CSRF-Token':owner.session.csrf_token,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({approved_outstanding_money:money(approved),approved_collection_kind:'processor',credential:{kind:'confirmation_token',value:'ctoken_fixture'}})});
    return {status:response.status,json:await response.json() as {state:{amount?:unknown};next?:string;error?:{kind?:string;code:string;message_key:string}}};
  };
  const jobs=()=>runtime.store.all<ActionRecord>("SELECT * FROM actions WHERE kind='pay'");
  return {...runtime,remote,order,pay,jobs,close:()=>{runtime.store.close();runtime.identity.close();}};
}

test('a stale tax rejection refreshes tax once, keeps the pay job rejected, and never pays again on its own',async()=>{
  const app=fixture();try{
    const {status,json}=await app.pay();
    assert.equal(status,200);assert.equal(json.error?.code,'ORDER_CHANGED_REFRESH_REQUIRED');assert.equal(json.error?.message_key,'tax_updated');
    assert.equal(app.remote.pays.length,1);assert.equal(app.jobs().length,1);assert.equal(app.jobs()[0]!.status,'rejected');assert.equal(app.jobs()[0]!.body,null);
    assert.equal(app.remote.updates.length,1);assert.deepEqual(app.remote.updates[0]!.body,{tax:{enabled:true}});assert.equal(app.remote.updates[0]!.authMode,'checkout');
    assert.ok(app.remote.updates[0]!.key);assert.notEqual(app.remote.updates[0]!.key,app.remote.pays[0]!.key);
    assert.equal(app.remote.pays.length,1,'the buyer must press again with a fresh credential');
    const next=await app.pay();assert.equal(next.status,200);assert.equal(next.json.error,undefined);assert.equal(app.remote.pays.length,2);
  }finally{app.close();}
});

test('a stale tax rejection with a changed total asks for approval of the new amount',async()=>{
  const app=fixture();app.remote.refreshedTotal='2600';try{
    const {json}=await app.pay();
    assert.equal(json.error?.code,'ORDER_CHANGED_REFRESH_REQUIRED');assert.equal(json.error?.message_key,'total_changed');
    assert.equal(app.remote.pays.length,1);
    const stale=await app.pay('2400');assert.equal(stale.json.error?.message_key,'total_changed','the old approval does not match the new total');assert.equal(app.remote.pays.length,1);
    const fresh=await app.pay('2600');assert.equal(fresh.json.error,undefined);assert.equal(app.remote.pays.length,2);
  }finally{app.close();}
});

test('a known refresh failure keeps the specific stale tax error and does not pay again',async()=>{
  const app=fixture();app.remote.refreshError=sdkError('ORDER_TAX_CALCULATION_FAILED',409);try{
    const {status,json}=await app.pay();
    assert.equal(status,409);assert.equal(json.error?.code,'ORDER_TAX_NOT_READY');assert.equal(json.error?.message_key,'order_tax_not_ready');
    assert.equal(app.remote.pays.length,1);assert.equal(app.remote.updates.length,1);
  }finally{app.close();}
});

test('a refresh with an unknown outcome is replayed with the same key before any later pay',async()=>{
  const app=fixture();app.remote.refreshLosesResponse=true;try{
    const first=await app.pay();
    assert.equal(first.json.error?.code,'ORDER_TAX_NOT_READY');assert.equal(app.remote.pays.length,1);assert.equal(app.remote.updates.length,1);
    app.remote.refreshLosesResponse=false;
    const second=await app.pay();
    assert.equal(second.json.error?.code,'ORDER_CHANGED_REFRESH_REQUIRED');assert.equal(second.json.error?.message_key,'tax_updated');
    assert.equal(app.remote.updates.length,2);assert.equal(app.remote.updates[1]!.key,app.remote.updates[0]!.key);assert.equal(app.remote.pays.length,1);
    const third=await app.pay();assert.equal(third.json.error,undefined);assert.equal(app.remote.pays.length,2);
  }finally{app.close();}
});

for(const replay of [{name:'a known rejection',status:'rejected',configure:(remote:ReturnType<typeof fixture>['remote'])=>{remote.refreshLosesResponse=false;remote.refreshError=sdkError('ORDER_TAX_CALCULATION_FAILED',409);}},{name:'another unknown outcome',status:'unknown',configure:(remote:ReturnType<typeof fixture>['remote'])=>{remote.refreshLosesResponse=true;}}])
  test(`a replayed refresh that fails with ${replay.name} shows the tax message without paying`,async()=>{
    const app=fixture();app.remote.refreshLosesResponse=true;try{
      await app.pay();
      const refreshes=()=>app.store.all<ActionRecord>("SELECT * FROM actions WHERE kind='tax_refresh'");
      assert.equal(refreshes().length,1);assert.equal(refreshes()[0]!.status,'unknown');
      replay.configure(app.remote);
      const second=await app.pay();
      assert.equal(second.status,409);assert.equal(second.json.error?.code,'ORDER_TAX_NOT_READY');assert.equal(second.json.error?.message_key,'order_tax_not_ready');
      assert.equal(second.json.error?.kind,'conflict');
      assert.equal(app.remote.pays.length,1);assert.equal(app.remote.updates.length,2);assert.equal(app.remote.updates[1]!.key,app.remote.updates[0]!.key);
      assert.equal(refreshes().length,1);assert.equal(refreshes()[0]!.status,replay.status);
    }finally{app.close();}
  });
