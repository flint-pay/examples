import {test} from 'node:test';
import assert from 'node:assert/strict';
import {errors} from '@flintpay/node';
import type {Client,Order,OrderPaymentAttempt,PayOrderRequestInput,RequestOptions} from '@flintpay/node';
import {createApp} from '../../src/app.ts';
import {IdentityStore} from '../../src/identity/index.ts';
import {Store} from '../../src/store/db.ts';
import {readConfig} from '../../src/config.ts';

for(const surface of ['invoice','return'] as const)test(`${surface} provider returns preserve the Stripe fallback for the payment-state endpoint`,async()=>{
  const identity=new IdentityStore(':memory:'),store=new Store(':memory:');
  try{
    const config=readConfig({FLINT_API_KEY:'flint_test_PLACEHOLDER',FLINT_API_BASE_URL:'https://api.staging.withflintpay.com',APP_ORIGIN:'http://localhost:4200',PORT:'4200'});
    const created=await identity.createUser('Example','buyer@example.invalid','example password');identity.bind(created.user_id,'sandbox_example','cus_example',created.email);const session=identity.createSession(created.user_id);
    identity.saveVault({user_id:created.user_id,sandbox_id:'sandbox_example',customer_session_id:'customer_session_example',secret:'example customer authority',refresh_token:'example refresh authority',expires_at:Date.now()+3600000,refresh_expires_at:Date.now()+86400000});
    const money={amount:'1000' as const,currency:'USD'},zero={amount:'0' as const,currency:'USD'},pricing={subtotal_money:money,discount_money:zero,charge_money:zero,requested_tip_money:zero,tax_money:zero,total_money:money};
    const order={order_id:'ord_example',order_number:'EXAMPLE',status:'open',payment_status:'unpaid',buyer_actions:[],line_items:[],pricing_amounts:pricing,settlement_amounts:{outstanding_money:money,paid_money:zero,refunded_money:zero},tax:{type:'none'},payment_collection:{stripe:{account_id:'acct_PLACEHOLDER',publishable_key:'pk_test_PLACEHOLDER',elements:{amount_money:money,mode:'payment',next_step:'create_confirmation_token',payment_method_creation:'manual',payment_method_types:['card']}}}} as unknown as Order;
    const invoice={invoice_id:'inv_example',invoice_number:'EXAMPLE',buyer_actions:[{kind:'pay',is_available:true,is_required:true}],status:'open',is_overdue:false,settlement_amounts:{outstanding_money:money,currently_due_money:money},memo:''};
    const resource={return_id:'return_example',return_number:'EXAMPLE',buyer_actions:[{kind:'pay_balance',is_available:true,is_required:true}],completion_blockers:[{code:'resolution_requires_action',return_resolution_id:'resolution_example'}],financial_summary:{due_from_buyer_money:money}};
    const checkout={checkout_session_id:'checkout_session_example',order_id:'ord_example',surface:'headless',page_origin:config.appOrigin,status:'open',is_in_recovery:true};
    const sent:{body:PayOrderRequestInput;key?:string}[]=[];let failRead=false;
    const client={me:{getInvoice:async()=>invoice,getReturn:async()=>resource},checkoutSessions:{get:async()=>checkout},orders:{get:async()=>{if(failRead){failRead=false;throw new Error('refusal read failed');}return order;},pay:async(_id:string,body:PayOrderRequestInput,options:RequestOptions)=>{
      sent.push({body,key:options.idempotencyKey});
      if(sent.length===1){
        order.active_payment_attempt={order_id:order.order_id,order_payment_attempt_id:'attempt_example',status:'requires_action',mode:'payment',is_resumable:true,pending_actions:[],payment_intents:[],gift_card_redemptions:[],supported_actions:[],expected_outstanding_money:money};
        failRead=true;throw new errors.ConflictError('URL unsupported',{status:409,code:'ACTION_NOT_ALLOWED',outcome:'response',details:[{code:'ACTION_NOT_ALLOWED',message:'URL unsupported',reason:'provider_action_unsupported'}]});
      }
      order.active_payment_attempt={...order.active_payment_attempt,status:'processing',is_resumable:false} as OrderPaymentAttempt;
      return {order,order_payment_attempt:order.active_payment_attempt};
    }}} as unknown as Client;
    const resourceId=surface==='invoice'?'inv_example':'return_example',root=surface==='invoice'?'/invoices/inv_example/pay':'/returns/return_example/pay';
    store.run('INSERT INTO payment_checkouts(checkout_ref,user_id,sandbox_id,resource_type,resource_id,order_id,checkout_session_id,checkout_auth_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)','checkout_example',created.user_id,'sandbox_example',surface,resourceId,order.order_id,checkout.checkout_session_id,'example checkout authority',Date.now(),Date.now());
    const {app,engine}=createApp({config,client,identity,store,preflight:{sandboxId:'sandbox_example',merchantId:'mer_example',cards:'ready',setupNeeded:false,capabilities:null,support:{}},paymentDelay:async()=>{}});
    const row=engine.record('checkout_example'),job=engine.job(row,'pay',{action:'pay',client_action_type:'url',payment_source:{credential_type:'stripe_confirmation_token',stripe:{confirmation_token:'ctoken_example'}}});
    await assert.rejects(()=>engine.execute(row,job,()=>{}),/refusal read failed/);
    const pending=engine.unresolved(row)!,headers={Cookie:`${config.cookieName}=${session.token}`};
    const returned=await app.request(root+'/return',{headers});assert.equal(returned.status,200);
    assert.equal(sent.length,1,'the return request must not call orders.pay');assert.deepEqual(engine.unresolved(row),pending,'the fallback body, key and status survive the return');
    const status=await app.request(root+'/attempt',{headers});assert.equal(status.status,200);
    assert.equal(sent.length,2);assert.deepEqual(sent[1]!.body,{action:'resume',order_payment_attempt_id:'attempt_example',client_action_type:'stripe'});assert.equal(sent[1]!.key,`${sent[0]!.key}-stripe`);assert.equal(engine.unresolved(row),undefined);
    store.run('DELETE FROM payment_checkouts WHERE checkout_ref=?',row.checkout_ref);
    const missing=await app.request(root+'/return',{headers});assert.equal(missing.status,303);assert.equal(missing.headers.get('Location'),root,'a return without a checkout defers session creation to the page');assert.equal(sent.length,2);
  }finally{store.close();identity.close();}
});
