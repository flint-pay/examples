import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../../src/store/db.ts';
import type {CheckoutRecord} from '../../src/store/db.ts';
import {Checkouts} from '../../src/flint/checkouts.ts';
import {Carts} from '../../src/store/cart.ts';
import type {Cart} from '../../src/store/cart.ts';
import type {Order} from '@flintpay/node';

test('resource locks serialize independent SQLite connections and release ownership',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'storefront-lock-'));const first=new Store(join(directory,'app.sqlite'));const second=new Store(join(directory,'app.sqlite'));const events:string[]=[];
  try{
    await Promise.all([first.locked('order:one',async assertOwnership=>{events.push('first');assertOwnership();await new Promise(resolve=>setTimeout(resolve,80));events.push('first-end');}),second.locked('order:one',async assertOwnership=>{assertOwnership();events.push('second');})]);
    assert.deepEqual(events,['first','first-end','second']);assert.equal(first.all('SELECT * FROM resource_locks').length,0);
    await assert.rejects(first.locked('order:lost',async assertOwnership=>{first.run('DELETE FROM resource_locks WHERE resource=?','order:lost');assertOwnership();}),/lock_ownership_lost/);
    assert.equal(statSync(join(directory,'app.sqlite')).mode&0o777,0o600);
  }finally{first.close();second.close();rmSync(directory,{recursive:true,force:true});}
});
test('fixed creation keys replay after remote success preceded the local checkout update',async()=>{
  const store=new Store(':memory:');try{
    const checkouts=Object.assign(Object.create(Checkouts.prototype) as Checkouts,{store});const record={checkout_ref:'example-checkout',order_id:null} as CheckoutRecord;let sends=0;
    const call=async(key:string)=>{sends++;return key;};
    assert.equal(await checkouts.action(record,'order_create',{items:['one']},call,'creation-key'),'creation-key');
    assert.equal(await checkouts.action(record,'order_create',{items:['one']},call,'creation-key'),'creation-key');assert.equal(sends,2);assert.equal(store.all('SELECT * FROM actions').length,1);
    await assert.rejects(checkouts.action(record,'order_create',{items:['changed']},call,'creation-key'),error=>error instanceof Error&&'code'in error&&error.code==='ACTION_RECONCILIATION_REQUIRED');
  }finally{store.close();}
});
test('completed orders subtract purchased quantities from a merged cart once',()=>{
  const store=new Store(':memory:');try{
    const carts=Object.assign(Object.create(Carts.prototype) as Carts,{store});const now=Date.now();
    store.run('INSERT INTO carts(cart_id,session_hash,status,merged_into,created_at,updated_at) VALUES(?,?,?,?,?,?)','source','session','merged','target',now,now);
    store.run('INSERT INTO carts(cart_id,session_hash,created_at,updated_at) VALUES(?,?,?,?)','target','session',now,now);
    store.run('INSERT INTO cart_lines VALUES(?,?,?,?,?)','line','target','product','variant',5);
    store.run('INSERT INTO checkouts(checkout_ref,session_hash,cart_id,kind,created_at,updated_at) VALUES(?,?,?,?,?,?)','checkout','session','source','order',now,now);
    const order={line_items:[{variant_id:'variant',quantity:'2'}]} as Order;
    carts.complete('checkout',order);const target=store.get<Cart>('SELECT * FROM carts WHERE cart_id=?','target')!;assert.equal(carts.lines(target)[0]?.quantity,3);carts.complete('checkout',order);assert.equal(carts.lines(target)[0]?.quantity,3);assert.equal(target.status,'open');
  }finally{store.close();}
});
test('completed checkout credentials are pruned after one day',()=>{
  const store=new Store(':memory:');try{
    store.run('INSERT INTO checkouts(checkout_ref,session_hash,kind,checkout_auth_token,completed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)','old','session','order','local-token',Date.now()-25*60*60_000,Date.now(),Date.now());store.cleanup();
    assert.equal(store.get<{checkout_auth_token:string|null}>('SELECT checkout_auth_token FROM checkouts WHERE checkout_ref=?','old')?.checkout_auth_token,null);
  }finally{store.close();}
});
test('consuming a rendered notice snapshot preserves newer notices and reconciliation data',()=>{
  const store=new Store(':memory:');try{
    const now=Date.now();store.run('INSERT INTO checkouts(checkout_ref,session_hash,kind,cart_dirty,needs_replacement,details,flash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)','notice-checkout','session','order',1,1,JSON.stringify({quote_input:{buyer_location:{type:'address',address:{postal_code:'12345'}}}}),JSON.stringify(['checkout_refreshed','reconciliation-marker']),now,now);
    const checkouts=Object.assign(Object.create(Checkouts.prototype) as Checkouts,{store});const snapshot=checkouts.record('notice-checkout');const shown=checkouts.displayNotices(snapshot);
    checkouts.notice(checkouts.record(snapshot.checkout_ref),'delivery_released');checkouts.notice(snapshot,'gift_card_changed');const before=checkouts.record(snapshot.checkout_ref);
    checkouts.consumeNotices(snapshot,shown);const after=checkouts.record(snapshot.checkout_ref);
    assert.deepEqual(JSON.parse(after.flash),['reconciliation-marker','delivery_released','gift_card_changed']);assert.deepEqual({...after,flash:before.flash},{...before});
    assert.equal(store.all('SELECT * FROM actions').length,0);assert.equal(after.cart_dirty,1);assert.equal(after.needs_replacement,1);
    checkouts.consumeNotices(after,['reconciliation-marker']);assert.deepEqual(checkouts.record(snapshot.checkout_ref),after);
  }finally{store.close();}
});
