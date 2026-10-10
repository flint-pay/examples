import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import ts from 'typescript';
import {makeCreatePromotionRequest} from '@flintpay/node';
import {readConfig} from '../../src/config.ts';
import {affirmReady,catalogProducts,deterministicKey,deliveryInputs,owned,productInput,validateWelcomeCodes,welcomePromotionInput} from '../../scripts/setup.ts';
function files(root:string):string[]{return readdirSync(root,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(root,entry.name)):entry.name.endsWith('.ts')?[join(root,entry.name)]:[]);}
const sourceRoot=resolve('src');
const merchantAllowed=new Set(['capabilities.listWithResponse','products.listItems','products.listVariantsItems','subscriptionPlans.listItems','customers.list','customers.get','customers.create','customers.update','customerVerifications.create','customerVerifications.confirm','customers.linkGuestPurchases','customerSessions.revoke','checkoutSessions.create','checkoutSessions.get','checkoutSessions.closeSession','orders.create','orders.get','orders.update','orders.deleteLineItem','orders.updateLineItem','orders.addLineItems','orders.getPaymentAttempt','orders.sendReceipt','subscriptions.get']);
function walk(node:ts.Node,visit:(node:ts.Node)=>void){visit(node);ts.forEachChild(node,child=>walk(child,visit));}
function hasMerchant(node:ts.Node):boolean{let result=false;walk(node,child=>{if(ts.isCallExpression(child)&&child.expression.getText().endsWith('auth.merchant'))result=true;});return result;}
test('only the auth module constructs Flint request credentials',()=>{
  const forbidden:string[]=[];
  for(const file of files(sourceRoot)){if(relative(sourceRoot,file)==='flint/auth.ts')continue;const source=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);walk(source,node=>{if(ts.isPropertyAssignment(node)&&['apiKey','customerToken','CheckoutSessionIDHeader','CheckoutSessionSecretHeader','X-Checkout-Session-ID','X-Checkout-Session-Secret'].includes(node.name.getText(source).replace(/^['"]|['"]$/g,'')))forbidden.push(`${relative(sourceRoot,file)}:${node.name.getText(source)}`);});}
  assert.deepEqual(forbidden,[]);
});
test('merchant-auth operations stay on the explicit server allowlist',()=>{
  const forbidden:string[]=[];
  for(const file of files(sourceRoot)){const source=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);walk(source,node=>{if(!ts.isCallExpression(node)||!node.arguments.some(hasMerchant))return;const expression=node.expression.getText(source);const match=expression.match(/(?:this\.)?client\.(\w+)\.(\w+)$/);if(match&&!merchantAllowed.has(`${match[1]}.${match[2]}`))forbidden.push(`${relative(sourceRoot,file)}:${match[1]}.${match[2]}`);});}
  assert.deepEqual(forbidden,[]);
});
test('configuration refuses live credentials and untrusted origins',()=>{
  const env={FLINT_API_KEY:['flint','test','unit'].join('_'),FLINT_API_BASE_URL:'https://api.staging.withflintpay.com',APP_ORIGIN:'http://localhost:4100',PORT:'4100'};
  assert.equal(readConfig(env).port,4100);assert.throws(()=>readConfig({...env,FLINT_API_KEY:['flint','live','unit'].join('_')}));assert.throws(()=>readConfig({...env,APP_ORIGIN:'http://outside.example'}));assert.throws(()=>readConfig({...env,FLINT_API_BASE_URL:'https://outside.example'}));assert.throws(()=>readConfig({...env,APP_ORIGIN:'https://user:password@store.example.test'}));
});
test('setup keys and catalog metadata are stable while variant inventory remains untracked',()=>{
  assert.equal(deterministicKey('sandbox-A','house-blend'),'examples-headless-storefront-sandbox-A-house-blend-v1');assert.equal(catalogProducts.length,6);
  const blend=productInput(catalogProducts[0]);assert.equal(blend.options?.[0]?.values?.length,2);assert.equal(blend.variants?.length,2);assert.equal(blend.metadata?.example_catalog,'cedar-and-stone');assert.equal(JSON.stringify(blend).includes('inventory_item'),false);
  const [shipping,pickup]=deliveryInputs('location','set');assert.equal(shipping?.type,'shipment');assert.equal(pickup?.configuration.public_details?.pickup_mode,'in_store');
  assert.equal(owned([{metadata:{example_catalog:'other',example_slug:'house-blend'}}],'house-blend'),undefined);assert.throws(()=>owned([{metadata:{example_catalog:'cedar-and-stone',example_slug:'duplicate'}},{metadata:{example_catalog:'cedar-and-stone',example_slug:'duplicate'}}],'duplicate'));
});

test('Affirm readiness uses the published capability ready state',()=>{assert.equal(affirmReady([{capability:'accept_affirm_payments',status:'ready'}]),true);for(const status of ['enabled','pending','disabled'])assert.equal(affirmReady([{capability:'accept_affirm_payments',status}]),false);assert.equal(affirmReady([{capability:'accept_card_payments',status:'ready'}]),false);});

test('welcome promotion creation serializes its required redeemable code',()=>{
  const body=JSON.parse(JSON.stringify(makeCreatePromotionRequest(welcomePromotionInput())));
  assert.equal(body.redemption_type,'code');
  assert.deepEqual(body.codes,[{code:'WELCOME10',metadata:{example_catalog:'cedar-and-stone',example_slug:'welcome10'}}]);
  assert.deepEqual(body.application_method,{type:'percent_off',percent_off:10});
});
test('welcome code ownership refuses collisions and inactive codes while allowing missing codes to be created',()=>{
  assert.doesNotThrow(()=>validateWelcomeCodes([]));
  assert.doesNotThrow(()=>validateWelcomeCodes([],'promotion'));
  assert.doesNotThrow(()=>validateWelcomeCodes([{promotion_id:'promotion',status:'active'}],'promotion'));
  assert.throws(()=>validateWelcomeCodes([{promotion_id:'other',status:'active'}],'promotion'),/belongs to another promotion/);
  assert.throws(()=>validateWelcomeCodes([{promotion_id:'other',status:'active'}]),/belongs to another promotion/);
  assert.throws(()=>validateWelcomeCodes([{promotion_id:'promotion',status:'inactive'}],'promotion'),/not active/);
});
