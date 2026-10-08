import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client,SdkError } from '@flintpay/node';
import { Ledger } from '../../support/ledger.ts';
import { Operator, operations } from '../../support/operator.ts';
import type { VerifiedClients } from '../../support/sdk.ts';
import type { Fixtures } from '../../support/fixtures.ts';

const run = '20000101T000000Z-00000000';
const config = { pins: { A: { merchantId: 'mer_PLACEHOLDER', sandboxId: 'test_PLACEHOLDER_A' }, B: { merchantId: 'mer_PLACEHOLDER', sandboxId: 'test_PLACEHOLDER_B' } } };
async function setup(fn: (ledger: Ledger, dir: string) => Promise<void>) { const dir = await mkdtemp(join(tmpdir(), 'headless-operator-unit-')); try { await fn(new Ledger(join(dir, 'ledger.json'), run), dir); } finally { await rm(dir, { recursive: true, force: true }); } }
test('every operator method exists in the exact published SDK', () => {
  const client = new Client({ baseUrl: 'https://api.staging.withflintpay.com', apiKey: 'flint_test_PLACEHOLDER' });
  for (const operation of Object.keys(operations)) { const [resource, method] = operation.split('.'); assert.equal(typeof (client as any)[resource]?.[`${method}WithResponse`], 'function', operation); }
});
test('challenge registration returns the current owned session only in memory',async()=>setup(async ledger=>{
 const id='ord_CHALLENGE_PLACEHOLDER',sessionId='cs_CHALLENGE_PLACEHOLDER',origin='http://localhost:4100',url='https://checkout.staging.withflintpay.com/gift-card-challenge/gccf_fixture.token';
 await ledger.record({resource:id,type:'order',mode:'test',sandbox:'A',merchant:'mer_PLACEHOLDER',sandboxId:'test_PLACEHOLDER_A',createdBy:run,purpose:'unit',cleanup:'review',owner:'unit',reviewAt:'2000-02-01T00:00:00Z',owned:true});
 const session={checkout_session_id:sessionId,order_id:id,status:'open',recovery_mode:false,page_origin:origin,gift_card_challenge:{url}},fake={checkoutSessions:{list:async()=>({data:[session]}),get:async(value:string)=>{assert.equal(value,sessionId);return session;}}};
 const op=new Operator({config,clients:{A:fake}} as unknown as VerifiedClients,ledger,{} as Fixtures);
 assert.deepEqual(await op.challengeFor(id,origin),{url,checkoutSessionId:sessionId});assert.equal(await op.challengeUrlFor(id,origin),url);await assert.rejects(()=>op.challengeFor('ord_UNOWNED_PLACEHOLDER',origin),{code:'RUN_RESOURCE_AUTHORITY_REQUIRED'});
 assert.equal(JSON.stringify(ledger.state).includes(sessionId),false);assert.equal(JSON.stringify(ledger.state).includes(url),false);
}));
test('settings reject arbitrary preexisting authority before invoking the client', async () => setup(async ledger => {
  let called = false;
  const clients = { config, writable: async () => { called = true; return {}; } } as unknown as VerifiedClients;
  const op = new Operator(clients, ledger, { settingsAuthority: {} } as Fixtures);
  await assert.rejects(() => op.settings('A', { customer_account: { mode: 'merchant_hosted' } }), { message: 'PREEXISTING_SETTINGS_CHANGE_FORBIDDEN' }); assert.equal(called, false);
}));
test('unknown settings outcome replays the original version and restores the snapshot', async () => setup(async ledger => {
  let current: any = { version: '1', customer_account: { mode: 'flint_hosted' } }, lost = true;
  const seen: any[] = [], cache = new Map<string, any>();
  const fake = { settings: { get: async () => structuredClone(current), update: async (body: any, options: any) => {
    seen.push({ body: structuredClone(body), key: options.idempotencyKey });
    if (cache.has(options.idempotencyKey)) return cache.get(options.idempotencyKey);
    assert.equal(body.expected_version, current.version); current = { ...body, version: (BigInt(current.version) + 1n).toString() }; delete current.expected_version;
    const response = structuredClone(current); cache.set(options.idempotencyKey, response); if (lost) { lost = false; throw new Error('unknown'); } return response;
  } } };
  const clients = { config, writable: async () => fake } as unknown as VerifiedClients;
  const fixtures = { settingsAuthority: { A: { runOwned: true, owner: 'unit', reviewAt: '2000-02-01T00:00:00Z' } } } as Fixtures;
  const op = new Operator(clients, ledger, fixtures);
  await assert.rejects(() => op.settings('A', { customer_account: { mode: 'merchant_hosted' } }));
  await op.settings('A', { customer_account: { mode: 'merchant_hosted' } }); assert.deepEqual(seen[0], seen[1]);
  await op.cleanup(); assert.equal(current.customer_account.mode, 'flint_hosted'); ledger.assertTracked();
}));
test('concurrent settings change is preserved and teardown fails', async () => setup(async ledger => {
  let current: any = { version: '1', customer_account: { mode: 'flint_hosted' } };
  const fake = { settings: { get: async () => structuredClone(current), update: async (body: any) => { current = { ...body, version: '2' }; delete current.expected_version; return structuredClone(current); } } };
  const clients = { config, writable: async () => fake } as unknown as VerifiedClients;
  const op = new Operator(clients, ledger, { settingsAuthority: { A: { runOwned: true, owner: 'unit', reviewAt: '2000-02-01T00:00:00Z' } } } as Fixtures);
  await op.settings('A', { customer_account: { mode: 'merchant_hosted' } }); current = { version: '3', customer_account: { mode: 'foreign-owner-value' } };
  await assert.rejects(() => op.cleanup(), { message: 'TEARDOWN_FAILED' }); assert.equal(current.customer_account.mode, 'foreign-owner-value');
}));
test('cleanup fails if supported revocation reports failure', async () => setup(async ledger => {
  const clients = { config, writable: async () => ({ customerSessions: { revoke: async () => ({ revoked: false, customer_session_id: 'cs_PLACEHOLDER' }) } }) } as unknown as VerifiedClients;
  await ledger.record({ resource: 'cs_PLACEHOLDER', type: 'customer_session', mode: 'test', sandbox: 'A', merchant: 'mer_PLACEHOLDER', sandboxId: 'test_PLACEHOLDER_A', createdBy: run, purpose: 'unit', cleanup: 'customer_session', owner: 'unit', reviewAt: '2000-02-01T00:00:00Z', owned: true });
  await assert.rejects(() => new Operator(clients, ledger, {} as Fixtures).cleanup(), { message: 'TEARDOWN_FAILED' }); assert.equal(ledger.state.resources[0].status, 'PENDING AUTHORIZED CLEANUP');
}));
test('supplied unowned resources are never cleaned up', async () => setup(async ledger => {
  let called = false; const clients = { config, writable: async () => { called = true; return {}; } } as unknown as VerifiedClients;
  await ledger.record({ resource: 'sub_PLACEHOLDER', type: 'subscription', mode: 'test', sandbox: 'A', merchant: 'mer_PLACEHOLDER', sandboxId: 'test_PLACEHOLDER_A', createdBy: run, purpose: 'unit', cleanup: 'subscription', owner: 'fixture-owner', reviewAt: '2000-02-01T00:00:00Z', owned: false });
  await new Operator(clients, ledger, {} as Fixtures).cleanup(); assert.equal(called, false);
}));
test('same explicit key is durably recorded in both sandbox journals', async () => setup(async ledger => {
  for (const sandbox of ['A', 'B'] as const) await ledger.action('isolation', sandbox, 'orders.create', [], async key => key, async () => {}, 'same-PLACEHOLDER-key');
  assert.equal(ledger.state.actions['A:isolation'].key, ledger.state.actions['B:isolation'].key);
}));

