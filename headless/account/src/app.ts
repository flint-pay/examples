import {Hono} from 'hono';
import type {Context} from 'hono';
import {getCookie,setCookie} from 'hono/cookie';
import {bodyLimit} from 'hono/body-limit';
import {serveStatic} from '@hono/node-server/serve-static';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import type {Client,RequestOptions,BuyerAction,PostalAddressInput,EmailChangeRequest,ReturnLineItemRequestInput} from '@flintpay/node';
import {renderPage} from './views/index.ts';
import type {PageId,RenderContext} from './views/types.ts';
type Renderer=(pageId:PageId,context:RenderContext)=>string|Promise<string>;
import type {Config} from './config.ts';
import {SDK_VERSION} from './config.ts';
import {IdentityStore,verifyPassword,hashPassword,equalSecret,normalizeEmail,digest} from './identity/index.ts';
import type {Session,User} from './identity/index.ts';
import {CustomerSessions} from './flint/customer-sessions.ts';
import {Store} from './store/db.ts';
import type {CheckoutRecord,ActionRecord} from './store/db.ts';
import type {ReadOptions} from './flint/auth.ts';
import {createAuth} from './flint/auth.ts';
import type {Preflight} from './flint/preflight.ts';
import {LocalError,appError,errorStatus,unknownOutcome,giftPayError} from './flint/errors.ts';
import {project,safeMethod,safeNested} from './flint/projection.ts';
import {securityHeaders} from './security/headers.ts';
import {RateLimiter} from './security/rate-limit.ts';
import {returnPath} from './security/paths.ts';
import {resourceHint} from './security/hints.ts';
import {text,required,id,bool,code,email,object,giftRecipient} from './security/input.ts';
import {createHash} from 'node:crypto';
import {validProof} from './flint/gift-challenge.ts';
import {logRequest,logLaunchInvalid} from './security/log.ts';
import {attemptOpen} from './payments/next-step.ts';
import {PaymentEngine} from './payments/engine.ts';
import type {PayInput} from './payments/engine.ts';

