import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Client,Order,BuyerInvoice,Subscription,ReturnResource,Customer} from '@flintpay/node';
import {createApp} from '../../src/app.ts';
import {IdentityStore} from '../../src/identity/index.ts';
import {Store} from '../../src/store/db.ts';
import {readConfig} from '../../src/config.ts';

test('real renderer consumes composed resource DTOs and escapes untrusted buyer fields',async()=>{
  const config=readConfig({FLINT_API_KEY:'flint_test_PLACEHOLDER',FLINT_API_BASE_URL:'https://api.staging.withflintpay.com',APP_ORIGIN:'http://localhost:4200',PORT:'4200'}),identity=new IdentityStore(':memory:'),store=new Store(':memory:');
  try{
    const created=await identity.createUser('Example','buyer@example.invalid','example password');identity.bind(created.user_id,'sandbox_example','cus_example',created.email);const session=identity.createSession(created.user_id);
    identity.saveVault({user_id:created.user_id,sandbox_id:'sandbox_example',customer_session_id:'session_example',secret:'example customer authority',refresh_token:'example refresh authority',expires_at:Date.now()+3600000,refresh_expires_at:Date.now()+86400000});
    const zero={amount:'0',currency:'USD'},pricing={subtotal_money:zero,discount_money:zero,charge_money:zero,requested_tip_money:zero,tax_money:zero,total_money:zero},settlement={paid_money:zero,refunded_money:zero,outstanding_money:zero};
    const order={order_id:'ord_example',order_number:'EXAMPLE',status:'closed',payment_status:'paid',buyer_actions:[],line_items:[],pricing_amounts:pricing,settlement_amounts:settlement,tax:{type:'none'}} as unknown as Order;
    const invoice={invoice_id:'inv_example',invoice_number:'EXAMPLE',buyer_actions:[],status:'paid',is_overdue:false,credit_money:zero,currently_due_money:zero,outstanding_money:zero,paid_money:zero,late_fees:[],snapshot:{line_items:[],pricing_amounts:pricing}} as unknown as BuyerInvoice;
    const subscription={subscription_id:'sub_example',status:'active',buyer_actions:[],cancel_at_period_end:false,subscription_plan:{name:'Example plan',billing_interval:'monthly',billing_interval_count:1},billing_interval:'monthly',billing_interval_count:1,recurring_amount_money:zero,payment_method_id:'method_example'} as unknown as Subscription;
    const resource={return_id:'return_example',return_number:'EXAMPLE',order_id:'ord_example',status:'requested',buyer_actions:[],line_items:[],handoff_requirements:[],completion_blockers:[],supported_actions:[],financial_summary:{credit_money:zero,due_from_buyer_money:zero,refunded_money:zero,replacement_total_money:zero,returned_total_money:zero}} as unknown as ReturnResource;
    const customer={name:'<img src=x onerror=alert(1)>',email:'buyer@example.invalid'} as Customer;
    const envelope=(data:unknown[])=>({data});
    const client={me:{get:async()=>customer,getOrder:async()=>order,listOrders:async()=>envelope([order]),listSubscriptions:async()=>envelope([subscription]),listInvoices:async()=>envelope([invoice]),listReturns:async()=>envelope([resource]),getInvoice:async()=>invoice,listCreditNotes:async()=>envelope([]),getSubscription:async()=>subscription,getReturn:async()=>resource,listPayments:async()=>envelope([]),listRefunds:async()=>envelope([]),listFulfillments:async()=>envelope([]),listShipments:async()=>envelope([]),listPackages:async()=>envelope([]),listFulfillmentEvents:async()=>envelope([]),listPaymentMethods:async()=>envelope([])},settings:{getEffective:async()=>({customer_account:{buyer_capabilities:{}}})}} as unknown as Client;
    const {app}=createApp({config,client,identity,store,preflight:{sandboxId:'sandbox_example',merchantId:'mer_example',cards:'ready',setupNeeded:false,capabilities:null,support:{}}});
    for(const path of ['/','/orders','/orders/ord_example','/invoices/inv_example','/subscriptions/sub_example','/returns/return_example','/profile']){
      const response=await app.request(path,{headers:{Cookie:`${config.cookieName}=${session.token}`}}),html=await response.text();assert.equal(response.status,200,path);assert.ok(html.startsWith('<!doctype html>'),path);assert.equal(html.includes('example customer authority'),false);assert.equal(html.includes('<img src=x onerror='),false);
      if(path==='/profile')assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
    }
  }finally{store.close();identity.close();}
});
