import {mkdirSync,writeFileSync,readFileSync,chmodSync,openSync,closeSync,fsyncSync,renameSync,unlinkSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {SdkError,makeUpdateSettingsRequest} from '@flintpay/node';
import type {Client,CustomerAccountSettingsInput,Settings,UpdateSettingsRequestInput} from '@flintpay/node';
import type {Config} from '../src/config.ts';
import {readConfig} from '../src/config.ts';
import {createClient} from '../src/flint/client.ts';
import {createAuth} from '../src/flint/auth.ts';
import type {Auth} from '../src/flint/auth.ts';
import {preflight} from '../src/flint/preflight.ts';

// Null records an omitted customer_account subtree, not invented defaults.
type AccountState=CustomerAccountSettingsInput|null;
type SettingsWrite={expected_version:string;customer_account:AccountState};
type Snapshot={version:1;sandbox_id:string;merchant_id:string;previous:AccountState;planned:CustomerAccountSettingsInput;apply_key:string;restore_key:string;expected_version:string;state:'prepared'|'applied'|'restoring'|'restored';applied?:Settings['customer_account']|null;applied_version?:string;restore_expected_version?:string};
export function setupPlan(config:Config,demo=false):CustomerAccountSettingsInput{
  return {mode:'merchant_hosted',merchant_account_url:config.appOrigin,route_templates:{order:'/orders/{resource_id}',subscription:'/subscriptions/{resource_id}',return:'/returns/{resource_id}',invoice:'/invoices/{resource_id}',email_preferences:'/email-preferences'},...(demo?{buyer_capabilities:{cancellation_timing:'buyer_chooses' as const,pause:{enabled:true,max_cycles:3},cancellation_reasons:['too_expensive','unused','switched_service','other'] as const,retention_offer:{kind:'pause_instead' as const,pause_cycles:1}}}:{})};
}
function canonical(value:unknown):string{if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,item])=>item!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';return JSON.stringify(value??null);}
function account(settings:Settings):Settings['customer_account']|null{return settings.customer_account??null;}
function same(a:unknown,b:unknown){return canonical(a)===canonical(b);}
function containsPlan(actual:unknown,planned:unknown):boolean{
  if(planned&&typeof planned==='object'&&!Array.isArray(planned))return !!actual&&typeof actual==='object'&&Object.entries(planned).filter(([,value])=>value!==undefined).every(([key,value])=>containsPlan((actual as Record<string,unknown>)[key],value));
  return same(actual,planned);
}
function validVersion(value:unknown):value is string{return typeof value==='string'&&/^[1-9][0-9]*$/.test(value);}
function writeSnapshot(path:string,value:Snapshot,initial=false){
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const target=initial?path:`${path}.${randomUUID()}.tmp`;
  const fd=openSync(target,'wx',0o600);
  try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  if(!initial)renameSync(target,path);
  chmodSync(path,0o600);
  const directory=openSync(dirname(path),'r');try{fsyncSync(directory);}finally{closeSync(directory);}
}
async function lockedSnapshot<T>(path:string,fn:()=>Promise<T>):Promise<T>{
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const lock=path+'.lock';let fd:number;
  try{fd=openSync(lock,'wx',0o600);}catch{throw new Error('Snapshot is locked; reconcile the owning setup process before retrying');}
  try{return await fn();}finally{closeSync(fd);unlinkSync(lock);}
}
function readSnapshot(path:string,sandboxId:string,merchantId:string):Snapshot{
  const snapshot=JSON.parse(readFileSync(path,'utf8')) as Snapshot;
  if(snapshot.version!==1||snapshot.sandbox_id!==sandboxId||snapshot.merchant_id!==merchantId||!Object.hasOwn(snapshot,'previous')||!snapshot.planned||!snapshot.apply_key||!snapshot.restore_key||!validVersion(snapshot.expected_version)||!['prepared','applied','restoring','restored'].includes(snapshot.state)||snapshot.restore_expected_version!==undefined&&!validVersion(snapshot.restore_expected_version))throw new Error('Snapshot target mismatch');
  return snapshot;
}
function sdkWrite(body:SettingsWrite):UpdateSettingsRequestInput{
  // The public API accepts null to clear this subtree, and the pinned SDK
  // preserves explicit null. Validate locally before any settings write.
  return makeUpdateSettingsRequest(body as UpdateSettingsRequestInput).toJSON();
}
function assertRestorable(snapshot:Snapshot){
  try{sdkWrite({expected_version:snapshot.expected_version,customer_account:snapshot.previous});}
  catch(error){
    if(snapshot.previous===null)throw new Error('Restoring absent customer_account requires a published SDK that accepts customer_account:null; no settings write was sent');
    throw error;
  }
}
function verifyApplied(settings:Settings,snapshot:Snapshot){
  if(!same(account(settings),snapshot.applied)||settings.customer_account?.mode!=='merchant_hosted'||settings.customer_account.merchant_account_url!==snapshot.planned.merchant_account_url)throw new Error('Customer account settings changed since setup; reconciliation is required');
}
async function applySnapshot(client:Client,auth:Auth,path:string,snapshot:Snapshot,settings:Settings):Promise<Settings>{
  assertRestorable(snapshot);
  if(snapshot.state==='applied'){verifyApplied(settings,snapshot);return settings;}
  if(snapshot.state!=='prepared')throw new Error('Snapshot cannot be applied after restoration starts');
  if(!same(account(settings),snapshot.previous)&&!containsPlan(account(settings),snapshot.planned))throw new Error('Customer account settings changed since setup; reconciliation is required');
  const changed=await client.settings.update(sdkWrite({expected_version:snapshot.expected_version,customer_account:snapshot.planned}),auth.merchant(snapshot.apply_key));
  snapshot.applied=account(changed);snapshot.applied_version=changed.version;snapshot.state='applied';writeSnapshot(path,snapshot);
  const verified=await client.settings.get(undefined,auth.merchant());verifyApplied(verified,snapshot);return verified;
}
export async function runSetup(client:Client,config:Config,args:string[]):Promise<{mode:string;setupNeeded:boolean;cards:string;snapshot?:string;changes?:CustomerAccountSettingsInput;previous_mode?:string}>{
  const flags=new Set(args),allowed=new Set(['--apply','--check','--buyer-capabilities=demo']);
  const resume=args.find(arg=>arg.startsWith('--resume=')),restore=args.find(arg=>arg.startsWith('--restore=')),snapshotArg=args.find(arg=>arg.startsWith('--snapshot='));
  for(const arg of args)if(!allowed.has(arg)&&arg!==resume&&arg!==restore&&arg!==snapshotArg)throw new Error('Unknown setup option');
  if([flags.has('--apply'),flags.has('--check'),!!restore,!!resume].filter(Boolean).length>1)throw new Error('Choose dry run, apply, check, resume, or restore');
  if(!config.sandboxGuard||config.sandboxGuard.includes('REPLACE'))throw new Error('FLINT_SANDBOX_ID must pin the target sandbox before setup');
  const auth=createAuth(config.apiKey),ready=await preflight(client,auth,config);
  if(resume||restore){
    const path=resolve((resume??restore!).slice((resume?'--resume=':'--restore=').length));
    return lockedSnapshot(path,async()=>{
      const snapshot=readSnapshot(path,ready.sandboxId,ready.merchantId);
      let settings=await client.settings.get(undefined,auth.merchant());
      if(resume){await applySnapshot(client,auth,path,snapshot,settings);return {mode:'resume',setupNeeded:false,cards:ready.cards,snapshot:path};}
      if(snapshot.state==='restored'){
        if(!same(account(settings),snapshot.previous))throw new Error('Customer account settings changed since restoration; reconciliation is required');
        return {mode:'restore',setupNeeded:settings.customer_account?.mode!=='merchant_hosted'||settings.customer_account.merchant_account_url!==config.appOrigin,cards:ready.cards,snapshot:path};
      }
      // Resolve an unknown apply using its original body/key before restoring.
      if(snapshot.state==='prepared')settings=await applySnapshot(client,auth,path,snapshot,settings);
      if(snapshot.state!=='restoring'&&same(account(settings),snapshot.previous)){
        snapshot.state='restored';writeSnapshot(path,snapshot);return {mode:'restore',setupNeeded:ready.setupNeeded,cards:ready.cards,snapshot:path};
      }
      if(!same(account(settings),snapshot.applied??snapshot.planned)&&!(snapshot.state==='restoring'&&same(account(settings),snapshot.previous)))throw new Error('Customer account settings changed since setup; restore requires reconciliation');
      assertRestorable(snapshot);
      if(snapshot.state!=='restoring'){
        if(!validVersion(settings.version))throw new Error('Settings version is required before restoration');
        // Persist the exact request version before sending. Never recompute it
        // when replaying a restore whose response was lost.
        snapshot.restore_expected_version=settings.version;snapshot.state='restoring';writeSnapshot(path,snapshot);
      }
      if(!snapshot.restore_expected_version)throw new Error('Restoration request version is missing');
      await client.settings.update(sdkWrite({expected_version:snapshot.restore_expected_version,customer_account:snapshot.previous}),auth.merchant(snapshot.restore_key));
      const verified=await client.settings.get(undefined,auth.merchant());
      if(!same(account(verified),snapshot.previous))throw new Error('Restoration verification failed; retain the snapshot for reconciliation');
      snapshot.state='restored';writeSnapshot(path,snapshot);return {mode:'restore',setupNeeded:verified.customer_account?.mode!=='merchant_hosted'||verified.customer_account.merchant_account_url!==config.appOrigin,cards:ready.cards,snapshot:path};
    });
  }
  const settings=await client.settings.get(undefined,auth.merchant());
  const plan={...settings.customer_account,...setupPlan(config,flags.has('--buyer-capabilities=demo'))} as CustomerAccountSettingsInput;
  if(!flags.has('--apply')){
    if(flags.has('--check')&&ready.setupNeeded)throw new Error('Customer account setup is incomplete');
    if(flags.has('--check')&&ready.cards!=='ready')throw new Error('Card acceptance is not ready');
    return {mode:flags.has('--check')?'check':'dryrun',setupNeeded:ready.setupNeeded,cards:ready.cards,changes:plan,previous_mode:settings.customer_account?.mode};
  }
  if(!validVersion(settings.version))throw new Error('Settings version is required before setup');
  const path=resolve(snapshotArg?.slice('--snapshot='.length)??`data/setup-${randomUUID()}.json`);
  return lockedSnapshot(path,async()=>{
    const snapshot:Snapshot={version:1,sandbox_id:ready.sandboxId,merchant_id:ready.merchantId,previous:(account(settings) as AccountState),planned:plan,expected_version:settings.version,apply_key:randomUUID(),restore_key:randomUUID(),state:'prepared'};
    writeSnapshot(path,snapshot,true);
    await applySnapshot(client,auth,path,snapshot,settings);
    return {mode:'apply',setupNeeded:false,cards:ready.cards,snapshot:path};
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const config=readConfig(),client=createClient(config.apiBaseUrl);
  try{console.info(JSON.stringify(await runSetup(client,config,process.argv.slice(2))));}
  catch(error){console.error(error instanceof SdkError?JSON.stringify({code:error.code,kind:error.kind,request_id:error.meta?.requestId}):error instanceof Error?error.message:'Setup failed');process.exitCode=1;}
  finally{await client.close();}
}
