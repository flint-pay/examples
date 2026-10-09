import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import type {Client,Order,CheckoutSession,OrderPaymentAttempt} from '@flintpay/node';
import {createApp} from '../../src/app.ts';
import type {Config} from '../../src/config.ts';
import {Store} from '../../src/store/db.ts';
import type {ActionRecord} from '../../src/store/db.ts';
import {IdentityStore} from '../../src/identity/index.ts';
import {viewPath} from '../../src/flint/view-data.ts';
import {LocalError} from '../../src/flint/errors.ts';
import {trialSetupNotStarted} from '../../src/views/pages/complete.ts';
import type {CheckoutState} from '../../src/views/types.ts';

const origin='http://localhost:4100';const money={amount:'1800',currency:'USD'};
function fixture(){
  const product={product_id:'fixture-product',name:'House blend',product_type:'physical',available_for_sale:true,default_variant_id:'fixture-variant',metadata:{example_catalog:'cedar-and-stone',example_slug:'house-blend'},price_range:{min_unit_price_money:money,max_unit_price_money:money}};
  const variant={variant_id:'fixture-variant',available_for_sale:true,unit_price_money:money};
  const remote={
    order:{order_id:'fixture-order',order_number:'Example order',status:'open',payment_status:'unpaid',order_revision:'1',line_items:[{order_line_item_id:'fixture-order-line',variant_id:variant.variant_id,name:product.name,quantity:'1',total_money:money}],pricing_amounts:{total_money:money},settlement_amounts:{outstanding_money:money,paid_money:{amount:'0',currency:'USD'}},buyer_contact:{email:'buyer@example.test'},payment_collection:{stripe:{}}} as unknown as Order,
    session:{checkout_session_id:'fixture-flint-session',status:'open',customer_collection:{require_email:true},buyer_contact:{email:'buyer@example.test'}} as unknown as CheckoutSession,
    reads:0,mutations:0,readFailureAt:undefined as number|undefined,
  };
  const mutation=async()=>{remote.mutations++;throw new Error('rendering and locked cart requests must not mutate Flint');};
  const client={
    products:{listItems:async function*(){yield product;},listVariantsItems:async function*(){yield variant;}},
    subscriptionPlans:{listItems:async function*(){}},
    checkoutSessions:{get:async()=>remote.session,getCurrentDeliverySelection:async()=>({}),create:mutation,update:mutation,closeSession:mutation,createDeliveryQuote:mutation},
    orders:{get:async()=>{remote.reads++;if(remote.reads===remote.readFailureAt)throw new Error('local order read failure');return remote.order;},getPaymentAttempt:async()=>remote.order.active_payment_attempt,updateLineItem:mutation,deleteLineItem:mutation,addLineItems:mutation,pay:mutation},
  } as unknown as Client;
  const config:Config={apiKey:'local-render-fixture',apiBaseUrl:'https://api.staging.withflintpay.com',giftChallengeOrigin:'https://checkout.staging.withflintpay.com',appOrigin:origin,port:4100,identityDatabasePath:':memory:',appDatabasePath:':memory:',cookieName:'render_session',checkoutTtl:3600,storeName:'Example store'};
  const runtime=createApp({config,preflight:{sandboxId:'fixture-sandbox',cards:'enabled'},client,store:new Store(':memory:'),identity:new IdentityStore(':memory:')});
  const identitySession=runtime.identity.createSession();const cookie=`render_session=${identitySession.token}`;
  const get=(path:string,method='GET')=>runtime.app.request(origin+path,{method,headers:{Cookie:cookie}});
  const post=(path:string,fields:Record<string,string>,json=false)=>runtime.app.request(origin+path,{method:'POST',headers:{Cookie:cookie,Origin:origin,'X-CSRF-Token':identitySession.session.csrf_token,'Content-Type':json?'application/json':'application/x-www-form-urlencoded',Accept:json?'application/json':'text/html'},body:json?JSON.stringify(fields):new URLSearchParams(fields).toString()});
  const checkout=()=>{
    const cart=runtime.carts.current(identitySession.session);
    runtime.store.run('INSERT INTO cart_lines VALUES(?,?,?,?,?)','fixture-line',cart.cart_id,product.product_id,variant.variant_id,1);
    runtime.store.run('INSERT INTO checkouts(checkout_ref,cart_id,session_hash,kind,order_id,checkout_session_id,checkout_auth_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)','chk_fixture',cart.cart_id,identitySession.session.session_hash,'order',remote.order.order_id,remote.session.checkout_session_id,'private-checkout-credential',Date.now(),Date.now());
    return {cart,record:runtime.checkouts.record('chk_fixture')};
  };
  return {...runtime,remote,identitySession,get,post,checkout,close:()=>{runtime.store.close();runtime.identity.close();}};
}
function inputValue(html:string,name:string):string{
  const tag=html.match(new RegExp(`<input\\b(?=[^>]*\\bname="${name}")[^>]*>`))?.[0];assert.ok(tag,`missing ${name} field`);
  return (tag.match(/\bvalue="([^"]*)"/)?.[1]??'').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
}
test('reading a paid zero-dollar trial keeps its local checkout open until subscription provisioning',async()=>{
  const app=fixture();try{
    const {record}=app.checkout();app.store.run("UPDATE checkouts SET kind='subscription' WHERE checkout_ref=?",record.checkout_ref);
    app.remote.order={...app.remote.order,payment_status:'paid',subscription_plan_id:'fixture-plan',settlement_amounts:{...app.remote.order.settlement_amounts,outstanding_money:{amount:'0',currency:'USD'}},setup_collection:{stripe:{elements:{mode:'setup'}}}} as Order;
    await app.checkouts.read(record.checkout_ref);assert.equal(app.checkouts.record(record.checkout_ref).status,'open');
    app.store.run("UPDATE checkouts SET status='paid',completed_at=1 WHERE checkout_ref=?",record.checkout_ref);await app.checkouts.read(record.checkout_ref);assert.equal(app.checkouts.record(record.checkout_ref).status,'open');assert.equal(app.checkouts.record(record.checkout_ref).completed_at,null);
    app.remote.order.subscription_id='fixture-subscription';await app.checkouts.read(record.checkout_ref);assert.equal(app.checkouts.record(record.checkout_ref).status,'paid');assert.equal(app.remote.mutations,0);
  }finally{app.close();}
});
test('browser assets are served when launched from the repository root',async()=>{
  const cwd=process.cwd();process.chdir(fileURLToPath(new URL('../../../../',import.meta.url)));
  let app:ReturnType<typeof fixture>|undefined;try{
    app=fixture();
    for(const [path,type] of [['/js/site.js','javascript'],['/styles.css','css'],['/images/stoneware-mug.svg','svg']] as const){
      const response=await app.get(path);assert.equal(response.status,200,path);
      assert.ok(response.headers.get('content-type')?.includes(type),path);
      assert.ok((await response.text()).length>0,path);
    }
    assert.equal(app.remote.mutations,0);
  }finally{app?.close();process.chdir(cwd);}
});
test('the non-JavaScript add-to-cart redirect supplies its settled notice to the real renderer',async()=>{
  const app=fixture();try{
    const added=await app.post('/cart/items',{product_slug:'house-blend',variant_id:'fixture-variant',quantity:'1'});assert.equal(added.status,303);assert.equal(added.headers.get('location'),'/products/house-blend?notice=added_to_cart');
    const page=await app.get(added.headers.get('location')!);assert.equal(page.status,200);const html=await page.text();assert.match(html,/data-notice="added_to_cart"/);assert.match(html,/data-count="1"/);assert.equal(app.remote.mutations,0);
  }finally{app.close();}
});
test('sign-out redirects to a rendered signed-out notice with the rotated cookie',async()=>{
  const app=fixture();try{
    const signedOut=await app.post('/sign-out',{});assert.equal(signedOut.status,303);assert.equal(signedOut.headers.get('location'),'/sign-in?notice=signed_out');
    const cookie=signedOut.headers.get('set-cookie')!.split(';')[0]!;const page=await app.app.request(origin+signedOut.headers.get('location'),{headers:{Cookie:cookie}});
    assert.match(await page.text(),/data-notice="signed_out"/);assert.equal(app.identity.session(app.identitySession.token),undefined);
  }finally{app.close();}
});
test('unknown, parameterized and wrong-page query notices are never echoed or rendered',async()=>{
  const app=fixture();try{
    for(const notice of ['<script>untrusted-notice</script>','email_confirmed_linked:999','signed_out:untrusted-notice','added_to_cart']){
      const html=await (await app.get('/sign-in?notice='+encodeURIComponent(notice))).text();assert.doesNotMatch(html,/data-notice=/);assert.doesNotMatch(html,/untrusted-notice|email_confirmed_linked|notice%3D/);
    }
    assert.doesNotMatch(await (await app.get('/products/house-blend?notice=signed_out')).text(),/data-notice="signed_out"/);
  }finally{app.close();}
});
test('the sign-in navigation link preserves the current safe path and hints without credentials',async()=>{
  const app=fixture();try{
    const html=await (await app.get('/products/house-blend?variant=choice&flint_return_attempt=fixture-attempt&notice=invalid&password=do-not-echo&payment_intent_client_secret=pi_fixture_secret_private')).text();
    const href=html.match(/href="(\/sign-in\?next=[^"]+)"[^>]*data-testid="sf-nav-sign-in"/)?.[1];assert.ok(href);
    const next=new URL(href.replace(/&amp;/g,'&'),origin).searchParams.get('next');assert.equal(next,'/products/house-blend?variant=choice&flint_return_attempt=fixture-attempt');assert.doesNotMatch(html,/do-not-echo|pi_fixture_secret_private|notice%3Dinvalid/);
  }finally{app.close();}
});
test('return-path rendering strips sensitive fields inside nested next while retaining safe hints',()=>{
  const inner='/checkout/chk_fixture?flint_return_attempt=fixture-attempt&password=private&gift_card_code=private-code';
  const path=viewPath('/sign-in?next='+encodeURIComponent(inner)+'&notice=signed_out');
  assert.equal(new URL(path,origin).searchParams.get('next'),'/checkout/chk_fixture?flint_return_attempt=fixture-attempt');
  assert.equal(viewPath('//outside.example/path'),'/');assert.equal(viewPath('/bad%zz'),'/');assert.equal(viewPath('/checkout/ckat_private'),'/');
});
test('invalid sign-in retains only email and the submitted safe next and uses existing failure copy',async()=>{
  const app=fixture();try{
    const response=await app.post('/sign-in?next=/query-choice',{email:'buyer@example.test',password:'never-echo-password',next:'/checkout/chk_fixture?flint_return_attempt=fixture-attempt&password=next-private',credential:'ckat_private',name:'do-not-refill-name'});
    assert.equal(response.status,401);const html=await response.text();assert.equal(inputValue(html,'email'),'buyer@example.test');assert.equal(inputValue(html,'password'),'');assert.equal(inputValue(html,'next'),'/checkout/chk_fixture?flint_return_attempt=fixture-attempt');
    assert.match(html,/Email or password is incorrect/);assert.doesNotMatch(html,/never-echo-password|next-private|ckat_private|do-not-refill-name/);
  }finally{app.close();}
});
test('sign-up duplicate errors retain escaped safe fields and next without password or extra body fields',async()=>{
  const app=fixture();try{
    await app.identity.createUser('Existing buyer','buyer@example.test','a long example password');const name='Buyer "><script>not-an-element</script>';
    const response=await app.post('/sign-up?next=/query-choice',{name,email:'buyer@example.test',password:'private-signup-password',next:'/cart?variant=choice',customer_verification_id:'do-not-refill-proof',extra:'do-not-refill-extra'});
    assert.equal(response.status,409);const html=await response.text();assert.equal(inputValue(html,'name'),name);assert.equal(inputValue(html,'email'),'buyer@example.test');assert.equal(inputValue(html,'password'),'');assert.equal(inputValue(html,'next'),'/cart?variant=choice');
    assert.match(html,/data-testid="sf-sign-up-email-error"/);assert.match(html,/&lt;script&gt;not-an-element&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>not-an-element|private-signup-password|do-not-refill-proof|do-not-refill-extra/);
  }finally{app.close();}
});
test('sign-up validation and rate-limit errors preserve parsed fields and posted next',async()=>{
  const app=fixture();try{
    for(let i=0;i<6;i++){
      const response=await app.post('/sign-up?next=/query-choice',{name:`Buyer ${i}`,email:'not-an-email',password:'private-rate-password',next:'/cart?variant=choice'});
      assert.equal(response.status,i<5?400:429);const html=await response.text();assert.equal(inputValue(html,'name'),`Buyer ${i}`);assert.equal(inputValue(html,'email'),'not-an-email');assert.equal(inputValue(html,'next'),'/cart?variant=choice');assert.equal(inputValue(html,'password'),'');assert.doesNotMatch(html,/private-rate-password/);
      if(i<5)assert.match(html,/id="email-error"/);
    }
  }finally{app.close();}
});
test('CSRF rejection never captures or echoes identity form values',async()=>{
  const app=fixture();try{
    const response=await app.app.request(origin+'/sign-up',{method:'POST',headers:{Cookie:`render_session=${app.identitySession.token}`,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:'wrong',name:'untrusted-name',email:'untrusted@example.test',password:'untrusted-password',next:'/untrusted-next'})});
    assert.equal(response.status,403);const html=await response.text();assert.equal(inputValue(html,'name'),'');assert.equal(inputValue(html,'email'),'');assert.equal(inputValue(html,'password'),'');assert.doesNotMatch(html,/untrusted-name|untrusted@example.test|untrusted-password|untrusted-next/);
  }finally{app.close();}
});
test('checkout flash survives JSON reads and is consumed once by HTML without releasing payment or reconciliation state',async()=>{
  const app=fixture();try{
    const {record}=app.checkout();const action=app.payments.job(record,'pay',{action:'pay',payment_source:{token:'pm_original'},expected_outstanding_money:money});
    app.store.run("UPDATE actions SET status='unknown' WHERE action_id=?",action.action_id);app.store.run('UPDATE checkouts SET cart_dirty=1,needs_replacement=1,flash=?,details=? WHERE checkout_ref=?',JSON.stringify(['checkout_refreshed','affirm_incomplete','reconciliation-marker']),JSON.stringify({verification:{customer_verification_id:'private-proof',status:'code_sent'}}),record.checkout_ref);
    const journal=app.store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',action.action_id)!;
    for(const route of ['state','attempt']){
      const response=await app.get(`/checkout/${record.checkout_ref}/${route}`);assert.equal(response.status,200);const body=await response.json() as {state:{next:string;notices:string[]}};
      assert.equal(body.state.next,'resume');assert.deepEqual(body.state.notices,['checkout_refreshed','affirm_incomplete']);assert.deepEqual(JSON.parse(app.checkouts.record(record.checkout_ref).flash),['checkout_refreshed','affirm_incomplete','reconciliation-marker']);
    }
    const first=await app.get(`/checkout/${record.checkout_ref}`);assert.equal(first.status,200);const html=await first.text();assert.match(html,/data-notice="checkout_refreshed"/);assert.match(html,/data-notice="affirm_incomplete"/);assert.doesNotMatch(html,/private-proof|private-checkout-credential|reconciliation-marker/);
    const after=app.checkouts.record(record.checkout_ref);assert.deepEqual(JSON.parse(after.flash),['reconciliation-marker']);assert.equal(after.cart_dirty,1);assert.equal(after.needs_replacement,1);assert.equal(after.pay_seq,1);assert.equal(after.generation,1);assert.equal(JSON.parse(after.details).verification.customer_verification_id,'private-proof');assert.deepEqual(app.store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',action.action_id),journal);
    const second=await app.get(`/checkout/${record.checkout_ref}`);assert.equal(second.status,200);assert.doesNotMatch(await second.text(),/data-notice="(?:checkout_refreshed|affirm_incomplete)"/);assert.equal(app.remote.mutations,0);assert.ok(app.payments.unresolved(after));
  }finally{app.close();}
});
test('HEAD rendering and a failed real completion render retain flash until a successful GET',async()=>{
  const app=fixture();try{
    const {record}=app.checkout();app.checkouts.notice(record,'checkout_refreshed');
    assert.equal((await app.get(`/checkout/${record.checkout_ref}`,'HEAD')).status,200);assert.deepEqual(JSON.parse(app.checkouts.record(record.checkout_ref).flash),['checkout_refreshed']);
    app.store.run('UPDATE checkouts SET cart_id=NULL WHERE checkout_ref=?',record.checkout_ref);
    app.remote.session={...app.remote.session,status:'paid'};
    const lines=app.remote.order.line_items;app.remote.order={...app.remote.order,payment_status:'paid',line_items:null} as unknown as Order;
    const failed=await app.get(`/checkout/${record.checkout_ref}/complete`);assert.equal(failed.status,500);assert.deepEqual(JSON.parse(app.checkouts.record(record.checkout_ref).flash),['checkout_refreshed']);
    app.remote.order={...app.remote.order,line_items:lines};const succeeded=await app.get(`/checkout/${record.checkout_ref}/complete`);assert.equal(succeeded.status,200);assert.match(await succeeded.text(),/data-notice="checkout_refreshed"/);assert.deepEqual(JSON.parse(app.checkouts.record(record.checkout_ref).flash),[]);assert.equal(app.remote.mutations,0);
  }finally{app.close();}
});
test('paid checkout redirects leave flash for the completion page to display',async()=>{
  const app=fixture();try{
    const {record}=app.checkout();app.checkouts.notice(record,'delivery_released');app.remote.session={...app.remote.session,status:'paid'};app.remote.order={...app.remote.order,payment_status:'paid',settlement_amounts:{...app.remote.order.settlement_amounts,outstanding_money:{amount:'0',currency:'USD'}}};
    const redirect=await app.get(`/checkout/${record.checkout_ref}`);assert.equal(redirect.status,303);assert.deepEqual(JSON.parse(app.checkouts.record(record.checkout_ref).flash),['delivery_released']);
    const completion=await app.get(redirect.headers.get('location')!);assert.equal(completion.status,200);assert.match(await completion.text(),/data-notice="delivery_released"/);assert.deepEqual(JSON.parse(app.checkouts.record(record.checkout_ref).flash),[]);
  }finally{app.close();}
});
test('the locked cart is reachable for an unknown payment and rejected edits preserve the journal and cart',async()=>{
  const app=fixture();try{
    const {cart,record}=app.checkout();const action=app.payments.job(record,'pay',{action:'pay',payment_source:{token:'pm_original'}});app.store.run("UPDATE actions SET status='unknown' WHERE action_id=?",action.action_id);
    const journal=app.store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',action.action_id)!;const lines=app.carts.lines(cart);
    const response=await app.get('/cart');assert.equal(response.status,200);const html=await response.text();assert.match(html,/data-testid="sf-cart" data-state="locked"/);assert.match(html,/href="\/checkout\/chk_fixture"/);assert.doesNotMatch(html,/action="\/cart\/items\//);assert.equal(app.remote.reads,0);
    for(const route of ['/cart/items/fixture-line','/cart/items/fixture-line/remove']){
      const rejected=await app.post(route,{quantity:'2'});assert.equal(rejected.status,409);const rendered=await rejected.text();assert.match(rendered,/data-testid="sf-cart" data-state="locked"/);assert.match(rendered,/data-notice="cart_locked_payment"/);
    }
    const json=await app.post('/cart/items/fixture-line',{quantity:'2'},true);assert.equal(json.status,409);const error=await json.json() as {error:{code:string;message_key:string}};assert.equal(error.error.code,'CHECKOUT_PAYMENT_RESOLVING');assert.equal(error.error.message_key,'cart_locked_payment');
    assert.deepEqual(app.carts.lines(cart),lines);assert.deepEqual(app.store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',action.action_id),journal);assert.equal(app.checkouts.record(record.checkout_ref).cart_dirty,0);assert.equal(app.remote.mutations,0);
    const other=app.identity.createSession();const unrelated=await app.app.request(origin+'/cart',{headers:{Cookie:`render_session=${other.token}`}});assert.doesNotMatch(await unrelated.text(),/\/checkout\/chk_fixture|data-state="locked"/);
  }finally{app.close();}
});
test('active-attempt cart locks use fresh reads and terminal attempts restore the editable cart',async()=>{
  const app=fixture();try{
    const {cart}=app.checkout();app.remote.order={...app.remote.order,active_payment_attempt:{order_payment_attempt_id:'fixture-attempt',status:'processing',is_resumable:false} as OrderPaymentAttempt};
    const locked=await app.get('/cart');assert.equal(locked.status,200);assert.match(await locked.text(),/data-testid="sf-cart" data-state="locked"/);assert.equal(app.remote.mutations,0);
    const rejected=await app.post('/cart/items/fixture-line',{quantity:'2'});assert.equal(rejected.status,409);assert.match(await rejected.text(),/data-notice="cart_locked_payment"/);assert.equal(app.carts.lines(cart)[0]!.quantity,1);
    app.remote.order={...app.remote.order,active_payment_attempt:{...app.remote.order.active_payment_attempt!,status:'failed'}};
    const unlocked=await app.get('/cart');assert.equal(unlocked.status,200);const html=await unlocked.text();assert.match(html,/data-testid="sf-cart" data-state="filled"/);assert.match(html,/action="\/cart\/items\/fixture-line"/);assert.doesNotMatch(html,/href="\/checkout\/chk_fixture"/);assert.equal(app.remote.mutations,0);
  }finally{app.close();}
});
test('a failed lock refresh after a rejected cart edit keeps the rejection and never offers an editable cart',async()=>{
  const app=fixture();try{
    const {cart}=app.checkout();app.remote.order={...app.remote.order,active_payment_attempt:{order_payment_attempt_id:'fixture-attempt',status:'processing',is_resumable:false} as OrderPaymentAttempt};app.remote.readFailureAt=2;
    const rejected=await app.post('/cart/items/fixture-line',{quantity:'2'});assert.equal(rejected.status,409);const html=await rejected.text();assert.match(html,/data-page="error"/);assert.match(html,/Your payment is still being confirmed/);assert.doesNotMatch(html,/action="\/cart\/items\//);assert.equal(app.carts.lines(cart)[0]!.quantity,1);assert.equal(app.remote.mutations,0);
  }finally{app.close();}
});

type VerificationBody={state?:{verification?:Record<string,unknown>};error?:{code:string;message_key:string}};
function verificationClient(app:ReturnType<typeof fixture>,fail?:string){
  const calls:Record<string,unknown>[]=[];
  (app.client.checkoutSessions as unknown as Record<string,unknown>).createCustomerVerification=async(_id:string,params:Record<string,unknown>)=>{
    calls.push(params);if(fail)throw new LocalError(fail,409);
    return {customer_verification_id:`private-verification-${calls.length}`,channel:params.channel==='auto'?'sms':params.channel,...(params.channel==='email'?{email:'b•••@example.test'}:{phone_last_digits:'67'})};
  };
  return calls;
}
test('a code that confirms a saved card sends no address, refuses auto, and is told apart from a code asked for before payment',async()=>{
  const app=fixture();try{
    const {record}=app.checkout();const calls=verificationClient(app);const url=`/checkout/${record.checkout_ref}/verification`;
    const before=await app.post(url,{purpose:'use_saved_payment_methods',channel:'email',email:'buyer@example.test'},true);assert.equal(before.status,200);
    const left=(await before.json() as VerificationBody).state?.verification;assert.equal(left?.purpose,'use_saved_payment_methods');assert.equal(calls[0]!.email,'buyer@example.test');

    const auto=await app.post(url,{purpose:'confirm_saved_payment_method',channel:'auto'},true);assert.equal(auto.status,400);assert.equal(calls.length,1);
    const texted=await app.post(url,{purpose:'confirm_saved_payment_method',channel:'sms',email:'someone-else@example.test'},true);assert.equal(texted.status,200);
    assert.equal(calls.length,2);assert.equal(calls[1]!.purpose,'confirm_saved_payment_method');assert.equal(calls[1]!.channel,'sms');assert.equal('email' in calls[1]!,false);
    const text=await texted.text();assert.doesNotMatch(text,/private-verification|private-checkout-credential/);
    assert.deepEqual((JSON.parse(text) as VerificationBody).state?.verification,{status:'code_sent',purpose:'confirm_saved_payment_method',delivery_channel:'sms',phone_last_digits:'67'});

    const emailed=await app.post(url,{purpose:'confirm_saved_payment_method',channel:'email'},true);assert.equal(emailed.status,200);
    assert.deepEqual((await emailed.json() as VerificationBody).state?.verification,{status:'code_sent',purpose:'confirm_saved_payment_method',delivery_channel:'email',masked_email:'b•••@example.test'});
    assert.equal(JSON.parse(app.checkouts.record(record.checkout_ref).details).verification.purpose,'confirm_saved_payment_method');
  }finally{app.close();}
});
test('codes to confirm a saved card have their own allowance and stop after six',async()=>{
  const app=fixture();try{
    const {record}=app.checkout();verificationClient(app);const url=`/checkout/${record.checkout_ref}/verification`;
    for(let count=0;count<3;count++)assert.equal((await app.post(url,{purpose:'use_saved_payment_methods',channel:'email',email:'buyer@example.test'},true)).status,200);
    assert.equal((await app.post(url,{purpose:'use_saved_payment_methods',channel:'email',email:'buyer@example.test'},true)).status,429);
    for(let count=0;count<6;count++)assert.equal((await app.post(url,{purpose:'confirm_saved_payment_method',channel:count%2?'email':'sms'},true)).status,200);
    assert.equal((await app.post(url,{purpose:'confirm_saved_payment_method',channel:'sms'},true)).status,429);
  }finally{app.close();}
});
test('when a text cannot be sent the answer names the code and keeps the earlier code state',async()=>{
  const app=fixture();try{
    const {record}=app.checkout();verificationClient(app,'CUSTOMER_VERIFICATION_TEXT_UNAVAILABLE');
    const response=await app.post(`/checkout/${record.checkout_ref}/verification`,{purpose:'confirm_saved_payment_method',channel:'sms'},true);
    assert.equal(response.status,409);const body=await response.json() as VerificationBody;
    assert.equal(body.error?.code,'CUSTOMER_VERIFICATION_TEXT_UNAVAILABLE');assert.equal(body.error?.message_key,'customer_verification_text_unavailable');
    assert.equal(body.state?.verification,undefined);assert.equal(JSON.parse(app.checkouts.record(record.checkout_ref).details).verification,undefined);
  }finally{app.close();}
});

function trialState(change:Record<string,unknown>={},order:Record<string,unknown>={}):CheckoutState{
  return {kind:'subscription',next:'new_payment',session:{status:'open'},order:{settlement_amounts:{outstanding_money:{amount:'0',currency:'USD'}},...order},...change} as unknown as CheckoutState;
}
test('a trial whose card setup never ran is the only state that leaves the confirmation page',()=>{
  const cases:[string,CheckoutState,boolean][]=[
    ['no attempt',trialState(),true],
    ['failed setup',trialState({attempt:{status:'failed'}}),true],
    ['canceled setup',trialState({attempt:{status:'canceled'}}),true],
    ['subscription exists',trialState({},{subscription_id:'example-subscription'}),false],
    ['amount due',trialState({},{settlement_amounts:{outstanding_money:{amount:'2200',currency:'USD'}}}),false],
    ['unknown outcome',trialState({next:'resume'}),false],
    ['processing',trialState({next:'wait',attempt:{status:'processing'}}),false],
    ['needs authentication',trialState({next:'authenticate',attempt:{status:'requires_action'}}),false],
    ['setup succeeded, subscription pending',trialState({next:'wait',attempt:{status:'succeeded'}}),false],
    ['done',trialState({next:'done'}),false],
    ['session paid',trialState({session:{status:'paid'}}),false],
    ['session partially paid',trialState({session:{status:'partially_paid'}}),false],
    ['order checkout',trialState({kind:'order'}),false],
  ];
  for(const [name,state,expected] of cases)assert.equal(trialSetupNotStarted(state),expected,name);
});

function unstartedTrial(app:ReturnType<typeof fixture>){
  const {record}=app.checkout();app.store.run("UPDATE checkouts SET kind='subscription' WHERE checkout_ref=?",record.checkout_ref);
  app.remote.order={...app.remote.order,payment_status:'paid',subscription_plan_id:'fixture-plan',settlement_amounts:{...app.remote.order.settlement_amounts,outstanding_money:{amount:'0',currency:'USD'}},setup_collection:{stripe:{elements:{mode:'setup'}}}} as Order;
  return record;
}
test('the real completion route sends an unstarted $0 trial back to checkout with a one-time notice and no Flint mutation',async()=>{
  const app=fixture();try{
    const record=unstartedTrial(app);const flash=()=>JSON.parse(app.checkouts.record(record.checkout_ref).flash) as string[];
    assert.deepEqual(flash(),[]);
    const redirect=await app.get(`/checkout/${record.checkout_ref}/complete`);
    assert.equal(redirect.status,303);assert.equal(redirect.headers.get('location'),`/checkout/${record.checkout_ref}`);assert.deepEqual(flash(),['trial_not_started']);assert.equal(app.remote.mutations,0);
    const shown=await app.get(redirect.headers.get('location')!);assert.equal(shown.status,200);assert.match(await shown.text(),/data-notice="trial_not_started"/);
    assert.deepEqual(flash(),[]);assert.equal(app.remote.mutations,0);
    const again=await app.get(`/checkout/${record.checkout_ref}`);assert.equal(again.status,200);assert.doesNotMatch(await again.text(),/data-notice="trial_not_started"/);
    assert.equal(app.remote.mutations,0);
  }finally{app.close();}
});
test('the real completion route keeps a $0 trial with an unknown payment outcome on the confirming page',async()=>{
  const app=fixture();try{
    const record=unstartedTrial(app);const action=app.payments.job(record,'pay',{action:'setup',setup_payment_source:{token:'pm_trial'}});
    app.store.run("UPDATE actions SET status='unknown' WHERE action_id=?",action.action_id);
    const response=await app.get(`/checkout/${record.checkout_ref}/complete`);
    assert.equal(response.status,200);assert.equal(response.headers.get('location'),null);assert.match(await response.text(),/data-testid="sf-complete"/);
    assert.deepEqual(JSON.parse(app.checkouts.record(record.checkout_ref).flash),[]);assert.equal(app.remote.mutations,0);
  }finally{app.close();}
});
