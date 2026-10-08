import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client,SdkError} from '@flintpay/node';
import type {CustomerAccountSettings,CustomerAccountSettingsInput} from '@flintpay/node';
import {runSetup} from '../../scripts/setup.ts';
import {readConfig} from '../../src/config.ts';
const config=readConfig({FLINT_API_KEY:'flint_test_PLACEHOLDER',FLINT_API_BASE_URL:'https://api.staging.withflintpay.com',APP_ORIGIN:'http://localhost:4200',PORT:'4200',FLINT_SANDBOX_ID:'sandbox_example'});
type Write={customer_account:CustomerAccountSettings|null;expected_version:string|number};
function localApi(initial:CustomerAccountSettings|null={mode:'flint_hosted'}){
  let account=initial??undefined,version=1,writes=0,lose:'before'|'after'|undefined,loseRead=false,normalize=false,beforeUpdate:((body:Write,key:string)=>void)|undefined;
  const attempts:{body:Write;key:string}[]=[],cache=new Map<string,{body:string;response:string}>();
  const headers={'Content-Type':'application/json','Flint-Mode':'test','Flint-Sandbox-ID':'sandbox_example'};
  const resource=()=>({settings_id:'settings_example',settings_scope:'merchant',version:String(version),...(account?{customer_account:account}:{})});
  const client=new Client({baseUrl:config.apiBaseUrl,maxAttempts:1,transport:async(input,init)=>{
    const path=new URL(String(input)).pathname;
    assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer flint_test_PLACEHOLDER');
    if(path==='/v1/capabilities')return new Response(JSON.stringify({data:[{capability:'accept_card_payments',domain:'payments',status:'ready',requirements:{}}]}),{headers});
    if(path==='/v1/merchant')return new Response(JSON.stringify({data:{merchant_id:'mer_example',email:'merchant@example.invalid',has_past_due:false,observed_at:'2026-01-01T00:00:00Z',onboarding_status:'completed',payments:{status:'ready',next_actions:[]},payouts:{status:'ready',next_actions:[]},requirements:{currently_due:[],eventually_due:[],past_due:[],pending_verification:[]},status:'active',version:'1'}}),{headers});
    assert.equal(path,'/v1/settings');
    if(init?.method==='GET'){if(loseRead){loseRead=false;throw new Error('Synthetic readback loss');}return new Response(JSON.stringify({data:resource()}),{headers});}
    const body=JSON.parse(String(init?.body)) as Write,key=new Headers(init?.headers).get('Idempotency-Key')!;
    assert.ok(key);attempts.push({body,key});beforeUpdate?.(body,key);
    const replay=cache.get(key);
    if(replay){assert.equal(JSON.stringify(body),replay.body,'Idempotency retries must keep the exact request');return new Response(replay.response,{headers});}
    if(lose==='before'){lose=undefined;throw new Error('Synthetic transport loss before commit');}
    if(String(body.expected_version)!==String(version))return new Response(JSON.stringify({error:{code:'VERSION_CONFLICT',message:'Synthetic version conflict'}}),{status:409,headers});
    writes++;version++;account=body.customer_account??undefined;
    if(normalize&&account)account={buyer_capabilities:{cancellation_timing:'end_of_period'},...account};
    const response=JSON.stringify({data:resource()});cache.set(key,{body:JSON.stringify(body),response});
    if(lose==='after'){lose=undefined;throw new Error('Synthetic transport loss after commit');}
    return new Response(response,{headers});
  }});
  return {client,attempts,writes:()=>writes,account:()=>account,loseNext:(when:'before'|'after')=>{lose=when;},loseNextRead:()=>{loseRead=true;},normalize:()=>{normalize=true;},beforeUpdate:(fn:typeof beforeUpdate)=>{beforeUpdate=fn;},interfere:()=>{account={...account,merchant_account_url:'http://localhost:4300'};version++;},bumpVersion:()=>{version++;}};
}
function tempSnapshot(){const dir=mkdtempSync(join(tmpdir(),'account-setup-'));return {path:join(dir,'snapshot.json'),close:()=>rmSync(dir,{recursive:true,force:true})};}
function saved(path:string){return JSON.parse(readFileSync(path,'utf8'));}
test('setup snapshots before each write, retains permissions and restores existing state once',async t=>{
  const temp=tempSnapshot(),api=localApi();t.after(async()=>{await api.client.close();temp.close();});
  assert.equal((await runSetup(api.client,config,[])).mode,'dryrun');assert.equal(api.writes(),0);
  api.beforeUpdate(()=>{const snapshot=saved(temp.path);assert.equal(snapshot.previous.mode,'flint_hosted');assert.equal(snapshot.state,api.writes()===0?'prepared':'restoring');});
  await runSetup(api.client,config,['--apply','--snapshot='+temp.path]);assert.equal(api.account()?.mode,'merchant_hosted');assert.equal(statSync(temp.path).mode&0o777,0o600);
  assert.equal(saved(temp.path).state,'applied');
  await runSetup(api.client,config,['--restore='+temp.path]);assert.equal(api.account()?.mode,'flint_hosted');assert.equal(api.writes(),2);
  await runSetup(api.client,config,['--restore='+temp.path]);assert.equal(api.writes(),2);
});
test('absent customer_account dryrun is valid and snapshot records explicit absence before the SDK clearing prerequisite',async t=>{
  const temp=tempSnapshot(),api=localApi(null);
  t.after(async()=>{await api.client.close();temp.close();});
  const client=api.client;
  const dryrun=await runSetup(client,config,[]);assert.equal(dryrun.setupNeeded,true);assert.equal(dryrun.previous_mode,undefined);assert.equal(dryrun.changes?.mode,'merchant_hosted');
  await assert.rejects(runSetup(client,config,['--apply','--snapshot='+temp.path]),/published SDK.*customer_account:null/);
  assert.equal(saved(temp.path).previous,null);assert.equal(saved(temp.path).state,'prepared');assert.ok(saved(temp.path).apply_key);assert.equal(api.writes(),0);
  await assert.rejects(runSetup(client,config,['--restore='+temp.path]),/published SDK.*customer_account:null/);assert.equal(api.writes(),0);assert.equal(api.attempts.length,0);
});
test('published SDK refuses clearing before transport, so a type assertion cannot silently turn null into omission',async()=>{
  let calls=0;const client=new Client({baseUrl:config.apiBaseUrl,maxAttempts:1,transport:async()=>{calls++;throw new Error('Transport must not be called');}});
  try{
    await assert.rejects(client.settings.update({expected_version:'1',customer_account:null as unknown as CustomerAccountSettingsInput},{apiKey:'flint_test_PLACEHOLDER',idempotencyKey:'example-clear-key'}),error=>error instanceof SdkError&&error.kind==='validation'&&error.outcome==='not_sent');
    assert.equal(calls,0);
  }finally{await client.close();}
});
test('lost apply responses resume the original request and key with one settings change',async t=>{
  for(const when of ['before','after'] as const){
    const temp=tempSnapshot(),api=localApi();t.after(async()=>{await api.client.close();temp.close();});api.loseNext(when);
    await assert.rejects(runSetup(api.client,config,['--apply','--snapshot='+temp.path]),error=>error instanceof SdkError&&error.outcome==='unknown');
    assert.equal(saved(temp.path).state,'prepared');
    await runSetup(api.client,config,['--resume='+temp.path]);assert.equal(api.writes(),1);assert.deepEqual(api.attempts[0],api.attempts[1]);assert.equal(saved(temp.path).state,'applied');
    await runSetup(api.client,config,['--resume='+temp.path]);assert.equal(api.attempts.length,2);
  }
});
test('lost restoration response replays the persisted expected_version despite a later unrelated settings change',async t=>{
  const temp=tempSnapshot(),api=localApi();t.after(async()=>{await api.client.close();temp.close();});
  await runSetup(api.client,config,['--apply','--snapshot='+temp.path]);api.loseNext('after');
  await assert.rejects(runSetup(api.client,config,['--restore='+temp.path]));
  assert.equal(saved(temp.path).state,'restoring');assert.equal(saved(temp.path).restore_expected_version,'2');assert.equal(api.account()?.mode,'flint_hosted');
  api.bumpVersion();await runSetup(api.client,config,['--restore='+temp.path]);assert.equal(api.writes(),2);assert.deepEqual(api.attempts[1],api.attempts[2]);assert.equal(saved(temp.path).state,'restored');
});
test('restore first resolves an unknown apply with its original key',async t=>{
  const temp=tempSnapshot(),api=localApi();t.after(async()=>{await api.client.close();temp.close();});api.loseNext('after');
  await assert.rejects(runSetup(api.client,config,['--apply','--snapshot='+temp.path]));
  await runSetup(api.client,config,['--restore='+temp.path]);assert.equal(api.writes(),2);assert.deepEqual(api.attempts[0],api.attempts[1]);assert.equal(api.account()?.mode,'flint_hosted');assert.equal(saved(temp.path).state,'restored');
});
test('setup refuses an unpinned target and never overwrites intervening account changes, including after restoration',async t=>{
  const temp=tempSnapshot(),api=localApi();t.after(async()=>{await api.client.close();temp.close();});
  await assert.rejects(runSetup(api.client,{...config,sandboxGuard:undefined},['--apply']));assert.equal(api.writes(),0);
  await runSetup(api.client,config,['--apply','--snapshot='+temp.path]);api.interfere();
  await assert.rejects(runSetup(api.client,config,['--restore='+temp.path]),/changed since setup/);
  await assert.rejects(runSetup(api.client,config,['--resume='+temp.path]),/changed since setup/);assert.equal(api.writes(),1);
});
test('prepared apply and in-flight restore preserve their request on version conflict and do not overwrite racing edits',async t=>{
  for(const operation of ['apply','restore'] as const){
    const temp=tempSnapshot(),api=localApi();t.after(async()=>{await api.client.close();temp.close();});
    if(operation==='restore')await runSetup(api.client,config,['--apply','--snapshot='+temp.path]);
    api.beforeUpdate(()=>{api.beforeUpdate(undefined);api.interfere();});
    await assert.rejects(runSetup(api.client,config,operation==='apply'?['--apply','--snapshot='+temp.path]:['--restore='+temp.path]),error=>error instanceof SdkError&&error.kind==='conflict');
    assert.equal(saved(temp.path).state,operation==='apply'?'prepared':'restoring');assert.equal(api.writes(),operation==='apply'?0:1);assert.equal(api.account()?.merchant_account_url,'http://localhost:4300');
    const attempts=api.attempts.length;
    await assert.rejects(runSetup(api.client,config,[(operation==='apply'?'--resume=':'--restore=')+temp.path]),/changed since setup/);assert.equal(api.attempts.length,attempts);
  }
});
test('a completed restoration refuses later drift without issuing a write',async t=>{
  const temp=tempSnapshot(),api=localApi();t.after(async()=>{await api.client.close();temp.close();});
  await runSetup(api.client,config,['--apply','--snapshot='+temp.path]);await runSetup(api.client,config,['--restore='+temp.path]);api.interfere();
  await assert.rejects(runSetup(api.client,config,['--restore='+temp.path]),/changed since restoration/);assert.equal(api.writes(),2);
});
test('a lost apply readback resumes from its recorded response and verifies without another write',async t=>{
  const temp=tempSnapshot(),api=localApi();t.after(async()=>{await api.client.close();temp.close();});
  api.beforeUpdate(()=>{api.beforeUpdate(undefined);api.loseNextRead();});
  await assert.rejects(runSetup(api.client,config,['--apply','--snapshot='+temp.path]));assert.equal(saved(temp.path).state,'applied');
  await runSetup(api.client,config,['--resume='+temp.path]);assert.equal(api.writes(),1);assert.equal(api.attempts.length,1);
});
test('unknown apply recovery allows response defaults but uses the original write and verifies the full readback',async t=>{
  const temp=tempSnapshot(),api=localApi();t.after(async()=>{await api.client.close();temp.close();});api.normalize();api.loseNext('after');
  await assert.rejects(runSetup(api.client,config,['--apply','--snapshot='+temp.path]));
  await runSetup(api.client,config,['--resume='+temp.path]);assert.equal(api.writes(),1);assert.deepEqual(api.attempts[0],api.attempts[1]);assert.equal(saved(temp.path).applied.buyer_capabilities.cancellation_timing,'end_of_period');
});
test('two restoration processes cannot update one snapshot concurrently',async t=>{
  const temp=tempSnapshot(),api=localApi();t.after(async()=>{await api.client.close();temp.close();});
  await runSetup(api.client,config,['--apply','--snapshot='+temp.path]);
  const outcomes=await Promise.allSettled([runSetup(api.client,config,['--restore='+temp.path]),runSetup(api.client,config,['--restore='+temp.path])]);
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);const failure=outcomes.find(result=>result.status==='rejected');assert.ok(failure&&failure.status==='rejected');assert.match(failure.reason.message,/Snapshot is locked/);assert.equal(api.writes(),2);assert.equal(saved(temp.path).state,'restored');
});
