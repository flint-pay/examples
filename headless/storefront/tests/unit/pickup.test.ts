import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SdkError} from '@flintpay/node';
import type {Client,Order,CheckoutSession} from '@flintpay/node';
import {createApp} from '../../src/app.ts';
import type {Config} from '../../src/config.ts';
import {Store} from '../../src/store/db.ts';
import {IdentityStore} from '../../src/identity/index.ts';

const origin='http://localhost:4100';
const money={amount:'0',currency:'USD'};
const address={line1:'400 Congress Ave',city:'Austin',state:'TX',postal_code:'78701',country:'US'};
const location=(id:string,name:string)=>({location_id:id,name,address});
const method={delivery_method_id:'dm_pickup',delivery_method_revision_id:'dmr_pickup'};
// The real pickup_locations preview: nearest first, with one location that cannot fill the cart and one without a compatible method.
const preview={mode:'pickup_locations',audience:'buyer',evaluation_status:'complete',evaluated_at:'2026-10-09T12:00:00Z',input_requirements:[],locations:[
  {location:location('loc_near','Congress roastery'),distance_meters:804.672,compatible_methods:[method],candidate_outcome:{type:'available'},applicable_quantities:[]},
  {location:location('loc_out','Sold out roastery'),distance_meters:1000,compatible_methods:[method],candidate_outcome:{type:'unavailable',unavailable_reason:'inventory_insufficient'},applicable_quantities:[]},
  {location:location('loc_none','No method roastery'),distance_meters:2000,compatible_methods:[],candidate_outcome:{type:'available'},applicable_quantities:[]},
]};
const option=(locationId:string,name:string)=>({delivery_option_id:`opt_${locationId}`,delivery_method_id:'dm_pickup',name,type:'pickup',amount_money:money,pickup:{pickup_mode:'in_store',location:location(locationId,name)}});

