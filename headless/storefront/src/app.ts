import {Hono} from 'hono';
import type {Context} from 'hono';
import {getCookie,setCookie} from 'hono/cookie';
import {bodyLimit} from 'hono/body-limit';
import {serveStatic} from '@hono/node-server/serve-static';
import type {ContentfulStatusCode} from 'hono/utils/http-status';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {IncomingMessage} from 'node:http';
import type {Client,DeliveryAddressRequestInput,MoneyValue,OrderTaxLocationFullAddressRequestInput} from '@flintpay/node';
import {SDK_VERSION} from './config.ts';
import type {Config} from './config.ts';
import {createAuth} from './flint/auth.ts';
import {createClient} from './flint/client.ts';
import {LocalError,appError,errorStatus,unknownOutcome} from './flint/errors.ts';
import type {Preflight} from './flint/preflight.ts';
import {Catalog} from './flint/catalog.ts';
import {Checkouts} from './flint/checkouts.ts';
import type {Quote,ReadCheckout,Details} from './flint/checkouts.ts';
import {IdentityBinding} from './flint/identity-binding.ts';
import {IdentityStore,normalizeEmail,verifyPassword,equalSecret,digest} from './identity/index.ts';
import type {Session,User} from './identity/index.ts';
import {Store} from './store/db.ts';
import {Carts} from './store/cart.ts';
import {PaymentEngine} from './payments/engine.ts';
import type {PayInput,PaymentResult} from './payments/engine.ts';
import {RateLimiter} from './security/rate-limit.ts';
import {securityHeaders} from './security/headers.ts';
import {validProof} from './flint/gift-challenge.ts';
import {logRequest,logLaunchInvalid} from './security/log.ts';
import {returnPath} from './security/paths.ts';
import {decimalMinor} from './security/money.ts';
import {buyerSafe} from './flint/projection.ts';
import type {PageId,ViewContext} from './flint/view-data.ts';
import {viewPath} from './flint/view-data.ts';
import {renderPage} from './views/index.ts';
import {trialSetupNotStarted} from './views/pages/complete.ts';
import type {CheckoutState} from './views/types.ts';

type Env={Bindings:{incoming?:IncomingMessage};Variables:{session:Session;user:User|undefined;requestId:string;returnNext?:string;form?:ViewContext['form']}};
export type AppOptions={config:Config;preflight:Preflight;client?:Client;store?:Store;identity?:IdentityStore};
type Body=Record<string,unknown>;
function text(value:unknown,max=255):string {if(typeof value!=='string'||value.length>max)throw new LocalError('INVALID_INPUT');return value.trim();}
function password(value:unknown):string{if(typeof value!=='string'||value.length>256)throw new LocalError('INVALID_INPUT');return value;}
function email(value:unknown):string{const normalized=normalizeEmail(text(value));if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))throw new LocalError('INVALID_EMAIL');return normalized;}
function phone(value:unknown):string|null {
  const raw=text(value,32).replace(/[\s().-]/g,'');if(!raw)return null;
  const normalized=/^\d{10}$/.test(raw)?`+1${raw}`:raw;
  if(!/^\+[1-9]\d{1,14}$/.test(normalized))throw new LocalError('INVALID_PHONE');return normalized;
}
async function body(c:Context<Env>):Promise<Body>{
  const value:unknown=c.req.header('content-type')?.includes('application/json')?await c.req.json().catch(()=>{throw new LocalError('INVALID_INPUT');}):await c.req.parseBody();
  if(!value||typeof value!=='object'||Array.isArray(value))throw new LocalError('INVALID_INPUT');return value as Body;
}
function asRecord(value:unknown):Body{if(!value||typeof value!=='object'||Array.isArray(value))throw new LocalError('INVALID_INPUT');return value as Body;}
function approvedMoney(value:unknown):MoneyValue{const record=asRecord(value);const amount=text(record.amount,20);const currency=text(record.currency,3);if(!/^\d+$/.test(amount)||!/^[A-Z]{3}$/.test(currency))throw new LocalError('INVALID_AMOUNT');return {amount,currency};}

