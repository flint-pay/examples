import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@flintpay/node';
import type {RequestOptions,Order,BuyerGiftCard,BuyerGiftCardTransaction,PaymentIntent,PaymentSourceSummary,PickupFulfillmentDetails} from '@flintpay/node';
import {createApp} from '../../src/app.ts';
import {IdentityStore} from '../../src/identity/index.ts';
import {Store} from '../../src/store/db.ts';
import {readConfig} from '../../src/config.ts';
import {LocalError} from '../../src/flint/errors.ts';
const config=readConfig({FLINT_API_KEY:'flint_test_PLACEHOLDER',FLINT_API_BASE_URL:'https://api.staging.withflintpay.com',APP_ORIGIN:'http://localhost:4200',PORT:'4200'});
async function harness(api:unknown,appConfig=config){
  const identity=new IdentityStore(':memory:'),store=new Store(':memory:');
  const user=await identity.createUser('Example','buyer@example.invalid','example password');identity.bind(user.user_id,'sandbox_example','cus_example',user.email);
  identity.saveVault({user_id:user.user_id,sandbox_id:'sandbox_example',customer_session_id:'session_example',secret:'example customer authority',refresh_token:'example refresh authority',expires_at:Date.now()+3600000,refresh_expires_at:Date.now()+86400000});
  const session=identity.createSession(user.user_id);let rendered:unknown;
  const {app}=createApp({config:appConfig,client:api as Client,identity,store,preflight:{sandboxId:'sandbox_example',merchantId:'mer_example',cards:'ready',setupNeeded:false,capabilities:null,support:{}},render:async(pageId,context)=>{rendered={pageId,...context};return '<!doctype html><title>Local renderer boundary</title>';},paymentDelay:async()=>{}});
  const headers={Cookie:`${config.cookieName}=${session.token}`,Origin:config.appOrigin,'X-CSRF-Token':session.session.csrf_token,'Content-Type':'application/json'};
  return {app,identity,store,user,session,headers,rendered:()=>rendered,close:()=>{store.close();identity.close();}};
}
test('health exposes configured source identity and process start without inventing a build',async()=>{
  const sha='a'.repeat(40),build=readConfig({FLINT_API_KEY:'flint_test_PLACEHOLDER',FLINT_API_BASE_URL:config.apiBaseUrl,APP_ORIGIN:config.appOrigin,PORT:'4200',BUILD_SHA:sha,BUILD_ARTIFACT_ID:sha+':headless/account'});
  for(const configured of [config,build]){
    const h=await harness({},configured);try{
      const response=await h.app.request('/healthz');assert.equal(response.status,200);const body=await response.json();
      assert.equal(body.mode,'test');assert.equal(body.sandbox_id,'sandbox_example');assert.deepEqual(body.build,configured.build);assert.equal('apiKey'in body,false);
    }finally{h.close();}
  }
});
test('unsafe requests reject missing Origin and CSRF before any provider call',async()=>{
  let writes=0;const h=await harness({me:{update:async()=>{writes++;return {};}}});try{
    for(const headers of [{...h.headers,Origin:'http://other.invalid'},{...h.headers,'X-CSRF-Token':'wrong'}]){const response=await h.app.request('/profile',{method:'POST',headers,body:JSON.stringify({name:'Changed'})});assert.equal(response.status,403);assert.equal((await response.json()).error.code,'CSRF_REJECTED');}
    assert.equal(writes,0);
  }finally{h.close();}
});
test('foreign resource mutations and payment launches stop at the buyer ownership read',async()=>{
  let writes=0;const h=await harness({me:{getOrder:async()=>{throw new LocalError('NOT_FOUND',404);},getInvoice:async()=>{throw new LocalError('NOT_FOUND',404);},sendOrderReceipt:async()=>{writes++;},createInvoiceCheckoutSession:async()=>{writes++;}}});try{
    const receipt=await h.app.request('/orders/ord_foreign/receipt',{method:'POST',headers:h.headers,body:'{}'});assert.equal(receipt.status,404);
    const pay=await h.app.request('/invoices/inv_foreign/pay',{headers:{Cookie:h.headers.Cookie,Accept:'application/json'}});assert.equal(pay.status,404);assert.equal(writes,0);assert.equal(h.store.all('SELECT * FROM payment_checkouts').length,0);
    assert.equal(JSON.stringify(await receipt.json()).includes('cus_example'),false);
  }finally{h.close();}
});
test('foreign environment hints return before any customer data or credential mint',async()=>{
  const h=await harness({});try{
    const response=await h.app.request('/orders/ord_example?flint_merchant_id=mer_other&flint_mode=sandbox&flint_environment_id=sandbox_example&flint_resource_type=order&flint_resource_id=ord_example&flint_action=view',{headers:{Cookie:h.headers.Cookie}});
    assert.equal(response.status,303);assert.equal(response.headers.get('Location'),'/');assert.equal(await response.text(),'');
  }finally{h.close();}
});
test('signed-out hints preserve full next through the login entry point',async()=>{
  const h=await harness({});try{
    const path='/invoices/inv_example?flint_mode=sandbox&flint_resource_type=invoice&flint_resource_id=inv_example&flint_action=view';
    const response=await h.app.request(path);assert.equal(response.status,303);assert.equal(new URL(response.headers.get('Location')!,'http://localhost').searchParams.get('next'),path);
  }finally{h.close();}
});
test('a customer 401 ends the local session and sign-in renders the allowlisted notice with the full return path',async()=>{
  const h=await harness({me:{getOrder:async()=>{throw new LocalError('INVALID_CUSTOMER_SESSION',401);}}});try{
    const path='/orders/ord_example?view=details&sort=newest';
    const response=await h.app.request(path,{headers:{Cookie:h.headers.Cookie}});assert.equal(response.status,303);
    const location=response.headers.get('Location')!,url=new URL(location,config.appOrigin);
    assert.equal(url.pathname,'/sign-in');assert.equal(url.searchParams.get('notice'),'session_ended');assert.equal(url.searchParams.get('next'),path);assert.equal(h.identity.session(h.session.token),undefined);
    assert.equal((await h.app.request(location)).status,200);
    const context=h.rendered() as {notices:unknown[];data:{next:string}};
    assert.deepEqual(context.notices,['session_ended']);assert.equal(context.data.next,path);
  }finally{h.close();}
});
test('sign-in accepts only session-ended query notices and preserves existing flash state',async()=>{
  const h=await harness({});try{
    const error={code:'INVALID_LOGIN',kind:'validation',message_key:'invalid_login'},form={values:{email:'buyer@example.invalid'}};
    const flash={notices:['profile_saved'],error,form};
    h.identity.db.prepare('UPDATE sessions SET flash=? WHERE session_hash=?').run(JSON.stringify(flash),h.session.session.session_hash);
    assert.equal((await h.app.request('/sign-in?notice=session_ended&next=%2Forders',{headers:{Cookie:h.headers.Cookie}})).status,200);
    const context=h.rendered() as {notices:unknown[];error:unknown;data:{next:string;email:string}};
    assert.deepEqual(context.notices,['profile_saved','session_ended']);assert.deepEqual(context.error,error);assert.equal(context.data.email,form.values.email);assert.equal(context.data.next,'/orders');
    for(const notice of ['wrong_environment','arbitrary_notice','%3Cscript%3E']){
      await h.app.request('/sign-in?notice='+notice);assert.deepEqual((h.rendered() as {notices:unknown[]}).notices,[]);
    }
  }finally{h.close();}
});
test('published buyer SDK data reaches gift history and order summaries through customer-only transports',async()=>{
  const money={amount:'2000',currency:'USD'},zero={amount:'0',currency:'USD'},postedAt='2026-01-02T12:00:00Z';
  const transaction={gift_card_id:'gfc_example',gift_card_transaction_id:'gct_example',transaction_type:'redeem',posted_at:'2026-01-02T12:00:00Z',sequence:'2',amount_money:{amount:'-500',currency:'USD'},balance_before_money:{amount:'2500',currency:'USD'},balance_after_money:money} satisfies BuyerGiftCardTransaction;
  const source={type:'card',card:{brand:'visa',last4:'4242'}} satisfies PaymentSourceSummary;
  const pickup={location_name:'Example Store',address:{line1:'123 Example Street',city:'Example City',state:'NY',postal_code:'10001',country:'US'},instructions:'Collect at the counter.',ready_at:'2026-01-02T12:00:00Z',window_start_at:'2026-01-02T12:00:00Z',window_end_at:'2026-01-02T13:00:00Z',timezone:'America/New_York'} satisfies PickupFulfillmentDetails;
  const giftCard={gift_card_id:'gfc_example',merchant_id:'mer_example',status:'active',currency:'USD',last_characters:'EXAMPLE',balance_money:money,available_money:money,reserved_money:zero,created_at:postedAt,updated_at:postedAt,last_loaded_at:postedAt,last_redeemed_at:postedAt,version:'1'} satisfies BuyerGiftCard;
  const paidOrder={order_id:'ord_example',status:'closed',payment_status:'paid',refund_status:'none',buyer_actions:[],line_items:[],pricing_amounts:{total_money:money,subtotal_money:money,charge_money:zero,discount_money:zero,requested_tip_money:zero,tax_money:zero},settlement_amounts:{balance_money:zero,credit_money:zero,net_collected_money:money,outstanding_money:zero,paid_money:money,refunded_money:zero,settled_tip_money:zero},tax:{enabled:false,mode:'external',status:'not_required',taxability_reason:'tax_disabled'}} satisfies Order;
  const payment={payment_intent_id:'intent_example',status:'succeeded',amount_money:money,payment_source:source,payment_flow:'checkout',payment_options:['card'],last_payment_error:null,risk:null,support_reference:'EXAMPLE'} satisfies PaymentIntent;
  const replies:Record<string,unknown>={
    '/v1/me/gift-cards/gfc_example':{data:giftCard},
    '/v1/me/gift-cards/gfc_example/transactions':{data:[{...transaction,metadata:{private:'private'}}]},
    '/v1/me/orders/ord_example':{data:paidOrder},
    '/v1/me/payments':{data:[{...payment,payment_source:{...source,card:{...source.card,fingerprint:'private'}}}]},
    '/v1/me/fulfillments':{data:[{fulfillment_id:'ful_example',order_id:'ord_example',type:'pickup',status:'ready',line_items:[],request_status:'accepted',supported_actions:[],version:'1',pickup_details:{...pickup,metadata:{private:'private'}}}]},
    '/v1/me/refunds':{data:[]},'/v1/me/shipments':{data:[]},'/v1/me/packages':{data:[]},'/v1/me/fulfillment-events':{data:[]}
  };
  const requests:URL[]=[];
  const client=new Client({baseUrl:config.apiBaseUrl,maxAttempts:1,transport:async(input,init)=>{
    const url=new URL(String(input)),headers=new Headers(init?.headers);requests.push(url);
    assert.equal(headers.get('Authorization'),'Bearer example customer authority');assert.equal(headers.get('X-API-Key'),null);assert.equal(headers.get('X-Checkout-Session-ID'),null);assert.equal(headers.get('X-Checkout-Session-Secret'),null);
    assert.ok(Object.hasOwn(replies,url.pathname),url.pathname);
    return new Response(JSON.stringify(replies[url.pathname]),{headers:{'Content-Type':'application/json','Flint-Mode':'test','Flint-Sandbox-ID':'sandbox_example'}});
  }});
  const h=await harness(client);try{
    assert.equal((await h.app.request('/gift-cards/gfc_example',{headers:{Cookie:h.headers.Cookie}})).status,200);
    const gift=h.rendered() as {pageId:string;data:{transactions:{status:string;value:BuyerGiftCardTransaction[]}}};assert.equal(gift.pageId,'ac-gift-card');assert.equal(gift.data.transactions.status,'ok');assert.equal(gift.data.transactions.value[0]?.transaction_type,'redeem');assert.equal(gift.data.transactions.value[0]?.posted_at,transaction.posted_at);assert.equal('metadata'in gift.data.transactions.value[0]!,false);
    assert.equal((await h.app.request('/orders/ord_example',{headers:{Cookie:h.headers.Cookie}})).status,200);
    const order=h.rendered() as {data:{payments:{status:string;value:{payment_source:PaymentSourceSummary}[]};fulfillments:{status:string;value:{pickup_details:PickupFulfillmentDetails}[]}}};
    assert.equal(order.data.payments.status,'ok');assert.deepEqual(order.data.payments.value[0]?.payment_source,source);assert.equal(order.data.fulfillments.status,'ok');assert.deepEqual(order.data.fulfillments.value[0]?.pickup_details,pickup);
    assert.equal(requests.length,Object.keys(replies).length);
    for(const request of requests.filter(url=>!url.pathname.includes('/gift-cards/')&&!url.pathname.includes('/orders/')))assert.equal(request.searchParams.get('order_id'),'ord_example');
  }finally{h.close();await client.close();}
});
test('list envelopes are composed and customer reads carry no merchant or checkout authority',async()=>{
  const seen:RequestOptions[]=[];const money={amount:'1000',currency:'USD'};
  const order={order_id:'ord_example',order_number:'EXAMPLE',buyer_actions:[],payment_status:'paid',pricing_amounts:{total_money:money},metadata:{private:'private'},checkout_session_ids:['session_example']} as unknown as Order;
  const h=await harness({me:{listOrders:async(_params:unknown,options:RequestOptions)=>{seen.push(options);return {data:[order],next_page_token:'example-page'};}}});try{
    const response=await h.app.request('/orders',{headers:{Cookie:h.headers.Cookie}});assert.equal(response.status,200);
    const context=h.rendered() as {data:{orders:{value:{items:Order[];next_page_token:string}}}};assert.equal(context.data.orders.value.next_page_token,'example-page');assert.equal(context.data.orders.value.items[0]?.order_id,'ord_example');assert.equal('metadata'in context.data.orders.value.items[0]!,false);
    assert.equal(seen[0]?.customerToken,'example customer authority');assert.equal(seen[0]?.apiKey,undefined);assert.equal(seen[0]?.authMode,undefined);
    assert.equal(response.headers.get('Cache-Control'),'no-store');assert.ok(response.headers.get('Content-Security-Policy')?.includes("frame-ancestors 'none'"));
  }finally{h.close();}
});
test('public preference lookup requires Origin but works without login and excludes customer id',async()=>{
  const h=await harness({emailPreferenceLinks:{lookup:async(body:{token:string})=>{assert.equal(body.token,'example preference token');return {customer_id:'cus_example',email:'buyer@example.invalid',email_preference:'shipping_updates',enabled:true};}}});try{
    const response=await h.app.request('/email-preferences/lookup',{method:'POST',headers:{Origin:config.appOrigin,'Content-Type':'application/json'},body:JSON.stringify({token:'example preference token'})});assert.equal(response.status,200);
    const data=await response.json();assert.deepEqual(data,{link:{email:'buyer@example.invalid',email_preference:'shipping_updates',enabled:true}});
  }finally{h.close();}
});
test('invoice PDF is forwarded as binary after ownership verification',async()=>{
  const bytes=new Uint8Array([37,80,68,70,45,255]);const h=await harness({me:{getInvoice:async()=>({invoice_id:'inv_example'}),getInvoicePDF:async()=>({data:bytes})}});try{
    const response=await h.app.request('/invoices/inv_example/pdf',{headers:{Cookie:h.headers.Cookie}});assert.equal(response.headers.get('Content-Type'),'application/pdf');assert.match(response.headers.get('Content-Disposition')!,/attachment/);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);
  }finally{h.close();}
});
test('login rotates the local session and preserves the hinted destination through the real form route',async()=>{
  const h=await harness({});try{
    const next='/invoices/inv_example?flint_resource_type=invoice&flint_resource_id=inv_example&flint_action=view&flint_mode=sandbox';
    const response=await h.app.request('/sign-in',{method:'POST',headers:{Cookie:h.headers.Cookie,Origin:config.appOrigin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:h.session.session.csrf_token,email:h.user.email,password:'example password',next}).toString()});
    assert.equal(response.status,303);assert.equal(response.headers.get('Location'),next);assert.equal(h.identity.session(h.session.token),undefined);
    assert.match(response.headers.get('Set-Cookie')!,/HttpOnly/);assert.match(response.headers.get('Set-Cookie')!,/SameSite=Lax/);
  }finally{h.close();}
});
test('wrong password attempts use a real local rate limit',async()=>{
  const h=await harness({});try{
    for(let i=0;i<5;i++){const response=await h.app.request('/sign-in',{method:'POST',headers:h.headers,body:JSON.stringify({email:h.user.email,password:'wrong password'})});assert.equal(response.status,400);assert.equal((await response.json()).error.code,'INVALID_LOGIN');}
    const limited=await h.app.request('/sign-in',{method:'POST',headers:h.headers,body:JSON.stringify({email:h.user.email,password:'wrong password'})});assert.equal(limited.status,429);
  }finally{h.close();}
});
test('pending email changes reserve the new email in the shared canonical identity store',async()=>{
  const h=await harness({me:{createEmailChangeRequest:async(body:{new_email:string})=>({email_change_request_id:'email_change_example',customer_id:'cus_example',new_email:body.new_email,confirmed:false,current_email_confirmation_required:true,created_at:new Date().toISOString(),expires_at:new Date(Date.now()+3600000).toISOString()})}});try{
    const response=await h.app.request('/profile/email',{method:'POST',headers:h.headers,body:JSON.stringify({new_email:'new-buyer@example.invalid'})});assert.equal(response.status,200);assert.equal('customer_id'in(await response.json()).request,false);
    await assert.rejects(h.identity.createUser('Another','new-buyer@example.invalid','another example password'),/email_reserved/);
  }finally{h.close();}
});
test('foreign saved address mutations perform no write',async()=>{
  let writes=0;const h=await harness({me:{getAddress:async()=>{throw new LocalError('NOT_FOUND',404);},deleteAddress:async()=>{writes++;},setDefaultAddress:async()=>{writes++;}}});try{
    for(const path of ['/addresses/address_foreign/default','/addresses/address_foreign/delete']){const response=await h.app.request(path,{method:'POST',headers:h.headers,body:JSON.stringify({kind:'billing'})});assert.equal(response.status,404);}
    assert.equal(writes,0);
  }finally{h.close();}
});
test('recipient save passes only the validated proof through the buyer bridge and exposes no proof in response or render',async()=>{
  const grant='gcg_'+'0'.repeat(26),token='synthetic recipient proof';let writes=0;
  const h=await harness({me:{saveGiftCard:async(body:unknown,options:RequestOptions)=>{
    writes++;assert.deepEqual(body,{credential_type:'recipient_access',grant_id:grant,recipient_access_token:token});
    assert.equal(options.customerToken,'example customer authority');assert.equal(options.apiKey,undefined);assert.equal(options.authMode,undefined);assert.ok(options.idempotencyKey);
    return {gift_card_id:'gfc_example',status:'active',available_money:{amount:'2500',currency:'USD'},grant_id:grant,recipient_access_token:token};
  }}});try{
    const response=await h.app.request('/gift-cards',{method:'POST',headers:h.headers,body:JSON.stringify({credential_type:'recipient_access',grant_id:grant,recipient_access_token:token,url:'https://checkout.example.invalid/gift-cards/'+grant+'?mode=test#token=synthetic',query:'mode=test'})});
    assert.equal(response.status,200);const body=await response.text();assert.equal(body.includes(token),false);assert.equal(body.includes(grant),false);assert.equal(body.includes('checkout.example.invalid'),false);assert.equal(writes,1);assert.equal(h.rendered(),undefined);
  }finally{h.close();}
});
test('malformed recipient proofs stop before customer authority or save and form errors never echo credentials',async()=>{
  const grant='gcg_'+'0'.repeat(26),token='synthetic recipient proof';const h=await harness({});try{
    // An empty SDK client proves validation precedes any authority mint or read.
    for(const body of [{grant_id:'gcg_example',recipient_access_token:token},{grant_id:grant,recipient_access_token:''},{grant_id:grant,recipient_access_token:'s'.repeat(4097)},{recipient_url:'https://checkout.example.invalid/gift-cards/'+grant+'#token=synthetic'}]){
      const response=await h.app.request('/gift-cards',{method:'POST',headers:h.headers,body:JSON.stringify({credential_type:'recipient_access',...body})});
      assert.equal(response.status,400);assert.equal((await response.json()).error.code,'INVALID_INPUT');
    }
    const form=await h.app.request('/gift-cards',{method:'POST',headers:{Cookie:h.headers.Cookie,Origin:config.appOrigin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:h.session.session.csrf_token,credential_type:'recipient_access',grant_id:'gcg_example',recipient_access_token:token}).toString()});
    assert.equal(form.status,303);assert.equal(form.headers.get('Location'),'/gift-cards/add');
    const flashed=h.store.all('SELECT * FROM actions');assert.equal(flashed.length,0);
    const shown=await h.app.request('/gift-cards/add',{headers:{Cookie:h.headers.Cookie}});assert.equal(shown.status,200);assert.equal(JSON.stringify(h.rendered()).includes(token),false);assert.equal(JSON.stringify(h.rendered()).includes('gcg_example'),false);
  }finally{h.close();}
});
test('an unknown gift card code returns to the add form while foreign resources still redirect home',async()=>{
  const code='SYNTHETIC-EXAMPLE-CODE';let reads=0;
  const h=await harness({me:{saveGiftCard:async()=>{throw new LocalError('GIFT_CARD_NOT_FOUND',404);},getGiftCard:async()=>{reads++;throw new LocalError('NOT_FOUND',404);}}});try{
    const form={Cookie:h.headers.Cookie,Origin:config.appOrigin,'Content-Type':'application/x-www-form-urlencoded'};
    const save=await h.app.request('/gift-cards',{method:'POST',headers:form,body:new URLSearchParams({_csrf:h.session.session.csrf_token,credential_type:'code',code}).toString()});
    assert.equal(save.status,303);assert.equal(save.headers.get('Location'),'/gift-cards/add');
    const shown=await h.app.request('/gift-cards/add',{headers:{Cookie:h.headers.Cookie}});assert.equal(shown.status,200);
    const page=h.rendered() as {pageId:string;notices:string[];error:{code:string;message_key:string}};
    assert.equal(page.pageId,'ac-gift-card-add');assert.equal(page.error.message_key,'gift_card_invalid');assert.deepEqual(page.notices,[]);assert.equal(JSON.stringify(page).includes(code),false);
    const foreign=await h.app.request('/gift-cards/gfc_foreign/remove',{method:'POST',headers:form,body:new URLSearchParams({_csrf:h.session.session.csrf_token}).toString()});
    assert.equal(foreign.status,303);assert.equal(foreign.headers.get('Location'),'/');assert.equal(reads,1);
    assert.deepEqual(JSON.parse((h.identity.db.prepare('SELECT flash FROM sessions WHERE session_hash=?').get(h.session.session.session_hash) as {flash:string}).flash),{notices:['not_in_account']});
  }finally{h.close();}
});