type Env={Bindings:{ip?:string;incoming?:import('node:http').IncomingMessage};Variables:{session:Session;user:User|undefined;body:Record<string,unknown>;ip:string;errorReturn:string;flash:{notices:unknown[];error?:ReturnType<typeof appError>;form?:FormState}}};
type C=Context<Env>;
type FormState={values:Record<string,string>;dialog?:'cancel'|'pause'|'payment_method'};
function safeFormState(c:C):FormState{
  const path=c.req.path,values:Record<string,string>={},body=c.get('body')??{};
  const fields=path==='/sign-in'?['email']:path==='/sign-up'?['name','email']:path==='/profile'?['name','phone']:path==='/profile/email'?['new_email']:path.startsWith('/addresses')?['recipient_name','label','line1','line2','city','state','postal_code','country','phone','is_default_shipping','is_default_billing']:path.startsWith('/subscriptions')?['cancel_when','reason','comment','cycles','payment_method_id']:[];
  for(const [key,value]of Object.entries(body))if(typeof value==='string'&&value.length<=1000&&(fields.includes(key)||path.startsWith('/orders/')&&path.endsWith('/return')&&/^line_\d+_(selected|quantity|reason|note)$/.test(key)))values[key]=value;
  const dialog=path.startsWith('/subscriptions/')?(path.endsWith('/cancel')?'cancel':path.endsWith('/pause')?'pause':path.endsWith('/payment-method')?'payment_method':undefined):undefined;
  return {values,dialog};
}
export type Dependencies={config:Config;client:Client;identity:IdentityStore;store:Store;preflight:Preflight;render?:Renderer;paymentDelay?:(ms:number)=>Promise<void>};
export function createApp(deps:Dependencies){
  const {config,client,identity,store,preflight}=deps,auth=createAuth(config.apiKey),sessions=new CustomerSessions(identity,client,auth,config,preflight.sandboxId),engine=new PaymentEngine(client,auth,store,deps.paymentDelay),limiter=new RateLimiter(),render:Renderer=deps.render??((pageId,context)=>renderPage(pageId,context as never));
  identity.db.exec(`CREATE TABLE IF NOT EXISTS account_email_reservations(email TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS account_reserved_email_insert BEFORE INSERT ON users WHEN EXISTS(SELECT 1 FROM account_email_reservations WHERE email=NEW.email AND user_id<>NEW.user_id AND expires_at>unixepoch()*1000) BEGIN SELECT RAISE(ABORT,'email_reserved'); END;
    CREATE TRIGGER IF NOT EXISTS account_reserved_email_update BEFORE UPDATE OF email ON users WHEN EXISTS(SELECT 1 FROM account_email_reservations WHERE email=NEW.email AND user_id<>NEW.user_id AND expires_at>unixepoch()*1000) BEGIN SELECT RAISE(ABORT,'email_reserved'); END;`);
  const app=new Hono<Env>();
  const secure=new URL(config.appOrigin).protocol==='https:';
  const cookie=(c:C,token:string)=>setCookie(c,config.cookieName,token,{httpOnly:true,sameSite:'Lax',secure,path:'/',maxAge:30*24*3600});
  const nonce=(c:C)=>{const value=c.req.header('X-Action-ID')??c.get('body')?._action_id;return value===undefined?undefined:id(value);};
  const user=(c:C)=>{const value=c.get('user');if(!identity.isBound(value,preflight.sandboxId))throw new LocalError('SESSION_ENDED',401);return value;};
  const me=<T>(c:C,fn:(opts:ReadOptions<'customer'>)=>Promise<T>)=>sessions.call(user(c),opts=>fn({...opts,idempotencyKey:undefined}));
  const mutate=<T>(c:C,action:string,resource:string,body:unknown,fn:(opts:RequestOptions<'customer'>)=>Promise<T>)=>store.mutate(`${preflight.sandboxId}:${user(c).user_id}:${resource}`,action,body,key=>sessions.call(user(c),fn,key),nonce(c));
  const isJson=(c:C)=>c.req.header('Content-Type')?.includes('application/json')||c.req.header('Accept')?.includes('application/json');
  const flash=(c:C,key:string,params?:Record<string,string|number>)=>identity.db.prepare('UPDATE sessions SET flash=? WHERE session_hash=?').run(JSON.stringify({notices:[params?{key,params}:key]}),c.get('session').session_hash);
  const finish=(c:C,path:string,data?:unknown)=>isJson(c)?c.json(data??{ok:true}):c.redirect(path,303);
  const page=async(c:C,pageId:PageId,data:unknown,status=200)=>{
    const current=c.get('user'),flashes=c.get('flash')??{notices:[]};
    const form=flashes.form;
    if(form&&data&&typeof data==='object')data={...data,...(['sign-in','sign-up'].includes(pageId)?form.values:{values:form.values}),...(form.dialog?{dialog:form.dialog}:{})};
    const ctx={storeName:config.storeName,appOrigin:config.appOrigin,giftChallengeOrigin:config.giftChallengeOrigin,storefrontOrigin:config.storefrontOrigin,csrf:c.get('session').csrf_token,user:current?{name:current.name,email:current.email}:null,data,notices:flashes.notices,error:flashes.error,support:preflight.support,setupNeeded:preflight.setupNeeded};
    return c.html(await render(pageId,ctx as never),status as 200);
  };
  const loaded=async<T>(fn:()=>Promise<T>)=>{try{return {status:'ok' as const,value:await fn()};}catch(error){if(errorStatus(error)===401)throw error;return {status:'error' as const,error:appError(error)};}};
  const list=<T>(kind:string,response:{data:T[];next_page_token?:string})=>({items:response.data.map(item=>project(kind,item)),next_page_token:response.next_page_token});
  const items=<T>(kind:string,response:{data:T[]})=>response.data.map(item=>project(kind,item));
  const pagination=(c:C,size=10)=>({page_size:size,page_token:c.req.query('page')?required(c.req.query('page'),4096):undefined});
  const requireAction=(resource:{buyer_actions:BuyerAction[]},kind:string)=>{if(!resource.buyer_actions.some(action=>action.kind===kind&&action.is_available))throw new LocalError('ACTION_NOT_AVAILABLE',409);};
  const ownedOrder=(c:C,orderId:string)=>me(c,opts=>client.me.getOrder(id(orderId),undefined,opts));
  const ownedReturn=(c:C,returnId:string)=>me(c,opts=>client.me.getReturn(id(returnId),undefined,opts));
  const ownedInvoice=(c:C,invoiceId:string)=>me(c,opts=>client.me.getInvoice(id(invoiceId),undefined,opts));
  const ownedSubscription=(c:C,subscriptionId:string)=>me(c,opts=>client.me.getSubscription(id(subscriptionId),undefined,opts));
  const boundRoutes=new Set(['/sign-in','/sign-up','/verify-email','/verify-email/send','/verify-email/confirm','/sign-out','/email-preferences','/email-preferences/lookup','/email-preferences/unsubscribe','/healthz']);
  app.use('*',async(c,next)=>{
    for(const [key,value]of Object.entries(securityHeaders(config)))c.header(key,value);
    const start=Date.now(),requestId=randomUUID();c.header('X-Request-ID',requestId);
    // Network listeners supply peer addresses explicitly. Proxy headers are never trusted.
    c.set('ip',c.env?.incoming?.socket.remoteAddress??c.env?.ip??'local');
    try{await next();}finally{logRequest({request_id:requestId,route:c.req.routePath||'unmatched',status:c.res.status,duration_ms:Date.now()-start});}
  });
  app.get('/healthz',c=>c.json({status:'ok',app:'headless/account',sandbox_id:preflight.sandboxId,mode:'test',sdk_version:SDK_VERSION,cards:preflight.cards,...(config.build?{build:config.build}:{})}));
  app.use('/assets/*',serveStatic({root:fileURLToPath(new URL('../public',import.meta.url)),rewriteRequestPath:path=>path.replace(/^\/assets/,'')}));
  app.use('/js/*',serveStatic({root:fileURLToPath(new URL('../public',import.meta.url))}));
  app.use('/css/*',serveStatic({root:fileURLToPath(new URL('../public',import.meta.url))}));
  app.use('*',bodyLimit({maxSize:65536,onError:c=>c.json({error:{kind:'validation',code:'INVALID_INPUT',message_key:'validation'}},413)}));
  app.use('*',async(c,next)=>{
    const incomingToken=getCookie(c,config.cookieName);let session=identity.session(incomingToken);
    if(session&&incomingToken)cookie(c,incomingToken);
    if(!session){const created=identity.createSession();session=created.session;cookie(c,created.token);}
    c.set('session',session);c.set('user',session.user_id?identity.user(session.user_id):undefined);
    let flashes:{notices:unknown[];error?:ReturnType<typeof appError>}={notices:[]};
    if(session.flash){try{flashes=JSON.parse(session.flash);}catch{}identity.db.prepare('UPDATE sessions SET flash=NULL WHERE session_hash=?').run(session.session_hash);}
    c.set('flash',flashes);
    if(!['GET','HEAD','OPTIONS'].includes(c.req.method)){
      if(c.req.header('Origin')!==config.appOrigin)throw new LocalError('CSRF_REJECTED',403);
      const contentType=c.req.header('Content-Type')??'';
      const body=contentType.includes('application/json')?object(await c.req.json().catch(()=>{throw new LocalError('INVALID_INPUT');})):contentType.includes('application/x-www-form-urlencoded')?await c.req.parseBody():{};
      c.set('body',body);
      const publicToken=c.req.path==='/email-preferences/lookup'||c.req.path==='/email-preferences/unsubscribe';
      if(publicToken){if(!limiter.take(`preferences:${c.get('ip')}`,20,3600000))throw new LocalError('RATE_LIMITED',429);}
      else{const supplied=c.req.header('X-CSRF-Token')??body._csrf;if(typeof supplied!=='string'||!equalSecret(session.csrf_token,supplied))throw new LocalError('CSRF_REJECTED',403);}
    }
    const path=c.req.path;
    const signedIn=c.get('user');
    const nextPath=returnPath(path+new URL(c.req.url).search);
    if(!boundRoutes.has(path)){
      if(!signedIn)return isJson(c)?c.json({error:appError(new LocalError('SESSION_ENDED',401))},401):c.redirect('/sign-in?next='+encodeURIComponent(nextPath),303);
      if(!identity.isBound(signedIn,preflight.sandboxId))return c.redirect('/verify-email?next='+encodeURIComponent(nextPath),303);
    }
    if(c.req.method==='GET'&&!['/sign-in','/sign-up','/verify-email'].includes(path)){
      const hint=resourceHint(new URL(c.req.url),preflight.merchantId,preflight.sandboxId);
      if(hint.kind==='reject'){if(hint.notice)flash(c,hint.notice);return c.redirect('/',303);}
      if(hint.kind==='resource'){
        if(!signedIn)return c.redirect('/sign-in?next='+encodeURIComponent(nextPath),303);
        if(!identity.isBound(signedIn,preflight.sandboxId))return c.redirect('/verify-email?next='+encodeURIComponent(nextPath),303);
        if(hint.type==='order')await ownedOrder(c,hint.id);
        else if(hint.type==='subscription')await ownedSubscription(c,hint.id);
        else if(hint.type==='invoice')await ownedInvoice(c,hint.id);
        else await ownedReturn(c,hint.id);
        const cleaned=new URL(c.req.url);for(const key of [...cleaned.searchParams.keys()])if(key.startsWith('flint_'))cleaned.searchParams.delete(key);return c.redirect(hint.path+cleaned.search,303);
      }
      if(hint.kind==='preferences')return c.redirect('/email-preferences',303);
    }
    await next();
  });
  app.onError(async(error,c)=>{
    const safe=/\/pay\/gift-card(?:\/|$)/.test(c.req.path)?giftPayError(error):appError(error),status=errorStatus(error);
    if(/\/pay\/gift-card(?:\/challenge)?$/.test(c.req.path)&&unknownOutcome(error))safe.message_key='gift_challenge_unconfirmed';
    const giftInvalid=c.req.method==='POST'&&c.req.path==='/gift-cards'&&status===404&&safe.code==='GIFT_CARD_NOT_FOUND';
    if(giftInvalid)safe.message_key='gift_card_invalid';
    if(safe.code==='INVALID_PAGE_ORIGIN')logLaunchInvalid('invalid_page_origin',safe.request_id);
    const errorField=safe.code==='EMAIL_ALREADY_USED'||safe.code==='INVALID_EMAIL'?(c.req.path.startsWith('/profile/email')?'new_email':'email'):safe.code==='PASSWORD_TOO_SHORT'?(c.req.path==='/sign-up'?'password':'new_password'):safe.code==='CURRENT_PASSWORD_INCORRECT'?'current_password':undefined;
    if(errorField)Object.assign(safe,{field_errors:{[errorField]:safe.message_key}});
    if(safe.request_id)console.warn(JSON.stringify({event:'flint_request_failed',code:safe.code,request_id:safe.request_id}));
    if(status===401&&c.get('session')){identity.destroy(c.get('session'));setCookie(c,config.cookieName,'',{path:'/',maxAge:0,httpOnly:true,sameSite:'Lax',secure});}
    if(isJson(c))return c.json({error:safe},status as 400);
    if(status===401)return c.redirect('/sign-in?notice=session_ended&next='+encodeURIComponent(returnPath(c.req.path+new URL(c.req.url).search)),303);
    if(status===404&&c.get('user')&&!giftInvalid){flash(c,'not_in_account');return c.redirect('/',303);}
    if(c.req.method!=='GET'&&c.get('errorReturn')){identity.db.prepare('UPDATE sessions SET flash=? WHERE session_hash=?').run(JSON.stringify({notices:[],error:safe,form:safeFormState(c)}),c.get('session').session_hash);return c.redirect(c.get('errorReturn'),303);}
    c.set('flash',{notices:[],error:safe});return page(c,status===404?'not-found':'error',{},status);
  });
  app.get('/sign-in',c=>{
    if(c.req.query('notice')==='session_ended'){const flashes=c.get('flash');c.set('flash',{...flashes,notices:[...flashes.notices,'session_ended']});}
    return page(c,'sign-in',{next:returnPath(c.req.query('next'))});
  });
  app.get('/sign-up',c=>page(c,'sign-up',{next:returnPath(c.req.query('next'))}));
  app.post('/sign-up',async c=>{
    const b=c.get('body'),next=returnPath(b.next);c.set('errorReturn','/sign-up?next='+encodeURIComponent(next));
    if(!limiter.take(`signup:${c.get('ip')}`,5,3600000))throw new LocalError('RATE_LIMITED',429);
    const address=email(b.email),password=required(b.password,1024),name=required(b.name);
    if(password.length<10)throw new LocalError('PASSWORD_TOO_SHORT');
    if(identity.userByEmail(address)||identity.db.prepare('SELECT email FROM account_email_reservations WHERE email=? AND expires_at>?').get(address,Date.now()))throw new LocalError('EMAIL_ALREADY_USED',409);
    const created=await identity.createUser(name,address,password),rotated=identity.rotate(c.get('session'),created.user_id);cookie(c,rotated.token);
    return c.redirect('/verify-email?next='+encodeURIComponent(next),303);
  });
  app.post('/sign-in',async c=>{
    const b=c.get('body'),next=returnPath(b.next);c.set('errorReturn','/sign-in?next='+encodeURIComponent(next));
    const address=email(b.email);
    if(!limiter.take(`login-ip:${c.get('ip')}`,5,900000)||!limiter.take(`login-email:${digest(address)}`,5,900000))throw new LocalError('RATE_LIMITED',429);
    const current=identity.userByEmail(address),valid=await verifyPassword(required(b.password,1024),current?.password_hash);
    if(!valid||!current)throw new LocalError('INVALID_LOGIN',400);
    if(current.status==='closed')throw new LocalError('ACCOUNT_CLOSED',400);
    const rotated=identity.rotate(c.get('session'),current.user_id);cookie(c,rotated.token);
    return c.redirect(identity.isBound(current,preflight.sandboxId)?next:'/verify-email?next='+encodeURIComponent(next),303);
  });
  app.post('/sign-out',async c=>{
    const current=c.get('user');try{if(current&&identity.isBound(current,preflight.sandboxId))await sessions.revoke(current);}catch(error){console.warn(JSON.stringify({event:'session_revocation_pending',code:appError(error).code}));}finally{const rotated=identity.rotate(c.get('session'),null);cookie(c,rotated.token);c.set('session',rotated.session);flash(c,'signed_out');}
    return c.redirect('/sign-in',303);
  });
  const verifyPage=(c:C,link=false)=>{
    const current=c.get('user');if(!current)return c.redirect('/sign-in?next='+encodeURIComponent(returnPath(c.req.query('next'))),303);
    const pending=identity.pending(c.get('session'));
    return page(c,link?'ac-link-purchases':'verify-email',link?{state:pending?'code_sent':'idle',email:current.email,sentAt:pending?.created_at}:{next:returnPath(c.req.query('next')),email:current.email,verification:pending?{status:'code_sent',sentAt:pending.created_at}:{status:'idle'}});
  };
  app.get('/verify-email',c=>verifyPage(c));app.get('/link-purchases',c=>verifyPage(c,true));
  const sendVerification=async(c:C,link=false)=>{
    const current=c.get('user');if(!current||current.status!=='active')throw new LocalError('SESSION_ENDED',401);
    const next=returnPath(c.get('body').next);c.set('errorReturn',link?'/link-purchases':'/verify-email?next='+encodeURIComponent(next));
    if(!limiter.take(`verify:${c.get('ip')}:${current.user_id}`,3,900000))throw new LocalError('RATE_LIMITED',429);
    const previous=identity.pending(c.get('session'));if(previous&&Date.now()-previous.created_at<30000)throw new LocalError('RATE_LIMITED',429);
    let customerId=identity.isBound(current,preflight.sandboxId)?current.flint_customer_id!:undefined;
    if(!customerId){
      const candidates=await client.customers.list({email:current.email},auth.merchant());
      if(candidates.data.length>1)throw new LocalError('INVALID_CUSTOMER_ACCOUNT_REQUEST',409);
      customerId=candidates.data[0]?.customer_id;
      if(!customerId){
        try{customerId=(await client.customers.create({email:current.email,name:current.name,external_reference_id:current.user_id},auth.merchant(identity.actionKey(`customer:${preflight.sandboxId}:${current.user_id}`)))).customer_id;}
        catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='CUSTOMER_EMAIL_ALREADY_USED'))throw error;customerId=(await client.customers.list({email:current.email},auth.merchant())).data[0]?.customer_id;}
      }
    }
    if(!customerId||identity.customerBoundElsewhere(current.user_id,preflight.sandboxId,customerId))throw new LocalError('EMAIL_ALREADY_CONNECTED',409);
    const request=await store.mutate(`${preflight.sandboxId}:${current.user_id}:verification`,'verify',{customer_id:customerId,email:current.email,previous:previous?.customer_verification_id??null},key=>client.customerVerifications.create({customer_id:customerId!,email:current.email,purpose:'link_guest_purchases',channel:'email'},auth.merchant(key)),nonce(c));
    identity.setPending(c.get('session'),{customer_verification_id:request.customer_verification_id,customer_id:request.customer_id,email:request.email,purpose:request.purpose,created_at:Date.now()});
    return finish(c,link?'/link-purchases':'/verify-email?next='+encodeURIComponent(next),{verification:{status:'code_sent'}});
  };
  const confirmVerification=async(c:C,link=false)=>{
    const current=c.get('user'),pending=identity.pending(c.get('session')),next=returnPath(c.get('body').next);c.set('errorReturn',link?'/link-purchases':'/verify-email?next='+encodeURIComponent(next));
    if(!current||!pending||pending.email!==current.email||pending.purpose!=='link_guest_purchases')throw new LocalError('INVALID_CUSTOMER_ACCOUNT_REQUEST',400);
    if(!limiter.take(`confirm:${c.get('session').session_hash}`,10,900000))throw new LocalError('RATE_LIMITED',429);
    const confirmed=await store.mutate(`${preflight.sandboxId}:${current.user_id}:${pending.customer_verification_id}`,'confirm',{code:code(c.get('body').code)},key=>client.customerVerifications.confirm(pending.customer_verification_id,{code:code(c.get('body').code)},auth.merchant(key)),nonce(c));
    if(confirmed.status!=='confirmed'||confirmed.customer_id!==pending.customer_id||normalizeEmail(confirmed.email)!==current.email||confirmed.purpose!=='link_guest_purchases'||identity.customerBoundElsewhere(current.user_id,preflight.sandboxId,confirmed.customer_id))throw new LocalError('INVALID_CUSTOMER_ACCOUNT_REQUEST',409);
    identity.bind(current.user_id,preflight.sandboxId,confirmed.customer_id,current.email);
    const linked=await client.customers.linkGuestPurchases(confirmed.customer_id,{customer_verification_id:confirmed.customer_verification_id},auth.merchant(identity.actionKey(`link:${preflight.sandboxId}:${confirmed.customer_verification_id}`)));
    identity.setPending(c.get('session'),null);flash(c,Number(linked.linked_order_count)>0?'email_confirmed_linked':'email_confirmed',{count:Number(linked.linked_order_count),orders:Number(linked.linked_order_count)===1?'order':'orders'});
    const rotated=identity.rotate(c.get('session'),current.user_id);cookie(c,rotated.token);
    if(link)return page(c,'ac-link-purchases',{state:'done',email:current.email,linked_order_count:Number(linked.linked_order_count)});
    return c.redirect(next,303);
  };
  app.post('/verify-email/send',c=>sendVerification(c));app.post('/verify-email/confirm',c=>confirmVerification(c));
  app.post('/link-purchases/send',c=>sendVerification(c,true));app.post('/link-purchases/confirm',c=>confirmVerification(c,true));
  app.get('/',async c=>{
    await me(c,opts=>client.me.get(undefined,opts));
    const [orders,subscriptions,invoices,returns]=await Promise.all([
      loaded(async()=>list('order',await me(c,opts=>client.me.listOrders({page_size:3},opts)))),
      loaded(async()=>list('subscription',await me(c,opts=>client.me.listSubscriptions({page_size:100},opts)))),
      loaded(async()=>list('invoice',await me(c,opts=>client.me.listInvoices({page_size:100},opts)))),
      loaded(async()=>list('return',await me(c,opts=>client.me.listReturns({page_size:100},opts))))]);
    return page(c,'ac-home',{orders,subscriptions,invoices,returns});
  });
  app.get('/orders',async c=>page(c,'ac-orders',{orders:await loaded(async()=>list('order',await me(c,opts=>client.me.listOrders(pagination(c),opts)))),page_token:c.req.query('page')}));
  const orderData=async(c:C)=>{
    const orderId=id(c.req.param('orderId')),order=await ownedOrder(c,orderId);
    const [payments,refunds,fulfillments,shipments,packages,events]=await Promise.all([
      loaded(async()=>items('payment',await me(c,opts=>client.me.listPayments({order_id:orderId,page_size:100},opts)))),
      loaded(async()=>items('refund',await me(c,opts=>client.me.listRefunds({order_id:orderId,page_size:100},opts)))),
      loaded(async()=>items('fulfillment',await me(c,opts=>client.me.listFulfillments({order_id:orderId,page_size:100},opts)))),
      loaded(async()=>items('shipment',await me(c,opts=>client.me.listShipments({order_id:orderId,page_size:100},opts)))),
      loaded(async()=>items('package',await me(c,opts=>client.me.listPackages({order_id:orderId,page_size:100},opts)))),
      loaded(async()=>items('event',await me(c,opts=>client.me.listFulfillmentEvents({order_id:orderId,page_size:100},opts))))]);
    return {order:project('order',order),payments,refunds,fulfillments,shipments,packages,events};
  };
  app.get('/orders/:orderId',async c=>page(c,'ac-order',await orderData(c)));
  app.get('/orders/:orderId/receipt',async c=>page(c,'ac-order-receipt',await orderData(c)));
  app.post('/orders/:orderId/receipt',async c=>{
    const orderId=id(c.req.param('orderId'));c.set('errorReturn',`/orders/${orderId}`);
    const order=await ownedOrder(c,orderId);requireAction(order,'resend_receipt');
    await mutate(c,'receipt',`order:${orderId}`,{},opts=>client.me.sendOrderReceipt(orderId,undefined,opts));flash(c,'receipt_sent',{email:user(c).email});return finish(c,`/orders/${orderId}`);
  });
  const returnStartData=async(c:C)=>{
    const orderId=id(c.req.param('orderId')),order=await ownedOrder(c,orderId);requireAction(order,'start_return');
    const [preview,reasons]=await Promise.all([me(c,opts=>client.me.createReturnPreview({mode:'eligibility',eligibility:{order_id:orderId,selection:{selection_type:'all_remaining_fulfilled'}}},opts)),client.returnReasons.list({status:['active'],page_size:100},auth.merchant())]);
    if(!preview.eligibility)throw new LocalError('RETURN_PREVIEW_UNAVAILABLE',503);
    return {order:{order_id:order.order_id,order_number:order.order_number},eligibility:project('eligibility',preview.eligibility),reasons:items('reason',reasons)};
  };
  app.get('/orders/:orderId/return',async c=>page(c,'ac-return-start',await returnStartData(c)));
  app.post('/orders/:orderId/return',async c=>{
    const orderId=id(c.req.param('orderId'));c.set('errorReturn',`/orders/${orderId}/return`);
    const data=await returnStartData(c),body=c.get('body');let raw=body.line_items;
    if(typeof raw==='string'){try{raw=JSON.parse(raw);}catch{throw new LocalError('INVALID_INPUT');}}
    if(!Array.isArray(raw)){
      raw=data.eligibility.line_items.flatMap((line,index)=>{
        const prefix=`line_${index}_`;return bool(body[prefix+'selected'])?[{order_line_item_id:body[prefix+'order_line_item_id'],fulfillment_id:body[prefix+'fulfillment_id'],requested_quantity:body[prefix+'quantity'],return_reason_id:body[prefix+'reason'],buyer_note:body[prefix+'note']}]:[];
      });
    }
    const seen=new Set<string>();
    const lines:ReturnLineItemRequestInput[]=(raw as unknown[]).map(value=>{
      const row=object(value),lineId=id(row.order_line_item_id),fulfillmentId=id(row.fulfillment_id),quantity=required(row.requested_quantity,20),reason=id(row.return_reason_id),key=`${lineId}:${fulfillmentId}`;
      const eligible=data.eligibility.line_items.find(line=>line.order_line_item_id===lineId&&line.fulfillment_id===fulfillmentId);
      if(seen.has(key)||!eligible||!eligible.is_self_service_enabled||eligible.eligibility.status==='ineligible'||!/^\d+$/.test(quantity)||BigInt(quantity)<1n||BigInt(quantity)>BigInt(eligible.eligibility.eligible_quantity)||!data.reasons.some(r=>r.return_reason_id===reason))throw new LocalError('RETURN_SELECTION_INVALID');
      const buyerNote=row.buyer_note?text(row.buyer_note,500):undefined;
      if(data.reasons.find(r=>r.return_reason_id===reason)?.is_note_required&&!buyerNote)throw new LocalError('RETURN_REASON_NOTE_REQUIRED');
      seen.add(key);return {order_line_item_id:lineId,fulfillment_id:fulfillmentId,requested_quantity:quantity,return_reason_id:reason,buyer_note:buyerNote};
    });
    if(!lines.length)throw new LocalError('RETURN_SELECTION_REQUIRED');
    const created=await mutate(c,'create-return',`order:${orderId}`,{order_id:orderId,line_items:lines},opts=>client.me.createReturn({order_id:orderId,line_items:lines},opts));flash(c,'return_requested');return finish(c,`/returns/${created.return_id}`,{return:project('return',created)});
  });
  app.get('/returns',async c=>page(c,'ac-returns',{returns:await loaded(async()=>list('return',await me(c,opts=>client.me.listReturns(pagination(c),opts)))),page_token:c.req.query('page')}));
  app.get('/returns/:returnId',async c=>{
    const returnId=id(c.req.param('returnId')),resource=await ownedReturn(c,returnId);
    const packages=await loaded(async()=>{
      const shipments=await me(c,opts=>client.me.listShipments({return_id:returnId,page_size:100},opts));
      const results=await Promise.all(shipments.data.map(shipment=>me(c,opts=>client.me.listPackages({shipment_id:shipment.shipment_id,page_size:100},opts))));
      return results.flatMap(result=>items('package',result));
    });return page(c,'ac-return',{return:project('return',resource),packages});
  });
  app.post('/returns/:returnId/withdraw',async c=>{
    const returnId=id(c.req.param('returnId'));c.set('errorReturn',`/returns/${returnId}`);
    requireAction(await ownedReturn(c,returnId),'withdraw');const result=await mutate(c,'withdraw',`return:${returnId}`,{reason:'buyer_request'},opts=>client.me.cancelReturn(returnId,{reason:'buyer_request'},opts));return finish(c,`/returns/${returnId}`,{return:project('return',result)});
  });
  app.get('/invoices',async c=>page(c,'ac-invoices',{invoices:await loaded(async()=>list('invoice',await me(c,opts=>client.me.listInvoices(pagination(c),opts)))),page_token:c.req.query('page')}));
  app.get('/invoices/:invoiceId',async c=>{
    const invoiceId=id(c.req.param('invoiceId')),invoice=await ownedInvoice(c,invoiceId);
    return page(c,'ac-invoice',{invoice:project('invoice',invoice),credit_notes:await loaded(async()=>items('credit',await me(c,opts=>client.me.listCreditNotes(invoiceId,{page_size:100},opts)))),awaiting_payment:c.req.query('payment')==='received'});
  });
  app.get('/invoices/:invoiceId/status',async c=>c.json({invoice:project('invoice',await ownedInvoice(c,id(c.req.param('invoiceId'))))}));
  app.get('/invoices/:invoiceId/pdf',async c=>{
    const invoiceId=id(c.req.param('invoiceId'));await ownedInvoice(c,invoiceId);
    const result=await me(c,opts=>client.me.getInvoicePDF(invoiceId,undefined,opts));
    c.header('Content-Type','application/pdf');c.header('Content-Disposition','attachment; filename="invoice.pdf"');return c.body(result.data as Uint8Array<ArrayBuffer>);
  });
  app.get('/invoices/:invoiceId/credit-notes/:creditNoteId/pdf',async c=>{
    const invoiceId=id(c.req.param('invoiceId')),creditId=id(c.req.param('creditNoteId'));await ownedInvoice(c,invoiceId);
    await me(c,opts=>client.me.getCreditNote(invoiceId,creditId,undefined,opts));
    const result=await me(c,opts=>client.me.getCreditNotePDF(invoiceId,creditId,undefined,opts));c.header('Content-Type','application/pdf');c.header('Content-Disposition','attachment; filename="credit-note.pdf"');return c.body(result.data as Uint8Array<ArrayBuffer>);
  });
  const paymentRecord=(c:C,type:'invoice'|'return',resourceId:string)=>{
    const record=store.checkout(user(c).user_id,preflight.sandboxId,type,resourceId);if(!record)throw new LocalError('NOT_FOUND',404);return record;
  };
  const launchPayment=async(c:C,type:'invoice'|'return',returned=false)=>{
    const resourceId=id(c.req.param(type==='invoice'?'invoiceId':'returnId')),root=type==='invoice'?'invoices':'returns',current=user(c);
    const resource=type==='invoice'?await ownedInvoice(c,resourceId):await ownedReturn(c,resourceId),action=type==='invoice'?'pay':'pay_balance';
    let record=store.checkout(current.user_id,preflight.sandboxId,type,resourceId);
    if(!resource.buyer_actions.some(item=>item.kind===action&&item.is_available)&&!record)return c.redirect(`/${root}/${resourceId}`,303);
    let launch:'ready'|'surface_conflict'|'collection_in_progress'='ready';
    if(!record||!returned){
      try{
        record=await store.locked(`launch:${preflight.sandboxId}:${current.user_id}:${type}:${resourceId}`,async()=>{
          const previous=store.checkout(current.user_id,preflight.sandboxId,type,resourceId);
          if(previous){
            try{const state=await engine.status(previous.checkout_ref);if(state.unknown||attemptOpen(state.attempt)||engine.unresolvedGift(previous))return previous;}
            catch(error){if(!['INVALID_CHECKOUT_SESSION','CHECKOUT_SESSION_NOT_OPEN','CHECKOUT_SESSION_EXPIRED'].includes(appError(error).code))throw error;if(engine.unresolved(previous))throw new LocalError('UNKNOWN_PAYMENT_OUTCOME',409);}
          }
          if(!resource.buyer_actions.some(item=>item.kind===action&&item.is_available))return previous!;
          const resolutionId=type==='return'?('completion_blockers'in resource?resource.completion_blockers.find(blocker=>blocker.code==='resolution_requires_action'&&blocker.return_resolution_id)?.return_resolution_id:undefined):undefined;
          if(type==='return'&&!resolutionId)throw new LocalError('RETURN_PAYMENT_NOT_AVAILABLE',409);
          const generation=(previous?.generation??0)+1,returnUrl=`${config.appOrigin}/${root}/${resourceId}/pay/return`,freshBody={surface:'embedded' as const,page_origin:config.appOrigin,redirects:{success_redirect_url:returnUrl}};
          const launchResource=`${preflight.sandboxId}:${current.user_id}:launch:${type}:${resourceId}`,launchNonce=`generation:${generation}`,actionId=createHash('sha256').update(`${launchResource}:launch:${launchNonce}`).digest('hex');
          const prior=store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',actionId);
          const replay=prior&&(prior.status==='pending'||prior.status==='unknown')&&prior.body;
          const journalBody=replay?JSON.parse(prior.body!) as typeof freshBody&{generation:number;resolutionId?:string}:{...freshBody,generation,resolutionId};
          const {generation:storedGeneration,resolutionId:storedResolutionId,...body}=journalBody;
          const result=await store.mutate(launchResource,'launch',journalBody,async key=>{
            const launched=await sessions.call(current,opts=>type==='invoice'?client.me.createInvoiceCheckoutSession(resourceId,body,opts):client.me.createReturnResolutionCheckoutSession(storedResolutionId!,body,opts),key);
            return {...launched,checkout_session:{...launched.checkout_session,gift_card_challenge:undefined}};
          },launchNonce);
          if(!result.checkout_session.order_id||result.checkout_session.surface!=='embedded')throw new LocalError('CHECKOUT_LAUNCH_INVALID',503);
          if(!replay&&body.page_origin&&result.checkout_session.page_origin!==body.page_origin){logLaunchInvalid('page_origin_mismatch');throw new LocalError('CHECKOUT_LAUNCH_INVALID',503);}
          if(previous&&previous.checkout_session_id!==result.checkout_session.checkout_session_id)store.closeGiftChallenges(previous.checkout_ref);
          const ref=previous?.checkout_ref??randomUUID(),now=Date.now();
          store.run(`INSERT INTO payment_checkouts(checkout_ref,user_id,sandbox_id,resource_type,resource_id,resolution_id,order_id,checkout_session_id,checkout_auth_token,generation,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,sandbox_id,resource_type,resource_id) DO UPDATE SET last_attempt_id=CASE WHEN payment_checkouts.order_id=excluded.order_id THEN payment_checkouts.last_attempt_id ELSE NULL END,order_id=excluded.order_id,checkout_session_id=excluded.checkout_session_id,checkout_auth_token=excluded.checkout_auth_token,resolution_id=excluded.resolution_id,generation=excluded.generation,updated_at=excluded.updated_at`,ref,current.user_id,preflight.sandboxId,type,resourceId,storedResolutionId??null,result.checkout_session.order_id,result.checkout_session.checkout_session_id,result.checkout_access.checkout_auth_token,storedGeneration,now,now);
          return store.checkout(current.user_id,preflight.sandboxId,type,resourceId)!;
        });
      }catch(error){const code=appError(error).code;if(code==='CHECKOUT_SURFACE_CHANGE_NOT_ALLOWED')launch='surface_conflict';else if(code==='ORDER_COLLECTION_IN_PROGRESS')launch='collection_in_progress';else throw error;}
    }
    let state=null;
    if(record&&launch==='ready'){
      const result=returned?await engine.resume(record.checkout_ref):await engine.status(record.checkout_ref),job=await engine.view(record,result,returned);state=job.state;
      if(job.next==='done'||job.next==='bank_processing'){flash(c,type==='return'?'return_payment_received':job.next==='done'?'invoice_payment_received':'invoice_payment_processing');return c.redirect(`/${root}/${resourceId}${type==='invoice'?'?payment=received':''}`,303);}
    }
    return page(c,type==='invoice'?'ac-invoice-pay':'ac-return-pay',{surface:type,resource_id:resourceId,buyer:{name:current.name,email:current.email},summary:{[type]:project(type,resource)},launch,state,returned});
  };
  app.get('/invoices/:invoiceId/pay',c=>launchPayment(c,'invoice'));app.get('/invoices/:invoiceId/pay/return',c=>launchPayment(c,'invoice',true));
  app.get('/returns/:returnId/pay',c=>launchPayment(c,'return'));app.get('/returns/:returnId/pay/return',c=>launchPayment(c,'return',true));
  const paymentJob=async(c:C,type:'invoice'|'return',kind:'submit'|'resume'|'attempt'|'cancel')=>{
    const resourceId=id(c.req.param(type==='invoice'?'invoiceId':'returnId'));
    // Recheck ownership through me before touching persisted payment authority.
    if(type==='invoice')await ownedInvoice(c,resourceId);else await ownedReturn(c,resourceId);
    const record=paymentRecord(c,type,resourceId);
    if(kind!=='attempt'&&!limiter.take(`pay:${currentKey(c)}:${record.checkout_ref}`,10,60000))throw new LocalError('RATE_LIMITED',429);
    try{
      let payInput:PayInput|undefined;
      if(kind==='submit'){
        const body=c.get('body'),approved=object(body.approved_outstanding_money),amount=required(approved.amount,30),currency=required(approved.currency,3);
        if(!/^\d+$/.test(amount)||!/^[A-Z]{3}$/.test(currency))throw new LocalError('INVALID_INPUT');
        let credential:PayInput['credential'];if(body.credential){const value=object(body.credential),kind=value.kind;if(kind!=='confirmation_token'&&kind!=='payment_method_token'&&kind!=='saved_payment_method')throw new LocalError('INVALID_INPUT');credential={kind,value:required(value.value,2048)};}
        const collection=body.approved_collection_kind;if(collection!=='processor'&&collection!=='settlement')throw new LocalError('INVALID_INPUT');
        let giftMoney:PayInput['approved_gift_card_money'];if(body.approved_gift_card_money){const value=object(body.approved_gift_card_money),giftAmount=required(value.amount,30),giftCurrency=required(value.currency,3);if(!/^\d+$/.test(giftAmount)||!/^[A-Z]{3}$/.test(giftCurrency))throw new LocalError('INVALID_INPUT');giftMoney={amount:giftAmount,currency:giftCurrency};}
        payInput={approved_outstanding_money:{amount,currency},approved_collection_kind:collection,approved_order_revision:body.approved_order_revision===undefined?undefined:required(body.approved_order_revision,200),approved_gift_card_money:giftMoney,credential};
      }
      const result=kind==='submit'?await engine.start(record.checkout_ref,payInput!,nonce(c)):kind==='resume'?await engine.resume(record.checkout_ref,nonce(c)):kind==='cancel'?await engine.cancel(record.checkout_ref):await engine.status(record.checkout_ref);
      return c.json(await engine.view(record,result));
    }catch(error){const safe=appError(error);let job;try{job=await engine.view(record,await engine.status(record.checkout_ref));}catch{}return c.json({error:safe,...job},errorStatus(error) as 400);}
  };
  const currentKey=(c:C)=>c.get('session').session_hash;
  for(const type of ['invoice','return'] as const){
    const route=type==='invoice'?'/invoices/:invoiceId/pay':'/returns/:returnId/pay';
    const ownedPayment=async(c:C)=>{const resourceId=id(c.req.param(type==='invoice'?'invoiceId':'returnId'));if(type==='invoice')await ownedInvoice(c,resourceId);else await ownedReturn(c,resourceId);return paymentRecord(c,type,resourceId);};
    const payPath=(c:C)=>`/${type==='invoice'?'invoices':'returns'}/${id(c.req.param(type==='invoice'?'invoiceId':'returnId'))}/pay`;
    app.post(route+'/gift-card',async c=>{
      const record=await ownedPayment(c);if(!limiter.take(`gift-apply:${currentKey(c)}`,5,3600000))throw new LocalError('RATE_LIMITED',429);
      if(!c.req.header('Content-Type')?.includes('application/json'))throw new LocalError('INVALID_INPUT');
      const actionId=nonce(c);if(!actionId)throw new LocalError('INVALID_INPUT');
      const giftCardCode=required(c.get('body').gift_card_code,200),challenge=await engine.applyGift(record.checkout_ref,giftCardCode,config.giftChallengeOrigin,actionId);
      if(challenge)return c.json({gift_challenge:challenge});flash(c,'gift_card_applied');return c.json({redirect:payPath(c)});
    });
    app.post(route+'/gift-card/challenge',async c=>{
      const record=await ownedPayment(c);if(!limiter.take(`gift-challenge:${currentKey(c)}`,10,3600000))throw new LocalError('RATE_LIMITED',429);
      if(!c.req.header('Content-Type')?.includes('application/json'))throw new LocalError('INVALID_INPUT');
      const input=c.get('body'),challengeId=input.challenge_id,proof=input.proof,giftCardCode=required(input.gift_card_code,200);
      if(typeof challengeId!=='string'||!/^gch_[A-Za-z0-9_-]{32}$/.test(challengeId)||!validProof(proof))throw new LocalError('INVALID_INPUT');
      const challenge=await engine.retryGift(record.checkout_ref,challengeId,giftCardCode,proof,config.giftChallengeOrigin);
      if(challenge)return c.json({gift_challenge:challenge});flash(c,'gift_card_applied');return c.json({redirect:payPath(c)});
    });
    app.post(route+'/gift-card/:giftCardId/remove',async c=>{
      c.set('errorReturn',payPath(c));const record=await ownedPayment(c),actionId=nonce(c);if(!actionId)throw new LocalError('INVALID_INPUT');
      try{await engine.removeGift(record.checkout_ref,id(c.req.param('giftCardId')),actionId);}
      catch(error){if(!unknownOutcome(error))throw error;return c.redirect(payPath(c),303);}
      flash(c,'gift_card_removed');return c.redirect(payPath(c),303);
    });
    app.post(route+'/submit',c=>paymentJob(c,type,'submit'));app.post(route+'/pay',c=>paymentJob(c,type,'submit'));
    app.post(route+'/resume',c=>paymentJob(c,type,'resume'));app.get(route+'/attempt',c=>paymentJob(c,type,'attempt'));app.post(route+'/cancel-attempt',c=>paymentJob(c,type,'cancel'));
  }
  app.get('/subscriptions',async c=>page(c,'ac-subscriptions',{subscriptions:await loaded(async()=>list('subscription',await me(c,opts=>client.me.listSubscriptions(pagination(c),opts)))),page_token:c.req.query('page')}));
  app.get('/subscriptions/:subscriptionId',async c=>{
    const subscriptionId=id(c.req.param('subscriptionId')),subscription=await ownedSubscription(c,subscriptionId),retryId=c.req.query('retry');
    const [settings,methods]=await Promise.all([loaded(()=>client.settings.getEffective(undefined,auth.merchant())),loaded(async()=>items('method',await me(c,opts=>client.me.listPaymentMethods(undefined,opts))))]);
    const retry=retryId?project('retry',await me(c,opts=>client.me.getSubscriptionPaymentRetry(subscriptionId,id(retryId),undefined,opts))):null;
    return page(c,'ac-subscription',{subscription:project('subscription',subscription),billing_history:await loaded(async()=>list('order',await me(c,opts=>client.me.listOrders({subscription_id:subscriptionId,page_size:100},opts)))),capabilities:settings.status==='ok'?settings.value.customer_account?.buyer_capabilities??null:null,payment_methods:methods,retry});
  });
  const subscriptionAction=async(c:C,action:'cancel'|'pause'|'resume'|'reactivate'|'payment-method'|'retry')=>{
    const subscriptionId=id(c.req.param('subscriptionId')),body=c.get('body');c.set('errorReturn',`/subscriptions/${subscriptionId}`);
    const resource=await ownedSubscription(c,subscriptionId),kind=action==='payment-method'?'update_payment_method':action==='retry'?'retry_payment':action;
    // Replay uncertain actions with the same key before evaluating their new state.
    const pending=store.get('SELECT action_id FROM actions WHERE resource=? AND kind=? AND status IN (\'pending\',\'unknown\')',`${preflight.sandboxId}:${user(c).user_id}:subscription:${subscriptionId}`,action);
    if(!pending)requireAction(resource,kind);
    let result;
    if(action==='cancel'){
      const settings=await client.settings.getEffective(undefined,auth.merchant()),capabilities=settings.customer_account?.buyer_capabilities;
      const immediate=bool(body.cancel_immediately)||body.cancel_when==='now',reason=(body.cancellation_reason_code??body.reason)?required(body.cancellation_reason_code??body.reason):undefined,comment=(body.cancellation_comment??body.comment)?text(body.cancellation_comment??body.comment,1000):undefined;
      if(immediate&&capabilities?.cancellation_timing!=='buyer_chooses'&&resource.status==='active')throw new LocalError('CANCEL_IMMEDIATELY_NOT_ALLOWED');
      if(capabilities?.cancellation_reasons?.length&&!capabilities.cancellation_reasons.includes(reason??''))throw new LocalError('CANCELLATION_REASON_NOT_OFFERED');
      const allowed=['too_expensive','missing_features','switched_service','unused','customer_service','too_complex','low_quality','other'] as const;
      if(reason&&!allowed.some(value=>value===reason))throw new LocalError('CANCELLATION_REASON_NOT_OFFERED');
      const request={cancel_immediately:immediate,cancellation_reason_code:reason as typeof allowed[number]|undefined,cancellation_comment:comment};
      result=await mutate(c,action,`subscription:${subscriptionId}`,request,opts=>client.me.cancelSubscription(subscriptionId,request,opts));
    }else if(action==='pause'){
      const count=body.pause_duration_cycles??body.pause_cycles??body.cycles,cycles=count===undefined||count===''?undefined:Number(count);
      if(cycles!==undefined&&(!Number.isSafeInteger(cycles)||cycles<1))throw new LocalError('PAUSE_DURATION_REQUIRED');
      result=await mutate(c,action,`subscription:${subscriptionId}`,{pause_duration_cycles:cycles},opts=>client.me.pauseSubscription(subscriptionId,{pause_duration_cycles:cycles},opts));
    }else if(action==='resume')result=await mutate(c,action,`subscription:${subscriptionId}`,{},opts=>client.me.resumeSubscription(subscriptionId,undefined,opts));
    else if(action==='reactivate')result=await mutate(c,action,`subscription:${subscriptionId}`,{},opts=>client.me.reactivateSubscription(subscriptionId,undefined,opts));
    else if(action==='payment-method'){
      const methodId=id(body.payment_method_id),method=await me(c,opts=>client.me.getPaymentMethod(methodId,undefined,opts));
      if(method.status!=='active'||method.type!=='card'||method.usage!=='off_session')throw new LocalError('PAYMENT_METHOD_NOT_USABLE');
      result=await mutate(c,action,`subscription:${subscriptionId}`,{payment_method_id:methodId},opts=>client.me.changeSubscriptionPaymentMethod(subscriptionId,{payment_method_id:methodId},opts));
    }else{
      if(!limiter.take(`retry:${currentKey(c)}`,10,60000))throw new LocalError('RATE_LIMITED',429);
      const retry=await mutate(c,action,`subscription:${subscriptionId}`,{},opts=>client.me.createSubscriptionPaymentRetry(subscriptionId,{},opts));
      return finish(c,`/subscriptions/${subscriptionId}?retry=${retry.subscription_payment_retry_id}`,{retry:project('retry',retry)});
    }
    return finish(c,`/subscriptions/${subscriptionId}`,{subscription:project('subscription',result)});
  };
  for(const action of ['cancel','pause','resume','reactivate','payment-method','retry'] as const)app.post(`/subscriptions/:subscriptionId/${action}`,c=>subscriptionAction(c,action));
  app.post('/subscriptions/:subscriptionId/retry-payment',c=>subscriptionAction(c,'retry'));
  app.get('/subscriptions/:subscriptionId/retries/:retryId',async c=>{
    const subscriptionId=id(c.req.param('subscriptionId'));await ownedSubscription(c,subscriptionId);return c.json({retry:project('retry',await me(c,opts=>client.me.getSubscriptionPaymentRetry(subscriptionId,id(c.req.param('retryId')),undefined,opts)))});
  });
  app.get('/subscriptions/:subscriptionId/retry/:retryId',async c=>{
    const subscriptionId=id(c.req.param('subscriptionId'));await ownedSubscription(c,subscriptionId);return c.json({retry:project('retry',await me(c,opts=>client.me.getSubscriptionPaymentRetry(subscriptionId,id(c.req.param('retryId')),undefined,opts)))});
  });
  app.get('/payment-methods',async c=>{
    const customer=await me(c,opts=>client.me.get(undefined,opts));return page(c,'ac-payment-methods',{payment_methods:await loaded(async()=>items('method',await me(c,opts=>client.me.listPaymentMethods(undefined,opts)))),default_payment_method_id:customer.default_payment_method_id});
  });
  app.get('/payment-methods/new',c=>page(c,'ac-payment-method-new',{return_to:returnPath(c.req.query('return_to'),'/payment-methods')}));
  app.get('/payment-methods/new/return',async c=>{
    const pending=store.get<{payment_method_id:string;return_to:string}>('SELECT * FROM pending_cards WHERE user_id=? AND sandbox_id=?',user(c).user_id,preflight.sandboxId);
    const method=pending?await me(c,opts=>client.me.getPaymentMethod(pending.payment_method_id,undefined,opts)):null;
    if(method?.status==='active'&&pending)return c.redirect(returnPath(pending.return_to,'/payment-methods'),303);
    return page(c,'ac-payment-method-return',{payment_method:method?safeMethod(method):null});
  });
  app.post('/payment-methods/new/setup',async c=>{
    if(!limiter.take(`setup:${currentKey(c)}`,10,60000))throw new LocalError('RATE_LIMITED',429);
    const pending=store.get<{payment_method_id:string}>('SELECT * FROM pending_cards WHERE user_id=? AND sandbox_id=?',user(c).user_id,preflight.sandboxId);
    const previous=pending?await me(c,opts=>client.me.getPaymentMethod(pending.payment_method_id,undefined,opts)):undefined;
    const resource=`${preflight.sandboxId}:${user(c).user_id}:card-setup`;
    const sequence=store.get<{n:number}>('SELECT COUNT(*) AS n FROM actions WHERE resource=?',resource)!.n;
    const result=await store.mutate(resource,'card-setup',{type:'card',generation:previous?.status==='pending'?sequence-1:sequence},key=>sessions.call(user(c),opts=>client.me.savePaymentMethod({type:'card'},opts),key),nonce(c));
    if(!result.client_setup?.stripe?.setup_intent?.client_secret)throw new LocalError('CARD_SETUP_UNAVAILABLE',503);
    store.run('INSERT OR REPLACE INTO pending_cards VALUES(?,?,?,?,?)',user(c).user_id,preflight.sandboxId,result.payment_method.payment_method_id,returnPath(c.get('body').return_to,'/payment-methods'),Date.now());
    return c.json({payment_method:{payment_method_id:result.payment_method.payment_method_id,status:result.payment_method.status},client_setup:{stripe:result.client_setup.stripe}});
  });
  const cardStatus=async(c:C)=>{
    const methodId=id(c.req.param('methodId')??c.get('body').payment_method_id),method=await me(c,opts=>client.me.getPaymentMethod(methodId,undefined,opts));
    return c.json({payment_method:safeMethod(method)});
  };
  app.get('/payment-methods/:methodId/status',cardStatus);
  app.post('/payment-methods/new/confirm',async c=>{
    const pending=store.get<{payment_method_id:string}>('SELECT * FROM pending_cards WHERE user_id=? AND sandbox_id=?',user(c).user_id,preflight.sandboxId);
    if(!pending||pending.payment_method_id!==c.get('body').payment_method_id)throw new LocalError('NOT_FOUND',404);return cardStatus(c);
  });
  const cardAction=async(c:C,action:'default'|'remove')=>{
    const methodId=id(c.req.param('methodId'));c.set('errorReturn','/payment-methods');
    const method=await me(c,opts=>client.me.getPaymentMethod(methodId,undefined,opts));
    if(action==='default'&&(method.status!=='active'||method.usage!=='off_session'))throw new LocalError('PAYMENT_METHOD_NOT_USABLE');
    const result=action==='default'?await mutate(c,action,`method:${methodId}`,{},opts=>client.me.setDefaultPaymentMethod(methodId,undefined,opts)):await mutate(c,action,`method:${methodId}`,{},opts=>client.me.removePaymentMethod(methodId,undefined,opts));
    return finish(c,'/payment-methods',{payment_method:project('method',result)});
  };
  app.post('/payment-methods/:methodId/default',c=>cardAction(c,'default'));app.post('/payment-methods/:methodId/delete',c=>cardAction(c,'remove'));app.post('/payment-methods/:methodId/remove',c=>cardAction(c,'remove'));
  app.get('/profile',async c=>page(c,'ac-profile',{customer:project('customer',await me(c,opts=>client.me.get(undefined,opts)))}));
  app.post('/profile',async c=>{
    c.set('errorReturn','/profile');const b=c.get('body'),request={name:required(b.name),phone:b.phone===undefined?undefined:text(b.phone,40)};
    const customer=await mutate(c,'profile','profile',request,opts=>client.me.update(request,opts));identity.db.prepare('UPDATE users SET name=? WHERE user_id=?').run(customer.name??request.name,user(c).user_id);flash(c,'profile_saved');return finish(c,'/profile',{customer:project('customer',customer)});
  });
  const pendingEmail=(c:C)=>{const row=store.get<{request:string}>('SELECT request FROM pending_email WHERE user_id=? AND sandbox_id=?',user(c).user_id,preflight.sandboxId);return row?JSON.parse(row.request) as EmailChangeRequest:null;};
  app.get('/profile/email',c=>page(c,'ac-profile-email',{current_email:user(c).email,request:pendingEmail(c)}));
  app.post('/profile/email',async c=>{
    c.set('errorReturn','/profile/email');const newEmail=email(c.get('body').new_email),current=user(c);
    const existing=identity.userByEmail(newEmail);if(existing&&existing.user_id!==current.user_id)throw new LocalError('EMAIL_ALREADY_USED',409);
    if(!limiter.take(`email-change:${currentKey(c)}`,3,900000))throw new LocalError('RATE_LIMITED',429);
    identity.db.exec('BEGIN IMMEDIATE');
    try{
      identity.db.prepare('DELETE FROM account_email_reservations WHERE expires_at<=?').run(Date.now());
      const reservation=identity.db.prepare('SELECT user_id FROM account_email_reservations WHERE email=?').get(newEmail) as {user_id:string}|undefined;
      if(reservation&&reservation.user_id!==current.user_id)throw new LocalError('EMAIL_ALREADY_USED',409);
      if(identity.userByEmail(newEmail)&&identity.userByEmail(newEmail)!.user_id!==current.user_id)throw new LocalError('EMAIL_ALREADY_USED',409);
      identity.db.prepare('INSERT OR REPLACE INTO account_email_reservations VALUES(?,?,?)').run(newEmail,current.user_id,Date.now()+86400000);identity.db.exec('COMMIT');
    }catch(error){identity.db.exec('ROLLBACK');throw error;}
    let request;
    try{request=await mutate(c,'email-change','profile-email',{new_email:newEmail,previous:pendingEmail(c)?.email_change_request_id??null},opts=>client.me.createEmailChangeRequest({new_email:newEmail},opts));}
    catch(error){if(!unknownOutcome(error))identity.db.prepare('DELETE FROM account_email_reservations WHERE email=? AND user_id=?').run(newEmail,current.user_id);throw error;}
    store.run('INSERT OR REPLACE INTO pending_email VALUES(?,?,?,?)',current.user_id,preflight.sandboxId,JSON.stringify(project('email',request)),Date.now());
    identity.db.prepare('UPDATE account_email_reservations SET expires_at=? WHERE email=? AND user_id=?').run(Date.parse(request.expires_at)+86400000,newEmail,current.user_id);
    return finish(c,'/profile/email',{request:project('email',request)});
  });
  app.post('/profile/email/confirm',async c=>{
    c.set('errorReturn','/profile/email');const pending=pendingEmail(c),current=user(c),b=c.get('body');
    if(!pending)throw new LocalError('EMAIL_CHANGE_REQUEST_REQUIRED');
    const existing=identity.userByEmail(pending.new_email);if(existing&&existing.user_id!==current.user_id)throw new LocalError('EMAIL_ALREADY_USED',409);
    if(!limiter.take(`email-confirm:${currentKey(c)}`,10,900000))throw new LocalError('RATE_LIMITED',429);
    const request={new_email_code:code(b.new_email_code),current_email_code:pending.current_email_confirmation_required?code(b.current_email_code):undefined};
    const confirmed=await mutate(c,'email-confirm',`email:${pending.email_change_request_id}`,request,opts=>client.me.confirmEmailChangeRequest(pending.email_change_request_id,request,opts));
    if(!confirmed.confirmed||confirmed.new_email!==pending.new_email)throw new LocalError('EMAIL_CHANGE_NOT_CONFIRMED',409);
    // Flint revoked the old address's sessions. Keep only the browser that proved both inboxes.
    await sessions.locks.locked(`customer-session:${preflight.sandboxId}:${current.user_id}`,async()=>{
      identity.db.exec('BEGIN IMMEDIATE');
      try{
        identity.db.prepare('UPDATE users SET email=? WHERE user_id=?').run(normalizeEmail(confirmed.new_email),current.user_id);
        identity.db.prepare('DELETE FROM sessions WHERE user_id=? AND session_hash<>?').run(current.user_id,c.get('session').session_hash);
        sessions.resetVault(current);identity.db.prepare('DELETE FROM account_email_reservations WHERE user_id=?').run(current.user_id);identity.db.exec('COMMIT');
      }catch(error){identity.db.exec('ROLLBACK');throw error;}
    });
    store.run('DELETE FROM pending_email WHERE user_id=? AND sandbox_id=?',current.user_id,preflight.sandboxId);
    const rotated=identity.rotate(c.get('session'),current.user_id);cookie(c,rotated.token);c.set('session',rotated.session);c.set('user',identity.user(current.user_id));
    await sessions.vault(user(c));
    flash(c,'email_changed',{email:confirmed.new_email});return finish(c,'/profile',{confirmed:true});
  });
  app.get('/profile/password',c=>page(c,'ac-profile-password',{}));
  app.post('/profile/password',async c=>{
    c.set('errorReturn','/profile/password');const current=user(c),b=c.get('body'),password=required(b.new_password,1024);
    if(password.length<10)throw new LocalError('PASSWORD_TOO_SHORT');
    if(!limiter.take(`password:${currentKey(c)}`,5,900000))throw new LocalError('RATE_LIMITED',429);
    if(!await verifyPassword(required(b.current_password,1024),current.password_hash))throw new LocalError('CURRENT_PASSWORD_INCORRECT');
    const hash=await hashPassword(password);
    await sessions.locks.locked(`customer-session:${preflight.sandboxId}:${current.user_id}`,async()=>{
      // Revalidate the password after acquiring the identity lock, including parallel password changes.
      if(!await verifyPassword(required(b.current_password,1024),identity.user(current.user_id)?.password_hash))throw new LocalError('CURRENT_PASSWORD_INCORRECT');
      await store.mutate(`${preflight.sandboxId}:${current.user_id}:password`,'password',{password_digest:digest(password)},key=>client.customers.revokeSessions(current.flint_customer_id!,undefined,auth.merchant(key)),nonce(c));
      identity.db.exec('BEGIN IMMEDIATE');
      try{identity.db.prepare('UPDATE users SET password_hash=? WHERE user_id=?').run(hash,current.user_id);identity.db.prepare('DELETE FROM sessions WHERE user_id=? AND session_hash<>?').run(current.user_id,c.get('session').session_hash);sessions.resetVault(current);identity.db.exec('COMMIT');}catch(error){identity.db.exec('ROLLBACK');throw error;}
    });
    const rotated=identity.rotate(c.get('session'),current.user_id);cookie(c,rotated.token);await sessions.vault(identity.user(current.user_id)!);c.set('session',rotated.session);flash(c,'password_changed');return finish(c,'/profile');
  });
  app.get('/addresses',async c=>page(c,'ac-addresses',{addresses:await loaded(async()=>list('address',await me(c,opts=>client.me.listAddresses({page_size:100},opts))))}));
  app.get('/addresses/new',async c=>page(c,'ac-address-form',{mode:'new',is_first:(await me(c,opts=>client.me.listAddresses({page_size:1},opts))).data.length===0}));
  app.get('/addresses/:addressId/edit',async c=>page(c,'ac-address-form',{mode:'edit',address:project('address',await me(c,opts=>client.me.getAddress(id(c.req.param('addressId')),undefined,opts)))}));
  const addressInput=(body:Record<string,unknown>)=>{
    const a=body.address?object(body.address):body;
    const address:PostalAddressInput={line1:required(a.line1),line2:a.line2?text(a.line2):undefined,city:required(a.city),state:required(a.state),postal_code:required(a.postal_code,30),country:required(a.country,2).toUpperCase()};
    if(!/^[A-Z]{2}$/.test(address.country))throw new LocalError('INVALID_INPUT');
    return {address,recipient_name:required(body.recipient_name),label:body.label?text(body.label):undefined,phone:body.phone?text(body.phone,40):undefined};
  };
  app.post('/addresses',async c=>{
    c.set('errorReturn','/addresses/new');const body=c.get('body'),request=addressInput(body),first=(await me(c,opts=>client.me.listAddresses({page_size:1},opts))).data.length===0;
    const input={...request,is_default_billing:first||bool(body.is_default_billing),is_default_shipping:first||bool(body.is_default_shipping)};
    const address=await mutate(c,'address-create','addresses',input,opts=>client.me.createAddress(input,opts));return finish(c,'/addresses',{address:project('address',address)});
  });
  app.post('/addresses/:addressId',async c=>{
    const addressId=id(c.req.param('addressId'));c.set('errorReturn',`/addresses/${addressId}/edit`);await me(c,opts=>client.me.getAddress(addressId,undefined,opts));const request=addressInput(c.get('body'));
    let address=await mutate(c,'address-update',`address:${addressId}`,request,opts=>client.me.updateAddress(addressId,request,opts));
    const shipping=bool(c.get('body').is_default_shipping),billing=bool(c.get('body').is_default_billing);
    if(shipping||billing){const defaultFor=shipping&&billing?'both' as const:shipping?'shipping' as const:'billing' as const;address=await mutate(c,'address-default',`address:${addressId}`,{default_for:defaultFor},opts=>client.me.setDefaultAddress(addressId,{default_for:defaultFor},opts));}
    flash(c,'address_saved');return finish(c,'/addresses',{address:project('address',address)});
  });
  app.post('/addresses/:addressId/default',async c=>{
    c.set('errorReturn','/addresses');const addressId=id(c.req.param('addressId')),defaultFor=c.get('body').default_for??c.get('body').purpose??c.get('body').kind;
    if(defaultFor!=='shipping'&&defaultFor!=='billing'&&defaultFor!=='both')throw new LocalError('INVALID_INPUT');
    await me(c,opts=>client.me.getAddress(addressId,undefined,opts));const address=await mutate(c,'address-default',`address:${addressId}`,{default_for:defaultFor},opts=>client.me.setDefaultAddress(addressId,{default_for:defaultFor},opts));return finish(c,'/addresses',{address:project('address',address)});
  });
  app.post('/addresses/:addressId/delete',async c=>{
    c.set('errorReturn','/addresses');const addressId=id(c.req.param('addressId'));await me(c,opts=>client.me.getAddress(addressId,undefined,opts));await mutate(c,'address-delete',`address:${addressId}`,{},opts=>client.me.deleteAddress(addressId,undefined,opts));return finish(c,'/addresses');
  });
  app.get('/gift-cards',async c=>page(c,'ac-gift-cards',{gift_cards:await loaded(async()=>list('gift',await me(c,opts=>client.me.listGiftCards(pagination(c),opts))))}));
  app.get('/gift-cards/add',c=>page(c,'ac-gift-card-add',{tab:c.req.query('tab')==='link'?'link':'code'}));
  app.post('/gift-cards',async c=>{
    c.set('errorReturn','/gift-cards/add');if(!limiter.take(`gift:${currentKey(c)}`,5,3600000))throw new LocalError('RATE_LIMITED',429);
    const body=c.get('body');let request:{credential_type:'code';code:string}|{credential_type:'recipient_access';grant_id:string;recipient_access_token:string};
    if(body.credential_type==='recipient_access')request=giftRecipient(body.grant_id,body.recipient_access_token);
    else if(body.credential_type==='code')request={credential_type:'code',code:required(body.code,255)};
    else throw new LocalError('INVALID_INPUT');
    const card=await mutate(c,'gift-save','gift-cards',request,opts=>client.me.saveGiftCard(request,opts));return finish(c,`/gift-cards/${card.gift_card_id}`,{gift_card:project('gift',card)});
  });
  app.get('/gift-cards/:giftCardId',async c=>{
    const cardId=id(c.req.param('giftCardId'));let card;
    try{card=await me(c,opts=>client.me.getGiftCard(cardId,undefined,opts));}catch(error){if(errorStatus(error)!==404)throw error;return page(c,'ac-gift-card',{gift_card:null,transactions:{status:'ok',value:[]}});}
    return page(c,'ac-gift-card',{gift_card:project('gift',card),transactions:await loaded(async()=>items('transaction',await me(c,opts=>client.me.listGiftCardTransactions(cardId,{page_size:100},opts))))});
  });
  app.post('/gift-cards/:giftCardId/remove',async c=>{
    c.set('errorReturn','/gift-cards');const cardId=id(c.req.param('giftCardId'));await me(c,opts=>client.me.getGiftCard(cardId,undefined,opts));await mutate(c,'gift-remove',`gift:${cardId}`,{},opts=>client.me.removeGiftCard(cardId,undefined,opts));return finish(c,'/gift-cards');
  });
  app.get('/email-preferences',async c=>{
    const current=c.get('user'),bound=identity.isBound(current,preflight.sandboxId);
    const preferences=bound?await loaded(async()=>project('preferences',await me(c,opts=>client.me.getEmailPreferences(undefined,opts)))):null;
    return page(c,'ac-email-preferences',{signed_in:bound,preferences:preferences?.status==='ok'?preferences.value:null,preferences_error:preferences?.status==='error'?preferences.error:null});
  });
  app.post('/email-preferences/lookup',async c=>{
    const result=await client.emailPreferenceLinks.lookup({token:required(c.get('body').token,8192)},auth.merchant());return c.json({link:project('link',result)});
  });
  app.post('/email-preferences/unsubscribe',async c=>{
    const token=required(c.get('body').token,8192);
    const result=await store.mutate(`unsubscribe:${preflight.sandboxId}:${digest(token)}`,'unsubscribe',{token},key=>client.emailPreferenceLinks.unsubscribe({token},auth.merchant(key)));return c.json({link:project('link',result)});
  });
  app.post('/email-preferences',async c=>{
    c.set('errorReturn','/email-preferences');const request={shipping_updates:bool(c.get('body').shipping_updates),checkout_reminders:bool(c.get('body').checkout_reminders)};
    const preferences=await mutate(c,'preferences','preferences',request,opts=>client.me.updateEmailPreferences(request,opts));flash(c,'email_preferences_saved');return finish(c,'/email-preferences',{preferences:project('preferences',preferences)});
  });
  app.get('/privacy',async c=>page(c,'ac-privacy',{requests:await loaded(async()=>items('deletion',await me(c,opts=>client.me.listDeletionRequests({page_size:100},opts))))}));
  app.post('/privacy/deletion-request',async c=>{
    c.set('errorReturn','/privacy');const request=await mutate(c,'deletion','privacy',{},opts=>client.me.createDeletionRequest(undefined,opts));flash(c,'deletion_requested');return finish(c,'/privacy',{request:project('deletion',request)});
  });
  app.notFound(c=>page(c,'not-found',{},404));
  return {app,sessions,engine};
}
