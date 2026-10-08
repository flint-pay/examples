import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client,SdkError} from '@flintpay/node';
import {createAuth} from '../../src/flint/auth.ts';
import {createClient} from '../../src/flint/client.ts';
import type {CheckoutRecord} from '../../src/store/db.ts';
import type {Order,OrderPaymentAttempt,PaymentIntent,CheckoutSession} from '@flintpay/node';
import {Store} from '../../src/store/db.ts';
import {PaymentEngine} from '../../src/payments/engine.ts';

test('published SDK emits only the named authority and preserves list envelopes',async()=>{
  const requests:{path:string;headers:Headers}[]=[];
  const client=new Client({baseUrl:'https://api.staging.withflintpay.com',maxAttempts:1,transport:async(input,init)=>{
    const url=new URL(String(input)),headers=new Headers(init?.headers);requests.push({path:url.pathname,headers});
    return new Response(JSON.stringify({data:[],next_page_token:'example-page'}),{headers:{'Content-Type':'application/json','Flint-Mode':'test','Flint-Sandbox-ID':'sandbox_example'}});
  }});
  try{
    const auth=createAuth('flint_test_PLACEHOLDER');const response=await client.me.listOrders({page_size:10},auth.customer('flint_cses_PLACEHOLDER'));assert.equal(response.next_page_token,'example-page');assert.deepEqual(response.data,[]);
    await client.customers.list({email:'buyer@example.invalid'},auth.merchant());
    const record={checkout_session_id:'session_example',checkout_auth_token:'example checkout authority'} as CheckoutRecord;
    await client.paymentMethods.list(undefined,auth.checkout(record));
    assert.equal(requests[0]?.headers.get('Authorization'),'Bearer flint_cses_PLACEHOLDER');assert.equal(requests[0]?.headers.get('X-Checkout-Session-ID'),null);assert.equal(requests[0]?.headers.get('X-API-Key'),null);
    assert.equal(requests[1]?.headers.get('Authorization'),'Bearer flint_test_PLACEHOLDER');
    assert.equal(requests[2]?.headers.get('Authorization'),null);assert.equal(requests[2]?.headers.get('X-Checkout-Session-ID'),'session_example');assert.equal(requests[2]?.headers.get('X-Checkout-Session-Secret'),'example checkout authority');
    for(const req of requests){assert.equal(req.headers.get('X-Portal-Session-Secret'),null);assert.equal(req.headers.get('Flint-Merchant-Id'),null);}
  }finally{await client.close();}
});
test('client refuses a live response before decoding any buyer data',async()=>{
  const client=createClient('https://api.staging.withflintpay.com',async()=>new Response(JSON.stringify({data:[]}),{headers:{'Content-Type':'application/json','Flint-Mode':'live'}}));
  try{await assert.rejects(client.me.listOrders(undefined,{customerToken:'flint_cses_PLACEHOLDER'}),error=>error instanceof SdkError&&error.kind==='transport');}finally{await client.close();}
});
test('binary published PDF binding keeps opaque bytes and customer authority',async()=>{
  const bytes=new Uint8Array([37,80,68,70,45,255]);
  const client=new Client({baseUrl:'https://api.staging.withflintpay.com',transport:async(_input,init)=>{assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer flint_cses_PLACEHOLDER');return new Response(bytes,{headers:{'Content-Type':'application/pdf'}});}});
  try{const response=await client.me.getInvoicePDF('inv_example',undefined,{customerToken:'flint_cses_PLACEHOLDER'});assert.deepEqual(response.data,bytes);}finally{await client.close();}
});
test('requires-action card and Affirm legs retain payment options using published SDK checkout reads',async()=>{
  const money={amount:'1000',currency:'USD'};
  for(const paymentOption of ['card','affirm'])for(const source of ['summary','lookup']){
    const store=new Store(':memory:'),paths:string[]=[];
    const client=new Client({baseUrl:'https://api.staging.withflintpay.com',maxAttempts:1,transport:async(input,init)=>{
      const url=new URL(String(input)),headers=new Headers(init?.headers);paths.push(url.pathname);
      assert.equal(headers.get('Authorization'),null);assert.equal(headers.get('X-API-Key'),null);assert.equal(headers.get('X-Checkout-Session-ID'),'session_example');assert.equal(headers.get('X-Checkout-Session-Secret'),'example checkout authority');
      assert.ok(['/v1/payment-intents/intent_example','/v1/checkout-sessions/session_example'].includes(url.pathname),url.pathname);
      const data:PaymentIntent|CheckoutSession=url.pathname.includes('/payment-intents/')?{payment_intent_id:'intent_example',status:'requires_action',amount_money:money,selected_payment_option:paymentOption,payment_flow:'invoice',payment_options:[paymentOption],last_payment_error:null,risk:null,support_reference:'EXAMPLE'}:{checkout_session_id:'session_example',status:'open',surface:'embedded',recovery_mode:false,delivery_method_ids:[],delivery_selection_required:false,problems:[]};
      return new Response(JSON.stringify({data}),{headers:{'Content-Type':'application/json','Flint-Mode':'test','Flint-Sandbox-ID':'sandbox_example'}});
    }});
    try{
      store.run('INSERT INTO payment_checkouts(checkout_ref,user_id,sandbox_id,resource_type,resource_id,order_id,checkout_session_id,checkout_auth_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)','checkout_example','user_example','sandbox_example','invoice','inv_example','ord_example','session_example','example checkout authority',Date.now(),Date.now());
      const record=store.checkout('user_example','sandbox_example','invoice','inv_example')!;
      const attempt={order_payment_attempt_id:'attempt_example',status:'requires_action',is_resumable:true,mode:'payment',expected_outstanding_money:money,payment_intents:[{payment_intent_id:'intent_example',status:'requires_action',amount_money:money,tip_money:{amount:'0',currency:'USD'}}],pending_actions:[{pending_action_id:'action_example',action_type:'payment_authentication',subject:{payment_intent:{payment_intent_id:'intent_example'}},client_action:{stripe:{account_id:'acct_example',publishable_key:'pk_test_PLACEHOLDER',payment_intent:{client_secret:'pi_example_secret_PLACEHOLDER',stripe_js_call:'handle_next_action'}}}}]} satisfies OrderPaymentAttempt;
      const order={order_id:'ord_example',payment_status:'unpaid',status:'open',line_items:[],pricing_amounts:{total_money:money},settlement_amounts:{outstanding_money:money},...(source==='summary'?{payment_intents:[{payment_intent_id:'intent_example',payment_source:{type:paymentOption}}]}:{})} as unknown as Order;
      const engine=new PaymentEngine(client,createAuth('flint_test_PLACEHOLDER'),store,async()=>{});
      const view=await engine.view(record,{order,attempt,unknown:false},true);
      assert.equal(view.next,'authenticate');assert.equal(view.state.returned,true);assert.equal(view.state.attempt?.legs?.[0]?.payment_option,paymentOption);assert.equal(view.state.pending_action_id,'action_example');assert.equal(view.client_action?.payment_intent?.client_secret,'pi_example_secret_PLACEHOLDER');
      assert.equal(JSON.stringify(view.state).includes('pi_example_secret_PLACEHOLDER'),false);assert.equal(JSON.stringify(view.state).includes(record.checkout_auth_token),false);
      assert.deepEqual(paths,source==='summary'?['/v1/checkout-sessions/session_example']:['/v1/payment-intents/intent_example','/v1/checkout-sessions/session_example']);
      const completed=await engine.view(record,{order:{...order,payment_status:'paid'},attempt:{...attempt,status:'succeeded'},unknown:false});assert.equal(completed.client_action,undefined);
    }finally{store.close();await client.close();}
  }
});
