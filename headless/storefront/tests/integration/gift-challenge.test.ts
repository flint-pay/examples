import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SdkError} from '@flintpay/node';
import type {Client,Order,RequestOptions} from '@flintpay/node';
import {Store} from '../../src/store/db.ts';
import {createAuth} from '../../src/flint/auth.ts';
import {readConfig} from '../../src/config.ts';
import {createApp} from '../../src/app.ts';
import {IdentityStore} from '../../src/identity/index.ts';
import {LocalError} from '../../src/flint/errors.ts';
import {newChallengeId} from '../../src/flint/gift-challenge.ts';
import {Checkouts} from '../../src/flint/checkouts.ts';
import {PaymentEngine} from '../../src/payments/engine.ts';
import type {Carts} from '../../src/store/cart.ts';
const origin='https://checkout.staging.withflintpay.com',url=`${origin}/gift-card-challenge/gccf_fixture.token`,code='GIFTCODE-fixture-private',proof='gccp_fixtureProofOnlyOnce1234567890';
function refusal(code='GIFT_CARD_CHALLENGE_REQUIRED',reason='proof_required',status=400,challengeUrl=url){return new SdkError(status>=500?'server':'validation','fixture refusal','response',status>=500,{status,headers:{},attempts:1,durationMs:1},code,{reason,remediation:{next_actions:[{action_type:'complete_gift_card_challenge',url:challengeUrl}]}});}
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'gift-challenge-backend-')),store=new Store(join(dir,'app.sqlite')),config=readConfig({FLINT_API_KEY:'flint_test_FIXTURE',FLINT_API_BASE_URL:'https://api.staging.withflintpay.com',APP_ORIGIN:'http://localhost:4100',PORT:'4100'});
 const order={order_id:'ord_fixture',status:'open',payment_status:'unpaid',order_revision:'5',gift_card_tender_enabled:true,settlement_amounts:{outstanding_money:{amount:'1000',currency:'USD'},paid_money:{amount:'0',currency:'USD'}},payment_collection:{stripe:{elements:{}}},gift_cards:[]} as unknown as Order;
 const session={checkout_session_id:'cs_fixture',status:'open',recovery_mode:false,page_origin:config.appOrigin,gift_card_challenge:{url}};
 const calls:{body:Record<string,unknown>;options:RequestOptions}[]=[],reads:RequestOptions[]=[];
 let send:()=>Promise<Order>=async()=>{throw refusal();};
 const client={orders:{get:async(_id:string,_params:unknown,options:RequestOptions)=>{reads.push(options);return order;},applyGiftCard:async(_id:string,body:Record<string,unknown>,options:RequestOptions)=>{calls.push({body:{...body},options});return send();},removeGiftCard:async()=>order},checkoutSessions:{get:async(_id:string,_params:unknown,options:RequestOptions)=>{reads.push(options);return session;},create:async(body:Record<string,unknown>)=>({checkout_session:{...session,order_id:order.order_id,page_origin:body.page_origin},checkout_access:{checkout_auth_token:'fixture checkout authority'}})}} as unknown as Client;
 store.run('INSERT INTO checkouts(checkout_ref,session_hash,kind,order_id,checkout_session_id,checkout_auth_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)','chk_fixture','owner_fixture','order',order.order_id,session.checkout_session_id,'fixture checkout authority',Date.now(),Date.now());
 const payments=new PaymentEngine(client,createAuth(config.apiKey),store),app=new Checkouts(client,createAuth(config.apiKey),store,{} as IdentityStore,config,'sandbox_fixture',{} as Carts,payments),record=app.record('chk_fixture');
 const apply=(_nonce='unused')=>app.applyGift(record.checkout_ref,code),retry=(id:string,giftCode=code)=>app.retryGift(record.checkout_ref,id,giftCode,proof),remove=(id:string)=>app.mutate(record.checkout_ref,'gift_remove',{gift_card_id:id},(checkout,key,context)=>client.orders.removeGiftCard(checkout.order_id!,id,{order_revision:context.order_revision!},createAuth(config.apiKey).checkout(checkout,key)));
 return {dir,store,order,session,calls,reads,app,record,client,config,send(fn:()=>Promise<Order>){send=fn;},apply,retry,remove,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
async function use(fn:(f:ReturnType<typeof fixture>)=>Promise<void>){const f=fixture();try{await fn(f);}finally{f.close();}}
const row=(f:ReturnType<typeof fixture>)=>f.store.get<{status:string;body:string;idempotency_key:string;action_id:string;result?:string}>('SELECT * FROM actions WHERE kind=\'gift\' ORDER BY created_at DESC LIMIT 1')!;
const challenged=async(f:ReturnType<typeof fixture>)=>{const view=await f.apply();assert.ok(view);return view;};
async function retryRefused(f:ReturnType<typeof fixture>,id:string,expected:string,remoteReads:boolean,giftCode=code){
 const reads=f.reads.length,calls=f.calls.length;await assert.rejects(()=>f.retry(id,giftCode),{code:expected});assert.equal(f.calls.length,calls);assert.equal(f.store.get<{status:string}>('SELECT status FROM gift_challenges WHERE challenge_id=?',id)?.status,'closed');if(remoteReads)assert.ok(f.reads.length>reads);else assert.equal(f.reads.length,reads);
}
function openAttempt(f:ReturnType<typeof fixture>){f.order.active_payment_attempt={order_payment_attempt_id:'attempt_fixture',status:'processing',mode:'payment'} as Order['active_payment_attempt'];}
function localPayment(f:ReturnType<typeof fixture>,status='pending'){f.store.run('INSERT INTO actions(action_id,resource,kind,idempotency_key,body,body_hash,status,created_at) VALUES(?,?,?,?,?,?,?,?)','pay_fixture',`order:${f.order.order_id}`,'pay','pay_fixture','{}','fixture',status,Date.now());}
test('I2 challenge issuance exposes only its view and keeps a safe bound journal',async()=>use(async f=>{
 const view=await challenged(f);assert.deepEqual(Object.keys(view).sort(),['challenge_id','expires_in_seconds','reason','session_tag','url']);assert.equal(view.url,url);assert.equal(row(f).status,'challenge');assert.equal(f.store.all("SELECT * FROM gift_challenges WHERE status='open'").length,1);assert.ok(f.reads.some(read=>read.authMode==='checkout'));assert.equal(row(f).body.includes(code),false);
 for(const name of readdirSync(f.dir))assert.equal(readFileSync(join(f.dir,name)).includes(Buffer.from(url)),false);
}));
test('I3 I4 I16 retry spends the proof once with the original checkout key and revision',async()=>use(async f=>{
 const view=await challenged(f),key=row(f).idempotency_key;f.send(async()=>f.order);
 await Promise.allSettled([f.retry(view.challenge_id),f.retry(view.challenge_id)]).then(results=>{assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const failed=results.find(r=>r.status==='rejected');assert.equal(failed?.status==='rejected'&&(failed.reason as any).code,'GIFT_CHALLENGE_EXPIRED');});
 assert.equal(f.calls.length,2);assert.equal(f.calls[1]!.options.idempotencyKey,key);assert.equal(f.calls[1]!.body.order_revision,'5');assert.equal(f.calls[1]!.body['Flint-Gift-Card-Challenge'],proof);assert.ok(f.calls.every(call=>call.options.authMode==='checkout'&&call.options.apiKey===undefined&&call.options.maxAttempts===1));assert.equal(row(f).status,'succeeded');
 for(const name of readdirSync(f.dir)){const bytes=readFileSync(join(f.dir,name));for(const secret of [code,proof,url])assert.equal(bytes.includes(Buffer.from(secret)),false);}

}));
test('I5 code binding refuses a changed code without any checkout read or gift call',async()=>use(async f=>{const view=await challenged(f);await retryRefused(f,view.challenge_id,'GIFT_CHALLENGE_CODE_CHANGED',false,'DIFFERENT-CODE');}));
test('I5 wrong code precedes a remote open payment attempt',async()=>use(async f=>{const view=await challenged(f);openAttempt(f);await retryRefused(f,view.challenge_id,'GIFT_CHALLENGE_CODE_CHANGED',false,'DIFFERENT-CODE');}));
for(const status of ['pending','unknown'])test(`I5 local ${status} payment precedes wrong code`,async()=>use(async f=>{const view=await challenged(f);localPayment(f,status);await retryRefused(f,view.challenge_id,'CHECKOUT_PAYMENT_RESOLVING',false,'DIFFERENT-CODE');}));
test('I17 correct code with a remote open payment attempt closes without applying',async()=>use(async f=>{const view=await challenged(f);openAttempt(f);await retryRefused(f,view.challenge_id,'PAYMENT_ATTEMPT_IN_PROGRESS',true);}));
for(const status of ['pending','unknown'])test(`I17 local ${status} payment fences correct code without reading Flint`,async()=>use(async f=>{const view=await challenged(f);localPayment(f,status);await retryRefused(f,view.challenge_id,'CHECKOUT_PAYMENT_RESOLVING',false);}));
for(const status of ['open','closed','retrying'] as const)test(`I6 changed session precedes ${status} and expiry with no Flint read`,async()=>use(async f=>{
 const view=await challenged(f);f.store.run('UPDATE gift_challenges SET status=?,expires_at=? WHERE challenge_id=?',status,Date.now()-1,view.challenge_id);f.store.run('UPDATE checkouts SET checkout_session_id=? WHERE checkout_ref=?','cs_replaced',f.record.checkout_ref);const reads=f.reads.length;
 await assert.rejects(()=>f.retry(view.challenge_id),{code:'GIFT_CHALLENGE_SESSION_CHANGED'});assert.equal(f.reads.length,reads);assert.equal(f.calls.length,1);assert.equal(row(f).status,'challenge');assert.equal(f.store.get<{status:string}>('SELECT status FROM gift_challenges WHERE challenge_id=?',view.challenge_id)?.status,'closed');
}));
for(const status of ['closed','retrying','expired'] as const)test(`I6 same-session ${status} stays expired`,async()=>use(async f=>{const view=await challenged(f);if(status==='expired')f.store.run('UPDATE gift_challenges SET expires_at=? WHERE challenge_id=?',Date.now()-1,view.challenge_id);else f.store.run('UPDATE gift_challenges SET status=? WHERE challenge_id=?',status,view.challenge_id);const reads=f.reads.length;await assert.rejects(()=>f.retry(view.challenge_id),{code:'GIFT_CHALLENGE_EXPIRED'});assert.equal(f.reads.length,reads);assert.equal(f.calls.length,1);}));
test('I7 revision fence discards an unspent proof',async()=>use(async f=>{const view=await challenged(f);f.order.order_revision='6';await assert.rejects(()=>f.retry(view.challenge_id),{code:'GIFT_CHALLENGE_ORDER_CHANGED'});assert.equal(f.calls.length,1);assert.equal(row(f).status,'rejected');}));
test('I7 remote open payment attempt precedes the changed order revision',async()=>use(async f=>{const view=await challenged(f);f.order.order_revision='6';openAttempt(f);await retryRefused(f,view.challenge_id,'PAYMENT_ATTEMPT_IN_PROGRESS',true);}));
test('GB4 failed fresh order read closes the challenge and preserves the original action',async()=>use(async f=>{
 const view=await challenged(f),before=row(f);Object.assign(f.client.orders,{get:async(_id:string,_params:unknown,options:RequestOptions)=>{f.reads.push(options);throw refusal('UNKNOWN_FAILURE','',503);}});
 await retryRefused(f,view.challenge_id,'UNKNOWN_FAILURE',true);assert.deepEqual(row(f),before);
}));
test('I8 proof rejection issues a fresh single-use context',async()=>use(async f=>{const first=await challenged(f);f.send(async()=>{throw refusal('GIFT_CARD_CHALLENGE_REQUIRED','proof_rejected');});const second=await f.retry(first.challenge_id);assert.ok(second);assert.notEqual(second.challenge_id,first.challenge_id);assert.equal(second.reason,'proof_rejected');assert.equal(row(f).status,'challenge');assert.equal(f.store.get<{status:string}>('SELECT status FROM gift_challenges WHERE challenge_id=?',first.challenge_id)?.status,'closed');}));
test('I9 definite refusal closes the context and rejects the action',async()=>use(async f=>{const view=await challenged(f);f.send(async()=>{throw refusal('GIFT_CARD_UNAVAILABLE');});await assert.rejects(()=>f.retry(view.challenge_id),{code:'GIFT_CARD_UNAVAILABLE'});assert.equal(row(f).status,'rejected');assert.equal(f.calls.length,2);}));
test('I10 unknown retry preserves the key and body, and the next Apply omits proof',async()=>use(async f=>{const view=await challenged(f),key=row(f).idempotency_key;f.send(async()=>{throw refusal('UNKNOWN_FAILURE','',503);});await assert.rejects(()=>f.retry(view.challenge_id));assert.equal(row(f).status,'unknown');f.send(async()=>f.order);await f.apply();assert.equal(f.calls[2]!.options.idempotencyKey,key);assert.equal(f.calls[2]!.body.order_revision,'5');assert.equal('Flint-Gift-Card-Challenge'in f.calls[2]!.body,false);}));
test('I11 origin-required limits replacements to one per ten minutes',async()=>use(async f=>{f.send(async()=>{throw refusal('GIFT_CARD_CHALLENGE_REQUIRED','page_origin_required');});await assert.rejects(()=>f.apply(),{code:'GIFT_CARD_CHALLENGE_ORIGIN_REQUIRED'});await assert.rejects(()=>f.apply('next-action'),{code:'GIFT_CARD_CHALLENGE_UNAVAILABLE'});}));
test('I12 untrusted URL and fresh-session mismatch produce no view',async()=>use(async f=>{f.send(async()=>{throw refusal('GIFT_CARD_CHALLENGE_REQUIRED','proof_required',400,'https://evil.example/x');});await assert.rejects(()=>f.apply(),{code:'GIFT_CARD_CHALLENGE_UNAVAILABLE'});assert.equal(row(f).status,'rejected');f.send(async()=>{throw refusal();});f.session.gift_card_challenge.url=url+'changed';await assert.rejects(()=>f.apply('next-action'),{code:'GIFT_CARD_CHALLENGE_UNAVAILABLE'});assert.equal(row(f).status,'rejected');}));
test('I13 new apply abandons the earlier challenge before its Flint call',async()=>use(async f=>{const view=await challenged(f),first=row(f).action_id;f.send(async()=>{assert.equal(f.store.get<{status:string}>('SELECT status FROM actions WHERE action_id=?',first)?.status,'rejected');assert.equal(f.store.get<{status:string}>('SELECT status FROM gift_challenges WHERE challenge_id=?',view.challenge_id)?.status,'closed');return f.order;});await f.apply('new-action');}));
test('I14 unknown and foreign challenge ids are indistinguishable on an owned checkout',async()=>use(async f=>{await challenged(f);await assert.rejects(()=>f.retry(newChallengeId()),{code:'GIFT_CHALLENGE_EXPIRED'});assert.equal(f.calls.length,1);}));
test('I13 remove abandons the earlier challenge before its checkout-authenticated Flint call',async()=>use(async f=>{
 const view=await challenged(f),action=row(f).action_id;let removed=false;Object.assign(f.client.orders,{removeGiftCard:async(_order:string,_gift:string,_body:unknown,options:RequestOptions)=>{removed=true;assert.equal(options.authMode,'checkout');assert.equal(f.store.get<{status:string}>('SELECT status FROM actions WHERE action_id=?',action)?.status,'rejected');assert.equal(f.store.get<{status:string}>('SELECT status FROM gift_challenges WHERE challenge_id=?',view.challenge_id)?.status,'closed');return f.order;}});
 await f.remove('gift_fixture');assert.equal(removed,true);assert.equal(f.calls.length,1);
}));
test('I6 session change wins over an unresolved payment without reading Flint',async()=>use(async f=>{
 const view=await challenged(f);f.store.run('UPDATE checkouts SET checkout_session_id=? WHERE checkout_ref=?','cs_replaced',f.record.checkout_ref);f.store.run('INSERT INTO actions(action_id,resource,kind,idempotency_key,body,body_hash,created_at) VALUES(?,?,?,?,?,?,?)','pay_fixture',`order:${f.order.order_id}`,'pay','pay_fixture','{}','fixture',Date.now());const reads=f.reads.length;
 await assert.rejects(()=>f.retry(view.challenge_id),{code:'GIFT_CHALLENGE_SESSION_CHANGED'});assert.equal(f.reads.length,reads);assert.equal(f.calls.length,1);assert.equal(row(f).status,'challenge');
}));
for(const owner of ['same','foreign'])test(`I14 ${owner} buyer's other checkout challenge stays untouched`,async()=>use(async f=>{
 await challenged(f);f.store.run('INSERT INTO checkouts(checkout_ref,session_hash,kind,order_id,checkout_session_id,checkout_auth_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)','chk_other',owner==='same'?'owner_fixture':'other_owner','order','ord_other','cs_other','other fixture authority',Date.now(),Date.now());const id=newChallengeId();f.store.issueGiftChallenge('chk_other','other_action','cs_other',id);const before=f.store.get('SELECT * FROM gift_challenges WHERE challenge_id=?',id),local=row(f),reads=f.reads.length;
 await assert.rejects(()=>f.retry(id),{code:'GIFT_CHALLENGE_EXPIRED'});assert.deepEqual(f.store.get('SELECT * FROM gift_challenges WHERE challenge_id=?',id),before);assert.deepEqual(row(f),local);assert.equal(f.reads.length,reads);assert.equal(f.calls.length,1);
}));

async function routeUse(fn:(h:ReturnType<typeof fixture>&{post:(path:string,body:unknown,options?:{headers?:Record<string,string>;form?:boolean})=>Promise<Response>;root:string})=>Promise<void>){
 const f=fixture(),identity=new IdentityStore(':memory:');try{
 const session=identity.createSession();f.store.run('UPDATE checkouts SET session_hash=? WHERE checkout_ref=?',session.session.session_hash,f.record.checkout_ref);Object.assign(f.client.checkoutSessions,{getCurrentDeliverySelection:async()=>({})});
 const {app}=createApp({config:f.config,client:f.client,identity,store:f.store,preflight:{sandboxId:'sandbox_fixture',cards:'enabled'}}),root=`/checkout/${f.record.checkout_ref}`;
 const headers={Cookie:`${f.config.cookieName}=${session.token}`,Origin:f.config.appOrigin,'X-CSRF-Token':session.session.csrf_token,'Content-Type':'application/json','X-Action-ID':'apply-fixture',Accept:'application/json'};
 const post=async(path:string,body:unknown,options:{headers?:Record<string,string>;form?:boolean}={})=>app.request(f.config.appOrigin+path,{method:'POST',headers:{...headers,...options.headers},body:options.form?'challenge_id=x':JSON.stringify(body)});
 await fn({...f,post,root});
 }finally{identity.close();f.close();}
}
test('I5 HTTP wrong code returns 409 without reads or error-handler state',async()=>routeUse(async h=>{
 const applied=await h.post(h.root+'/gift-card',{gift_card_code:code}),view=(await applied.json()).gift_challenge;assert.ok(view);openAttempt(h);const reads=h.reads.length,calls=h.calls.length;
 const response=await h.post(h.root+'/gift-card/challenge',{challenge_id:view.challenge_id,gift_card_code:'DIFFERENT-CODE',proof}),body=await response.json();assert.equal(response.status,409);assert.equal(body.error.code,'GIFT_CHALLENGE_CODE_CHANGED');assert.equal('state'in body,false);assert.equal(h.reads.length,reads);assert.equal(h.calls.length,calls);assert.equal(h.store.get<{status:string}>('SELECT status FROM gift_challenges WHERE challenge_id=?',view.challenge_id)?.status,'closed');
}));
test('I14 HTTP challenge rejects non-JSON, invalid proof, CSRF and foreign Origin before applying',async()=>routeUse(async h=>{
 const id=newChallengeId();
 for(const [body,options,status] of [[{challenge_id:id,gift_card_code:code,proof:' '},{},400],[{challenge_id:'invalid',gift_card_code:code,proof},{},400],[{challenge_id:id,gift_card_code:code,proof},{form:true,headers:{'Content-Type':'application/x-www-form-urlencoded'}},400],[{challenge_id:id,gift_card_code:code,proof},{headers:{'X-CSRF-Token':''}},403],[{challenge_id:id,gift_card_code:code,proof},{headers:{Origin:'https://evil.example'}},403]] as const){const response=await h.post(h.root+'/gift-card/challenge',body,options);assert.equal(response.status,status);}
 assert.equal(h.calls.length,0);
}));
test('I14 HTTP ownership rejects an unowned checkout before reading challenge rows',async()=>routeUse(async h=>{const response=await h.post('/checkout/chk_foreign/gift-card/challenge',{challenge_id:newChallengeId(),gift_card_code:code,proof});assert.equal(response.status,404);assert.equal(h.calls.length,0);}));
test('I14 HTTP ownership refuses a victim challenge without changing it or taking limiter tokens',async()=>routeUse(async h=>{
 const applied=await h.post(h.root+'/gift-card',{gift_card_code:code}),view=(await applied.json()).gift_challenge,owner=h.app.record(h.record.checkout_ref).session_hash;assert.ok(view);h.store.run('UPDATE checkouts SET session_hash=? WHERE checkout_ref=?','victim_owner',h.record.checkout_ref);const before=h.store.get('SELECT * FROM gift_challenges WHERE challenge_id=?',view.challenge_id),reads=h.reads.length;
 for(let count=0;count<11;count++)assert.equal((await h.post(h.root+'/gift-card/challenge',{challenge_id:view.challenge_id,gift_card_code:code,proof})).status,404);
 assert.deepEqual(h.store.get('SELECT * FROM gift_challenges WHERE challenge_id=?',view.challenge_id),before);assert.equal(h.reads.length,reads);assert.equal(h.calls.length,1);h.store.run('UPDATE checkouts SET session_hash=? WHERE checkout_ref=?',owner,h.record.checkout_ref);
 for(let count=0;count<10;count++)assert.equal((await h.post(h.root+'/gift-card/challenge',{challenge_id:newChallengeId(),gift_card_code:code,proof})).status,409);
}));
test('I15 retry limiter allows ten admissions without spending the apply bucket',async()=>routeUse(async h=>{
 for(let count=0;count<10;count++){const response=await h.post(h.root+'/gift-card/challenge',{challenge_id:newChallengeId(),gift_card_code:code,proof});assert.equal(response.status,409);assert.equal((await response.json()).error.code,'GIFT_CHALLENGE_EXPIRED');}
 assert.equal((await h.post(h.root+'/gift-card/challenge',{challenge_id:newChallengeId(),gift_card_code:code,proof})).status,429);
 const apply=await h.post(h.root+'/gift-card',{gift_card_code:code});assert.equal(apply.status,200);assert.ok((await apply.json()).gift_challenge);
}));
test('I10 unknown retry HTTP response uses the unconfirmed message and never echoes authority',async()=>routeUse(async h=>{
 const applied=await h.post(h.root+'/gift-card',{gift_card_code:code});const view=(await applied.json()).gift_challenge;assert.ok(view);h.send(async()=>{throw refusal('UNKNOWN_FAILURE','',503);});
 const response=await h.post(h.root+'/gift-card/challenge',{challenge_id:view.challenge_id,gift_card_code:code,proof}),body=await response.json();assert.equal(response.status,503);assert.equal(body.error.message_key,'gift_challenge_unconfirmed');for(const value of [proof,code,url,'checkout_session_id','page_origin'])assert.equal(JSON.stringify(body).includes(value),false);
}));

test('I16 request and challenge logs exclude codes, proof, frame URLs and session authority',async()=>routeUse(async h=>{
 const output:string[]=[],info=console.info,warn=console.warn;console.info=(...values:unknown[])=>{output.push(values.map(String).join(' '));};console.warn=console.info;
 try{const applied=await h.post(h.root+'/gift-card',{gift_card_code:code}),view=(await applied.json()).gift_challenge;assert.ok(view);h.send(async()=>{throw new SdkError('server',[code,proof,url].join(' '),'response',true,{status:503,headers:{},attempts:1,durationMs:1},'UNKNOWN_FAILURE',{private_code:code,private_proof:proof,private_url:url});});assert.equal((await h.post(h.root+'/gift-card/challenge',{challenge_id:view.challenge_id,gift_card_code:code,proof})).status,503);
  const text=output.join('\n');assert.ok(text.includes('"outcome":"issued"'));assert.ok(text.includes('"outcome":"retry_unknown"'));for(const secret of [code,proof,url,'fixture checkout authority','cs_fixture','page_origin'])assert.equal(text.includes(secret),false);
 }finally{console.info=info;console.warn=warn;}
}));
test('I1 fresh order, subscription and replacement launch inputs carry the configured page origin',async()=>use(async f=>{
 const sent:Record<string,unknown>[]=[];Object.assign(f.client.checkoutSessions,{create:async(body:Record<string,unknown>)=>{sent.push(body);return {checkout_session:{...f.session,order_id:f.order.order_id,page_origin:body.page_origin},checkout_access:{checkout_auth_token:'fixture authority'}};}});
 await f.app.launch(f.app.record(f.record.checkout_ref));assert.equal(sent[0]!.page_origin,f.config.appOrigin);assert.equal(sent[0]!.replace_checkout_session_id,'cs_fixture');
 f.store.run('UPDATE checkouts SET generation=generation+1 WHERE checkout_ref=?',f.record.checkout_ref);await f.app.launch(f.app.record(f.record.checkout_ref));assert.equal(sent[1]!.page_origin,f.config.appOrigin);
 f.store.run("UPDATE checkouts SET kind='subscription',order_id=NULL,checkout_session_id=NULL,subscription_plan_id=?,generation=generation+1 WHERE checkout_ref=?",'plan_fixture',f.record.checkout_ref);await f.app.launch(f.app.record(f.record.checkout_ref));assert.equal(sent[2]!.subscription_plan_id,'plan_fixture');assert.equal(sent[2]!.page_origin,f.config.appOrigin);
}));
test('I1 echo mismatch preserves the checkout record and the same creation key',async()=>use(async f=>{
 const before=f.app.record(f.record.checkout_ref);Object.assign(f.client.checkoutSessions,{create:async()=>({checkout_session:{...f.session,order_id:f.order.order_id,page_origin:'https://wrong.example'},checkout_access:{checkout_auth_token:'different authority'}})});
 await assert.rejects(()=>f.app.launch(before),{code:'CHECKOUT_LAUNCH_INVALID'});assert.deepEqual(f.app.record(f.record.checkout_ref),before);assert.equal(f.store.all("SELECT * FROM actions WHERE kind='session_create'").length,1);
 await assert.rejects(()=>f.app.launch(before),{code:'CHECKOUT_LAUNCH_INVALID'});assert.equal(f.store.all("SELECT * FROM actions WHERE kind='session_create'").length,1);
}));
test('I1 pre-upgrade pending session bodies replay byte for byte without inserting page_origin',async()=>use(async f=>{
 const body={surface:'embedded',order_id:f.order.order_id,redirects:{success_redirect_url:'http://localhost:4100/return'}},json=JSON.stringify(body),key=`session-${f.record.checkout_ref}-1`;
 f.store.run('INSERT INTO actions(action_id,resource,kind,idempotency_key,body,body_hash,created_at) VALUES(?,?,?,?,?,?,?)',key,`order:${f.order.order_id}`,'session_create',key,json,createHash('sha256').update(json).digest('hex'),Date.now());
 let sent:unknown;Object.assign(f.client.checkoutSessions,{create:async(input:unknown)=>{sent=input;return {checkout_session:{...f.session,order_id:f.order.order_id,page_origin:undefined},checkout_access:{checkout_auth_token:'fixture authority'}};}});
 await f.app.launch(f.app.record(f.record.checkout_ref));assert.equal(JSON.stringify(sent),json);assert.equal('page_origin'in(sent as object),false);
}));
test('I11 origin-required HTTP error state replaces the session with the configured page origin once',async()=>routeUse(async h=>{
 const inputs:Record<string,unknown>[]=[];Object.assign(h.client.checkoutSessions,{create:async(input:Record<string,unknown>)=>{inputs.push(input);h.session.checkout_session_id='cs_replacement';return {checkout_session:{...h.session,order_id:h.order.order_id,page_origin:input.page_origin},checkout_access:{checkout_auth_token:'replacement fixture authority'}};}});h.send(async()=>{throw refusal('GIFT_CARD_CHALLENGE_REQUIRED','page_origin_required');});
 const first=await h.post(h.root+'/gift-card',{gift_card_code:code}),body=await first.json();assert.equal(first.status,409);assert.equal(body.error.code,'GIFT_CARD_CHALLENGE_ORIGIN_REQUIRED');assert.ok(body.state);assert.equal(body.gift_challenge,undefined);assert.equal(inputs.length,1);assert.equal(inputs[0]!.page_origin,h.config.appOrigin);assert.equal(inputs[0]!.replace_checkout_session_id,'cs_fixture');assert.equal(h.app.record(h.record.checkout_ref).checkout_session_id,'cs_replacement');
 const second=await h.post(h.root+'/gift-card',{gift_card_code:code});assert.equal(second.status,503);assert.equal((await second.json()).error.code,'GIFT_CARD_CHALLENGE_UNAVAILABLE');assert.equal(inputs.length,1);
}));