test('external gift funding uses a sanctioned customer ID read through the public client', async () => setup(async ledger => {
  const id = 'cus_FUNDING_PLACEHOLDER';
  await ledger.record({ resource: id, type: 'customer', mode: 'test', sandbox: 'A', merchant: 'mer_PLACEHOLDER', sandboxId: 'test_PLACEHOLDER_A', createdBy: run, purpose: 'supplied-fixture', cleanup: 'review', owner: 'unit', reviewAt: '2000-02-01T00:00:00Z', owned: false });
  let buyerId: string | undefined;
  const fake = { customers: { get: async (value: string) => { assert.equal(value, id); return { customer_id: id }; } }, giftCards: { createWithResponse: async (body: any) => { buyerId = body.funding.source.buyer_id; return { body: { data: { gift_card: { gift_card_id: 'gift_PLACEHOLDER' }, code: 'GIFT-PLACEHOLDER' } }, meta: {} }; } } };
  const clients = { config, clients: { A: fake }, writable: async () => fake } as unknown as VerifiedClients;
  const op = new Operator(clients, ledger, { values: { giftFundingCustomerId: id } } as unknown as Fixtures); await op.issueGiftCard('funded'); assert.equal(buyerId, id);
}));
test('synthetic unrecognized gift funding references are refused before issuance', async () => setup(async ledger => {
  let calls = 0; const clients = { config, clients: { A: { customers: { get: async () => { calls++; } } } } } as unknown as VerifiedClients;
  const op = new Operator(clients, ledger, { values: { giftFundingCustomerId: 'cus_UNSANCTIONED_PLACEHOLDER' } } as unknown as Fixtures);
  await assert.rejects(() => op.issueGiftCard('funded'), { message: 'SANCTIONED_FUNDING_CUSTOMER_REQUIRED' }); assert.equal(calls, 0);
}));
for(const initial of ['absent','null','object'] as const)test(`settings restore ${initial} snapshots with exact clearing and crash replay`,async()=>setup(async(ledger,dir)=>{
  let current:any={version:'1',...(initial==='absent'?{}:{customer_account:initial==='null'?null:{mode:'flint_hosted'}})},lostApply=true,lostRestore=true;
  const effective={mode:'flint_hosted'},seen:any[]=[],cache=new Map<string,any>();
  const fake={settings:{get:async()=>structuredClone(current),getEffective:async()=>({customer_account:current.customer_account??effective}),update:async(body:any,options:any)=>{
    seen.push({body:structuredClone(body),key:options.idempotencyKey});if(cache.has(options.idempotencyKey))return cache.get(options.idempotencyKey);
    assert.equal(body.expected_version,current.version);current={...current,...body,version:(BigInt(current.version)+1n).toString()};delete current.expected_version;if(body.customer_account===null)delete current.customer_account;
    const response=structuredClone(current);cache.set(options.idempotencyKey,response);
    if(body.customer_account?.mode==='merchant_hosted'&&lostApply){lostApply=false;throw new Error('lost apply');}
    if(body.customer_account?.mode!=='merchant_hosted'&&lostRestore){lostRestore=false;throw new Error('lost restore');}return response;
  }}};
  const clients={config,writable:async()=>fake} as unknown as VerifiedClients,fixtures={settingsAuthority:{A:{runOwned:true,owner:'unit',reviewAt:'2000-02-01T00:00:00Z'}}} as Fixtures;
  const op=new Operator(clients,ledger,fixtures);await assert.rejects(()=>op.settings('A',{customer_account:{mode:'merchant_hosted'}}));
  const loaded=new Ledger(join(dir,'ledger.json'),run);await loaded.load();assert.equal(loaded.state.settings['settings-A'].snapshot._presence.customer_account,initial==='object'?'value':initial);
  const resumed=new Operator(clients,loaded,fixtures);await resumed.settings('A',{customer_account:{mode:'merchant_hosted'}});assert.deepEqual(seen[0],seen[1]);
  await assert.rejects(()=>resumed.cleanup(),{message:'TEARDOWN_FAILED'});
  const afterCrash=new Ledger(join(dir,'ledger.json'),run);await afterCrash.load();await new Operator(clients,afterCrash,fixtures).cleanup();assert.deepEqual(seen[2],seen[3]);
  if(initial==='object')assert.deepEqual(current.customer_account,{mode:'flint_hosted'});else{assert.equal(Object.hasOwn(current,'customer_account'),false);assert.equal(seen[2].body.customer_account,null);}
  afterCrash.assertTracked();
}));
test('unsupported settings absence and null remain blocked before any write',async()=>setup(async ledger=>{
 for(const value of [undefined,null]){let writes=0;const clients={config,writable:async()=>({settings:{get:async()=>({version:'1',checkout:value}),update:async()=>{writes++;}}})} as unknown as VerifiedClients;
 const op=new Operator(clients,ledger,{settingsAuthority:{A:{runOwned:true,owner:'unit',reviewAt:'2000-02-01T00:00:00Z'}}} as Fixtures);
 await assert.rejects(()=>op.settings('A',{checkout:{}}),{message:'SETTINGS_PATCH_NOT_RESTORABLE'});assert.equal(writes,0);}
}));

