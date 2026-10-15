import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createClient,fetchRetryingReads} from '../../src/flint/client.ts';

const failing=(status:number,headers:Record<string,string>={})=>()=>new Response('{}',{status,headers:{'content-type':'application/json',...headers}});
function counting(...responses:Array<()=>Response>){
  let calls=0;
  const send=(async()=>{const next=responses[Math.min(calls,responses.length-1)]!;calls++;return next();}) as typeof fetch;
  return {send,calls:()=>calls};
}

test('a read retries a brief Flint or network error and returns the first good response',async()=>{
  let calls=0;
  const send=(async()=>{calls++;if(calls===1)throw new TypeError('fetch failed');if(calls===2)return failing(503)();return new Response('{"ok":true}',{status:200});}) as typeof fetch;
  const response=await fetchRetryingReads('https://api.example.invalid/v1/orders/ord_1',{method:'GET'},send);
  assert.equal(response.status,200);
  assert.equal(calls,3);
});

test('a read stops after three attempts and returns the last response',async()=>{
  const flint=counting(failing(502));
  const response=await fetchRetryingReads('https://api.example.invalid/v1/orders/ord_1',undefined,flint.send);
  assert.equal(response.status,502);
  assert.equal(flint.calls(),3);
});

test('a read is not retried for a client error or a long Retry-After',async()=>{
  for(const respond of [failing(404),failing(409),failing(429,{'Retry-After':'30'})]){
    const flint=counting(respond);
    await fetchRetryingReads('https://api.example.invalid/v1/orders/ord_1',{method:'GET'},flint.send);
    assert.equal(flint.calls(),1);
  }
});

test('a write is sent once, whatever Flint answers',async()=>{
  const flint=counting(failing(503));
  const response=await fetchRetryingReads('https://api.example.invalid/v1/orders/ord_1/pay',{method:'POST',body:'{}'},flint.send);
  assert.equal(response.status,503);
  assert.equal(flint.calls(),1);
  let calls=0;
  await assert.rejects(fetchRetryingReads('https://api.example.invalid/v1/orders',{method:'POST'},(async()=>{calls++;throw new TypeError('fetch failed');}) as typeof fetch));
  assert.equal(calls,1);
});

test('an aborted read is not retried',async()=>{
  const controller=new AbortController();
  let calls=0;
  const send=(async()=>{calls++;controller.abort(new Error('timed out'));throw new DOMException('aborted','AbortError');}) as typeof fetch;
  await assert.rejects(fetchRetryingReads('https://api.example.invalid/v1/orders/ord_1',{signal:controller.signal},send));
  assert.equal(calls,1);
});

test('the SDK client retries reads through the transport and sends writes once',async(t)=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return failing(503)();});
  const client=createClient('https://api.example.invalid');
  await assert.rejects(client.orders.get('ord_example',undefined,{apiKey:'sk_test_example'}));
  assert.equal(calls,3);
  calls=0;
  await assert.rejects(client.orders.pay({order_id:'ord_example',body:{action:'pay',expected_outstanding_money:{amount:'100',currency:'USD'}}},{apiKey:'sk_test_example',idempotencyKey:'pay-example'}));
  assert.equal(calls,1);
});
