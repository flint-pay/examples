import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {MoneyValue,Order} from '@flintpay/node';
import {readConfig} from '../../src/config.ts';
import {createClient} from '../../src/flint/client.ts';
import {createAuth} from '../../src/flint/auth.ts';
import {preflight} from '../../src/flint/preflight.ts';
import {createApp} from '../../src/app.ts';
import type {CheckoutRecord} from '../../src/store/db.ts';

// These tests call the configured Flint sandbox and Stripe test payment methods.
// They create orders, refund successful payments, and cancel the trial subscription.
// No HTTP responses or SDK operations are mocked.
test('storefront public SDK sandbox journeys',{timeout:180_000},async t=>{
  const config=readConfig();if(!config.sandboxGuard)throw new Error('Set FLINT_SANDBOX_ID to the dedicated integration sandbox.');
  const client=createClient(config.apiBaseUrl,config.sandboxGuard);const auth=createAuth(config.apiKey);const ready=await preflight(client,auth,config);assert.equal(ready.sandboxId,config.sandboxGuard);assert.equal(ready.cards,'enabled');
  const journals=process.env.E2E_INTEGRATION_JOURNAL_DIR;
  if(journals)mkdirSync(journals,{recursive:true,mode:0o700});
  const directory=mkdtempSync(join(journals??tmpdir(),'storefront-integration-'));const runId=randomUUID();const runtime=createApp({config:{...config,appDatabasePath:join(directory,'app.sqlite'),identityDatabasePath:join(directory,'identity.sqlite')},client,preflight:ready});
  type State={checkout_ref:string;kind:'order'|'subscription';collection_kind:'processor'|'settlement'|'setup'|'unavailable';order:Order;approved_outstanding_money:MoneyValue;next:string;delivery_quote?:{choice_groups:Array<{delivery_choice_group_id:string;availability_status:string;options:Array<{delivery_option_id:string;type:string}>}>};delivery_selection?:{status:string}};
  type Result={state:State;next?:string;error?:{code:string};client_action?:unknown};
  const created:{ref:string;subscription_id?:string}[]=[];
  const session=runtime.identity.createSession();const cookie=`${config.cookieName}=${session.token}`;
  async function request(path:string,input?:unknown):Promise<Response>{return runtime.app.request(config.appOrigin+path,{method:input===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:config.appOrigin,'X-CSRF-Token':session.session.csrf_token,Accept:'application/json',...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)})});}
  async function state(ref:string):Promise<State>{const response=await request(`/checkout/${ref}/state`);assert.equal(response.status,200);return (await response.json() as Result).state;}
  async function checkout(slug='brewing-class'):Promise<State>{
    const item=await runtime.catalog.product(slug);const response=await request('/cart/items',{product_slug:slug,variant_id:item.variants[0]!.variant_id,quantity:1});assert.equal(response.status,200);
    const started=await request('/checkout',{});assert.equal(started.status,303);const ref=started.headers.get('location')!.split('/').at(-1)!;created.push({ref});
    const contact=await request(`/checkout/${ref}/contact`,{name:'Integration buyer',email:`storefront-${runId}@example.test`});assert.equal(contact.status,200);return state(ref);
  }
  async function pay(current:State,token:string):Promise<{status:number;result:Result}>{
    const response=await request(`/checkout/${current.checkout_ref}/pay`,{credential:{kind:'payment_method_token',value:token},approved_outstanding_money:current.approved_outstanding_money,approved_collection_kind:current.collection_kind,approved_order_revision:current.order.order_revision,...(current.order.gift_card_estimate?{approved_gift_card_money:current.order.gift_card_estimate.gift_card_money}:{})});
    return {status:response.status,result:await response.json() as Result};
  }
  try{
    await t.test('guest service order pays once with a Stripe test card',async()=>{
      const current=await checkout();assert.equal(current.collection_kind,'processor');const paid=await pay(current,'pm_card_visa');assert.equal(paid.status,200);assert.equal(paid.result.next,'done');assert.equal(paid.result.state.order.payment_status,'paid');
      const again=await pay(await state(current.checkout_ref),'pm_card_visa');assert.equal(again.result.state.order.payment_status,'paid');assert.equal(again.result.state.order.payment_intents?.length,paid.result.state.order.payment_intents?.length);
      await request(`/checkout/${current.checkout_ref}/complete`);
    });
    await t.test('a decline remains payable and a fresh card succeeds',async()=>{
      const current=await checkout();const declined=await pay(current,'pm_card_chargeDeclined');assert.equal(declined.result.state.next,'new_payment');assert.notEqual(declined.result.state.order.payment_status,'paid');
      const paid=await pay(await state(current.checkout_ref),'pm_card_visa');assert.equal(paid.status,200);assert.equal(paid.result.next,'done');await request(`/checkout/${current.checkout_ref}/complete`);
    });
    await t.test('requires_action exposes the current provider action only in the payment job',async()=>{
      const current=await checkout();const paid=await pay(current,'pm_card_threeDSecure2Required');assert.equal(paid.status,200);assert.equal(paid.result.next,'authenticate');assert.ok(paid.result.client_action);
      const bootstrap=await state(current.checkout_ref);assert.equal(JSON.stringify(bootstrap).includes('_secret_'),false);
      const canceled=await request(`/checkout/${current.checkout_ref}/cancel-attempt`,{});assert.equal(canceled.status,200);assert.equal((await canceled.json() as Result).next,'new_payment');
      const cart=runtime.carts.current(session.session);await runtime.checkouts.editCart(cart,async()=>runtime.store.run('DELETE FROM cart_lines WHERE cart_id=?',cart.cart_id));
    });
    await t.test('pickup uses the posted ZIP quote and selects its ready groups',async()=>{
      const current=await checkout('house-blend');const quote=await request(`/checkout/${current.checkout_ref}/pickup-locations`,{postal_code:'78701',country:'US'});assert.equal(quote.status,200);const quoted=(await quote.json() as Result).state;
      const groups=quoted.delivery_quote!.choice_groups.filter(group=>group.availability_status==='ready');assert.ok(groups.length);
      const choices=groups.map(group=>({delivery_choice_group_id:group.delivery_choice_group_id,delivery_option_id:group.options.find(option=>option.type==='pickup')!.delivery_option_id}));
      const selection=await request(`/checkout/${current.checkout_ref}/delivery/select`,{choices,recipient:{name:'Integration buyer',email:`storefront-${runId}@example.test`}});assert.equal(selection.status,200);assert.equal((await selection.json() as Result).state.delivery_selection?.status,'selected');
      const cart=runtime.carts.current(session.session);await runtime.checkouts.editCart(cart,async()=>runtime.store.run('DELETE FROM cart_lines WHERE cart_id=?',cart.cart_id));
    });
    await t.test('trial signup collects a setup payment method without charging',async()=>{
      const started=await request('/subscribe/coffee-club-trial',{});assert.equal(started.status,303);const ref=started.headers.get('location')!.split('/').at(-1)!;created.push({ref});
      const contact=await request(`/checkout/${ref}/contact`,{name:'Integration buyer',email:`trial-${runId}@example.test`});assert.equal(contact.status,200);const current=await state(ref);assert.equal(current.collection_kind,'setup');assert.equal(current.approved_outstanding_money.amount,'0');
      const setup=await pay(current,'pm_card_visa');assert.equal(setup.status,200);assert.equal(setup.result.next,'done');const read=await runtime.checkouts.read(ref);const subscription=await runtime.checkouts.subscription(read);assert.ok(subscription);assert.equal(subscription.status,'trialing');created.at(-1)!.subscription_id=subscription.subscription_id;
      assert.equal(setup.result.state.order.payment_intents?.filter(intent=>intent.status==='succeeded').length??0,0);
    });
  }finally{
    const incomplete:unknown[]=[];
    for(const createdCheckout of created){
      let record:CheckoutRecord|undefined;
      try{
        record=runtime.checkouts.record(createdCheckout.ref);const order=await client.orders.get(record.order_id!,undefined,auth.merchant());
        if(order.active_payment_attempt)await runtime.payments.cancel(record.checkout_ref);
        if(createdCheckout.subscription_id||order.subscription_id)await client.subscriptions.cancel(createdCheckout.subscription_id??order.subscription_id!,{cancel_immediately:true},auth.merchant(`integration-${runId}-${record.checkout_ref}-cancel`));
        if(order.payment_status==='paid'&&BigInt(order.settlement_amounts.paid_money.amount)>0n)await client.refunds.create({order_id:order.order_id,reason:'other',metadata:{example_test_run:runId}},auth.merchant(`integration-${runId}-${record.checkout_ref}-refund`));
        if(record.checkout_session_id){const session=await client.checkoutSessions.get(record.checkout_session_id,undefined,auth.merchant());if(session.status==='open')await client.checkoutSessions.closeSession(record.checkout_session_id,{},auth.merchant(`integration-${runId}-${record.checkout_ref}-close-checkout`));}
        if(order.status==='open')await client.orders.closeSession(order.order_id,{},auth.merchant(`integration-${runId}-${record.checkout_ref}-close-order`));
      }catch(error){incomplete.push({checkout_ref:createdCheckout.ref,order_id:record?.order_id,subscription_id:createdCheckout.subscription_id,error_code:error&&typeof error==='object'&&'code'in error?error.code:'cleanup_failed'});}
    }
    // The lifecycle adapter keeps the application's original durable requests
    // in its private run directory for reconciliation after uncertain outcomes.
    runtime.store.close();runtime.identity.close();if(!journals)rmSync(directory,{recursive:true,force:true});
    if(incomplete.length){const artifact=resolve(dirname(config.appDatabasePath),`integration-cleanup-${runId}.json`);mkdirSync(dirname(artifact),{recursive:true,mode:0o700});writeFileSync(artifact,JSON.stringify({sandbox_id:ready.sandboxId,resources:incomplete},null,2),{mode:0o600});throw new Error(`Integration cleanup needs attention. See ${artifact}.`);}
  }
});