export function createApp(options:AppOptions){
  const {config,preflight}=options;
  const client=options.client??createClient(config.apiBaseUrl,config.sandboxGuard);const auth=createAuth(config.apiKey);
  const store=options.store??new Store(config.appDatabasePath);const identity=options.identity??new IdentityStore(config.identityDatabasePath);
  const catalog=new Catalog(client,auth);const carts=new Carts(store,catalog);const payments=new PaymentEngine(client,auth,store);
  const checkouts=new Checkouts(client,auth,store,identity,config,preflight.sandboxId,carts,payments);
  const binding=new IdentityBinding(client,auth,identity,preflight.sandboxId);const limits=new RateLimiter();const app=new Hono<Env>();
  const jsonWanted=(c:Context<Env>)=>c.req.header('content-type')?.includes('application/json')||c.req.header('accept')?.includes('application/json')||/\/(state|attempt|saved-methods)$/.test(c.req.path);
  function cookie(c:Context<Env>,token:string){c.header('Set-Cookie',undefined);setCookie(c,config.cookieName,token,{httpOnly:true,secure:config.appOrigin.startsWith('https:'),sameSite:'Lax',path:'/',maxAge:30*24*60*60});}
  function requireUser(c:Context<Env>):User{const user=c.get('user');if(!user||user.status==='closed')throw new LocalError('SESSION_ENDED',401);return user;}
  function limited(c:Context<Env>,kind:string,count:number,window:number,emailKey=''){
    const session=c.get('session');const ip=c.env?.incoming?.socket.remoteAddress??'direct';
    if(!limits.take(`${kind}:session:${session.session_hash}`,count,window)||!limits.take(`${kind}:ip:${ip}:${digest(emailKey)}`,count,window))throw new LocalError('RATE_LIMITED',429);
  }
  async function page(c:Context<Env>,pageId:PageId,data:Record<string,unknown>={},status:ContentfulStatusCode=200,error?:ReturnType<typeof appError>,notices:string[]=[]){
    const session=c.get('session');const user=c.get('user');const cart=carts.current(session,user);
    const queryNotice=c.req.query('notice');const fromRedirect=pageId==='sf-product'&&queryNotice==='added_to_cart'?'added_to_cart':pageId==='sign-in'&&queryNotice==='signed_out'?'signed_out':undefined;
    const url=new URL(c.req.url);
    const context:ViewContext={storeName:config.storeName,csrf:session.csrf_token,user:user?{name:user.name,email:user.email}:null,cartCount:carts.lines(cart).reduce((sum,line)=>sum+line.quantity,0),accountOrigin:config.accountOrigin??null,appOrigin:config.appOrigin,giftChallengeOrigin:config.giftChallengeOrigin,data,notices:[...new Set([...notices,...(fromRedirect?[fromRedirect]:[])])],error,form:c.get('form'),path:viewPath(url.pathname+url.search)};
    return c.html(await renderPage(pageId,context),status);
  }
  async function checkoutPage(c:Context<Env>,pageId:'sf-checkout'|'sf-complete',data:Record<string,unknown>,read:ReadCheckout){
    const notices=checkouts.displayNotices(read.record);const response=await page(c,pageId,data,200,undefined,notices);
    if(c.req.method==='GET')checkouts.consumeNotices(read.record,notices);
    return response;
  }
  async function cartData(c:Context<Env>){
    const cart=carts.current(c.get('session'),c.get('user'));const locked=await checkouts.cartLock(cart,c.get('session'),c.get('user'));
    return {cart:await carts.view(cart),locked:!!locked,checkoutRef:locked?.checkout_ref??null};
  }
  function rememberForm(c:Context<Env>,input:Body,pageId:'sign-in'|'sign-up'){
    c.set('returnNext',viewPath(input.next));const values:Record<string,string>={};
    for(const name of pageId==='sign-up'?['name','email']:['email']){
      const value=input[name];if(typeof value==='string'&&value.length<=(name==='name'?200:255)&&buyerSafe(value)!==undefined)values[name]=value.trim();
    }
    c.set('form',{values});
  }
  async function state(c:Context<Env>,result?:PaymentResult){
    const read=await checkouts.read(c.req.param('ref')!,c.get('user'));
    if(result?.totalChanged){read.result.totalChanged=true;checkouts.notice(read.record,'total_changed');if(result.order.gift_cards?.length)checkouts.notice(read.record,'gift_card_changed');}
    return {read,state:checkouts.project(read)};
  }
  const own=(c:Context<Env>)=>checkouts.owned(c.req.param('ref')!,c.get('session'),c.get('user'));
  async function job(c:Context<Env>,run:()=>Promise<unknown>){own(c);await checkouts.read(c.req.param('ref')!,c.get('user'));await run();return c.json({state:(await state(c)).state});}
  function paymentJson(c:Context<Env>,read:ReadCheckout,result?:PaymentResult){
    const current=read.result;const next=payments.next(current);const action=current.attempt?.status==='requires_action'?current.attempt.pending_actions?.[0]:undefined;
    return c.json({state:checkouts.project(read),next,client_action:action?.client_action.stripe,pending_action_id:action?.pending_action_id,...(current.totalChanged?{error:{kind:'conflict',code:'ORDER_CHANGED_REFRESH_REQUIRED',message_key:current.order.gift_cards?.length?'gift_card_changed':'total_changed'}}:{})});
  }
  app.use('*',bodyLimit({maxSize:65536,onError:c=>c.json({error:{kind:'validation',code:'REQUEST_TOO_LARGE',message_key:'generic_error'}},413)}));
  app.use('*',async(c,next)=>{
    const started=Date.now();const requestId=randomUUID();c.set('requestId',requestId);c.header('X-Request-Id',requestId);
    for(const [name,value] of Object.entries(securityHeaders(config)))c.header(name,value);
    await next();logRequest({request_id:requestId,route:c.req.path,status:c.res.status,duration_ms:Date.now()-started});
  });
  app.get('/healthz',c=>c.json({status:'ok',app:'storefront',sandbox_id:preflight.sandboxId,mode:'test',sdk_version:SDK_VERSION,cards:preflight.cards,...(config.build?{build:config.build}:{})}));
  const publicRoot=fileURLToPath(new URL('../public/',import.meta.url));
  app.get('/js/*',serveStatic({root:publicRoot}));app.get('/images/*',serveStatic({root:publicRoot}));app.get('/styles.css',serveStatic({root:publicRoot}));
  app.post('/webhooks/flint',async c=>{
    if(!config.webhookSecret)return c.body(null,404);
    const raw=new Uint8Array(await c.req.arrayBuffer());let event:Body;
    try{event=asRecord(client.verifyWebhook(raw,c.req.raw.headers,config.webhookSecret).event);}catch{return c.json({error:'invalid_signature'},400);}
    if(event.mode!=='test')return c.json({error:'invalid_mode'},400);
    const eventId=c.req.header('webhook-id');if(!eventId||typeof event.event_type!=='string')return c.json({error:'invalid_event'},400);
    const data=asRecord(event.data);const object=(data.order??data.checkout_session??data.payment_intent??data.subscription) as Body|undefined;
    const objectId=object?.order_id??object?.checkout_session_id??object?.payment_intent_id??object?.subscription_id;
    store.transaction(()=>{
      const inserted=store.run('INSERT OR IGNORE INTO webhook_events VALUES(?,?,?,?)',eventId,event.event_type as string,typeof objectId==='string'?objectId:null,Date.now());
      if(inserted.changes!==1)return;
      if(event.event_type==='order.paid'&&typeof object?.order_id==='string')store.run('INSERT OR IGNORE INTO order_signals VALUES(?,?)',object.order_id,Date.now());
      if(event.event_type==='checkout_session.invalidated'&&typeof object?.checkout_session_id==='string')store.run('UPDATE checkouts SET needs_replacement=1 WHERE checkout_session_id=?',object.checkout_session_id);
    });
    return c.json({received:true});
  });
  app.use('*',async(c,next)=>{
    const mutating=!['GET','HEAD','OPTIONS'].includes(c.req.method);
    if(mutating&&c.req.header('origin')!==config.appOrigin)throw new LocalError('CSRF_ORIGIN_REJECTED',403);
    const token=getCookie(c,config.cookieName);let session=identity.session(token);
    if(!session&&mutating)throw new LocalError('SESSION_ENDED',401);
    if(!session){const created=identity.createSession();session=created.session;cookie(c,created.token);}else if(token)cookie(c,token);
    c.set('session',session);c.set('user',session.user_id?identity.user(session.user_id):undefined);
    if(mutating){
      let csrf=c.req.header('X-CSRF-Token');if(!csrf&&!c.req.header('content-type')?.includes('application/json'))csrf=String((await c.req.parseBody())._csrf??'');
      if(!csrf||!equalSecret(csrf,session.csrf_token))throw new LocalError('CSRF_TOKEN_REJECTED',403);
    }
    await next();
  });
  app.get('/',async c=>{const loaded=await catalog.read();return page(c,'sf-home',{...loaded,cards:preflight.cards,setupNeeded:loaded.products.length===0});});
  app.get('/products/:slug',async c=>page(c,'sf-product',{item:await catalog.product(c.req.param('slug'))}));
  app.get('/cart',async c=>page(c,'sf-cart',await cartData(c)));
  app.post('/cart/items',async c=>{
    const input=await body(c);const slug=text(input.product_slug??input.slug);const item=await catalog.product(slug);const variantId=text(input.variant_id??item.product.default_variant_id);const quantity=carts.quantity(input.quantity??1);
    if(!item.variants.some(variant=>variant.variant_id===variantId&&variant.available_for_sale))throw new LocalError('PRODUCT_UNAVAILABLE');
    const cart=carts.current(c.get('session'),c.get('user'));const existing=carts.lines(cart).find(line=>line.variant_id===variantId);
    await checkouts.editCart(cart,()=>carts.add(cart,slug,variantId,quantity));
    if(jsonWanted(c))return c.json({cart:await carts.view(cart),notice:'added_to_cart'});return c.redirect(`/products/${encodeURIComponent(slug)}?notice=added_to_cart`,303);
  });
  for(const remove of [false,true])app.post(`/cart/items/:lineId${remove?'/remove':''}`,async c=>{
    const cart=carts.current(c.get('session'),c.get('user'));const line=carts.lines(cart).find(line=>line.line_id===c.req.param('lineId'));if(!line)throw new LocalError('NOT_FOUND',404);
    const quantity=remove?null:carts.quantity((await body(c)).quantity);
    await checkouts.editCart(cart,async()=>{if(remove)store.run('DELETE FROM cart_lines WHERE line_id=?',line.line_id);else store.run('UPDATE cart_lines SET quantity=? WHERE line_id=?',quantity!,line.line_id);});
    return jsonWanted(c)?c.json({cart:await carts.view(cart)}):c.redirect('/cart',303);
  });
  app.post('/checkout',async c=>{limited(c,'checkout',10,60_000);const record=await checkouts.start(carts.current(c.get('session'),c.get('user')),c.get('session'),c.get('user'));return c.redirect(`/checkout/${record.checkout_ref}`,303);});
  app.get('/subscribe/:planSlug',async c=>page(c,'sf-subscribe',{item:await catalog.plan(c.req.param('planSlug'))}));
  app.post('/subscribe/:planSlug',async c=>{limited(c,'checkout',10,60_000);const plan=await catalog.plan(c.req.param('planSlug'));const record=await checkouts.subscribe(plan.plan.subscription_plan_id,c.get('session'),c.get('user'));return c.redirect(`/checkout/${record.checkout_ref}`,303);});
  app.get('/checkout/:ref',async c=>{own(c);const current=await state(c);if(['paid','partially_paid'].includes(current.read.session.status))return c.redirect(`/checkout/${c.req.param('ref')}/complete`,303);return checkoutPage(c,'sf-checkout',{state:current.state},current.read);});
  app.get('/checkout/:ref/state',async c=>{own(c);return c.json({state:(await state(c)).state});});
  app.post('/checkout/:ref/contact',async c=>job(c,async()=>{
    const input=await body(c);const contact:{email?:string|null;phone?:string|null}={};if(input.email!==undefined)contact.email=input.email===null||input.email===''?null:email(input.email);if(input.phone!==undefined)contact.phone=input.phone===null?null:phone(input.phone);
    const name=input.name===undefined?undefined:text(input.name,200);
    await checkouts.mutate(c.req.param('ref'),'contact',{buyer_contact:contact,...(name===undefined?{}:{name})},async(record,key)=>{if(Object.keys(contact).length)await client.checkoutSessions.update(record.checkout_session_id!,{buyer_contact:contact},auth.checkout(record,key));const details=checkouts.details(record);details.contact={...details.contact,...contact};if(name!==undefined)details.name=name;checkouts.saveDetails(record,details);});
  }));
  app.post('/checkout/:ref/timezone',async c=>job(c,async()=>{const timezone=text((await body(c)).timezone,100);try{await checkouts.mutate(c.req.param('ref'),'timezone',{timezone},(record,key)=>client.checkoutSessions.update(record.checkout_session_id!,{timezone},auth.checkout(record,key)));}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='INVALID_TIMEZONE'))throw error;}}));
  app.post('/checkout/:ref/verification',async c=>job(c,async()=>{
    const input=await body(c);const purpose=text(input.purpose);const channel=text(input.channel??'auto');
    if(!['use_saved_payment_methods','save_payment_method','confirm_saved_payment_method'].includes(purpose)||!['auto','email','sms'].includes(channel))throw new LocalError('INVALID_INPUT');
    // Confirming a saved card sends to the number and email from the payment, so the buyer supplies neither and `auto` is refused.
    const confirming=purpose==='confirm_saved_payment_method';if(confirming&&channel==='auto')throw new LocalError('INVALID_INPUT');
    // Codes before payment keep their own allowance, and Flint allows 3 per channel to confirm a card.
    if(confirming)limited(c,'verification_confirm',6,15*60_000);else limited(c,'verification',3,15*60_000);
    const address=confirming||!input.email?undefined:email(input.email);
    await checkouts.mutate(c.req.param('ref'),'checkout_verification',{purpose,channel,email:address},async(record,key)=>{
      const verified=await client.checkoutSessions.createCustomerVerification(record.checkout_session_id!,{purpose:purpose as 'use_saved_payment_methods',channel:channel as 'auto',...(address?{email:address}:{}),...auth.checkoutHeaders(record)},auth.checkout(record,key));
      const details=checkouts.details(record);details.verification={customer_verification_id:verified.customer_verification_id,status:'code_sent',purpose,channel:verified.channel,email:verified.email,phone_last_digits:verified.phone_last_digits};checkouts.saveDetails(record,details);
    });
  }));
  app.post('/checkout/:ref/verification/confirm',async c=>job(c,async()=>{
    const code=text((await body(c)).code,6);if(!/^\d{6}$/.test(code))throw new LocalError('CUSTOMER_VERIFICATION_CODE_INVALID');
    await checkouts.mutate(c.req.param('ref'),'checkout_verification_confirm',{code_hash:digest(code)},async(record,key,context)=>{
      const details=checkouts.details(record);if(!details.verification)throw new LocalError('INVALID_CUSTOMER_ACCOUNT_REQUEST');
      const verified=await client.checkoutSessions.confirmCustomerVerification(record.checkout_session_id!,context.customer_verification_id!,{code,...auth.checkoutHeaders(record)},auth.checkout(record,key));
      if(verified.checkout_access)store.run('UPDATE checkouts SET checkout_auth_token=? WHERE checkout_ref=?',verified.checkout_access.checkout_auth_token,record.checkout_ref);
      delete details.verification;checkouts.saveDetails(record,details);
    });
  }));
  app.post('/checkout/:ref/discount',async c=>job(c,async()=>{limited(c,'discount',10,10*60_000);const promotion_code=text((await body(c)).promotion_code,100);await checkouts.mutate(c.req.param('ref'),'discount',{promotion_code},async(record,key)=>{await client.orders.applyDiscount(record.order_id!,{promotion:{promotion_code}},auth.checkout(record,key));const details=checkouts.details(record);if(details.delivery_selection)checkouts.notice(record,'delivery_released');delete details.delivery_selection;delete details.delivery_quote;checkouts.saveDetails(record,details);});}));
  app.post('/checkout/:ref/discount/remove',async c=>job(c,async()=>{
    const values=(await body(c)).order_discount_ids;if(!Array.isArray(values)||!values.length||!values.every(value=>typeof value==='string'))throw new LocalError('INVALID_INPUT');
    await checkouts.mutate(c.req.param('ref'),'discount_remove',{order_discount_ids:values},async(record,key)=>{const order=await payments.read(record);if(values.some(value=>!order.applied_discounts?.some(discount=>discount.order_discount_id===value)))throw new LocalError('NOT_FOUND',404);await client.orders.removeDiscounts(record.order_id!,{order_discount_ids:values as string[]},auth.checkout(record,key));const details=checkouts.details(record);delete details.delivery_selection;delete details.delivery_quote;checkouts.notice(record,'delivery_released');checkouts.saveDetails(record,details);});
  }));
  async function quote(c:Context<Env>){
    const input=await body(c);
    const destination:DeliveryAddressRequestInput=Object.fromEntries(Object.entries(asRecord(input.destination_address)).filter(([key])=>['line1','line2','city','state','postal_code','country'].includes(key)).map(([key,value])=>[key,text(value,200)]));
    await checkouts.mutate(c.req.param('ref')!,'delivery_quote',{destination_address:destination},async(record,key,context)=>{
      const details=checkouts.details(record);const response=await client.checkoutSessions.createDeliveryQuote(record.checkout_session_id!,{expected_delivery_selection_id:context.delivery_selection_id,destination_address:destination},auth.checkout(record,key));
      details.delivery_quote=response as Quote;details.quote_input={destination_address:destination};details.quote_basis={selection_id:context.delivery_selection_id};
      checkouts.saveDetails(record,details);
    });
  }
  async function pickupSelect(c:Context<Env>,pickupLocationId:string,recipient:{name:string;email?:string;phone?:string}){
    const ref=c.req.param('ref')!;const known=(details:Details)=>details.pickup_preview?.locations.find(location=>location.location_id===pickupLocationId);
    type PickupRequest={choices:{delivery_choice_group_id:string;delivery_option_id:string}[];delivery_quote_id:string;expected_delivery_selection_id:string|null};
    type PickupInput={pickup_location_id:string;recipient:typeof recipient;request?:PickupRequest};
    // A selection whose outcome is unknown may already exist remotely, so it is replayed from its journal before any new quote is considered.
    const unresolved=checkouts.pendingInput<PickupInput>(ref,'delivery_select');
    const replaying=!!unresolved?.request&&unresolved.pickup_location_id===pickupLocationId&&JSON.stringify(unresolved.recipient)===JSON.stringify(recipient);
    const current=checkouts.details(checkouts.record(ref));
    if(!replaying){
      if(!known(current))throw new LocalError('INVALID_DELIVERY_SELECTION');
      const quoted=current.delivery_quote;
      const reusable=current.quote_input?.pickup_location_id===pickupLocationId&&!!quoted&&Date.parse(quoted.expires_at)>Date.now()&&current.quote_basis?.selection_id===(current.delivery_selection?.delivery_selection_id??null);
      if(!reusable)await checkouts.mutate(ref,'delivery_quote',{pickup_location_id:pickupLocationId},async(record,key,context)=>{
        const details=checkouts.details(record);if(!known(details))throw new LocalError('INVALID_DELIVERY_SELECTION');
        details.delivery_quote=await client.checkoutSessions.createDeliveryQuote(record.checkout_session_id!,{expected_delivery_selection_id:context.delivery_selection_id,pickup_location_id:pickupLocationId},auth.checkout(record,key)) as Quote;
        details.quote_input={pickup_location_id:pickupLocationId};details.quote_basis={selection_id:context.delivery_selection_id};checkouts.saveDetails(record,details);
      });
    }
    let sent:PickupRequest|undefined;
    // The canonical request is journaled with the action; a replay sends it unchanged, including after the quote's local expiry.
    const build=(details:Details,saved?:{input:unknown}):PickupInput=>{
      const journaled=saved?.input as PickupInput|undefined;
      if(journaled){
        if(journaled.pickup_location_id!==pickupLocationId||JSON.stringify(journaled.recipient)!==JSON.stringify(recipient)||!journaled.request)throw new LocalError('ACTION_RECONCILIATION_REQUIRED',409);
        sent=journaled.request;return journaled;
      }
      const location=known(details);const quote=details.delivery_quote;if(!quote)throw new LocalError('DELIVERY_QUOTE_STALE',409);
      if(!location)throw new LocalError('INVALID_DELIVERY_SELECTION');
      if(new Date(quote.expires_at).getTime()<Date.now())throw new LocalError('DELIVERY_QUOTE_EXPIRED',409);
      const choices=quote.choice_groups.filter(group=>group.availability_status==='ready').map(group=>{
        const options=group.options.filter(option=>option.type==='pickup'&&!!option.delivery_option_id&&option.pickup?.location?.location_id===pickupLocationId&&location.delivery_method_ids.includes(option.delivery_method_id));
        if(options.length!==1)throw new LocalError('INVALID_DELIVERY_SELECTION');
        return {delivery_choice_group_id:group.delivery_choice_group_id,delivery_option_id:options[0]!.delivery_option_id!};
      });
      if(!choices.length)throw new LocalError('INVALID_DELIVERY_SELECTION');
      sent={choices,delivery_quote_id:quote.delivery_quote_id,expected_delivery_selection_id:details.delivery_selection?.delivery_selection_id??null};
      return {pickup_location_id:pickupLocationId,recipient,request:sent};
    };
    await checkouts.mutate(ref,'delivery_select',build,async(record,key)=>{
      const request=sent!;const response=await client.checkoutSessions.createDeliverySelection(record.checkout_session_id!,{choices:request.choices,recipient,delivery_quote_id:request.delivery_quote_id,expected_delivery_selection_id:request.expected_delivery_selection_id},auth.checkout(record,key));
      const details=checkouts.details(record);details.delivery_selection=(response as {delivery_selection:Details['delivery_selection']}).delivery_selection;checkouts.saveDetails(record,details);
    });
  }
  app.post('/checkout/:ref/billing-address',async c=>job(c,async()=>{
    const input=await body(c);const line1=text(input.line1,200),city=text(input.city,200),state=text(input.state,2),postal_code=text(input.postal_code,200),country=text(input.country,2),line2=input.line2===undefined?'':text(input.line2,200);
    if(!line1||!city||!state||!/^\d{5}(-\d{4})?$/.test(postal_code)||country!=='US')throw new LocalError('INVALID_INPUT');
    const address:OrderTaxLocationFullAddressRequestInput={line1,city,state,postal_code,country,...(line2?{line2}:{})};
    await checkouts.mutate(c.req.param('ref'),'tax_location',{address},async(record,key)=>{
      const session=await client.checkoutSessions.get(record.checkout_session_id!,undefined,auth.checkout(record));const order=await payments.read(record);const details=checkouts.details(record);
      if(session.delivery_selection_required||details.delivery_quote||details.delivery_selection||order.tax?.enabled!==true)throw new LocalError('INVALID_INPUT');
      await client.orders.update(record.order_id!,{tax:{enabled:true,location:{address_source:'provided',address_type:'billing_address',address}}},auth.checkout(record,key));
      details.billing_address=address;checkouts.saveDetails(record,details);
    });
  }));
  app.post('/checkout/:ref/delivery/quote',async c=>job(c,()=>quote(c)));
  app.post('/checkout/:ref/pickup-locations',async c=>job(c,async()=>{
    const input=await body(c);await checkouts.previewPickup(c.req.param('ref')!,{type:'address',address:{postal_code:text(input.postal_code,20),country:text(input.country??'US',2)}});
  }));
  app.post('/checkout/:ref/delivery/select',async c=>job(c,async()=>{
    const input=await body(c);
    if(input.pickup_location_id!==undefined){const raw=asRecord(input.recipient);return pickupSelect(c,text(input.pickup_location_id,200),{name:text(raw.name,200),...(raw.email?{email:email(raw.email)}:{}),...(raw.phone?{phone:phone(raw.phone)!}:{})});}
    if(!Array.isArray(input.choices))throw new LocalError('INVALID_INPUT');
    const choices=input.choices.map(value=>{const choice=asRecord(value);return {delivery_choice_group_id:text(choice.delivery_choice_group_id),delivery_option_id:text(choice.delivery_option_id)};});
    const raw=asRecord(input.recipient);const recipient={name:text(raw.name,200),...(raw.email?{email:email(raw.email)}:{}),...(raw.phone?{phone:phone(raw.phone)!}:{})};
    await checkouts.mutate(c.req.param('ref'),'delivery_select',{choices,recipient},async(record,key,context)=>{
      const details=checkouts.details(record);const quoted=details.delivery_quote;if(!quoted)throw new LocalError('DELIVERY_QUOTE_STALE',409);
      if(new Date(quoted.expires_at).getTime()<Date.now())throw new LocalError('DELIVERY_QUOTE_EXPIRED',409);
      if(choices.length!==new Set(choices.map(choice=>choice.delivery_choice_group_id)).size||choices.some(choice=>!quoted.choice_groups.some(group=>group.delivery_choice_group_id===choice.delivery_choice_group_id&&group.options.some(option=>option.delivery_option_id===choice.delivery_option_id)))||quoted.choice_groups.some(group=>group.availability_status==='ready'&&!choices.some(choice=>choice.delivery_choice_group_id===group.delivery_choice_group_id)))throw new LocalError('INVALID_DELIVERY_SELECTION');
      const response=await client.checkoutSessions.createDeliverySelection(record.checkout_session_id!,{choices,recipient,delivery_quote_id:context.delivery_quote_id!,expected_delivery_selection_id:context.delivery_selection_id},auth.checkout(record,key));
      details.delivery_selection=(response as {delivery_selection:Details['delivery_selection']}).delivery_selection;checkouts.saveDetails(record,details);
    });
  }));
  app.post('/checkout/:ref/gift-card',async c=>{
    own(c);limited(c,'gift',5,3600000);await checkouts.read(c.req.param('ref'),c.get('user'));
    const giftCardCode=text((await body(c)).gift_card_code,200);if(!giftCardCode)throw new LocalError('INVALID_INPUT');
    const giftChallenge=await checkouts.applyGift(c.req.param('ref'),giftCardCode);
    return c.json({state:(await state(c)).state,...(giftChallenge?{gift_challenge:giftChallenge}:{})});
  });
  app.post('/checkout/:ref/gift-card/challenge',async c=>{
    own(c);limited(c,'gift_challenge',10,3600000);
    if(!c.req.header('Content-Type')?.includes('application/json'))throw new LocalError('INVALID_INPUT');
    const input=await body(c),challengeId=input.challenge_id,proof=input.proof,giftCardCode=text(input.gift_card_code,200);
    if(typeof challengeId!=='string'||!/^gch_[A-Za-z0-9_-]{32}$/.test(challengeId)||!giftCardCode||!validProof(proof))throw new LocalError('INVALID_INPUT');
    const giftChallenge=await checkouts.retryGift(c.req.param('ref'),challengeId,giftCardCode,proof);
    return c.json({state:(await state(c)).state,...(giftChallenge?{gift_challenge:giftChallenge}:{})});
  });
  app.post('/checkout/:ref/gift-card/:giftCardId/remove',async c=>job(c,async()=>{const giftCardId=c.req.param('giftCardId');await checkouts.mutate(c.req.param('ref'),'gift_remove',{gift_card_id:giftCardId},async(record,key,context)=>{if(!context.order_revision)throw new LocalError('NOT_FOUND',404);return client.orders.removeGiftCard(record.order_id!,giftCardId,{order_revision:context.order_revision},auth.checkout(record,key));});}));
  app.post('/checkout/:ref/tip',async c=>job(c,async()=>{
    const input=await body(c);let requested_tip:{percent:number}|{amount_money:{amount:string;currency:string}}|null;
    if(input.clear===true)requested_tip=null;else if(input.percent!==undefined){const percent=Number(input.percent);if(!Number.isFinite(percent)||percent<0||percent>100)throw new LocalError('INVALID_TIP');requested_tip={percent};}else requested_tip={amount_money:{amount:decimalMinor(text(input.amount,20)),currency:'USD'}};
    await checkouts.mutate(c.req.param('ref'),'tip',{requested_tip},(record,key)=>client.orders.update(record.order_id!,{requested_tip},auth.checkout(record,key)));
  }));
  app.get('/checkout/:ref/saved-methods',async c=>{own(c);const current=await state(c);const methods=await client.paymentMethods.list(undefined,auth.checkout(current.read.record));return c.json({state:{...current.state,saved_methods:buyerSafe(methods.data)}});});
  app.post('/checkout/:ref/pay',async c=>{
    own(c);limited(c,'pay',10,60_000);await checkouts.read(c.req.param('ref'),c.get('user'));const raw=await body(c);
    const credential=raw.credential?asRecord(raw.credential):undefined;
    if(credential&&!['confirmation_token','payment_method_token','saved_payment_method'].includes(String(credential.kind)))throw new LocalError('PAYMENT_SOURCE_REQUIRED');
    if(!['processor','settlement','setup','unavailable'].includes(String(raw.approved_collection_kind)))throw new LocalError('INVALID_PAYMENT_APPROVAL');
    const input:PayInput={approved_outstanding_money:approvedMoney(raw.approved_outstanding_money),approved_collection_kind:raw.approved_collection_kind as PayInput['approved_collection_kind'],...(credential?{credential:{kind:credential.kind as NonNullable<PayInput['credential']>['kind'],value:text(credential.value,400)}}:{}),...(raw.approved_order_revision?{approved_order_revision:text(raw.approved_order_revision,20)}:{}),...(raw.approved_gift_card_money?{approved_gift_card_money:approvedMoney(raw.approved_gift_card_money)}:{}),...(raw.buyer_contact?{buyer_contact:{email:email(asRecord(raw.buyer_contact).email),...(asRecord(raw.buyer_contact).phone?{phone:phone(asRecord(raw.buyer_contact).phone)!}:{})}}:{}),save_payment_method:raw.save_payment_method===true,save_payment_method_phone:raw.save_payment_method_phone?phone(raw.save_payment_method_phone)??undefined:undefined};
    const result=await payments.start(c.req.param('ref'),input);const current=await state(c,result);return paymentJson(c,current.read,result);
  });
  app.post('/checkout/:ref/resume',async c=>{own(c);limited(c,'pay',10,60_000);const result=await payments.resume(c.req.param('ref'));const current=await state(c,result);return paymentJson(c,current.read,result);});
  app.get('/checkout/:ref/attempt',async c=>{own(c);const current=await state(c);return paymentJson(c,current.read);});
  app.post('/checkout/:ref/cancel-attempt',async c=>{own(c);const result=await payments.cancel(c.req.param('ref'));const current=await state(c,result);return paymentJson(c,current.read,result);});
  app.get('/checkout/:ref/return',async c=>{
    try{own(c);}catch{return page(c,'return-elsewhere');}
    const current=await state(c);const result=current.read.result.attempt?.status==='requires_action'&&current.read.result.attempt.is_resumable?await payments.resume(c.req.param('ref'),true):current.read.result;
    if(payments.next(result)==='done')return c.redirect(`/checkout/${c.req.param('ref')}/complete`,303);
    if(payments.next(result)==='authenticate')checkouts.notice(current.read.record,'affirm_incomplete');return c.redirect(`/checkout/${c.req.param('ref')}`,303);
  });
  app.get('/checkout/:ref/complete',async c=>{
    own(c);const current=await state(c);let subscription:unknown;
    if(trialSetupNotStarted(current.state as unknown as CheckoutState)){if(!current.state.attempt)checkouts.notice(current.read.record,'trial_not_started');return c.redirect(`/checkout/${c.req.param('ref')}`,303);}
    try{subscription=await checkouts.subscription(current.read);}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='CHECKOUT_SESSION_PAYMENT_REQUIRED'))throw error;}
    const user=c.get('user');const order=current.read.order;const accountUrl=config.accountOrigin?(user?`${config.accountOrigin}/orders/${encodeURIComponent(order.order_id)}`:`${config.accountOrigin}/sign-up?next=${encodeURIComponent(`/orders/${order.order_id}`)}`):null;
    if(current.read.record.cart_id&&['paid','bank_processing'].includes(checkouts.record(c.req.param('ref')).status))carts.complete(current.read.record.checkout_ref,order);
    return checkoutPage(c,'sf-complete',{state:{...current.state,subscription:buyerSafe(subscription)},paidSignal:!!store.get('SELECT * FROM order_signals WHERE order_id=?',order.order_id),accountUrl},current.read);
  });
  app.post('/checkout/:ref/receipt',async c=>job(c,async()=>{const record=own(c);const details=checkouts.details(record);if(details.receipt_sent_at&&Date.now()-details.receipt_sent_at<5*60_000)throw new LocalError('RECEIPT_JUST_SENT',429);const current=await checkouts.read(record.checkout_ref,c.get('user'));await checkouts.action(record,'receipt',{},key=>client.orders.sendReceipt(record.order_id!,{},current.session.status!=='open'||!record.checkout_auth_token?auth.merchant(key):auth.checkout(record,key)));details.receipt_sent_at=Date.now();checkouts.saveDetails(record,details);}));
  for(const route of ['/sign-in','/sign-up'] as const)app.get(route,c=>page(c,route==='/sign-in'?'sign-in':'sign-up',{next:viewPath(c.req.query('next'))}));
  app.post('/sign-up',async c=>{
    const input=await body(c);rememberForm(c,input,'sign-up');limited(c,'signup',5,60*60_000);const address=email(input.email);const name=text(input.name,200);const secret=password(input.password);if(!name||secret.length<10)throw new LocalError('PASSWORD_TOO_SHORT');if(identity.userByEmail(address))throw new LocalError('EMAIL_ALREADY_REGISTERED',409);
    const user=await identity.createUser(name,address,secret);const old=c.get('session');await checkouts.mergeCart(old,user);store.run('UPDATE checkouts SET user_id=? WHERE session_hash=? AND user_id IS NULL',user.user_id,old.session_hash);const rotated=identity.rotate(old,user.user_id);cookie(c,rotated.token);return c.redirect(`/verify-email?next=${encodeURIComponent(returnPath(input.next))}`,303);
  });
  app.post('/sign-in',async c=>{
    const input=await body(c);rememberForm(c,input,'sign-in');const address=email(input.email);limited(c,'signin',5,15*60_000,address);const user=identity.userByEmail(address);if(!await verifyPassword(password(input.password),user?.password_hash)||!user)throw new LocalError('INVALID_SIGN_IN',401);if(user.status==='closed')throw new LocalError('ACCOUNT_CLOSED',403);
    const old=c.get('session');await checkouts.mergeCart(old,user);store.run('UPDATE checkouts SET user_id=? WHERE session_hash=? AND user_id IS NULL',user.user_id,old.session_hash);const rotated=identity.rotate(old,user.user_id);cookie(c,rotated.token);const next=returnPath(input.next);return c.redirect(identity.isBound(user,preflight.sandboxId)?next:`/verify-email?next=${encodeURIComponent(next)}`,303);
  });
  app.post('/sign-out',async c=>{const session=c.get('session');await binding.signOut(c.get('user'));identity.destroy(session);const created=identity.createSession();cookie(c,created.token);return c.redirect('/sign-in?notice=signed_out',303);});
  app.get('/verify-email',c=>{const user=requireUser(c);const pending=identity.pending(c.get('session'));return page(c,'verify-email',{next:returnPath(c.req.query('next')),email:user.email,verification:pending?{status:'code_sent',sentAt:pending.created_at}:null});});
  app.post('/verify-email/send',async c=>{limited(c,'verification',3,15*60_000);const input=await body(c);c.set('returnNext',returnPath(input.next));await binding.send(requireUser(c),c.get('session'));return c.redirect(`/verify-email?next=${encodeURIComponent(returnPath(input.next))}`,303);});
  app.post('/verify-email/confirm',async c=>{const input=await body(c);c.set('returnNext',returnPath(input.next));await binding.confirm(requireUser(c),c.get('session'),text(input.code,6));return c.redirect(returnPath(input.next),303);});
  app.notFound(c=>page(c,'not-found',{},404));
  app.onError(async(error,c)=>{
    const mapped=appError(error);const status=errorStatus(error) as ContentfulStatusCode;
    if(c.req.path.endsWith('/gift-card/challenge')&&unknownOutcome(error))mapped.message_key='gift_challenge_unconfirmed';
    if(mapped.code==='INVALID_PAGE_ORIGIN')logLaunchInvalid('invalid_page_origin',mapped.request_id);
    if(c.req.path.startsWith('/cart/')&&['CHECKOUT_PAYMENT_RESOLVING','PAYMENT_ATTEMPT_IN_PROGRESS'].includes(mapped.code)){
      mapped.message_key='cart_locked_payment';
      if(!jsonWanted(c)&&c.get('session')){
        try{return await page(c,'sf-cart',await cartData(c),status,mapped,['cart_locked_payment']);}
        catch{/* Keep the original rejection when a fresh cart read cannot render. */}
      }
    }
    const form=c.get('form');if(form){
      const field=mapped.code==='INVALID_EMAIL'?'email':mapped.code==='PASSWORD_TOO_SHORT'?'password':mapped.code==='EMAIL_ALREADY_REGISTERED'?'email':undefined;
      const key=mapped.code==='INVALID_EMAIL'?'email_invalid':mapped.code==='EMAIL_ALREADY_REGISTERED'?'email_already_used':'password_too_short';
      if(field)c.set('form',{...form,errors:{[field]:key}});
      if(mapped.code==='INVALID_SIGN_IN')mapped.message_key='sign_in_failed';
    }
    if(jsonWanted(c)){
      const localChallenge=c.req.path.endsWith('/gift-card/challenge')&&['GIFT_CHALLENGE_EXPIRED','GIFT_CHALLENGE_SESSION_CHANGED','GIFT_CHALLENGE_CODE_CHANGED','GIFT_CHALLENGE_ORDER_CHANGED','CHECKOUT_PAYMENT_RESOLVING','PAYMENT_ATTEMPT_IN_PROGRESS'].includes(mapped.code);
      let projected:unknown;const ref=c.req.param('ref');if(ref&&status!==404&&!localChallenge){try{own(c);projected=(await state(c)).state;}catch{}}
      return c.json({error:mapped,state:projected},status);
    }
    if(status===401&&c.get('user')===undefined&&c.req.path.startsWith('/verify-email'))return c.redirect(`/sign-in?next=${encodeURIComponent(c.get('returnNext')??returnPath(c.req.query('next')))}`,303);
    if(!c.get('session'))return c.html(await renderPage('error',{storeName:config.storeName,csrf:'',user:null,cartCount:0,accountOrigin:config.accountOrigin??null,appOrigin:config.appOrigin,data:{},notices:[],error:mapped,path:viewPath(new URL(c.req.url).pathname)}),status);
    return page(c,status===404?'not-found':c.req.path==='/sign-in'?'sign-in':c.req.path==='/sign-up'?'sign-up':c.req.path.startsWith('/verify-email')?'verify-email':'error',{next:c.get('returnNext')??viewPath(c.req.query('next')),email:c.get('user')?.email},status,mapped);
  });
  return {app,store,identity,client,auth,catalog,carts,checkouts,payments,binding};
}
