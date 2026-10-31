import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SdkError} from '@flintpay/node';
import type {Client,CustomerSessionWithSecret,RequestOptions} from '@flintpay/node';
import {IdentityStore} from '../../src/identity/index.ts';
import {CustomerSessions} from '../../src/flint/customer-sessions.ts';
import {createAuth} from '../../src/flint/auth.ts';
import {readConfig} from '../../src/config.ts';
import {LocalError} from '../../src/flint/errors.ts';
const config=readConfig({FLINT_API_KEY:'flint_test_PLACEHOLDER',FLINT_API_BASE_URL:'https://api.staging.withflintpay.com',APP_ORIGIN:'http://localhost:4200',PORT:'4200'});
const credentialError=(reason:string)=>new SdkError('authentication','fixture','response',false,{status:401,headers:{},attempts:1,durationMs:1},'INVALID_CREDENTIAL',{type:'authentication_error',code:'INVALID_CREDENTIAL',message:'fixture',doc_url:'https://developers.withflintpay.com/docs/errors#invalid_credential',error_source:'integration',remediation:null,request_id:'req_01KWM6WAHG3N9Q8T2V5XRZ7C4D',details:[{code:'INVALID_CREDENTIAL',message:'fixture',reason}]});
const result=(secret:string):CustomerSessionWithSecret=>({created_at:new Date().toISOString(),status:'active',customer_id:'cus_example',customer_session_id:'session_example',secret,refresh_token:secret+' refresh',expires_at:new Date(Date.now()+3600000).toISOString(),refresh_token_expires_at:new Date(Date.now()+86400000).toISOString()});
test('concurrent expired requests use one refresh and atomically persist the rotated pair',async()=>{
  const identity=new IdentityStore(':memory:');try{
    const current=await identity.createUser('Example','buyer@example.invalid','example password');identity.bind(current.user_id,'sandbox_example','cus_example',current.email);const user=identity.user(current.user_id)!;
    identity.saveVault({user_id:user.user_id,sandbox_id:'sandbox_example',customer_session_id:'session_example',secret:'old example',refresh_token:'old refresh example',expires_at:0,refresh_expires_at:Date.now()+86400000});
    let calls=0;const client={customerSessions:{refresh:async(body:{refresh_token:string},options:RequestOptions)=>{calls++;assert.equal(body.refresh_token,'old refresh example');assert.ok(options.idempotencyKey);assert.equal(options.apiKey,undefined);await new Promise(resolve=>setTimeout(resolve,30));return result('new example');}}} as unknown as Client;
    const service=new CustomerSessions(identity,client,createAuth(config.apiKey),config,'sandbox_example');
    const values=await Promise.all(Array.from({length:8},()=>service.vault(user)));assert.equal(calls,1);assert.ok(values.every(v=>v.secret==='new example'&&v.refresh_token==='new example refresh'));
  }finally{identity.close();}
});
test('a lost refresh response replays the same old token and durable key',async()=>{
  const identity=new IdentityStore(':memory:');try{
    const created=await identity.createUser('Example','buyer@example.invalid','example password');identity.bind(created.user_id,'sandbox_example','cus_example',created.email);const user=identity.user(created.user_id)!;
    identity.saveVault({user_id:user.user_id,sandbox_id:'sandbox_example',customer_session_id:'session_example',secret:'old example',refresh_token:'old refresh example',expires_at:0,refresh_expires_at:Date.now()+86400000});
    const keys:string[]=[];let fail=true;
    const client={customerSessions:{refresh:async(_body:unknown,options:RequestOptions)=>{keys.push(options.idempotencyKey!);if(fail){fail=false;throw new Error('lost response');}return result('new example');}}} as unknown as Client;
    const service=new CustomerSessions(identity,client,createAuth(config.apiKey),config,'sandbox_example');await assert.rejects(service.vault(user));await service.vault(user);assert.equal(keys[0],keys[1]);
  }finally{identity.close();}
});
test('refresh reuse revokes the verified customer and destroys every local session',async()=>{
  const identity=new IdentityStore(':memory:');try{
    const created=await identity.createUser('Example','buyer@example.invalid','example password');identity.bind(created.user_id,'sandbox_example','cus_example',created.email);const user=identity.user(created.user_id)!;
    const first=identity.createSession(user.user_id),second=identity.createSession(user.user_id);let revoked:string|undefined;
    identity.saveVault({user_id:user.user_id,sandbox_id:'sandbox_example',customer_session_id:'session_example',secret:'old example',refresh_token:'old refresh example',expires_at:0,refresh_expires_at:Date.now()+86400000});
    const client={customerSessions:{refresh:async()=>{throw credentialError('revoked');}},customers:{revokeSessions:async(customerId:string)=>{revoked=customerId;}}} as unknown as Client;
    const service=new CustomerSessions(identity,client,createAuth(config.apiKey),config,'sandbox_example');await assert.rejects(service.vault(user),{code:'SESSION_ENDED'});assert.equal(revoked,'cus_example');assert.equal(identity.session(first.token),undefined);assert.equal(identity.session(second.token),undefined);assert.equal(identity.vault(user.user_id,'sandbox_example'),undefined);
  }finally{identity.close();}
});
test('sign-out followed by a new login mints a new family with a distinct durable key',async()=>{
  const identity=new IdentityStore(':memory:');try{
    const created=await identity.createUser('Example','buyer@example.invalid','example password');identity.bind(created.user_id,'sandbox_example','cus_example',created.email);const user=identity.user(created.user_id)!,keys:string[]=[];
    const client={customerSessions:{create:async(_body:unknown,options:RequestOptions)=>{keys.push(options.idempotencyKey!);return result('example '+keys.length);},revoke:async()=>({})}} as unknown as Client;
    const service=new CustomerSessions(identity,client,createAuth(config.apiKey),config,'sandbox_example');await service.vault(user);await service.revoke(user);await service.vault(user);assert.equal(keys.length,2);assert.notEqual(keys[0],keys[1]);
  }finally{identity.close();}
});
for(const failure of ['unknown','session_ended'])test(`an old INVALID_CREDENTIAL (${failure}) cannot invalidate a newer customer-session pair`,async()=>{
  const identity=new IdentityStore(':memory:');try{
    const created=await identity.createUser('Example','buyer@example.invalid','example password');identity.bind(created.user_id,'sandbox_example','cus_example',created.email);const user=identity.user(created.user_id)!;
    const service=new CustomerSessions(identity,{} as Client,createAuth(config.apiKey),config,'sandbox_example');service.save(user,result('old example'));const session=identity.createSession(user.user_id);let calls=0;
    const value=await service.call(user,async options=>{calls++;if(calls===1){service.save(user,result('new example'));throw credentialError(failure);}assert.equal(options.customerToken,'new example');return 'ok';});
    assert.equal(value,'ok');assert.equal(calls,2);assert.ok(identity.session(session.token));
  }finally{identity.close();}
});
test('a missing customer session ends every local session without minting replacement authority',async()=>{
  const identity=new IdentityStore(':memory:');try{
    const created=await identity.createUser('Example','buyer@example.invalid','example password');identity.bind(created.user_id,'sandbox_example','cus_example',created.email);const user=identity.user(created.user_id)!;
    const first=identity.createSession(user.user_id),second=identity.createSession(user.user_id);
    let minted=0;
    const client={customerSessions:{create:async()=>{minted++;return result('unexpected');}}} as unknown as Client;
    const service=new CustomerSessions(identity,client,createAuth(config.apiKey),config,'sandbox_example');service.save(user,result('old example'));
    await assert.rejects(service.call(user,async()=>{throw credentialError('unknown');}),{code:'SESSION_ENDED',status:401});
    assert.equal(minted,0);assert.equal(identity.session(first.token),undefined);assert.equal(identity.session(second.token),undefined);assert.equal(identity.vault(user.user_id,'sandbox_example'),undefined);
  }finally{identity.close();}
});
test('failed sign-out revocation remains queued and sweep replays the original key',async()=>{
  const identity=new IdentityStore(':memory:');try{
    const created=await identity.createUser('Example','buyer@example.invalid','example password');identity.bind(created.user_id,'sandbox_example','cus_example',created.email);const user=identity.user(created.user_id)!,keys:string[]=[];let fail=true;
    const client={customerSessions:{revoke:async(_id:string,_params:unknown,options:RequestOptions)=>{keys.push(options.idempotencyKey!);if(fail){fail=false;throw new Error('lost revocation response');}return {};}}} as unknown as Client;
    const service=new CustomerSessions(identity,client,createAuth(config.apiKey),config,'sandbox_example');service.save(user,result('example'));await assert.rejects(service.revoke(user));assert.equal(identity.vault(user.user_id,'sandbox_example'),undefined);await service.sweep();assert.equal(keys[0],keys[1]);assert.equal(identity.db.prepare('SELECT * FROM account_pending_revocations').all().length,0);
  }finally{identity.close();}
});
