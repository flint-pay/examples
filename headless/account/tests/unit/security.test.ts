import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {BuyerGiftCardTransaction,PaymentSourceSummary,PickupFulfillmentDetails} from '@flintpay/node';
import {returnPath} from '../../src/security/paths.ts';
import {resourceHint} from '../../src/security/hints.ts';
import {project,safeNested,clientAction} from '../../src/flint/projection.ts';
import {IdentityStore,verifyPassword} from '../../src/identity/index.ts';
import {createAuth} from '../../src/flint/auth.ts';
import {readConfig} from '../../src/config.ts';
import {giftRecipient} from '../../src/security/input.ts';

test('redirects reject protocol relative, encoded backslash, controls, and foreign origins',()=>{
  for(const value of ['//example.invalid','/%5c%5cexample.invalid','https://example.invalid','/\nanything','/%2fexample.invalid','/\\example.invalid','/%00','/'.repeat(2049)])assert.equal(returnPath(value),'/');
  assert.equal(returnPath('/invoices/inv_example?flint_action=view&flint_mode=sandbox'),'/invoices/inv_example?flint_action=view&flint_mode=sandbox');
});
test('all six email families are hints and a wrong merchant or environment never authorizes a read',()=>{
  const url=(type:string,action:string,source='')=>new URL(`http://localhost:4200/?flint_merchant_id=mer_example&flint_mode=sandbox&flint_environment_id=sandbox_example&flint_resource_type=${type}&flint_resource_id=resource_example&flint_action=${action}${source?'&flint_source='+source:''}`);
  for(const source of ['order_receipts','fulfillment_updates','subscription_lifecycle','dunning','returns','invoices'])assert.equal(resourceHint(url('order','view',source),'mer_example','sandbox_example').kind,'resource');
  for(const type of ['order','invoice','subscription','return'])assert.equal(resourceHint(url(type,type==='order'||type==='invoice'?'view':'manage'),'mer_example','sandbox_example').kind,'resource');
  assert.equal(resourceHint(url('order','view'),'mer_other','sandbox_example').kind,'reject');
  assert.equal(resourceHint(url('order','view'),'mer_example','sandbox_other').kind,'reject');
  assert.equal(resourceHint(url('order','unknown'),'mer_example','sandbox_example').kind,'reject');
  assert.equal(resourceHint(url('account','home'),'mer_example','sandbox_example').kind,'reject');
  const duplicate=url('order','view');duplicate.searchParams.append('flint_merchant_id','mer_other');assert.equal(resourceHint(duplicate,'mer_example','sandbox_example').kind,'reject');
});
test('allowlisted DTOs discard unknown fields, merchant metadata, and credentials in nested fields',()=>{
  const data={order_id:'ord_example',metadata:{customer:'private'},internal_note:'private',checkout_auth_token:'example_checkout_credential',customer_id:'cus_other',line_items:[{name:'Example',metadata:{secret:'private'},new_private_field:'private',description:'flint_cses_PLACEHOLDER'}],buyer_actions:[{kind:'start_return',is_available:true,is_required:false}]};
  const safe=project('order',data);assert.equal('metadata'in safe,false);assert.equal('checkout_auth_token'in safe,false);assert.deepEqual(safe.line_items,[{name:'Example'}]);assert.equal(safe.buyer_actions.length,1);
  assert.deepEqual(safeNested({secret:'secret',refresh_token:'secret',amount:'1',currency:'USD'}),{amount:'1',currency:'USD'});
  assert.equal(clientAction(undefined),undefined);
});
test('gift history retains published transaction names and dates without legacy aliases',()=>{
  const transaction={gift_card_id:'gfc_example',gift_card_transaction_id:'gct_example',transaction_type:'redeem',posted_at:'2026-01-02T12:00:00Z',sequence:'2',amount_money:{amount:'-500',currency:'USD'},balance_before_money:{amount:'2500',currency:'USD'},balance_after_money:{amount:'2000',currency:'USD'}} satisfies BuyerGiftCardTransaction;
  const safe=project('transaction',{...transaction,type:'private legacy type',created_at:'private legacy date',metadata:{private:'private'}});
  assert.deepEqual(safe,{gift_card_transaction_id:transaction.gift_card_transaction_id,transaction_type:transaction.transaction_type,amount_money:transaction.amount_money,balance_after_money:transaction.balance_after_money,posted_at:transaction.posted_at});
});
test('payment summaries retain published card and bank display fields without private source details',()=>{
  const card={type:'card',card:{brand:'visa',last4:'4242',payment_method_id:'method_example'}} satisfies PaymentSourceSummary;
  const bank={type:'ach_debit',ach_debit:{account_type:'checking',bank_name:'Example Bank',last4:'6789'}} satisfies PaymentSourceSummary;
  assert.deepEqual(project('payment',{payment_source:{...card,card:{...card.card,fingerprint:'private',metadata:{private:'private'},client_secret:'pi_example_secret_PLACEHOLDER'},provider:'private'}}).payment_source,card);
  assert.deepEqual(project('payment',{payment_source:{...bank,ach_debit:{...bank.ach_debit,routing_number:'private',account_number:'private'}}}).payment_source,bank);
  assert.deepEqual(project('payment',{payment_source:{type:'card',card:{brand:'visa',last4:'flint_cses_PLACEHOLDER'}}}).payment_source,{type:'card',card:{brand:'visa'}});
});
test('pickup summaries retain location, instructions, and promised timing while discarding private fields',()=>{
  const pickup={location_name:'Example Store',address:{line1:'123 Example Street',city:'Example City',state:'NY',postal_code:'10001',country:'US'},instructions:'Collect at the counter.',curbside_instructions:'Use the marked space.',pickup_mode:'in_store',ready_at:'2026-01-02T12:00:00Z',window_start_at:'2026-01-02T12:00:00Z',window_end_at:'2026-01-02T13:00:00Z',timezone:'America/New_York'} satisfies PickupFulfillmentDetails;
  const safe=project('fulfillment',{fulfillment_id:'ful_example',type:'pickup',pickup_details:{...pickup,address:{...pickup.address,metadata:{private:'private'}},metadata:{private:'private'},checkout_auth_token:'example checkout authority'}});
  assert.deepEqual(safe.pickup_details,pickup);
});
test('opaque sessions rotate and unknown accounts still run the password derivation',async()=>{
  const identity=new IdentityStore(':memory:');try{
    const user=await identity.createUser('Example','buyer@example.invalid','example password only');
    assert.equal(await verifyPassword('example password only',user.password_hash),true);
    assert.equal(await verifyPassword('wrong',undefined),false);
    const first=identity.createSession(),second=identity.rotate(first.session,user.user_id);
    assert.equal(identity.session(first.token),undefined);assert.equal(identity.session(second.token)?.user_id,user.user_id);
    assert.notEqual(first.session.csrf_token,second.session.csrf_token);
  }finally{identity.close();}
});
test('authority builders never mix merchant, customer, and checkout credentials',()=>{
  const auth=createAuth('flint_test_PLACEHOLDER');assert.deepEqual(auth.customer('example customer credential'),{customerToken:'example customer credential'});assert.deepEqual(auth.merchant(),{apiKey:'flint_test_PLACEHOLDER'});
  assert.equal('apiKey'in auth.customer('example customer credential'),false);
});
test('configuration refuses live keys and external HTTP origins',()=>{
  const env={FLINT_API_KEY:'flint_test_PLACEHOLDER',FLINT_API_BASE_URL:'https://api.staging.withflintpay.com',APP_ORIGIN:'http://localhost:4200',PORT:'4200'};
  assert.equal(readConfig(env).port,4200);assert.throws(()=>readConfig({...env,FLINT_API_KEY:'flint_live_PLACEHOLDER'}));assert.throws(()=>readConfig({...env,APP_ORIGIN:'http://example.invalid'}));
});
test('recipient proofs require the exact public grant pattern and preserve the opaque fragment token',()=>{
  const grant='gcg_'+'0'.repeat(26);
  assert.deepEqual(giftRecipient(grant,' synthetic '),{credential_type:'recipient_access',grant_id:grant,recipient_access_token:' synthetic '});
  assert.equal(giftRecipient(grant,'s'.repeat(4096)).recipient_access_token.length,4096);
  for(const invalid of ['gcf_'+'0'.repeat(26),'gcg_'+'0'.repeat(25),'gcg_'+'0'.repeat(27),'gcg_'+'a'.repeat(26),...['I','L','O','U'].map(letter=>'gcg_'+letter+'0'.repeat(25)),grant+'\n',' '+grant,grant+'/extra',null])assert.throws(()=>giftRecipient(invalid,'synthetic'));
  for(const token of ['',null,123,'s'.repeat(4097)])assert.throws(()=>giftRecipient(grant,token));
});
