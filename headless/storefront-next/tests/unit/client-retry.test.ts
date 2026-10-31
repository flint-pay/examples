import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '../../src/server/flint/client.ts';
import {createAuth} from '../../src/server/flint/auth.ts';

const failing=(status:number)=>()=>new Response('{}',{status,headers:{'content-type':'application/json'}});

test('the SDK client retries a read up to three attempts and sends a journaled write once',async(t)=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return failing(503)();});
  const client=createClient('https://api.example.invalid');
  const auth=createAuth('sk_test_example');
  await assert.rejects(client.orders.get('ord_example',undefined,auth.merchant()));
  assert.equal(calls,3);
  calls=0;
  await assert.rejects(client.orders.pay({order_id:'ord_example',body:{action:'pay',expected_outstanding_money:{amount:'100',currency:'USD'}}},auth.merchant('pay-example')));
  assert.equal(calls,1);
});
