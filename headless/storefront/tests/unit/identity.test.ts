import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IdentityStore,digest,equalSecret,hashPassword,normalizeEmail,verifyPassword} from '../../src/identity/index.ts';

test('scrypt hashes use independent salts and preserve password whitespace',async()=>{
  const password='  a long example password  ';
  const first=await hashPassword(password);const second=await hashPassword(password);
  assert.match(first,/^scrypt\$32768\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);assert.notEqual(first,second);
  assert.equal(await verifyPassword(password,first),true);assert.equal(await verifyPassword(password.trim(),first),false);
  assert.equal(await verifyPassword('wrong password',first),false);assert.equal(await verifyPassword(password,undefined),false);assert.equal(await verifyPassword(password,'scrypt$invalid'),false);
});
test('secret equality rejects differing lengths and values',()=>{
  assert.equal(equalSecret('same','same'),true);assert.equal(equalSecret('same','samer'),false);assert.equal(equalSecret('same','diff'),false);
});
test('identity rotation invalidates the old opaque token and CSRF token',()=>{
  const store=new IdentityStore(':memory:');try{
    const old=store.createSession();const rotated=store.rotate(old.session,'local-user');
    assert.equal(store.session(old.token),undefined);assert.equal(store.session(rotated.token)?.user_id,'local-user');assert.notEqual(rotated.session.csrf_token,old.session.csrf_token);
    assert.equal(rotated.session.session_hash,digest(rotated.token));assert.notEqual(rotated.session.session_hash,rotated.token);
    store.destroy(rotated.session);assert.equal(store.session(rotated.token),undefined);
  }finally{store.close();}
});
test('verified binding is sandbox-specific and cannot be assigned to another user',async()=>{
  const store=new IdentityStore(':memory:');try{
    const user=await store.createUser('Example buyer','Buyer@Example.Test','a long example password');const other=await store.createUser('Other buyer','other@example.test','another example password');
    assert.equal(normalizeEmail(' Buyer@Example.Test '),'buyer@example.test');assert.equal(store.isBound(user,'sandbox-A'),false);
    store.bind(user.user_id,'sandbox-A','example-customer',user.email);const bound=store.user(user.user_id)!;
    assert.equal(store.isBound(bound,'sandbox-A'),true);assert.equal(store.isBound(bound,'sandbox-B'),false);
    assert.equal(store.customerBoundElsewhere(other.user_id,'sandbox-A','example-customer'),true);assert.throws(()=>store.bind(other.user_id,'sandbox-A','example-customer',other.email));
    assert.throws(()=>store.bind(user.user_id,'sandbox-B','another-customer','wrong@example.test'));
  }finally{store.close();}
});
test('pending proofs belong to one identity session and customer vaults share the identity database',()=>{
  const store=new IdentityStore(':memory:');try{
    const one=store.createSession('local-user');const two=store.createSession('local-user');
    store.setPending(one.session,{customer_verification_id:'example-proof',customer_id:'example-customer',email:'buyer@example.test',purpose:'link_guest_purchases',created_at:Date.now()});
    assert.equal(store.pending(two.session),null);assert.equal(store.pending(one.session)?.customer_id,'example-customer');
    store.saveVault({user_id:'local-user',sandbox_id:'sandbox-A',customer_session_id:'example-session',secret:'local-fixture',refresh_token:'local-refresh',expires_at:Date.now()+1000,refresh_expires_at:Date.now()+2000});
    assert.equal(store.vaults('local-user').length,1);assert.equal(store.vault('local-user','sandbox-B'),undefined);store.deleteVault('local-user','sandbox-A');assert.equal(store.vault('local-user','sandbox-A'),undefined);
  }finally{store.close();}
});
