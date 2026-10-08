import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../../src/app.ts';
import {createHmac,randomBytes} from 'node:crypto';
import type {Config} from '../../src/config.ts';
import {readConfig} from '../../src/config.ts';
import type {Client} from '@flintpay/node';
import {IdentityStore,digest,verifyPassword} from '../../src/identity/index.ts';
import {Store} from '../../src/store/db.ts';

function runtime(webhookSecret?:string){
  const config:Config={apiKey:'local-test-fixture',apiBaseUrl:'https://api.staging.withflintpay.com',appOrigin:'http://localhost:4100',port:4100,identityDatabasePath:':memory:',appDatabasePath:':memory:',cookieName:'test_session',checkoutTtl:3600,storeName:'Example store',webhookSecret};
  return createApp({config,preflight:{sandboxId:'local-sandbox',cards:'enabled'},store:new Store(':memory:'),identity:new IdentityStore(':memory:')});
}
test('health reports configured build identity and process start while an ordinary copy omits it',async()=>{
  const env={FLINT_API_KEY:'flint_test_PLACEHOLDER',FLINT_API_BASE_URL:'https://api.staging.withflintpay.com',APP_ORIGIN:'http://localhost:4100',PORT:'4100'},sha='a'.repeat(40);
  for(const config of [readConfig(env),readConfig({...env,BUILD_SHA:sha,BUILD_ARTIFACT_ID:sha+':headless/storefront'})]){
    const app=createApp({config,client:{} as Client,preflight:{sandboxId:'sandbox_example',cards:'enabled'},store:new Store(':memory:'),identity:new IdentityStore(':memory:')});
    try{const response=await app.app.request('/healthz');assert.equal(response.status,200);const body=await response.json();assert.equal(body.mode,'test');assert.equal(body.sandbox_id,'sandbox_example');assert.deepEqual(body.build,config.build);assert.equal('apiKey'in body,false);}
    finally{app.store.close();app.identity.close();}
  }
});
test('mutating requests require exact origin and a session-bound CSRF token',async()=>{
  const app=runtime();try{
    const signIn=await app.app.request('http://localhost:4100/sign-in');const cookie=signIn.headers.get('set-cookie')!.split(';')[0]!;const html=await signIn.text();const csrf=html.match(/name="csrf-token" content="([^"]+)"/)![1]!;
    const request=(origin:string,token:string)=>app.app.request('http://localhost:4100/sign-out',{method:'POST',headers:{Cookie:cookie,Origin:origin,'X-CSRF-Token':token,'Content-Type':'application/json'},body:'{}'});
    assert.equal((await request('https://outside.example',csrf)).status,403);assert.equal((await request('http://localhost:4100','wrong')).status,403);const rotated=await request('http://localhost:4100',csrf);assert.equal(rotated.status,303);assert.notEqual(rotated.headers.get('set-cookie')!.split(';')[0],cookie);
    assert.equal((await request('http://localhost:4100',csrf)).status,401);
  }finally{app.store.close();app.identity.close();}
});
test('webhook route stays unavailable without a signing secret',async()=>{
  const app=runtime();try{assert.equal((await app.app.request('http://localhost:4100/webhooks/flint',{method:'POST',body:'{}'})).status,404);}finally{app.store.close();app.identity.close();}
});
test('signed test webhooks deduplicate and cannot turn an unverified browser order into paid',async()=>{
  const key=randomBytes(32);const app=runtime('whsec_'+key.toString('base64'));const eventId='local-event';const timestamp=String(Math.floor(Date.now()/1000));
  async function deliver(mode:string,valid=true){
    const body=JSON.stringify({webhook_event_id:eventId,event_type:'order.paid',payload_version:1,mode,merchant_id:'mer_'+''.padStart(26,'0'),created_at:new Date().toISOString(),request:null,data:{order:{order_id:'local-order'}}});
    const signature=createHmac('sha256',key).update(`${eventId}.${timestamp}.${body}`).digest('base64');
    return app.app.request('http://localhost:4100/webhooks/flint',{method:'POST',headers:{'webhook-id':eventId,'webhook-timestamp':timestamp,'webhook-signature':'v1,'+(valid?signature:'invalid'),'Content-Type':'application/json'},body});
  }
  try{
    assert.equal((await deliver('test',false)).status,400);assert.equal((await deliver('live')).status,400);assert.equal((await deliver('test')).status,200);assert.equal((await deliver('test')).status,200);
    assert.equal(app.store.all('SELECT * FROM webhook_events').length,1);assert.ok(app.store.get('SELECT * FROM order_signals WHERE order_id=?','local-order'));assert.equal(app.store.all('SELECT * FROM checkouts').length,0);
  }finally{app.store.close();app.identity.close();}
});
test('another identity session cannot read a locally owned checkout',async()=>{
  const app=runtime();try{
    const owner=app.identity.createSession();const other=app.identity.createSession();const now=Date.now();app.store.run('INSERT INTO checkouts(checkout_ref,session_hash,kind,created_at,updated_at) VALUES(?,?,?,?,?)','private-checkout',owner.session.session_hash,'order',now,now);
    const response=await app.app.request('http://localhost:4100/checkout/private-checkout/state',{headers:{Cookie:`test_session=${other.token}`,Accept:'application/json'}});assert.equal(response.status,404);
  }finally{app.store.close();app.identity.close();}
});
test('sign-up keeps password whitespace and stores only the hashed cookie',async()=>{
  const app=runtime();try{
    const created=app.identity.createSession();const password='  a long example password  ';
    const response=await app.app.request('http://localhost:4100/sign-up',{method:'POST',headers:{Cookie:`test_session=${created.token}`,Origin:'http://localhost:4100','X-CSRF-Token':created.session.csrf_token,'Content-Type':'application/json'},body:JSON.stringify({name:'Example buyer',email:'buyer@example.test',password,next:'/cart'})});assert.equal(response.status,303);
    const user=app.identity.userByEmail('buyer@example.test')!;assert.equal(await verifyPassword(password,user.password_hash),true);assert.equal(await verifyPassword(password.trim(),user.password_hash),false);
    const token=response.headers.get('set-cookie')!.match(/^test_session=([^;]+)/)![1]!;const session=app.identity.session(token)!;assert.equal(session.session_hash,digest(token));assert.equal(app.identity.session(created.token),undefined);assert.equal(app.identity.isBound(user,'local-sandbox'),false);
  }finally{app.store.close();app.identity.close();}
});

test('a rejected cross-site POST cannot replace an existing browser cookie',async()=>{
  const app=runtime();try{
    const response=await app.app.request('http://localhost:4100/sign-out',{method:'POST',headers:{Origin:'https://outside.example','Content-Type':'application/x-www-form-urlencoded'},body:'_csrf=invalid'});assert.equal(response.status,403);assert.equal(response.headers.get('set-cookie'),null);assert.equal(app.identity.db.prepare('SELECT count(*) AS count FROM sessions').get()?.count,0);
  }finally{app.store.close();app.identity.close();}
});
