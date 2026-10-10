import type {Client,CreateProductRequestInput,CreateDeliveryMethodRequestInput,CreatePromotionRequestInput,Product,Location,DeliveryMethod,DeliveryLocationSet,SubscriptionPlan,Promotion,PromotionCode} from '@flintpay/node';
import {SdkError} from '@flintpay/node';
import {mkdirSync,writeFileSync,chmodSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {readConfig} from '../src/config.ts';
import {createClient} from '../src/flint/client.ts';
import {createAuth} from '../src/flint/auth.ts';
import type {Auth} from '../src/flint/auth.ts';
import {preflight} from '../src/flint/preflight.ts';
import {Store} from '../src/store/db.ts';
import {unknownOutcome} from '../src/flint/errors.ts';

export const catalogProducts=[
  {slug:'house-blend',name:'House blend coffee, 12 oz',product_type:'physical',amount:'1800'},
  {slug:'stoneware-mug',name:'Stoneware mug',product_type:'physical',amount:'2400'},
  {slug:'travel-mug',name:'Insulated travel mug',product_type:'physical',amount:'3800'},
  {slug:'pour-over-kit',name:'Pour-over brewing kit',product_type:'physical',amount:'6800'},
  {slug:'burr-grinder',name:'Burr grinder',product_type:'physical',amount:'14500'},
  {slug:'brewing-class',name:'Online brewing class',product_type:'service',amount:'3500'}
] as const;
export const catalogPlans=[
  {slug:'coffee-club-monthly',name:'Coffee club, monthly',trial:undefined},
  {slug:'coffee-club-trial',name:'Coffee club with a 14-day free trial',trial:14}
] as const;
const catalog='cedar-and-stone';
const metadata=(slug:string)=>({example_catalog:catalog,example_slug:slug});
export function productInput(item:typeof catalogProducts[number]):CreateProductRequestInput{
  const common={name:item.name,product_type:item.product_type,status:'active' as const,external_reference_id:`examples-${item.slug}`,metadata:metadata(item.slug)};
  const price={amount:item.amount,currency:'USD'};
  if(item.slug!=='house-blend')return {...common,default_variant:{unit_price_money:price,status:'active'}};
  return {...common,options:[{name:'Grind',client_option_key:'grind',values:[{value:'Whole bean',client_value_key:'whole-bean'},{value:'Ground',client_value_key:'ground'}]}],variants:[
    {name:'Whole bean',unit_price_money:price,status:'active',selected_option_values:[{client_option_key:'grind',client_value_key:'whole-bean'}]},
    {name:'Ground',unit_price_money:price,status:'active',selected_option_values:[{client_option_key:'grind',client_value_key:'ground'}]}
  ]};
}
export function deliveryInputs(locationId:string,setId:string):CreateDeliveryMethodRequestInput[]{
  return [
    {name:'Standard shipping',type:'shipment',status:'active',metadata:metadata('standard-shipping'),configuration:{origin:{type:'fixed_location',location_id:locationId},eligibility:{country:{values:['US']}},pricing:{type:'fixed',fixed:{currency_options:{USD:{amount:'900',currency:'USD'}}}},estimate:{type:'transit_time',transit_time:{handling_days:{minimum:1,maximum:1},transit_days:{minimum:2,maximum:5}}},public_details:{service_level:'standard'}}},
    {name:'Pickup at the roastery',type:'pickup',status:'active',metadata:metadata('roastery-pickup'),configuration:{origin:{type:'pickup_location_collection',delivery_location_set_id:setId},pricing:{type:'fixed',fixed:{currency_options:{USD:{amount:'0',currency:'USD'}}}},public_details:{pickup_mode:'in_store'}}}
  ];
}
export function welcomePromotionInput():CreatePromotionRequestInput{
  return {name:'Welcome discount',display_name:'Welcome discount',discount_class:'order',redemption_type:'code',application_method:{type:'percent_off',percent_off:10},codes:[{code:'WELCOME10',metadata:metadata('welcome10')}],metadata:metadata('welcome10')};
}
export function validateWelcomeCodes(codes:readonly Pick<PromotionCode,'promotion_id'|'status'>[],promotionId?:string):void{
  if(codes.some(code=>code.promotion_id!==promotionId))throw new Error('WELCOME10 belongs to another promotion. Choose a dedicated sandbox for this sample.');
  if(codes.some(code=>code.promotion_id===promotionId&&code.status!=='active'))throw new Error('WELCOME10 exists but is not active. Activate the example promotion code before setup.');
}
export function deterministicKey(sandboxId:string,resource:string):string{return `examples-headless-storefront-${sandboxId}-${resource}-v1`;}
export function owned<T extends {metadata?:Record<string,string>}>(rows:T[],slug:string):T|undefined{
  const matches=rows.filter(row=>row.metadata?.example_catalog===catalog&&row.metadata.example_slug===slug);
  if(matches.length>1)throw new Error(`More than one example resource uses ${slug}. Resolve the duplicate before setup.`);
  return matches[0];
}
async function collect<T>(rows:AsyncIterable<T>):Promise<T[]>{const result:T[]=[];for await(const row of rows)result.push(row);return result;}
type Snapshot={locations:Location[];sets:DeliveryLocationSet[];methods:DeliveryMethod[];products:Product[];plans:SubscriptionPlan[];promotions:Promotion[]};
async function inventory(client:Client,auth:Auth):Promise<Snapshot>{
  const [locations,sets,methods,products,plans,promotions]=await Promise.all([
    collect(client.locations.listItems({page_size:100},auth.merchant())),collect(client.deliveryLocationSets.listItems({page_size:100},auth.merchant())),
    collect(client.deliveryMethods.listItems({page_size:100},auth.merchant())),collect(client.products.listItems({page_size:100},auth.merchant())),
    collect(client.subscriptionPlans.listItems({page_size:100},auth.merchant())),collect(client.promotions.listItems({page_size:100},auth.merchant()))
  ]);
  return {locations,sets,methods,products,plans,promotions};
}
type Probe={name:string;idempotency_key:string;resource_id:string|null};
async function probe<T>(store:Store,name:string,create:(key:string)=>Promise<T>,id:(response:T)=>string,cleanup:(id:string,key:string)=>Promise<unknown>,unavailable:string[]):Promise<boolean>{
  let job=store.get<Probe>('SELECT * FROM setup_probes WHERE name=?',name);
  if(!job){store.run('INSERT INTO setup_probes VALUES(?,?,NULL)',name,`examples-probe-${randomUUID()}`);job=store.get<Probe>('SELECT * FROM setup_probes WHERE name=?',name)!;}
  try{
    let resourceId=job.resource_id;
    if(!resourceId){resourceId=id(await create(job.idempotency_key));store.run('UPDATE setup_probes SET resource_id=? WHERE name=?',resourceId,name);job.resource_id=resourceId;}
    await cleanup(resourceId,`${job.idempotency_key}-cleanup`);store.run('DELETE FROM setup_probes WHERE name=?',name);return true;
  }catch(error){
    if(error instanceof SdkError&&unavailable.includes(error.code??'')&&!job.resource_id){store.run('DELETE FROM setup_probes WHERE name=?',name);return false;}
    if(!unknownOutcome(error)&&!job.resource_id)store.run('DELETE FROM setup_probes WHERE name=?',name);
    throw error;
  }
}
export function affirmReady(capabilities:readonly {capability:string;status:string}[]):boolean{return capabilities.some(capability=>capability.capability==='accept_affirm_payments'&&capability.status==='ready');}
export async function setup(args:string[]=process.argv.slice(2)){
  if(args.some(arg=>!['--apply','--check'].includes(arg)))throw new Error('Use --apply to create the sample store or --check to run readiness probes.');
  const apply=args.includes('--apply');const check=args.includes('--check');const config=readConfig();
  if(!config.sandboxGuard)throw new Error('Set FLINT_SANDBOX_ID before running setup.');
  const client=createClient(config.apiBaseUrl,config.sandboxGuard);const auth=createAuth(config.apiKey);const ready=await preflight(client,auth,config);
  const store=new Store(resolve(dirname(config.appDatabasePath),'setup.sqlite'));
  store.db.exec('CREATE TABLE IF NOT EXISTS setup_probes(name TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL,resource_id TEXT); CREATE TABLE IF NOT EXISTS setup_readiness(sandbox_id TEXT PRIMARY KEY,ach INTEGER NOT NULL,affirm INTEGER NOT NULL,tax INTEGER NOT NULL,checked_at INTEGER NOT NULL)');
  try{await store.locked(`setup:${ready.sandboxId}`,async()=>{
    const existing=await inventory(client,auth);const settings=await client.settings.get(undefined,auth.merchant());
    const existingPromotion=owned(existing.promotions,'welcome10');
    validateWelcomeCodes(await collect(client.promotions.listCodesItems({code:'WELCOME10',page_size:100},auth.merchant())),existingPromotion?.promotion_id);
    const affirm=affirmReady((await client.capabilities.list({capability:'accept_affirm_payments'},auth.merchant())).data);
    let ach=false;let tax=false;
    const last=store.get<{ach:number;affirm:number;tax:number;checked_at:number}>('SELECT * FROM setup_readiness WHERE sandbox_id=?',ready.sandboxId);
    if(last&&last.checked_at>Date.now()-24*60*60_000){ach=!!last.ach;tax=!!last.tax;}
    if(check){
      console.info('Readiness probes create a $2.00 ACH payment intent and a service order, then cancel or close them.');
      ach=await probe(store,'ach',key=>client.paymentIntents.create({amount_money:{amount:'200',currency:'USD'},payment_options:['ach_debit'],transaction_purpose:'goods',metadata:{example_probe:'true'}},auth.merchant(key)),response=>response.payment_intent.payment_intent_id,(id,key)=>client.paymentIntents.cancel(id,{cancellation_reason:'abandoned'},auth.merchant(key)),['PAYMENT_OPTION_UNAVAILABLE']);
      tax=await probe(store,'tax',key=>client.orders.create({line_items:[{name:'Automatic tax readiness probe',tax:{line_item_tax_category:'services'},fulfillment:{requirement:'none'},unit_price_money:{amount:'200',currency:'USD'},quantity:'1'}],tax:{enabled:true},metadata:{example_probe:'true'}},auth.merchant(key)),response=>response.order_id,(id,key)=>client.orders.closeSession(id,{},auth.merchant(key)),['AUTOMATIC_TAX_CONNECTION_REQUIRED']);
      store.run('INSERT OR REPLACE INTO setup_readiness VALUES(?,?,?,?,?)',ready.sandboxId,Number(ach),Number(affirm),Number(tax),Date.now());
    }
    const key=(resource:string)=>deterministicKey(ready.sandboxId,resource);
    async function resource<T>(slug:string,current:T|undefined,input:unknown,create:()=>Promise<T>):Promise<T|undefined>{
      if(current){console.info(`Keep ${slug}: already tagged as ${catalog}.`);return current;}
      console.info(`${apply?'Create':'Would create'} ${slug}: ${JSON.stringify(input)}`);return apply?create():undefined;
    }
    const locationInput={name:'Cedar & Stone Roastery',address:{line1:'400 Congress Ave',city:'Austin',state:'TX',postal_code:'78701',country:'US'},timezone:'America/Chicago',status:'active' as const,metadata:metadata('roastery')};
    const location=await resource('roastery',owned(existing.locations,'roastery'),locationInput,()=>client.locations.create(locationInput,auth.merchant(key('roastery'))));
    const setInput={name:'Roastery pickup locations',configuration:{location_ids:[location?.location_id??'<roastery location>']},metadata:metadata('roastery-locations')};
    const set=await resource('roastery-locations',owned(existing.sets,'roastery-locations'),setInput,()=>client.deliveryLocationSets.create(setInput,auth.merchant(key('roastery-locations'))));
    const methodInputs=deliveryInputs(location?.location_id??'<roastery location>',set?.delivery_location_set_id??'<pickup location set>');const methodIds:string[]=[];
    for(const input of methodInputs){const slug=input.metadata!.example_slug!;const method=await resource(slug,owned(existing.methods,slug),input,()=>client.deliveryMethods.create(input,auth.merchant(key(slug))));if(method){if(method.status!=='active')throw new Error(`${slug} must be active before it becomes a checkout default.`);methodIds.push(method.delivery_method_id);}}
    for(const item of catalogProducts){const input=productInput(item);const product=await resource(item.slug,owned(existing.products,item.slug),input,()=>client.products.create(input,auth.merchant(key(item.slug))));if(product&&product.status!=='active')throw new Error(`${item.slug} exists but is not active. Activate it before setup.`);}
    for(const item of catalogPlans){const input={name:item.name,billing_interval:'monthly' as const,billing_interval_count:1,currency:'USD',line_items:[{name:'Monthly coffee club',unit_price_money:{amount:'2200',currency:'USD'},quantity:1}],...(item.trial?{trial_period_days:item.trial}:{}),metadata:metadata(item.slug)};const plan=await resource(item.slug,owned(existing.plans,item.slug),input,()=>client.subscriptionPlans.create(input,auth.merchant(key(item.slug))));if(plan&&plan.status!=='active')throw new Error(`${item.slug} exists but is not active. Activate it before setup.`);}
    const promotionInput=welcomePromotionInput();
    const promotion=await resource('welcome10',existingPromotion,promotionInput,()=>client.promotions.create(promotionInput,auth.merchant(key('welcome10'))));
    const codes=await collect(client.promotions.listCodesItems({code:'WELCOME10',page_size:100},auth.merchant()));
    validateWelcomeCodes(codes,promotion?.promotion_id);
    if(!codes.some(code=>code.promotion_id===promotion?.promotion_id)){
      console.info(`${apply?'Create':'Would create'} promotion code WELCOME10.`);
      if(apply&&promotion)await client.promotions.createCode(promotion.promotion_id,{code:'WELCOME10',metadata:metadata('welcome10')},auth.merchant(key('welcome10-code')));
    }
    const checkedAffirm=affirm&&(check||!!last?.affirm&&last.checked_at>Date.now()-24*60*60_000);
    const enabled=[...new Set([...(settings.checkout?.enabled_payment_options??[]).filter(option=>!['ach_debit','affirm'].includes(option)),'card','apple_pay','google_pay',...(ach?['ach_debit']:[]),...(checkedAffirm?['affirm']:[])])];
    const checkout={default_delivery_method_ids:apply?methodIds:['<standard shipping>','<roastery pickup>'],enabled_payment_options:enabled};
    console.info(`Previous checkout settings: ${JSON.stringify({default_delivery_method_ids:settings.checkout?.default_delivery_method_ids??[],enabled_payment_options:settings.checkout?.enabled_payment_options??[]})}`);
    console.info(`${apply?'Set':'Would set'} checkout defaults: ${JSON.stringify(checkout)}`);
    if(apply){
      const snapshotPath=resolve(dirname(config.appDatabasePath),`setup-checkout-${ready.sandboxId}.json`);mkdirSync(dirname(snapshotPath),{recursive:true,mode:0o700});
      if(!existsSync(snapshotPath)){writeFileSync(snapshotPath,JSON.stringify({sandbox_id:ready.sandboxId,checkout:settings.checkout,version:settings.version},null,2),{mode:0o600});chmodSync(snapshotPath,0o600);}
      const settingsInput={checkout,expected_version:settings.version};const settingsHash=createHash('sha256').update(JSON.stringify(settingsInput)).digest('hex').slice(0,24);
      await client.settings.update(settingsInput,auth.merchant(key(`settings-${settingsHash}`)));
      console.info(`Previous checkout settings saved to ${snapshotPath}.`);
    }
    const domains=await collect(client.paymentMethodDomains.listItems({page_size:100},auth.merchant()));
    console.table({cards:{ready:ready.cards},Affirm:{ready:affirm?'enabled':'unavailable'},ACH:{ready:ach?'probe passed':check?'unavailable':'run --check'},automatic_tax:{ready:tax?'probe passed':check?'connection required':'run --check'},delivery_methods:{ready:methodIds.length===2?'configured':apply?'created':'run --apply'},catalog:{ready:existing.products.filter(row=>row.metadata?.example_catalog===catalog).length===catalogProducts.length?'configured':apply?'created':'run --apply'},payment_method_domain:{ready:domains.some(domain=>domain.domain_name===new URL(config.appOrigin).hostname)?'registered':'register an HTTPS domain for wallets'}});
    if(!apply)console.info('Dry run complete. Use npm run setup -- --apply to create resources and update sandbox checkout settings.');
  });}finally{store.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{await setup();}catch(error){console.error(error instanceof SdkError?`Setup failed: ${error.code??error.kind}${error.meta?.requestId?` (request ${error.meta.requestId})`:''}`:error instanceof Error?error.message:'Setup failed');process.exitCode=1;}
}
