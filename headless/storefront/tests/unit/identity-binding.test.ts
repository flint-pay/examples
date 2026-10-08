import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Client,CreateCustomerVerificationRequestInput,RequestOptions} from '@flintpay/node';
import {SdkError} from '@flintpay/node';
import {IdentityStore} from '../../src/identity/index.ts';
import {IdentityBinding} from '../../src/flint/identity-binding.ts';
import {createAuth} from '../../src/flint/auth.ts';

function verificationClient(){
  const calls:{key:string;body:CreateCustomerVerificationRequestInput}[]=[];
  const issued=new Map<string,{body:string;customer_verification_id:string}>();
  const state={loseResponse:false,reject:undefined as SdkError|undefined,customerId:'example-customer',lists:0};
  const client={
    customers:{list:async()=>{state.lists++;return {data:[{customer_id:state.customerId}]};}},
    customerVerifications:{create:async(body:CreateCustomerVerificationRequestInput,options:RequestOptions<'merchant'>)=>{
      const key=options.idempotencyKey!;calls.push({key,body:structuredClone(body)});
      assert.ok(key);assert.equal(options.apiKey,'local-fixture');assert.equal(options.authMode,undefined);
      if(state.reject)throw state.reject;
      let verification=issued.get(key);
      if(verification)assert.equal(verification.body,JSON.stringify(body),'an idempotency key must retain its original body');
      else{verification={body:JSON.stringify(body),customer_verification_id:`example-verification-${issued.size+1}`};issued.set(key,verification);}
      if(state.loseResponse)throw new SdkError('transport','local lost response','unknown',true);
      return {customer_verification_id:verification.customer_verification_id};
    }},
  } as unknown as Client;
  return {client,calls,issued,state};
}
async function buyer(identity:IdentityStore){return identity.createUser('Example buyer','buyer@example.test','a long example password');}
test('a fresh session after an expired proof sends a new verification under a new key',async t=>{
  let now=1_700_000_000_000;t.mock.method(Date,'now',()=>now);
  const identity=new IdentityStore(':memory:');const remote=verificationClient();
  try{
    const user=await buyer(identity);const binding=new IdentityBinding(remote.client,createAuth('local-fixture'),identity,'sandbox-A');const first=identity.createSession(user.user_id);
    await binding.send(user,first.session);const oldProof=identity.pending(first.session)!.customer_verification_id;
    identity.destroy(first.session);now+=16*60_000;const fresh=identity.createSession(user.user_id);
    await binding.send(user,fresh.session);
    assert.equal(remote.calls.length,2);assert.equal(remote.issued.size,2);assert.notEqual(remote.calls[0]!.key,remote.calls[1]!.key);assert.notEqual(identity.pending(fresh.session)!.customer_verification_id,oldProof);
    assert.equal(binding.verificationRequest(user)?.sequence,2);
  }finally{identity.close();}
});
test('successful requests get fresh keys after rotation and same-millisecond resends',async t=>{
  let now=1_700_000_000_000;t.mock.method(Date,'now',()=>now);
  const identity=new IdentityStore(':memory:');const remote=verificationClient();
  try{
    const user=await buyer(identity);const binding=new IdentityBinding(remote.client,createAuth('local-fixture'),identity,'sandbox-A');const original=identity.createSession(user.user_id);
    await binding.send(user,original.session);const fresh=identity.rotate(original.session,user.user_id);
    await binding.send(user,fresh.session);assert.equal(remote.issued.size,2);
    await binding.send(user,identity.session(fresh.token)!);assert.equal(remote.calls.length,2);
    now+=30_000;await binding.send(user,identity.session(fresh.token)!);assert.equal(remote.issued.size,3);
    const another=identity.rotate(identity.session(fresh.token)!,user.user_id);await binding.send(user,another.session);
    assert.equal(remote.issued.size,4);assert.equal(new Set(remote.calls.map(call=>call.key)).size,4);assert.equal(binding.verificationRequest(user)?.sequence,4);
  }finally{identity.close();}
});
test('a lost resend response retries the original key even while the older proof is in cooldown',async t=>{
  let now=1_700_000_000_000;t.mock.method(Date,'now',()=>now);
  const identity=new IdentityStore(':memory:');const remote=verificationClient();
  try{
    const user=await buyer(identity);const session=identity.createSession(user.user_id);const binding=new IdentityBinding(remote.client,createAuth('local-fixture'),identity,'sandbox-A');
    await binding.send(user,session.session);const oldProof=identity.pending(session.session)!.customer_verification_id;
    now+=30_000;remote.state.loseResponse=true;await assert.rejects(binding.send(user,identity.session(session.token)!));
    const pending=binding.verificationRequest(user)!;assert.ok(pending.idempotency_key);assert.ok(pending.body);assert.equal(identity.pending(identity.session(session.token)!)!.customer_verification_id,oldProof);
    now-=1000;remote.state.loseResponse=false;await binding.send(user,identity.session(session.token)!);
    assert.equal(remote.calls.length,3);assert.equal(remote.calls[1]!.key,remote.calls[2]!.key);assert.deepEqual(remote.calls[1]!.body,remote.calls[2]!.body);assert.equal(remote.issued.size,2);
    assert.notEqual(identity.pending(identity.session(session.token)!)!.customer_verification_id,oldProof);assert.equal(binding.verificationRequest(user)?.idempotency_key,null);
  }finally{identity.close();}
});
test('an uncertain verification retains its exact body and key after database reopen and session rotation',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'storefront-verification-recovery-'));const path=join(directory,'identity.sqlite');let identity=new IdentityStore(path);const remote=verificationClient();
  try{
    const user=await buyer(identity);const original=identity.createSession(user.user_id);let binding=new IdentityBinding(remote.client,createAuth('local-fixture'),identity,'sandbox-A');
    remote.state.loseResponse=true;await assert.rejects(binding.send(user,original.session));const pending=binding.verificationRequest(user)!;
    assert.equal(identity.pending(original.session),null);const rotated=identity.rotate(original.session,user.user_id);
    identity.close();identity=new IdentityStore(path);binding=new IdentityBinding(remote.client,createAuth('local-fixture'),identity,'sandbox-A');
    remote.state.customerId='different-customer';remote.state.loseResponse=false;const session=identity.session(rotated.token)!;
    await binding.send(user,session);
    assert.equal(remote.calls.length,2);assert.equal(remote.calls[0]!.key,remote.calls[1]!.key);assert.deepEqual(remote.calls[0]!.body,remote.calls[1]!.body);assert.equal(remote.issued.size,1);assert.equal(remote.state.lists,1);
    assert.equal(identity.pending(session)?.customer_id,'example-customer');assert.equal(identity.pending(session)?.customer_verification_id,'example-verification-1');assert.equal(binding.verificationRequest(user)?.sequence,pending.sequence);
    const fresh=identity.rotate(session,user.user_id);await binding.send(user,fresh.session);assert.equal(remote.issued.size,2);assert.notEqual(remote.calls[1]!.key,remote.calls[2]!.key);
  }finally{identity.close();rmSync(directory,{recursive:true,force:true});}
});
test('concurrent sends share a pending key and the durable cooldown prevents duplicate issuance',async()=>{
  const identity=new IdentityStore(':memory:');const remote=verificationClient();
  try{
    const user=await buyer(identity);const session=identity.createSession(user.user_id);const first=new IdentityBinding(remote.client,createAuth('local-fixture'),identity,'sandbox-A');const second=new IdentityBinding(remote.client,createAuth('local-fixture'),identity,'sandbox-A');
    await Promise.all([first.send(user,identity.session(session.token)!),second.send(user,identity.session(session.token)!)]);
    assert.equal(remote.issued.size,1);assert.equal(new Set(remote.calls.map(call=>call.key)).size,1);assert.equal(first.verificationRequest(user)?.sequence,1);
    await second.send(user,session.session);assert.equal(remote.issued.size,1);assert.equal(first.verificationRequest(user)?.idempotency_key,null);
  }finally{identity.close();}
});
test('verification request identity is scoped to the sandbox when apps share the identity database',async()=>{
  const identity=new IdentityStore(':memory:');const remote=verificationClient();
  try{
    const user=await buyer(identity);const first=identity.createSession(user.user_id);const second=identity.createSession(user.user_id);
    const sandboxA=new IdentityBinding(remote.client,createAuth('local-fixture'),identity,'sandbox-A');const sandboxB=new IdentityBinding(remote.client,createAuth('local-fixture'),identity,'sandbox-B');
    remote.state.loseResponse=true;await assert.rejects(sandboxA.send(user,first.session));remote.state.loseResponse=false;await sandboxB.send(user,second.session);await sandboxA.send(user,first.session);
    assert.equal(remote.issued.size,2);assert.notEqual(remote.calls[0]!.key,remote.calls[1]!.key);assert.equal(remote.calls[0]!.key,remote.calls[2]!.key);assert.equal(sandboxA.verificationRequest(user)?.sequence,1);assert.equal(sandboxB.verificationRequest(user)?.sequence,1);
  }finally{identity.close();}
});
test('definitive verification rejection releases its key so the next logical send can succeed',async()=>{
  const identity=new IdentityStore(':memory:');const remote=verificationClient();
  try{
    const user=await buyer(identity);const session=identity.createSession(user.user_id);const binding=new IdentityBinding(remote.client,createAuth('local-fixture'),identity,'sandbox-A');
    remote.state.reject=new SdkError('rate_limit','local rejection','response',false,{status:429,headers:{},attempts:1,durationMs:1},'CUSTOMER_VERIFICATION_RATE_LIMITED');
    await assert.rejects(binding.send(user,session.session));assert.equal(binding.verificationRequest(user)?.idempotency_key,null);
    remote.state.reject=undefined;await binding.send(user,session.session);assert.equal(remote.issued.size,1);assert.notEqual(remote.calls[0]!.key,remote.calls[1]!.key);assert.equal(binding.verificationRequest(user)?.sequence,2);
  }finally{identity.close();}
});
test('5xx and idempotency-in-progress verification responses retain the same logical request',async()=>{
  const identity=new IdentityStore(':memory:');const remote=verificationClient();
  try{
    const user=await buyer(identity);const session=identity.createSession(user.user_id);const binding=new IdentityBinding(remote.client,createAuth('local-fixture'),identity,'sandbox-A');
    for(const [status,code] of [[503,'CUSTOMER_VERIFICATION_UNAVAILABLE'],[409,'IDEMPOTENCY_KEY_IN_PROGRESS']] as const){
      remote.state.reject=new SdkError('server','local uncertain response','response',true,{status,headers:{},attempts:1,durationMs:1},code);await assert.rejects(binding.send(user,session.session));assert.ok(binding.verificationRequest(user)?.idempotency_key);
    }
    remote.state.reject=undefined;await binding.send(user,session.session);assert.equal(new Set(remote.calls.map(call=>call.key)).size,1);assert.equal(remote.issued.size,1);assert.equal(binding.verificationRequest(user)?.sequence,1);
  }finally{identity.close();}
});
test('a local proof persistence failure leaves the issued request recoverable under its original key',async t=>{
  const identity=new IdentityStore(':memory:');const remote=verificationClient();
  try{
    const user=await buyer(identity);const session=identity.createSession(user.user_id);const binding=new IdentityBinding(remote.client,createAuth('local-fixture'),identity,'sandbox-A');
    const persist=t.mock.method(identity,'setPending',()=>{throw new Error('local persistence failure');});
    await assert.rejects(binding.send(user,session.session),/local persistence failure/);assert.ok(binding.verificationRequest(user)?.idempotency_key);assert.equal(identity.pending(identity.session(session.token)!),null);
    persist.mock.restore();await binding.send(user,identity.session(session.token)!);
    assert.equal(remote.calls[0]!.key,remote.calls[1]!.key);assert.equal(remote.issued.size,1);assert.equal(identity.pending(identity.session(session.token)!)?.customer_verification_id,'example-verification-1');assert.equal(binding.verificationRequest(user)?.idempotency_key,null);
  }finally{identity.close();}
});
test('a customer bound elsewhere is rejected before reserving or sending a verification',async()=>{
  const identity=new IdentityStore(':memory:');const remote=verificationClient();
  try{
    const user=await buyer(identity);const other=await identity.createUser('Other buyer','other@example.test','a long example password');identity.bind(other.user_id,'sandbox-A','example-customer',other.email);
    const session=identity.createSession(user.user_id);const binding=new IdentityBinding(remote.client,createAuth('local-fixture'),identity,'sandbox-A');
    await assert.rejects(binding.send(user,session.session),error=>error instanceof Error&&'code'in error&&error.code==='CUSTOMER_ALREADY_BOUND');
    assert.equal(remote.calls.length,0);assert.equal(binding.verificationRequest(user),undefined);
  }finally{identity.close();}
});