for(const trips of [true,false])test(`challenge trip ${trips?'proves a shared dimension':'fails at the bounded lookup limit'} without merchant apply or persisted codes`,async()=>setup(async(ledger,dir)=>{
 let sessionCount=0,lookups=0;const requests:any[]=[],codes:string[]=[];
 const fake={orders:{get:async()=>({order_revision:'5'}),applyGiftCard:async(_id:string,body:any,options:any)=>{lookups++;requests.push(options);codes.push(body.gift_card_code);assert.match(body.gift_card_code,/^E2ENOPE[A-Za-z0-9_-]{16}$/);assert.equal('Flint-Gift-Card-Challenge'in body,false);const code=trips&&(sessionCount>1||lookups===2)?'GIFT_CARD_CHALLENGE_REQUIRED':'GIFT_CARD_UNAVAILABLE';throw new SdkError('validation','fixture','response',false,{status:400,headers:{},attempts:1,durationMs:1},code);}},checkoutSessions:{closeSession:async()=>({})}};
 const clients={config:{...config,origins:{storefrontA:'http://localhost:4100'}},writable:async()=>fake} as unknown as VerifiedClients,op=new Operator(clients,ledger,{} as Fixtures);
 op.execute=async step=>{
   const session=step.operation==='checkoutSessions.create';if(session)sessionCount++;const id=`${session?'cs':'ord'}_fixture_${sessionCount+(!session?1:0)}`;
   await ledger.record({resource:id,type:session?'checkout_session':'order',mode:'test',sandbox:'A',merchant:'mer_PLACEHOLDER',sandboxId:'test_PLACEHOLDER_A',createdBy:run,purpose:'gift-challenge-probe',cleanup:session?'checkout_session':'review',owner:'unit',reviewAt:'2000-02-01T00:00:00Z',owned:true});
   return {data:session?{checkout_session:{checkout_session_id:id},checkout_access:{checkout_auth_token:'fixture authority'}}:{order_id:id}};
 };
 if(trips){await op.tripGiftChallenge();assert.equal(sessionCount,2);assert.equal(lookups,3);assert.ok(ledger.state.giftChallengeTrippedAt);await op.tripGiftChallenge();assert.equal(sessionCount,3);assert.equal(lookups,4);}else{await assert.rejects(()=>op.tripGiftChallenge(),{code:'CHALLENGE_TRIP_NOT_OBSERVED'});assert.equal(sessionCount,3);assert.equal(lookups,15);}
 assert.ok(requests.every(options=>options.authMode==='checkout'&&options.apiKey===undefined&&options.maxAttempts===1));assert.ok(ledger.state.resources.filter(resource=>resource.type==='checkout_session').every(resource=>resource.status==='CLEANED UP'));
 const saved=await import('node:fs/promises').then(fs=>fs.readFile(join(dir,'ledger.json'),'utf8'));for(const code of codes)assert.equal(saved.includes(code),false);assert.equal(saved.includes('fixture authority'),false);
}));
