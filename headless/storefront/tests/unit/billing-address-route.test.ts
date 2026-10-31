import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client,SdkError} from '@flintpay/node';
import type {Address,Order,CheckoutSession,Customer,CreateCustomerAddressRequestInput,UpdateCustomerAddressRequestInput,RequestOptions} from '@flintpay/node';
import {createApp} from '../../src/app.ts';
import type {Config} from '../../src/config.ts';
import {Store} from '../../src/store/db.ts';
import type {ActionRecord} from '../../src/store/db.ts';
import {IdentityStore} from '../../src/identity/index.ts';
import {flintError,flintErrorBody} from './support/flint-error.ts';

const origin='http://localhost:4100';
const address={line1:'1 Example Street',city:'Austin',state:'TX',postal_code:'78701',country:'US' as const};
const taxRequest={tax:{enabled:true,location:{address_source:'provided',address_type:'billing_address',address}}};
type Saved={customer_address_id:string;address:Address;recipient_name:string;is_default_billing:boolean;is_default_shipping:boolean;version:string};
type Written={op:'create'|'update';id:string;addressId?:string;body:CreateCustomerAddressRequestInput|UpdateCustomerAddressRequestInput;key:string|undefined;apiKey:string|undefined};
function fixture(kind:'order'|'subscription'='order'){
  const money={amount:'2400' as const,currency:'USD'};
  const order={order_id:'fixture-order',status:'open',payment_status:'unpaid',version:'1',settlement_amounts:{outstanding_money:money},tax:{enabled:true,status:'requires_location',available_location_inputs:['provided']},payment_collection:{stripe:{}}} as unknown as Order;
  const session={checkout_session_id:'fixture-session',order_id:order.order_id,status:'open',buyer_fields:{require_email:true},delivery_selection_required:false} as unknown as CheckoutSession;
  // A customer's billing and shipping addresses are read-only copies of its default saved addresses.
  const customer={customer_id:'fixture-customer',email:'buyer@example.test',version:'1',billing_address:null,shipping_address:null} as unknown as Customer&{billing_address:Address|null;shipping_address:Address|null};
  const saved:Saved[]=[];
  const remote={updates:[] as {body:unknown;key:string|undefined;authMode:unknown}[],error:undefined as SdkError|undefined,selection:undefined as unknown,order,session,customer,saved,
    customerReads:[] as {id:string;apiKey:string|undefined}[],customerUpdates:[] as Written[],
    customerReadError:undefined as SdkError|undefined,customerError:undefined as SdkError|undefined,customerLoseResponse:false,beforeCustomerUpdate:undefined as (()=>void)|undefined};
  const customerRequests=new Map<string,{body:string;result:Saved}>();
  const write=(op:'create'|'update',id:string,addressId:string|undefined,body:CreateCustomerAddressRequestInput|UpdateCustomerAddressRequestInput,options:RequestOptions<'merchant'>,apply:()=>Saved)=>{
    remote.customerUpdates.push({op,id,addressId,body:structuredClone(body),key:options.idempotencyKey,apiKey:options.apiKey as string|undefined});
    if(remote.customerError)throw remote.customerError;
    remote.beforeCustomerUpdate?.();remote.beforeCustomerUpdate=undefined;
    const prior=customerRequests.get(options.idempotencyKey!);
    let result:Saved;
    if(prior){assert.equal(prior.body,JSON.stringify(body),'a customer key must retain its original request');result=prior.result;}
    else{result=apply();customerRequests.set(options.idempotencyKey!,{body:JSON.stringify(body),result});}
    if(remote.customerLoseResponse)throw new SdkError('transport','fixture lost customer response','unknown',true);
    return structuredClone(result);
  };
  const client={
    orders:{get:async()=>order,update:async(_id:string,body:unknown,options:RequestOptions<'checkout'>)=>{
      remote.updates.push({body:structuredClone(body),key:options.idempotencyKey,authMode:options.checkoutToken?'checkout':undefined});
      if(remote.error)throw remote.error;
      order.tax!.status='calculated';
      return order;
    }},
    customers:{get:async(id:string,_params:unknown,options:RequestOptions<'merchant'>)=>{
      remote.customerReads.push({id,apiKey:options.apiKey as string|undefined});if(remote.customerReadError)throw remote.customerReadError;return structuredClone(customer);
    },listAddresses:async()=>({data:structuredClone(saved)}),
    createAddress:async(id:string,body:CreateCustomerAddressRequestInput,options:RequestOptions<'merchant'>)=>write('create',id,undefined,body,options,()=>{
      const row:Saved={customer_address_id:`addr_${saved.length+1}`,address:structuredClone(body.address) as Address,recipient_name:body.recipient_name,is_default_billing:!!body.is_default_billing,is_default_shipping:false,version:'1'};
      if(row.is_default_billing){for(const other of saved)other.is_default_billing=false;customer.billing_address=structuredClone(row.address);}
      saved.push(row);return row;
    }),
    updateAddress:async(id:string,addressId:string,body:UpdateCustomerAddressRequestInput,options:RequestOptions<'merchant'>)=>write('update',id,addressId,body,options,()=>{
      const row=saved.find(item=>item.customer_address_id===addressId)!;
      if(body.expected_version!==row.version)throw flintError(409,'VERSION_CONFLICT',{param:'expected_version'},{retry:'after_refresh'});
      if(body.address)row.address=structuredClone(body.address) as Address;
      row.version=String(BigInt(row.version)+1n);
      if(row.is_default_billing)customer.billing_address=structuredClone(row.address);
      return row;
    })},
    checkoutSessions:{get:async()=>session,getCurrentDeliverySelection:async()=>({delivery_selection:remote.selection})},
  } as unknown as Client;
  const config:Config={apiKey:'local-billing-fixture',apiBaseUrl:'https://api.staging.withflintpay.com',giftChallengeOrigin:'https://checkout.staging.withflintpay.com',appOrigin:origin,port:4100,identityDatabasePath:':memory:',appDatabasePath:':memory:',cookieName:'billing_session',checkoutTtl:3600,storeName:'Example store'};
  const runtime=createApp({config,client,preflight:{sandboxId:'fixture-sandbox',cards:'enabled'},store:new Store(':memory:'),identity:new IdentityStore(':memory:')});
  let owner=runtime.identity.createSession();const now=Date.now();
  runtime.store.run('INSERT INTO checkouts(checkout_ref,session_hash,kind,order_id,checkout_session_id,checkout_auth_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)','chk_fixture',owner.session.session_hash,kind,order.order_id,session.checkout_session_id,'local-checkout-fixture',now,now);
  const post=(input:unknown)=>runtime.app.request(origin+'/checkout/chk_fixture/billing-address',{method:'POST',headers:{Cookie:`billing_session=${owner.token}`,Origin:origin,'X-CSRF-Token':owner.session.csrf_token,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(input)});
  const details=()=>runtime.checkouts.details(runtime.checkouts.record('chk_fixture'));
  const signIn=async()=>{
    const user=await runtime.identity.createUser('Example buyer',customer.email!,'an example fixture password');runtime.identity.bind(user.user_id,'fixture-sandbox',customer.customer_id,user.email);
    runtime.identity.destroy(owner.session);owner=runtime.identity.createSession(user.user_id);order.customer_id=customer.customer_id;
    runtime.store.run('UPDATE checkouts SET session_hash=?,user_id=? WHERE checkout_ref=?',owner.session.session_hash,user.user_id,'chk_fixture');return user;
  };
  const reload=()=>runtime.app.request(origin+'/checkout/chk_fixture/state',{headers:{Cookie:`billing_session=${owner.token}`,Accept:'application/json'}});
  return {...runtime,remote,post,details,signIn,reload,close:()=>{runtime.store.close();runtime.identity.close();}};
}

for(const kind of ['order','subscription'] as const)test(`a no-delivery ${kind} saves only a provided billing tax address and projects prefill`,async()=>{
  const app=fixture(kind);try{
    const initial=app.checkouts.project(await app.checkouts.read('chk_fixture'));assert.equal(initial.billing_address,null);
    const response=await app.post({...address,line1:'  '+address.line1+'  ',line2:'  '});assert.equal(response.status,200);
    assert.deepEqual(app.remote.updates[0]?.body,taxRequest);assert.equal(app.remote.updates[0]?.authMode,'checkout');assert.ok(app.remote.updates[0]?.key);
    assert.deepEqual(app.details().billing_address,address);assert.deepEqual((await response.json()).state.billing_address,address);
  }finally{app.close();}
});

test('billing tax input rejects incomplete, oversized, foreign and malformed postal addresses without dispatch',async()=>{
  const app=fixture();try{
    for(const input of [{...address,line1:''},{...address,city:' '},{...address,state:''},{...address,state:'Texas'},{...address,postal_code:'7870'},{...address,postal_code:'78701-'},{...address,country:'CA'},{...address,line1:'x'.repeat(201)},{...address,line2:null}]){
      const response=await app.post(input);assert.equal(response.status,400);assert.equal((await response.json()).error.code,'INVALID_INPUT');
    }
    assert.equal(app.remote.updates.length,0);assert.equal(app.details().billing_address,undefined);
    assert.equal((await app.post({...address,line2:' Suite 2 ',postal_code:'78701-1234'})).status,200);
    assert.deepEqual(app.details().billing_address,{...address,line2:'Suite 2',postal_code:'78701-1234'});
  }finally{app.close();}
});

for(const guard of ['delivery_required','delivery_quote','delivery_selection','tax_disabled'] as const)test(`billing tax input refuses ${guard} on the server`,async()=>{
  const app=fixture('subscription');try{
    await app.signIn();
    if(guard==='delivery_required')app.remote.session.delivery_selection_required=true;
    if(guard==='tax_disabled')app.remote.order.tax!.enabled=false;
    const record=app.checkouts.record('chk_fixture'),details=app.details();
    if(guard==='delivery_quote')details.delivery_quote={delivery_quote_id:'quote_fixture',choice_groups:[],expires_at:new Date(Date.now()+60_000).toISOString(),input_requirements:[],status:'active'};
    if(guard==='delivery_selection'){details.delivery_selection={delivery_selection_id:'selection_fixture'};app.remote.selection=details.delivery_selection;}
    app.checkouts.saveDetails(record,details);
    const response=await app.post(address);assert.equal(response.status,400);assert.equal((await response.json()).error.code,'INVALID_INPUT');
    assert.equal(app.remote.updates.length,0);assert.equal(app.remote.customerReads.length,0);assert.equal(app.remote.customerUpdates.length,0);assert.equal(app.details().billing_address,undefined);
  }finally{app.close();}
});

for(const guard of ['unknown_payment','active_attempt'] as const)test(`billing tax input keeps the existing ${guard} mutation fence`,async()=>{
  const app=fixture();try{
    if(guard==='unknown_payment')app.payments.job(app.checkouts.record('chk_fixture'),'pay',{action:'pay',payment_source:{credential_type:'token' as const,token:'pm_fixture'}});
    else app.remote.order.active_payment_attempt={order_payment_attempt_id:'attempt_fixture',status:'processing',is_resumable:false} as Order['active_payment_attempt'];
    const response=await app.post(address);assert.equal(response.status,409);assert.equal((await response.json()).error.code,guard==='unknown_payment'?'CHECKOUT_PAYMENT_RESOLVING':'PAYMENT_ATTEMPT_IN_PROGRESS');
    assert.equal(app.remote.updates.length,0);assert.equal(app.details().billing_address,undefined);
  }finally{app.close();}
});

test('unknown billing tax mutation replays the exact request and key and saves prefill only after success',async()=>{
  const app=fixture();try{
    const previous={...address,line1:'Previous address'};app.checkouts.saveDetails(app.checkouts.record('chk_fixture'),{billing_address:previous});
    app.remote.error=new SdkError('transport','fixture lost response','unknown',true);
    assert.equal((await app.post(address)).status,503);assert.deepEqual(app.details().billing_address,previous);
    const pending=app.store.get<ActionRecord>("SELECT * FROM actions WHERE kind='tax_location'")!;assert.equal(pending.status,'unknown');
    const changed=await app.post({...address,line1:'Different address'});assert.equal(changed.status,409);assert.equal((await changed.json()).error.code,'ACTION_RECONCILIATION_REQUIRED');assert.equal(app.remote.updates.length,1);
    app.remote.error=undefined;const recovered=await app.post({...address,line2:''});assert.equal(recovered.status,200);
    assert.deepEqual(app.remote.updates[1],app.remote.updates[0]);assert.deepEqual(app.details().billing_address,address);
    assert.equal(app.store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',pending.action_id)?.status,'succeeded');
    assert.equal(app.store.all("SELECT * FROM actions WHERE kind='tax_location'").length,1);
  }finally{app.close();}
});

test('an authoritative tax validation rejection preserves the prior prefill and surfaces the existing error',async()=>{
  const app=fixture();try{
    app.remote.error=flintError(400,'INVALID_REQUEST',{code:'INVALID_VALUE',param:'tax.location.address'});
    const response=await app.post(address);assert.equal(response.status,400);assert.equal((await response.json()).error.code,'INVALID_REQUEST');
    assert.equal(app.details().billing_address,undefined);assert.equal(app.remote.updates.length,1);
    assert.equal(app.store.get<ActionRecord>("SELECT * FROM actions WHERE kind='tax_location'")?.status,'rejected');
  }finally{app.close();}
});

test('an owned bound subscription saves the missing customer billing source once without projecting provenance',async()=>{
  const app=fixture('subscription');try{
    await app.signIn();const response=await app.post(address);assert.equal(response.status,200);
    assert.deepEqual(app.remote.customerReads,[{id:'fixture-customer',apiKey:'local-billing-fixture'}]);
    assert.equal(app.remote.customerUpdates[0]?.op,'create');assert.deepEqual(app.remote.customerUpdates[0]?.body,{address,recipient_name:'Example buyer',is_default_billing:true});assert.equal(app.remote.customerUpdates[0]?.id,'fixture-customer');assert.equal(app.remote.customerUpdates[0]?.apiKey,'local-billing-fixture');
    assert.equal(app.remote.customerUpdates[0]?.key,`${app.remote.updates[0]?.key}-customer`);
    assert.deepEqual(app.remote.customer.billing_address,address);assert.deepEqual(app.details().customer_billing_address,address);
    const state=(await response.json()).state;assert.deepEqual(state.billing_address,address);assert.equal('customer_billing_address'in state,false);
    assert.equal((await app.post({...address,line2:''})).status,200);assert.equal(app.remote.customerUpdates.length,1);
  }finally{app.close();}
});

for(const saved of ['billing','shipping','both','equal','equal_blank_line2','equal_null_line2'] as const)test(`a subscription preserves the customer's existing ${saved} defaults`,async()=>{
  const app=fixture('subscription');try{
    await app.signIn();const existing={...address,line1:'2 Existing Street'};
    if(saved==='billing'||saved==='both')app.remote.customer.billing_address=existing;
    if(saved==='shipping'||saved==='both')app.remote.customer.shipping_address=existing;
    if(saved.startsWith('equal'))app.remote.customer.billing_address={...address,...(saved==='equal_blank_line2'?{line2:' '}:saved==='equal_null_line2'?{line2:null as unknown as string}:{})};
    const before=structuredClone(app.remote.customer);assert.equal((await app.post(address)).status,200);
    assert.equal(app.remote.customerUpdates.length,0);assert.deepEqual(app.remote.customer,before);assert.equal(app.details().customer_billing_address,undefined);
    assert.equal((await app.post({...address,line1:'3 Corrected Street'})).status,200);assert.equal(app.remote.customerUpdates.length,0);
  }finally{app.close();}
});

for(const guard of ['one_time','guest','unbound','other_sandbox','other_owner','other_customer'] as const)test(`billing customer persistence excludes ${guard}`,async()=>{
  const app=fixture(guard==='one_time'?'order':'subscription');try{
    if(guard!=='guest'){
      const user=await app.signIn();
      if(guard==='unbound')app.identity.db.prepare('UPDATE users SET email_verified_at=NULL WHERE user_id=?').run(user.user_id);
      if(guard==='other_sandbox')app.identity.db.prepare('UPDATE users SET flint_sandbox_id=? WHERE user_id=?').run('other-sandbox',user.user_id);
      if(guard==='other_owner')app.store.run('UPDATE checkouts SET user_id=? WHERE checkout_ref=?','other-user','chk_fixture');
      if(guard==='other_customer')app.remote.order.customer_id='other-customer';
    }
    assert.equal((await app.post(address)).status,200);assert.equal(app.remote.customerReads.length,0);assert.equal(app.remote.customerUpdates.length,0);assert.equal(app.details().customer_billing_address,undefined);
  }finally{app.close();}
});

test('a checkout can correct its own customer billing source but preserves a later change from elsewhere',async()=>{
  const app=fixture('subscription');try{
    await app.signIn();assert.equal((await app.post(address)).status,200);
    const corrected={...address,line1:'2 Corrected Street'};assert.equal((await app.post(corrected)).status,200);
    assert.equal(app.remote.customerUpdates.length,2);assert.equal(app.remote.customerUpdates[1]?.op,'update');assert.equal(app.remote.customerUpdates[1]?.addressId,'addr_1');assert.deepEqual(app.remote.customerUpdates[1]?.body,{address:corrected,expected_version:'1'});
    assert.deepEqual(app.details().customer_billing_address,corrected);
    const external={...address,line1:'3 Saved Elsewhere'};app.remote.customer.billing_address=external;app.remote.customer.version='4';
    assert.equal((await app.post({...address,line1:'4 Checkout Street'})).status,200);assert.equal(app.remote.customerUpdates.length,2);assert.deepEqual(app.remote.customer.billing_address,external);
  }finally{app.close();}
});

for(const failure of ['read','write'] as const)test(`customer ${failure} failure keeps order tax incomplete across reload and retries the original keys`,async()=>{
  const app=fixture('subscription');try{
    app.store.db.exec('PRAGMA reverse_unordered_selects=ON');
    await app.signIn();const error=new SdkError('transport','fixture customer unavailable','unknown',true);
    if(failure==='read')app.remote.customerReadError=error;else app.remote.customerError=error;
    assert.equal((await app.post(address)).status,503);assert.equal(app.remote.updates.length,0);assert.equal(app.details().billing_address,undefined);assert.equal(app.details().customer_billing_address,undefined);
    const pending=app.store.get<ActionRecord>("SELECT * FROM actions WHERE kind='tax_location'")!;assert.equal(pending.status,'unknown');
    if(failure==='write')assert.equal(app.store.get<ActionRecord>("SELECT * FROM actions WHERE kind='tax_location_customer'")?.resource,`action:${pending.idempotency_key}`);
    const reloaded=await app.reload();assert.equal(reloaded.status,200);assert.equal((await reloaded.json()).state.order.tax.status,'requires_location');
    await assert.rejects(()=>app.payments.start('chk_fixture',{approved_outstanding_money:app.remote.order.settlement_amounts.outstanding_money,approved_collection_kind:'processor',credential:{kind:'payment_method_token',value:'pm_fixture'}}),{code:'ACTION_RECONCILIATION_REQUIRED'});
    assert.equal((await app.post({...address,line1:'Changed Street'})).status,409);
    app.remote.customerReadError=undefined;app.remote.customerError=undefined;assert.equal((await app.post(address)).status,200);
    assert.equal(app.remote.updates[0]?.key,pending.idempotency_key);assert.ok(app.remote.customerUpdates.every(update=>update.key===`${pending.idempotency_key}-customer`));
    assert.ok(app.remote.customerUpdates.every(update=>JSON.stringify(update.body)===JSON.stringify({address,recipient_name:'Example buyer',is_default_billing:true})));
    assert.equal(app.store.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',pending.action_id)?.status,'succeeded');
  }finally{app.close();}
});

test('a lost successful customer response recovers provenance without another customer write',async()=>{
  const app=fixture('subscription');try{
    await app.signIn();app.remote.customerLoseResponse=true;assert.equal((await app.post(address)).status,503);
    assert.deepEqual(app.remote.customer.billing_address,address);assert.equal(app.details().customer_billing_address,undefined);assert.equal(app.remote.updates.length,0);
    const pending=app.store.get<ActionRecord>("SELECT * FROM actions WHERE kind='tax_location'")!;
    app.remote.customerLoseResponse=false;assert.equal((await app.post(address)).status,200);assert.equal(app.remote.customerUpdates.length,1);
    assert.deepEqual(app.details().customer_billing_address,address);assert.equal(app.remote.updates[0]?.key,pending.idempotency_key);
    assert.equal(app.store.get<ActionRecord>('SELECT * FROM actions WHERE idempotency_key=?',`${pending.idempotency_key}-customer`)?.status,'succeeded');
    assert.equal((await app.post({...address,line1:'2 Corrected Street'})).status,200);assert.equal(app.remote.customerUpdates.length,2);
  }finally{app.close();}
});

test('the saved address version fences a correction that races another edit',async()=>{
  const app=fixture('subscription');try{
    await app.signIn();assert.equal((await app.post(address)).status,200);assert.equal(app.remote.updates.length,1);
    // Someone relabels the saved address between the correction's read and write, which advances its version.
    const corrected={...address,line1:'2 Corrected Street'};
    app.remote.beforeCustomerUpdate=()=>{app.remote.saved[0]!.version='2';};
    const response=await app.post(corrected);assert.equal(response.status,409);assert.equal((await response.json()).error.code,'ORDER_CHANGED_REFRESH_REQUIRED');assert.equal(app.remote.updates.length,1);
    assert.deepEqual(app.remote.customer.billing_address,address);
    assert.equal((await app.post(corrected)).status,200);assert.equal(app.remote.customerUpdates.length,3);assert.deepEqual(app.remote.customerUpdates[2]?.body,{address:corrected,expected_version:'2'});
  }finally{app.close();}
});

test('an unknown saved address write retains its original version after the address changes',async()=>{
  const app=fixture('subscription');try{
    await app.signIn();assert.equal((await app.post(address)).status,200);
    const corrected={...address,line1:'2 Corrected Street'};
    app.remote.customerError=new SdkError('transport','fixture not applied','unknown',true);assert.equal((await app.post(corrected)).status,503);
    app.remote.customerError=undefined;app.remote.saved[0]!.version='2';
    const response=await app.post(corrected);assert.equal(response.status,409);assert.equal((await response.json()).error.code,'ORDER_CHANGED_REFRESH_REQUIRED');
    assert.deepEqual(app.remote.customerUpdates[2],app.remote.customerUpdates[1]);assert.deepEqual(app.remote.customerUpdates[1]?.body,{address:corrected,expected_version:'1'});assert.equal(app.remote.updates.length,1);
    assert.deepEqual(app.details().customer_billing_address,address);
  }finally{app.close();}
});

test('customer provenance survives a later tax rejection so this checkout can correct its address',async()=>{
  const app=fixture('subscription');try{
    await app.signIn();app.remote.error=flintError(400,'INVALID_REQUEST',{code:'INVALID_VALUE',param:'tax.location.address'});
    assert.equal((await app.post(address)).status,400);assert.deepEqual(app.details().customer_billing_address,address);assert.equal(app.details().billing_address,undefined);
    app.remote.error=undefined;const corrected={...address,line1:'2 Corrected Street'};assert.equal((await app.post(corrected)).status,200);
    assert.deepEqual(app.remote.customerUpdates[1]?.body,{address:corrected,expected_version:'1'});assert.deepEqual(app.details().customer_billing_address,corrected);
  }finally{app.close();}
});

test('a lost tax response replays its key after customer persistence without repeating the customer write',async()=>{
  const app=fixture('subscription');try{
    await app.signIn();app.remote.error=new SdkError('transport','fixture lost tax response','unknown',true);assert.equal((await app.post(address)).status,503);
    assert.deepEqual(app.details().customer_billing_address,address);assert.equal(app.details().billing_address,undefined);assert.equal(app.remote.customerUpdates.length,1);
    app.remote.error=undefined;assert.equal((await app.post(address)).status,200);assert.equal(app.remote.customerUpdates.length,1);assert.deepEqual(app.remote.updates[1],app.remote.updates[0]);
  }finally{app.close();}
});

test('the installed SDK serializes a versioned saved address update with its own idempotency key',async()=>{
  let request:Request|undefined;
  const client=new Client({baseUrl:'https://sdk.example.invalid',maxAttempts:1,transport:async(input,init)=>{
    request=new Request(input,init);return new Response(JSON.stringify({error:flintErrorBody(409,'VERSION_CONFLICT',{param:'expected_version'},{retry:'after_refresh'})}),{status:409,headers:{'Content-Type':'application/json'}});
  }});
  await assert.rejects(()=>client.customers.updateAddress('fixture-customer','addr_1',{address,expected_version:'7'},{apiKey:'local-billing-fixture',idempotencyKey:'billing-fixture-key-customer'}),{code:'VERSION_CONFLICT'});
  assert.ok(request);assert.equal(request.method,'PATCH');assert.equal(new URL(request.url).pathname,'/v1/customers/fixture-customer/addresses/addr_1');
  assert.deepEqual(await request.json(),{address,expected_version:7});assert.equal(request.headers.get('Idempotency-Key'),'billing-fixture-key-customer');
});

test('the installed SDK serializes a saved default billing address with its own idempotency key',async()=>{
  let request:Request|undefined;
  const client=new Client({baseUrl:'https://sdk.example.invalid',maxAttempts:1,transport:async(input,init)=>{
    request=new Request(input,init);return new Response(JSON.stringify({error:flintErrorBody(409,'RESOURCE_IN_USE')}),{status:409,headers:{'Content-Type':'application/json'}});
  }});
  await assert.rejects(()=>client.customers.createAddress('fixture-customer',{address,recipient_name:'Example buyer',is_default_billing:true},{apiKey:'local-billing-fixture',idempotencyKey:'billing-fixture-key-customer'}),{code:'RESOURCE_IN_USE'});
  assert.ok(request);assert.equal(request.method,'POST');assert.equal(new URL(request.url).pathname,'/v1/customers/fixture-customer/addresses');
  assert.deepEqual(await request.json(),{address,recipient_name:'Example buyer',is_default_billing:true});assert.equal(request.headers.get('Idempotency-Key'),'billing-fixture-key-customer');
});

test('the installed SDK serializes the existing sparse tax update and checkout idempotency headers',async()=>{
  let request:Request|undefined;
  const client=new Client({baseUrl:'https://sdk.example.invalid',maxAttempts:1,transport:async(input,init)=>{
    request=new Request(input,init);
    return new Response(JSON.stringify({error:flintErrorBody(400,'INVALID_REQUEST',{code:'INVALID_VALUE',param:'tax.location.address'})}),{status:400,headers:{'Content-Type':'application/json'}});
  }});
  await assert.rejects(()=>client.orders.update('fixture-order',{tax:{enabled:true,location:{address_source:'provided',address_type:'billing_address',address}}},{checkoutToken:'local-fixture',idempotencyKey:'billing-fixture-key'}),{code:'INVALID_REQUEST'});
  assert.ok(request);assert.equal(request.method,'PATCH');assert.equal(new URL(request.url).pathname,'/v1/orders/fixture-order');
  assert.deepEqual(await request.json(),taxRequest);assert.equal(request.headers.get('Idempotency-Key'),'billing-fixture-key');assert.equal(request.headers.get('Authorization'),'Bearer local-fixture');
});
