import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../../src/store/db.ts';
import {LocalError} from '../../src/flint/errors.ts';

test('logical actions survive restart and reject reuse with a different request',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'account-action-')),path=join(dir,'local.sqlite');let store=new Store(path),calls=0;
  try{
    const first=await store.mutate('user:example:resource','update',{name:'Example'},async key=>{calls++;return {key,name:'Example'};},'example-nonce');
    store.close();store=new Store(path);
    const replay=await store.mutate('user:example:resource','update',{name:'Example'},async()=>{calls++;return {key:'wrong',name:'Wrong'};},'example-nonce');
    assert.deepEqual(replay,first);assert.equal(calls,1);assert.equal(statSync(path).mode&0o777,0o600);
    await assert.rejects(store.mutate('user:example:resource','update',{name:'Changed'},async()=>({}), 'example-nonce'),{code:'ACTION_BODY_MISMATCH'});
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('independent SQLite connections serialize the same resource',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'account-lock-')),path=join(dir,'local.sqlite'),a=new Store(path),b=new Store(path);let active=0,max=0;
  try{await Promise.all([a,b].map(store=>store.locked('same-resource',async assertOwnership=>{active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,35));assertOwnership();active--;})));assert.equal(max,1);}finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
test('uncertain mutations reuse the persisted key; foreign resources have separate keys',async()=>{
  const store=new Store(':memory:');const keys:string[]=[];
  try{
    await assert.rejects(store.mutate('user-a:resource','update',{name:'Example'},async key=>{keys.push(key);throw new Error('local transport interrupted');}));
    const result=await store.mutate('user-a:resource','update',{name:'Example'},async key=>{keys.push(key);return {ok:true};});
    assert.equal(result.ok,true);assert.equal(keys[0],keys[1]);assert.notEqual(store.action('user-b:resource','update',{name:'Example'}).idempotency_key,keys[0]);
    await assert.rejects(store.mutate('user-a:resource','another',{name:'Example'},async()=>{throw new LocalError('REJECTED');}));
  }finally{store.close();}
});
test('concurrent retry replays coalesce across connections with the same nonce or the implicit action',async()=>{
  for(const nonce of [undefined,'retry-primary']){
    const dir=mkdtempSync(join(tmpdir(),'account-retry-')),path=join(dir,'local.sqlite'),a=new Store(path),b=new Store(path);let calls=0;
    try{
      const send=async(key:string)=>{calls++;await new Promise(resolve=>setTimeout(resolve,35));return {subscription_payment_retry_id:'retry_example',idempotency_key:key};};
      const results=await Promise.all([a,b].map(store=>store.mutate('user:subscription:example','retry',{},send,nonce)));
      assert.deepEqual(results[0],results[1]);assert.equal(calls,1);
      assert.equal(a.all("SELECT * FROM actions WHERE kind='retry' AND status='succeeded'").length,1);
    }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
  }
});
test('distinct retry nonces preserve independent keys and journal the competing rejection',async()=>{
  const store=new Store(':memory:'),keys:string[]=[];
  try{
    const send=async(key:string)=>{keys.push(key);if(keys.length===1){await new Promise(resolve=>setTimeout(resolve,35));return {subscription_payment_retry_id:'retry_example'};}throw new LocalError('SUBSCRIPTION_PAYMENT_RETRY_IN_PROGRESS',409);};
    const results=await Promise.allSettled(['retry-primary','retry-competing'].map(nonce=>store.mutate('user:subscription:example','retry',{},send,nonce)));
    assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');
    if(results[1].status==='rejected')assert.equal(results[1].reason.code,'SUBSCRIPTION_PAYMENT_RETRY_IN_PROGRESS');
    assert.equal(keys.length,2);assert.notEqual(keys[0],keys[1]);
    assert.deepEqual(store.all<{status:string}>("SELECT status FROM actions WHERE kind='retry' ORDER BY status").map(row=>row.status),['rejected','succeeded']);
  }finally{store.close();}
});