function fixture(){
  const remote={previews:[] as {input:Record<string,unknown>;options:Record<string,unknown>|undefined}[],quotes:[] as {input:Record<string,unknown>;key?:string}[],selections:[] as {input:Record<string,any>;key?:string}[],selection:undefined as unknown,selectionError:undefined as SdkError|undefined,lostResponse:undefined as SdkError|undefined,byKey:new Map<string,unknown>()};
  const order={order_id:'fixture-order',status:'open',payment_status:'unpaid',order_revision:'1',settlement_amounts:{outstanding_money:{amount:'2400',currency:'USD'}},payment_collection:{stripe:{}}} as unknown as Order;
  const session={checkout_session_id:'fixture-session',status:'open',customer_collection:{require_email:true}} as unknown as CheckoutSession;
  const client={
    orders:{get:async()=>order},
    deliveryPreviews:{create:async(input:Record<string,unknown>,options?:Record<string,unknown>)=>{remote.previews.push({input,options});return preview;}},
    checkoutSessions:{
      get:async()=>session,getCurrentDeliverySelection:async()=>({delivery_selection:remote.selection}),
      createDeliveryQuote:async(_id:string,input:Record<string,unknown>,options:{idempotencyKey?:string})=>{
        remote.quotes.push({input,key:options.idempotencyKey});
        return {delivery_quote_id:`quote_${remote.quotes.length}`,status:'open',...(input.destination_address?{destination_address:input.destination_address}:{}),expires_at:new Date(Date.now()+60_000).toISOString(),input_requirements:[],choice_groups:[{delivery_choice_group_id:'grp_pickup',availability_status:'ready',method_types:['pickup'],input_requirements:[],options:[option('loc_near','Congress roastery')]}]};
      },
      createDeliverySelection:async(_id:string,input:Record<string,any>,options:{idempotencyKey?:string})=>{
        remote.selections.push({input,key:options.idempotencyKey});
        if(remote.selectionError)throw remote.selectionError;
        if(options.idempotencyKey&&remote.byKey.has(options.idempotencyKey)){return {delivery_selection:remote.byKey.get(options.idempotencyKey)};}
        remote.selection={delivery_selection_id:'selection_1',status:'selected',amount_money:money,input_requirements:[],choices:[{delivery_choice_group_id:'grp_pickup',delivery_option_id:input.choices[0].delivery_option_id,name:'Congress roastery',type:'pickup',amount_money:money,pickup:{location:location('loc_near','Congress roastery')}}]};
        if(options.idempotencyKey)remote.byKey.set(options.idempotencyKey,remote.selection);
        // A lost response happens after the selection exists remotely.
        if(remote.lostResponse){const lost=remote.lostResponse;remote.lostResponse=undefined;throw lost;}
        return {delivery_selection:remote.selection};
      },
    },
  } as unknown as Client;
  const config:Config={apiKey:'local-pickup-fixture',apiBaseUrl:'https://api.staging.withflintpay.com',giftChallengeOrigin:'https://checkout.staging.withflintpay.com',appOrigin:origin,port:4100,identityDatabasePath:':memory:',appDatabasePath:':memory:',cookieName:'pickup_session',checkoutTtl:3600,storeName:'Example store'};
  const runtime=createApp({config,client,preflight:{sandboxId:'fixture-sandbox',cards:'enabled'},store:new Store(':memory:'),identity:new IdentityStore(':memory:')});
  const owner=runtime.identity.createSession();const now=Date.now();
  runtime.store.run('INSERT INTO checkouts(checkout_ref,session_hash,kind,order_id,checkout_session_id,checkout_auth_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)','chk_fixture',owner.session.session_hash,'order',order.order_id,session.checkout_session_id,'local-checkout-fixture',now,now);
  const post=(path:string,input:unknown,csrf=owner.session.csrf_token)=>runtime.app.request(origin+'/checkout/chk_fixture'+path,{method:'POST',headers:{Cookie:`pickup_session=${owner.token}`,Origin:origin,'X-CSRF-Token':csrf,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(input)});
  const search=()=>post('/pickup-locations',{postal_code:'78701',country:'US'});
  const state=()=>runtime.app.request(origin+'/checkout/chk_fixture/state',{headers:{Cookie:`pickup_session=${owner.token}`,Accept:'application/json'}});
  const choose=(pickup_location_id:string)=>post('/delivery/select',{pickup_location_id,recipient:{name:'Example buyer'}});
  return {...runtime,remote,post,search,choose,state,close:()=>{runtime.store.close();runtime.identity.close();}};
}

test('pickup search uses the checkout-authorized preview and projects only selectable locations',async()=>{
  const app=fixture();try{
    const response=await app.search();assert.equal(response.status,200);
    assert.deepEqual(app.remote.previews,[{input:{body:{mode:'pickup_locations',checkout_session_id:'fixture-session',buyer_location:{type:'address',address:{postal_code:'78701',country:'US'}},expected_delivery_selection_id:null}},options:{authMode:'checkout',credentials:{CheckoutSessionIDHeader:'fixture-session',CheckoutSessionSecretHeader:'local-checkout-fixture'},idempotencyKey:undefined,maxAttempts:1}}]);
    assert.equal(app.remote.quotes.length,0);
    const {state}=await response.json();
    assert.deepEqual(state.pickup_search,{postal_code:'78701'});
    assert.equal(state.pickup_locations.length,1);
    const [shown]=state.pickup_locations;assert.equal(shown.name,'Congress roastery');assert.equal(shown.pickup.location.location_id,'loc_near');assert.equal(shown.pickup.location.address.line1,'400 Congress Ave');assert.equal(shown.distance_meters,804.672);assert.equal(shown.amount_money,null);
    assert.equal(state.delivery_quote??null,null);assert.equal(JSON.stringify(state).includes('merchant_diagnostics'),false);
  }finally{app.close();}
});

test('choosing a searched location quotes it by id with the current selection authority, then selects its option',async()=>{
  const app=fixture();try{
    assert.equal((await app.search()).status,200);
    const response=await app.choose('loc_near');assert.equal(response.status,200);
    assert.deepEqual(app.remote.quotes.map(quote=>quote.input),[{expected_delivery_selection_id:null,pickup_location_id:'loc_near'}]);
    assert.equal(app.remote.selections.length,1);
    assert.deepEqual(app.remote.selections[0]!.input,{choices:[{delivery_choice_group_id:'grp_pickup',delivery_option_id:'opt_loc_near'}],recipient:{name:'Example buyer'},delivery_quote_id:'quote_1',expected_delivery_selection_id:null});
    const {state}=await response.json();assert.equal(state.delivery_selection.delivery_selection_id,'selection_1');assert.equal(state.delivery_selection.choices[0].pickup.location.name,'Congress roastery');
    assert.equal(app.store.all("SELECT * FROM actions WHERE status IN ('pending','unknown')").length,0);
  }finally{app.close();}
});

test('a location outside the stored preview is rejected before any quote or selection',async()=>{
  const app=fixture();try{
    assert.equal((await app.choose('loc_near')).status,400);
    assert.equal((await app.search()).status,200);
    for(const forged of ['loc_forged','loc_out','loc_none']){
      const response=await app.choose(forged);assert.equal(response.status,400);assert.equal((await response.json()).error.code,'INVALID_DELIVERY_SELECTION');
    }
    assert.equal((await app.post('/delivery/select',{pickup_location_id:'loc_near',recipient:{name:'Example buyer'}},'wrong')).status,403);
    assert.deepEqual([app.remote.quotes.length,app.remote.selections.length],[0,0]);
  }finally{app.close();}
});

test('retrying an unknown selection outcome replays the selection without a second quote',async()=>{
  const app=fixture();try{
    assert.equal((await app.search()).status,200);
    app.remote.selectionError=new SdkError('transport','fixture lost response','unknown',true);
    assert.equal((await app.choose('loc_near')).status,503);
    assert.equal((await app.search()).status,409);
    app.remote.selectionError=undefined;
    assert.equal((await app.choose('loc_near')).status,200);
    assert.equal(app.remote.quotes.length,1);assert.equal(app.remote.selections.length,2);
    assert.ok(app.remote.selections[0]!.key);assert.equal(app.remote.selections[1]!.key,app.remote.selections[0]!.key);
    assert.deepEqual(app.remote.selections[1]!.input,app.remote.selections[0]!.input);
  }finally{app.close();}
});

test('retrying after the selection exists remotely but the response was lost replays the journaled request',async()=>{
  const app=fixture();try{
    assert.equal((await app.search()).status,200);
    app.remote.lostResponse=new SdkError('transport','fixture lost response','unknown',true);
    assert.equal((await app.choose('loc_near')).status,503);
    assert.equal(app.remote.selection&&(app.remote.selection as {delivery_selection_id:string}).delivery_selection_id,'selection_1');
    // Reading the checkout now observes the real selection, which no longer matches the quote's basis.
    const observed=(await (await app.state()).json()).state;assert.equal(observed.delivery_selection.delivery_selection_id,'selection_1');
    const retry=await app.choose('loc_near');assert.equal(retry.status,200);
    assert.equal(app.remote.quotes.length,1);assert.equal(app.remote.selections.length,2);
    assert.equal(app.remote.selections[1]!.key,app.remote.selections[0]!.key);assert.deepEqual(app.remote.selections[1]!.input,app.remote.selections[0]!.input);
    assert.equal(app.remote.selections[1]!.input.expected_delivery_selection_id,null);assert.equal(app.remote.selections[1]!.input.delivery_quote_id,'quote_1');
    assert.equal(app.store.all("SELECT * FROM actions WHERE status IN ('pending','unknown')").length,0);
  }finally{app.close();}
});

test('an unknown selection replays its journaled quote after the quote expires locally',async()=>{
  const app=fixture();try{
    assert.equal((await app.search()).status,200);
    app.remote.lostResponse=new SdkError('transport','fixture lost response','unknown',true);
    assert.equal((await app.choose('loc_near')).status,503);
    const row=app.store.get<{details:string}>("SELECT details FROM checkouts WHERE checkout_ref='chk_fixture'")!;const details=JSON.parse(row.details);details.delivery_quote.expires_at=new Date(Date.now()-60_000).toISOString();
    app.store.run("UPDATE checkouts SET details=? WHERE checkout_ref='chk_fixture'",JSON.stringify(details));
    assert.equal((await app.state()).status,200);
    assert.equal((await app.choose('loc_near')).status,200);
    // The replay never quotes; the one later quote is the read's routine requote of the now-expired quote, made against the observed selection.
    assert.equal(app.remote.selections.length,2);assert.equal(app.remote.selections[1]!.key,app.remote.selections[0]!.key);assert.deepEqual(app.remote.selections[1]!.input,app.remote.selections[0]!.input);
    assert.equal(app.remote.selections[1]!.input.delivery_quote_id,'quote_1');
    assert.deepEqual(app.remote.quotes.slice(1).map(quote=>quote.input.expected_delivery_selection_id),['selection_1']);
  }finally{app.close();}
});

test('an unknown selection is not replayed for a different location or recipient',async()=>{
  const app=fixture();try{
    assert.equal((await app.search()).status,200);
    app.remote.lostResponse=new SdkError('transport','fixture lost response','unknown',true);
    assert.equal((await app.choose('loc_near')).status,503);
    const other=await app.post('/delivery/select',{pickup_location_id:'loc_near',recipient:{name:'Someone else'}});assert.equal(other.status,409);assert.equal((await other.json()).error.code,'ACTION_RECONCILIATION_REQUIRED');
    assert.equal(app.remote.selections.length,1);assert.equal(app.remote.quotes.length,1);
  }finally{app.close();}
});

test('shipping quotes still send only the destination address',async()=>{
  const app=fixture();try{
    assert.equal((await app.search()).status,200);
    assert.equal((await app.post('/delivery/quote',{destination_address:{line1:'1 Example Street',city:'Austin',state:'TX',postal_code:'78701',country:'US'}})).status,200);
    assert.deepEqual(app.remote.quotes.map(quote=>Object.keys(quote.input).sort()),[['destination_address','expected_delivery_selection_id']]);
  }finally{app.close();}
});

test('a pickup search supersedes an earlier shipping quote unless a selection is active',async()=>{
  const app=fixture();try{
    const address={destination_address:{line1:'1 Example Street',city:'Austin',state:'TX',postal_code:'78701',country:'US'}};
    assert.equal((await app.post('/delivery/quote',address)).status,200);
    const quoted=(await (await app.state()).json()).state;assert.ok(quoted.delivery_quote.destination_address.line1);
    const found=(await (await app.search()).json()).state;assert.equal(found.delivery_quote??null,null);assert.equal(found.pickup_locations.length,1);
    const row=app.store.get<{details:string}>("SELECT details FROM checkouts WHERE checkout_ref='chk_fixture'")!;const details=JSON.parse(row.details);assert.equal(details.quote_input,undefined);assert.equal(details.quote_basis,undefined);
    // The read must not requote the superseded shipping address.
    assert.equal(app.remote.quotes.length,1);
    assert.equal((await app.choose('loc_near')).status,200);
    // With a selection active, a later search leaves the selection and its quote alone.
    assert.equal((await app.search()).status,200);
    const kept=JSON.parse(app.store.get<{details:string}>("SELECT details FROM checkouts WHERE checkout_ref='chk_fixture'")!.details);assert.equal(kept.delivery_selection.delivery_selection_id,'selection_1');assert.ok(kept.delivery_quote);
  }finally{app.close();}
});
