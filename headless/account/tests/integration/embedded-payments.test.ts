import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Client,Order,OrderPaymentAttempt,RequestOptions} from '@flintpay/node';
import {createApp} from '../../src/app.ts';
import {IdentityStore} from '../../src/identity/index.ts';
import {Store} from '../../src/store/db.ts';
import {readConfig} from '../../src/config.ts';

test('H1 and H2 launch with customer authority and pay only with the derived checkout authority',async()=>{
  for(const surface of ['invoice','return'] as const){
    const config=readConfig({FLINT_API_KEY:'flint_test_PLACEHOLDER',FLINT_API_BASE_URL:'https://api.staging.withflintpay.com',APP_ORIGIN:'http://localhost:4200',PORT:'4200'}),identity=new IdentityStore(':memory:'),store=new Store(':memory:');
    try{
      const created=await identity.createUser('Example','buyer@example.invalid','example password');identity.bind(created.user_id,'sandbox_example','cus_example',created.email);const session=identity.createSession(created.user_id);
      identity.saveVault({user_id:created.user_id,sandbox_id:'sandbox_example',customer_session_id:'customer_session_example',secret:'example customer authority',refresh_token:'example refresh authority',expires_at:Date.now()+3600000,refresh_expires_at:Date.now()+86400000});
      const money={amount:'1000',currency:'USD'},zero={amount:'0',currency:'USD'},pricing={subtotal_money:money,discount_money:zero,charge_money:zero,requested_tip_money:zero,tax_money:zero,total_money:money};
      let order={order_id:'ord_example',order_number:'EXAMPLE',status:'open',payment_status:'unpaid',buyer_actions:[],line_items:[],pricing_amounts:pricing,settlement_amounts:{outstanding_money:money,paid_money:zero,refunded_money:zero},tax:{type:'none'},payment_collection:{stripe:{account_id:'acct_PLACEHOLDER',publishable_key:'pk_test_PLACEHOLDER',elements:{amount_money:money,mode:'payment',next_step:'create_confirmation_token',payment_method_creation:'manual',payment_method_types:['card']}}}} as unknown as Order;
      const invoice={invoice_id:'inv_example',invoice_number:'EXAMPLE',buyer_actions:[{kind:'pay',is_available:true,is_required:true}],status:'open',is_overdue:false,outstanding_money:money,currently_due_money:money,memo:''};
      const resource={return_id:'return_example',return_number:'EXAMPLE',buyer_actions:[{kind:'pay_balance',is_available:true,is_required:true}],completion_blockers:[{code:'resolution_requires_action',return_resolution_id:'resolution_example'}],financial_summary:{due_from_buyer_money:money}};
      const checkout={checkout_session_id:'checkout_session_example',order_id:'ord_example',surface:'embedded',status:'open',recovery_mode:false};let launches=0,charges=0;
      const launch=async(resourceId:string,body:{surface:string;redirects:{success_redirect_url:string}},options:RequestOptions)=>{
        launches++;assert.equal(resourceId,surface==='invoice'?'inv_example':'resolution_example');assert.equal(body.surface,'embedded');assert.equal(body.redirects.success_redirect_url,config.appOrigin+(surface==='invoice'?'/invoices/inv_example/pay/return':'/returns/return_example/pay/return'));assert.equal(options.customerToken,'example customer authority');assert.equal(options.apiKey,undefined);assert.ok(options.idempotencyKey);
        return {checkout_session:checkout,checkout_access:{checkout_auth_token:'example checkout authority'},reused_existing:false,invoice};
      };
      const client={me:{getInvoice:async()=>invoice,getReturn:async()=>resource,createInvoiceCheckoutSession:launch,createReturnResolutionCheckoutSession:launch},checkoutSessions:{get:async()=>checkout},paymentMethods:{list:async()=>({data:[]})},orders:{get:async(_id:string,_params:unknown,options:RequestOptions)=>{assert.equal(options.authMode,'checkout');assert.equal(options.apiKey,undefined);assert.equal(options.customerToken,undefined);return order;},pay:async(request:{order_id:string;body:{action:string}},options:RequestOptions)=>{
        charges++;assert.equal(options.authMode,'checkout');assert.equal(options.customerToken,undefined);assert.equal(request.order_id,'ord_example');assert.equal(request.body.action,'pay');order={...order,payment_status:'paid',settlement_amounts:{...order.settlement_amounts,outstanding_money:zero}};const attempt:OrderPaymentAttempt={order_payment_attempt_id:'attempt_example',mode:'payment',status:'succeeded',is_resumable:false,expected_outstanding_money:money};return {order,payment_attempt:attempt};
      }}} as unknown as Client;
      const {app}=createApp({config,client,identity,store,preflight:{sandboxId:'sandbox_example',merchantId:'mer_example',cards:'ready',setupNeeded:false,capabilities:null,support:{}},paymentDelay:async()=>{}}),root=surface==='invoice'?'/invoices/inv_example/pay':'/returns/return_example/pay';
      const first=await app.request(root,{headers:{Cookie:`${config.cookieName}=${session.token}`}}),html=await first.text();assert.equal(first.status,200);assert.equal(html.includes('example checkout authority'),false);assert.equal(html.includes('example customer authority'),false);assert.equal(html.includes('checkout_session_example'),false);assert.equal(launches,1);
      const job=await app.request(root+'/submit',{method:'POST',headers:{Cookie:`${config.cookieName}=${session.token}`,Origin:config.appOrigin,'X-CSRF-Token':session.session.csrf_token,'Content-Type':'application/json'},body:JSON.stringify({credential:{kind:'confirmation_token',value:'ctoken_PLACEHOLDER'},approved_outstanding_money:money,return_resolution_id:'resolution_foreign',checkout_auth_token:'foreign credential'})});
      assert.equal(job.status,200);const result=await job.json();assert.equal(result.next,'done');assert.equal(charges,1);assert.equal(JSON.stringify(result).includes('example checkout authority'),false);
      assert.equal(store.checkout(created.user_id,'sandbox_example',surface,surface==='invoice'?'inv_example':'return_example')?.order_id,'ord_example');
    }finally{store.close();identity.close();}
  }
});
