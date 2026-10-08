import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { mkdtemp, rm, writeFile, chmod, symlink, link, stat, readFile, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityStore } from '../../../account/src/identity/index.ts';
import { AppVault, VAULT_QUERIES, SealedCredential, authorizeVaultRow, vaultReadScope, validateOwnedManifest, verifyOwnedProcess, checkVaultFiles, assertSameFile, assertVaultPath, verifyVaultHolders, assertAppFamily, vaultMetadata, anonymousSessionClient, sessionCall, assertGiftChallengeSqlite } from '../../support/app-vault.ts';
import type { OwnedApps } from '../../support/app-vault.ts';
import { Procfs, parseStatus, parseStartTicks, parseCmdline, listeningInodes } from '../../support/procfs.ts';
import { checkoutRoot, writePrivate } from '../../support/private-files.ts';
import { validateVaultSources } from '../../scripts/check.ts';
import { API_ORIGIN, alias } from '../../support/config.ts';
import type { Config } from '../../support/config.ts';
import { CredentialScanner } from '../../support/credential-scan.ts';
import { Ledger } from '../../support/ledger.ts';
import { Driver } from '../../support/driver.ts';
import { assertFixtureSecretsAbsent, assertSessionExceptions } from '../../support/fixtures.ts';
import { assertFreshRevocation } from '../../support/audit-feed.ts';
import { replayAppRefresh, assertAppSecretInvalid, assertRefreshRotation, assertNoEarlyRefresh, assertSignoutNegative, assertSignoutRevoked, runAppRefreshTransition, runAppSignoutTransition } from '../../scenarios/account.ts';

const run = '20000101T000000Z-00000000', family = 'cses_PLACEHOLDER', customer = 'cus_PLACEHOLDER';
function config(dir: string): Config {
  const commit = 'a'.repeat(40), pin = { merchantId: 'mer_PLACEHOLDER', sandboxId: 'test_PLACEHOLDER', providerId: 'acct_PLACEHOLDER', key: 'flint_test_PLACEHOLDER' };
  return { run, apiOrigin: API_ORIGIN, pins: { A: pin, B: { ...pin, sandboxId: 'test_B_PLACEHOLDER' } }, operatorPins: { A: pin, B: pin }, suite: 'extended', appVaultRead: 'AC-15,AC-16', inboxAddress: 'unit@example.invalid', apply: false, privateDir: dir, fixtureFile: '', targetCommit: commit, apiCommit: commit, origins: { accountA: 'http://localhost:4200', storefrontA: 'http://localhost:4100', storefrontB: 'http://localhost:4110' }, builds: { accountA: `${commit}:headless/account`, storefrontA: `${commit}:headless/storefront`, storefrontB: `${commit}:headless/storefront` } };
}
function manifest(c: Config): OwnedApps { return { schema_version: 1, run, target_commit: c.targetCommit, launcher_pid: 100, private_dir_realpath: c.privateDir, children: ['accountA', 'storefrontA', 'storefrontB'].map((name, i) => ({ name, pid: 101 + i, origin: c.origins[name as keyof Config['origins']], port: Number(new URL(c.origins[name as keyof Config['origins']]).port), artifact_id: c.builds[name], identity_file: name === 'storefrontB' ? 'identity-b.sqlite' : 'identity-a.sqlite', app_database_file: `${name}.sqlite` })) }; }
async function temp(fn: (dir: string) => Promise<void>): Promise<void> { const dir = await mkdtemp(join(tmpdir(), 'app-vault-unit-')); try { await fn(dir); } finally { await rm(dir, {recursive: true, force: true}); } }
const code = (error: any) => error?.code;

test('vault opt-in is exact and row-scoped; unsupported platforms never pass', async () => {
  for (const value of ['AC-14', 'AC-15,AC-17', 'AC-15,AC-15', ' AC-15', ',AC-16']) assert.throws(() => vaultReadScope(value), {code: 'APP_VAULT_READ_SCOPE_INVALID'});
  const proc = {available: async () => true} as Procfs;
  for (const appVaultRead of [undefined, '', 'AC-16']) await assert.rejects(() => authorizeVaultRow({appVaultRead, suite:'extended'}, 'AC-15', 'linux', proc), {status:'PENDING',code:'APP_VAULT_READ_NOT_AUTHORIZED_FOR_ROW'});
  await assert.rejects(() => authorizeVaultRow({appVaultRead:'AC-15',suite:'standard'}, 'AC-15', 'linux', proc));
  await assert.rejects(() => authorizeVaultRow({appVaultRead:'AC-16',suite:'standard'}, 'AC-16', 'darwin', proc), {status:'BLOCKED',code:'APP_VAULT_OWNERSHIP_PROOF_REQUIRES_LINUX_PROCFS'});
  await authorizeVaultRow({appVaultRead:'AC-16',suite:'standard'}, 'AC-16', 'linux', proc);
});
test('sealed authority cannot serialize or coerce and registers exact values for scanning', () => {
  const scanner = new CredentialScanner(), a = new SealedCredential('synthetic-authority', [scanner]);
  assert.deepEqual(Object.keys(a), []); assert.equal(inspect(a), '[sealed]');
  assert.throws(() => JSON.stringify(a), {code:'SEALED_CREDENTIAL_SERIALIZATION'}); assert.throws(() => `${a}`, {code:'SEALED_CREDENTIAL_SERIALIZATION'});
  assert.equal(a.equals(new SealedCredential('synthetic-authority')),true); assert.equal(a.equals(new SealedCredential('other')),false);
  scanner.scan('synthetic-authority','console'); assert.equal(scanner.violations.has('CREDENTIAL_CONSOLE'),true);
});
test('manifest mismatches and extra fields are refused', () => {
  const c = config('/tmp/synthetic'), valid = manifest(c); validateOwnedManifest(valid,c,c.privateDir);
  for (const patch of [{run:'other'}, {target_commit:'b'.repeat(40)}, {private_dir_realpath:'/tmp/other'}, {unexpected:'value'}]) assert.throws(() => validateOwnedManifest({...valid,...patch},c,c.privateDir), {code:'OWNED_APP_MANIFEST_MISMATCH'});
  const wrong = structuredClone(valid); wrong.children[0].identity_file = 'accountA.sqlite'; assert.throws(() => validateOwnedManifest(wrong,c,c.privateDir));
});
test('procfs parsers handle command names with spaces and exact listening socket inodes', () => {
  assert.deepEqual(parseStatus('PPid:\t100\nUid:\t10 10 10 10\n'), {parent:100,uid:10,effectiveUid:10});
  const fields = ['S',...Array(18).fill('0'),'1234']; assert.equal(parseStartTicks(`101 (name ) with spaces) ${fields.join(' ')}`),1234);
  assert.deepEqual(parseCmdline(Buffer.from('/usr/bin/node\0file.ts\0--apply\0')), ['/usr/bin/node','file.ts','--apply']);
  assert.deepEqual([...listeningInodes('header\n0: 0100007F:1068 00000000:0000 0A 0 0 0 10 0 123\n1: 0100007F:1068 00000000:0000 01 0 0 0 10 0 456',4200)],['123']);
});
test('ownership proof refuses each process, command, socket and health mismatch', async () => {
  const c=config('/tmp/synthetic'), m=manifest(c), started=Date.now();
  const child={uid:process.getuid!(),effectiveUid:process.getuid!(),parent:100,command:[process.execPath,'--import',join(checkoutRoot,'headless/e2e/support/app-audit.ts'),join(checkoutRoot,'headless/account/src/server.ts')],cwd:checkoutRoot,executable:process.execPath,startedAt:started,sockets:new Set(['123'])};
  const launcher={...child,command:[process.execPath,join(checkoutRoot,'headless/e2e/scripts/apps.ts'),'--apply']};
  const health=(skew=0)=>async()=>Response.json({build:{sha:c.targetCommit,artifactId:c.builds.accountA,startedAt:new Date(started+skew).toISOString()},sandbox_id:c.pins.A.sandboxId,mode:'test'});
  const proc=(patch={},listens=true)=>({process:async(pid:number)=>pid===100?launcher:{...child,...patch},listens:async()=>listens}) as unknown as Procfs;
  await verifyOwnedProcess(c,m,proc(),health());
  for(const patch of [{uid:child.uid+1},{effectiveUid:child.uid+1},{parent:999},{command:[...child.command,'extra']},{cwd:'/tmp/elsewhere'}]) await assert.rejects(()=>verifyOwnedProcess(c,m,proc(patch),health()),{code:'APP_PROCESS_OWNERSHIP_UNPROVEN'});
  await assert.rejects(()=>verifyOwnedProcess(c,m,proc({},false),health()),{code:'APP_PROCESS_OWNERSHIP_UNPROVEN'});
  await assert.rejects(()=>verifyOwnedProcess(c,m,proc(),health(3001)),{code:'APP_PROCESS_OWNERSHIP_UNPROVEN'});
});
test('real private vault refuses symlinks, hardlinks, permissions and replaced inodes', async () => temp(async dir => {
  const identity=new IdentityStore(join(dir,'identity-a.sqlite'));
  try {
    const before=await checkVaultFiles(dir); assertSameFile(before,await checkVaultFiles(dir));
    assert.throws(()=>assertSameFile(before,{...before,ino:before.ino+1}),{code:'APP_VAULT_FILE_IDENTITY_MISMATCH'});
    const info=await stat(join(dir,'identity-a.sqlite'));
    assert.throws(()=>assertVaultPath(join(dir,'identity-a.sqlite'),Object.assign(Object.create(Object.getPrototypeOf(info)),info,{uid:info.uid+1}),join(dir,'identity-a.sqlite'),false));
    assert.throws(()=>assertVaultPath(join(dir,'identity-a.sqlite'),info,'/tmp/foreign',false));
    await chmod(join(dir,'identity-a.sqlite'),0o640); await assert.rejects(()=>checkVaultFiles(dir),{code:'APP_VAULT_FILE_IDENTITY_MISMATCH'}); await chmod(join(dir,'identity-a.sqlite'),0o600);
    await link(join(dir,'identity-a.sqlite'),join(dir,'hardlink')); await assert.rejects(()=>checkVaultFiles(dir)); await rm(join(dir,'hardlink'));
    for(const suffix of ['', '-wal', '-shm']) {
      const path=join(dir,'identity-a.sqlite'+suffix), moved=path+'.real';
      const {rename}=await import('node:fs/promises'); await rename(path,moved); await symlink(moved,path); await assert.rejects(()=>checkVaultFiles(dir)); await rm(path); await rename(moved,path);
    }
    const linked=dir+'-link'; await symlink(dir,linked); try { await assert.rejects(()=>checkVaultFiles(linked)); } finally { await rm(linked); }
  } finally {identity.close();}
}));
test('a foreign same-uid holder or missing account descriptor refuses file authority', async () => {
  const c=config('/tmp/synthetic'),m=manifest(c),info={dev:1,ino:2,size:3};
  for(const [holds,holders] of [[false,[101]],[true,[101,102,999]]] as [boolean,number[]][]) await assert.rejects(()=>verifyVaultHolders(info,m,{holds:async()=>holds,holders:async()=>holders} as unknown as Procfs),{code:'APP_VAULT_FILE_IDENTITY_MISMATCH'});
  await verifyVaultHolders(info,m,{holds:async()=>true,holders:async()=>[101,102,process.pid]} as unknown as Procfs);
});
async function challengeSqliteFixture(dir:string,row:'AC-GIFTCHALLENGE'|'SF-GIFTCHALLENGE'){
  const c=config(dir),m=manifest(c),app=row==='AC-GIFTCHALLENGE'?'accountA':'storefrontA',child=m.children.find(v=>v.name===app)!,files=new Map<number,{path:string;owners:number[]}>();
  for(const file of ['identity-a.sqlite',`${app}.sqlite`])for(const suffix of ['', '-wal','-shm']){
    const path=join(dir,file+suffix);await writeFile(path,'synthetic database bytes',{mode:0o600});const info=await stat(path);files.set(info.ino,{path,owners:file==='identity-a.sqlite'?[101,102]:[child.pid]});
  }
  const proc={holds:async(pid:number,_dev:number,ino:number)=>files.get(ino)?.owners.includes(pid)??false,holders:async(_dev:number,ino:number)=>[...(files.get(ino)?.owners??[]),process.pid]} as unknown as Procfs;
  return {m,proc,files,app,scan:(codes:readonly string[]=[])=>assertGiftChallengeSqlite(dir,m,proc,row,codes)};
}
for(const row of ['AC-GIFTCHALLENGE','SF-GIFTCHALLENGE'] as const){
  test(`${row} challenge scan accepts shared identity vault authority without serializing it`,async()=>temp(async dir=>{
    const f=await challengeSqliteFixture(dir,row);await writeFile(join(dir,'identity-a.sqlite'),'flint_cses_PLACEHOLDER flint_cref_PLACEHOLDER');await f.scan(['SYNTHETIC-GIFT-CODE']);
  }));
  for(const [suffix,value,codes] of [['','SYNTHETIC-GIFT-CODE',['SYNTHETIC-GIFT-CODE']],['-wal','gccp_syntheticProof',[]],['-shm','https://checkout.staging.withflintpay.com/gift-card-challenge/gccf_synthetic.frame',[]]] as const){
    test(`${row} challenge scan rejects shared identity${suffix||' main'} authority`,async()=>temp(async dir=>{
      const f=await challengeSqliteFixture(dir,row);await writeFile(join(dir,'identity-a.sqlite'+suffix),value);
      await assert.rejects(()=>f.scan(codes),{code:'CHALLENGE_AUTHORITY_IN_APP_SQLITE'});
    }));
  }
  test(`${row} challenge scan still rejects app database authority`,async()=>temp(async dir=>{
    const f=await challengeSqliteFixture(dir,row);await writeFile(join(dir,f.app+'.sqlite-wal'),'gccp_syntheticProof');await assert.rejects(()=>f.scan(),{code:'CHALLENGE_AUTHORITY_IN_APP_SQLITE'});
  }));
}
for(const suffix of ['', '-wal','-shm'])test(`challenge scan refuses a shared identity${suffix||' main'} symlink`,async()=>temp(async dir=>{
  const f=await challengeSqliteFixture(dir,'SF-GIFTCHALLENGE'),path=join(dir,'identity-a.sqlite'+suffix);await rename(path,path+'.real');await symlink(path+'.real',path);await assert.rejects(()=>f.scan(),{code:'APP_VAULT_FILE_IDENTITY_MISMATCH'});
}));
test('challenge scan refuses a replaced shared WAL inode between path proof and read',async()=>temp(async dir=>{
  const f=await challengeSqliteFixture(dir,'AC-GIFTCHALLENGE'),path=join(dir,'identity-a.sqlite-wal'),info=await stat(path),original=f.proc.holders.bind(f.proc);let replaced=false;
  f.proc.holders=async(dev,ino,uid)=>{if(ino===info.ino&&!replaced){replaced=true;await rename(path,path+'.old');await writeFile(path,'replacement database bytes',{mode:0o600});}return original(dev,ino,uid);};
  await assert.rejects(()=>f.scan(),{code:'APP_VAULT_FILE_IDENTITY_MISMATCH'});
}));
test('challenge scan refuses an app database path outside the exact owned manifest',async()=>temp(async dir=>{
  const f=await challengeSqliteFixture(dir,'AC-GIFTCHALLENGE');f.m.children.find(child=>child.name==='accountA')!.app_database_file='../foreign.sqlite';await assert.rejects(()=>f.scan(),{code:'OWNED_APP_MANIFEST_MISMATCH'});
}));
for(const file of ['identity-a.sqlite-wal','accountA.sqlite'])test(`challenge scan refuses a foreign holder of ${file}`,async()=>temp(async dir=>{
  const f=await challengeSqliteFixture(dir,'AC-GIFTCHALLENGE'),info=await stat(join(dir,file)),original=f.proc.holders.bind(f.proc);f.proc.holders=async(dev,ino,uid)=>ino===info.ino?[999]:original(dev,ino,uid);
  await assert.rejects(()=>f.scan(),{code:'APP_VAULT_FILE_IDENTITY_MISMATCH'});
}));
test('the five exact SQL projections read synthetic IdentityStore rows without mutating the main database', async () => temp(async dir => {
  const path=join(dir,'identity-a.sqlite'), identity=new IdentityStore(path);
  try {
    const user=await identity.createUser('Unit',alias(config(dir),'b1'),'synthetic-password'); identity.bind(user.user_id,'test_PLACEHOLDER',customer,user.email);
    identity.saveVault({user_id:user.user_id,sandbox_id:'test_PLACEHOLDER',customer_session_id:family,secret:'flint_cses_PLACEHOLDER',refresh_token:'flint_cref_PLACEHOLDER',expires_at:1,refresh_expires_at:2});
    const before=await readFile(path),info=await stat(path);
    const readonly=Reflect.construct(identity.db.constructor,[path,{readOnly:true}]) as IdentityStore['db'];
    try {
      readonly.exec('PRAGMA query_only=ON'); assert.throws(()=>readonly.exec("DELETE FROM customer_session_vault"));
      const rows=readonly.prepare(VAULT_QUERIES.authority).all(user.email,customer,'test_PLACEHOLDER','test_PLACEHOLDER'); assert.equal(rows.length,1);
      identity.db.prepare("UPDATE users SET status='closed' WHERE user_id=?").run(user.user_id); assert.equal(readonly.prepare(VAULT_QUERIES.authority).all(user.email,customer,'test_PLACEHOLDER','test_PLACEHOLDER').length,0); identity.db.prepare("UPDATE users SET status='active' WHERE user_id=?").run(user.user_id);
      const row=rows[0]; const held=new SealedCredential(String(row.secret)); assert.equal(held.use(v=>v==='flint_cses_PLACEHOLDER'),true); assert.throws(()=>JSON.stringify(held));
      for(const args of [[user.email,customer,'foreign','test_PLACEHOLDER'],['wrong@example.invalid',customer,'test_PLACEHOLDER','test_PLACEHOLDER'],[user.email,'foreign','test_PLACEHOLDER','test_PLACEHOLDER']]) assert.equal(readonly.prepare(VAULT_QUERIES.authority).all(...args).length,0);
      assert.deepEqual(Object.keys(readonly.prepare(VAULT_QUERIES.metadata).all(user.email,customer,'test_PLACEHOLDER','test_PLACEHOLDER')[0]),['customer_session_id','expires_at','refresh_expires_at']);
    } finally {readonly.close();}
    assert.deepEqual(await readFile(path),before); assert.equal((await stat(path)).mtimeMs,info.mtimeMs);
  } finally {identity.close();}
}));
test('family provenance cannot use a public fixture or a non-app audit event', () => {
  const c=config('/tmp/synthetic'),resource={resource:family,type:'customer_session',sandbox:'A',sandboxId:c.pins.A.sandboxId,owned:true,createdBy:run,purpose:'app-creation'};
  const d={config:c,operator:{ledger:{state:{resources:[resource]}}},fixtures:{buyers:{b1:{customerId:customer}}},appResources:[{app:'accountA',id:family,type:'customer_session',created:true,customerId:customer,timestamp:100}]} as unknown as Driver;
  assert.equal(assertAppFamily(d,family),100);
  for(const patch of [{owned:false},{createdBy:'foreign'},{purpose:'own-public-refresh-family'},{sandboxId:'foreign'}]) {Object.assign(resource,patch);assert.throws(()=>assertAppFamily(d,family),{status:'BLOCKED',code:'RUN_OWNED_APP_MINTED_BUYER_SESSION_REQUIRED'});Object.assign(resource,{owned:true,createdBy:run,purpose:'app-creation',sandboxId:c.pins.A.sandboxId});}
  for(const rows of [[],[{customer_session_id:family,expires_at:1,refresh_expires_at:2},{customer_session_id:family,expires_at:1,refresh_expires_at:2}],[{customer_session_id:'../foreign',expires_at:1,refresh_expires_at:2}]])assert.throws(()=>vaultMetadata(d,rows),{code:'RUN_OWNED_APP_MINTED_BUYER_SESSION_REQUIRED'});
  d.appResources[0].customerId='other';assert.throws(()=>assertAppFamily(d,family));
  d.appResources=[];assert.throws(()=>assertAppFamily(d,family));
});
test('fixture credentials and app-session row exceptions are never admitted', () => {
  for(const value of [{secret:'synthetic'}, {nested:{refresh_token:'synthetic'}}, {customer_session_secret:'synthetic'}, ['flint_cref_PLACEHOLDER'], ['flint_test_PLACEHOLDER']]) assert.throws(()=>assertFixtureSecretsAbsent(value),{code:'FIXTURE_SECRET_FORBIDDEN'});
  for(const id of ['AC-15','AC-16']) assert.throws(()=>assertSessionExceptions([{id,acceptedByUser:true,reference:'UNIT'}]),{code:'EXCEPTION_NOT_PERMITTED_FOR_ROW'});
});
test('fresh revocation of another family is never evidence for this family', () => {
  const d={revocations:[{app:'accountA',sessionId:'cses_OTHER'}]} as Driver;
  assert.throws(()=>assertFreshRevocation(d,0,'accountA',{sessionId:family})); d.revocations.push({app:'accountA',sessionId:family});assertFreshRevocation(d,0,'accountA',{sessionId:family});
});
async function replayFixture(dir:string,reply:'reused'|'accepted'|'unknown'|409|503) {
  const c=config(dir),ledger=new Ledger(join(dir,'ledger.json'),run);
  for(const [id,type] of [[customer,'customer'],[family,'customer_session']]) await ledger.record({resource:id,type,mode:'test',sandbox:'A',merchant:c.pins.A.merchantId,sandboxId:c.pins.A.sandboxId,createdBy:run,purpose:'app-creation',cleanup:'review',owner:'unit',reviewAt:'2001-01-01T00:00:00Z',owned:true});
  const cleanup:string[]=[];
  const operatorClient={customerSessions:{revoke:async(id:string)=>{cleanup.push(id);return {customer_session_id:id,revoked:true};}},customers:{revokeSessions:async(id:string)=>{cleanup.push(id);return {customer_id:id,revoked_count:'1'};}}};
  const operator={ledger,clients:{writable:async()=>operatorClient}};
  const d=new Driver(c,{buyers:{b1:{customerId:customer}}} as any,{} as any,operator as any);
  let attempts=0;
  const anonymous=anonymousSessionClient(undefined,async(input,init)=>{
    attempts++; const request=new Request(input,init);assert.equal(request.headers.get('authorization'),null);assert.match(request.headers.get('idempotency-key')!,new RegExp(`^fx-${run}-A-`));assert.equal(request.headers.get('idempotency-key')!.startsWith('idem_'),false);
    assert.equal(ledger.state.actions['A:ac15-superseded-refresh-replay'].phase,'unknown');
    const persisted=await readFile(ledger.file,'utf8');assert.equal(persisted.includes('flint_cref_'),false);assert.equal(persisted.includes('refresh_token_hash'),false);
    if(reply==='unknown') throw new Error('flint_cref_PLACEHOLDER raw private transport');
    if(typeof reply==='number') return Response.json({error:{code:'UNAVAILABLE',message:'synthetic'}},{status:reply});
    return Response.json(reply==='accepted'?{data:{secret:'flint_cses_PLACEHOLDER',refresh_token:'flint_cref_PLACEHOLDER'}}:{error:{code:'CUSTOMER_SESSION_REFRESH_REUSED',message:'synthetic'}},{status:reply==='accepted'?200:401});
  });
  const result=await replayAppRefresh(d,anonymous,new SealedCredential('flint_cref_PLACEHOLDER'),family).then(()=>undefined,code);
  return {result,cleanup,ledger,attempts};
}
test('superseded replay uses anonymous SDK authority and records a durable rejected action',async()=>temp(async dir=>{
  const r=await replayFixture(dir,'reused');assert.equal(r.result,undefined);assert.equal(r.attempts,1);assert.equal(r.ledger.state.actions['A:ac15-superseded-refresh-replay'].phase,'rejected');
  const text=await readFile(r.ledger.file,'utf8');assert.equal(/flint_(?:cses|cref)_/.test(text),false);
}));
test('accepted superseded replay fails and revokes exactly the owned app family',async()=>temp(async dir=>{
  const r=await replayFixture(dir,'accepted');assert.equal(r.result,'SUPERSEDED_REFRESH_ACCEPTED');assert.deepEqual(r.cleanup,[family]);assert.equal((await readFile(r.ledger.file,'utf8')).includes('flint_cses_'),false);
}));
test('unknown replay is never resent and can only abandon after owned revoke-all reconciliation',async()=>temp(async dir=>{
  const r=await replayFixture(dir,'unknown');assert.equal(r.result,'REPLAY_OUTCOME_UNKNOWN');assert.deepEqual(r.cleanup,[customer]);assert.equal(r.attempts,1);assert.equal(r.ledger.state.actions['A:ac15-superseded-refresh-replay'].phase,'abandoned');
  await assert.rejects(()=>r.ledger.action('ac15-superseded-refresh-replay','A','customerSessions.refresh',r.ledger.state.actions['A:ac15-superseded-refresh-replay'].args,async()=>{throw new Error('must not send');},async()=>{}),{code:'UNREPLAYABLE_ACTION_ABANDONED'});
  r.ledger.state.actions['A:ac15-replay-reconcile'].phase='unknown';assert.throws(()=>r.ledger.assertTracked(),{code:'UNRECONCILED_CREATION_OR_MUTATION'});
}));
for(const status of [409,503] as const) test(`ambiguous HTTP ${status} replay is reconciled without resending sealed authority`,async()=>temp(async dir=>{
  const r=await replayFixture(dir,status);
  assert.equal(r.result,'REPLAY_OUTCOME_UNKNOWN');assert.deepEqual(r.cleanup,[customer]);assert.equal(r.attempts,1);
  assert.equal(r.ledger.state.actions['A:ac15-superseded-refresh-replay'].phase,'abandoned');
  assert.equal(r.ledger.state.actions['A:ac15-replay-reconcile'].phase,'known');
  await assert.rejects(()=>r.ledger.action('ac15-superseded-refresh-replay','A','customerSessions.refresh',r.ledger.state.actions['A:ac15-superseded-refresh-replay'].args,async()=>{throw new Error('must not send');},async()=>{}),{code:'UNREPLAYABLE_ACTION_ABANDONED'});
  assert.equal(/flint_(?:cses|cref)_/.test(await readFile(r.ledger.file,'utf8')),false);
}));
test('current app authority must fail with exact API status and code after revocation',async()=>{
  for(const response of [Response.json({data:{customer_id:customer,email:'unit@example.invalid',version:'1'}}),Response.json({error:{code:'OTHER',message:'synthetic'}},{status:401})]) {
    const anon=anonymousSessionClient(undefined,async(input,init)=>{assert.equal(new Request(input,init).headers.get('authorization'),'Bearer flint_cses_PLACEHOLDER');return response;});
    await assert.rejects(()=>assertAppSecretInvalid(anon,new SealedCredential('flint_cses_PLACEHOLDER'),'OLD_APP_SECRET_STILL_VALID'),{code:'OLD_APP_SECRET_STILL_VALID'});
  }
  const anon=anonymousSessionClient(undefined,async()=>Response.json({error:{code:'INVALID_CUSTOMER_SESSION',message:'synthetic'}},{status:401}));await assertAppSecretInvalid(anon,new SealedCredential('flint_cses_PLACEHOLDER'),'UNIT');
  const failure=await sessionCall(async()=>{throw Object.assign(new Error('raw flint_cses_PLACEHOLDER'),{code:'INVALID_CUSTOMER_SESSION',meta:{status:401},request:{headers:{authorization:'flint_cses_PLACEHOLDER'}}});}).catch(e=>e);
  assert.deepEqual(failure,{status:401,code:'INVALID_CUSTOMER_SESSION',requestId:undefined});assert.equal(JSON.stringify(failure).includes('flint_cses_'),false);
});
test('refresh evidence needs exactly one resolved automatic refresh in the same family',()=>{
  const event={app:'accountA',operation:'CUSTOMER_SESSION_REFRESH',fingerprint:'unit',timestamp:100,status:200,resolvedAt:200};
  const d={appMutations:[event],appResources:[{app:'accountA',type:'customer_session',id:family,created:true,timestamp:150}]} as Driver;assertRefreshRotation(d,0,family);
  d.appResources[0].id='other';assert.throws(()=>assertRefreshRotation(d,0,family),{code:'APP_REFRESH_FAMILY_CHANGED'});
  d.appResources[0].id=family;d.appMutations.push(event);assert.throws(()=>assertRefreshRotation(d,0,family),{code:'APP_AUTOMATIC_REFRESH_NOT_OBSERVED'});
});

test('a refresh during quiescence fails the real-TTL row', () => {
  const d={appMutations:[{app:'accountA',operation:'CUSTOMER_SESSION_REFRESH'}]} as Driver;
  assert.throws(()=>assertNoEarlyRefresh(d,0),{code:'EARLY_REFRESH_DURING_WAIT'});assertNoEarlyRefresh(d,1);
});
test('each sign-out CSRF negative must reject without changing the app vault',async()=>{
  const secret=new SealedCredential('synthetic'),reader={metadata:async()=>({familyId:family}),readVault:async()=>({familyId:family,secret}),count:async()=>1};
  for(const status of [200,302,401,500]) await assert.rejects(()=>assertSignoutNegative(reader as any,{} as Driver,{} as any,secret,family,1,0,async()=>status),{code:'ACCOUNT_CSRF_NOT_REJECTED'});
  for(const change of [{familyId:'other',secret},{familyId:family,secret:new SealedCredential('changed')}]) await assert.rejects(()=>assertSignoutNegative({...reader,readVault:async()=>change} as any,{} as Driver,{} as any,secret,family,1,0,async()=>403),{code:'ACCOUNT_CSRF_NOT_REJECTED'});
  await assert.rejects(()=>assertSignoutNegative({...reader,count:async()=>0} as any,{} as Driver,{} as any,secret,family,1,0,async()=>403),{code:'ACCOUNT_CSRF_NOT_REJECTED'});
});
test('sign-out must revoke this exact family and must not leave a pending queue or vault',()=>{
  const d={revocations:[{app:'accountA',sessionId:family}]} as Driver;assertSignoutRevoked(d,0,family,0,0);
  for(const [pending,vaults] of [[1,0],[0,1]]) assert.throws(()=>assertSignoutRevoked(d,0,family,pending,vaults),{code:'APP_SIGNOUT_DID_NOT_REVOKE_EXACT_SESSION'});
  d.revocations[0].sessionId='other';assert.throws(()=>assertSignoutRevoked(d,0,family,0,0));
});

// Synthetic ports exercise the same transition logic without starting apps or calling staging.
class Locator {
  async _expect(): Promise<any> { return {matches:true,received:'synthetic',log:[]}; }
}
async function flowFixture(dir: string, options: {early?: boolean; changedFamily?: boolean; staySignedIn?: boolean; csrfStatus?: number; queued?: boolean; oldAccepted?: boolean} = {}) {
  const c=config(dir), ledger=new Ledger(join(dir,'ledger.json'),run), epoch=Date.now(); let clock=epoch, rotated=false, revoked=false, url=c.origins.accountA+'/';
  for(const [id,type] of [[customer,'customer'],[family,'customer_session']]) await ledger.record({resource:id,type,mode:'test',sandbox:'A',merchant:c.pins.A.merchantId,sandboxId:c.pins.A.sandboxId,createdBy:run,purpose:'app-creation',cleanup:'review',owner:'unit',reviewAt:'2100-01-01T00:00:00Z',owned:true});
  const d=new Driver(c,{buyers:{b1:{customerId:customer}}} as any,{} as any,{ledger,clients:{requestIds:new Set(),writable:async()=>({})}} as any);
  const page={url:()=>url,goto:async(next:string)=>{url=next;},getByTestId:()=>new Locator(),request:{post:async()=>({status:()=>options.csrfStatus??403,text:async()=>''})}};
  d.page=async()=>page as any;d.login=async()=>{url=c.origins.accountA+'/';};d.csrf=async()=>'synthetic-csrf';d.guardCheck=async()=>{};
  d.goto=async(_page,_origin,path)=>{
    if(clock>=epoch+360000&&!rotated&&!revoked&&path==='/orders') {rotated=true;d.appMutations.push({app:'accountA',operation:'CUSTOMER_SESSION_REFRESH',fingerprint:'synthetic',timestamp:clock,status:200,resolvedAt:clock+1});d.appResources.push({app:'accountA',type:'customer_session',id:options.changedFamily?'other':family,created:true,customerId:customer,timestamp:clock});}
    url=revoked&&!options.staySignedIn?c.origins.accountA+'/sign-in?notice=session_ended&next=%2Forders':c.origins.accountA+path;
  };
  d.job=async()=>({status:options.csrfStatus??403,body:null});
  d.form=async()=>{revoked=true;d.revocations.push({app:'accountA',sessionId:family});url=c.origins.accountA+'/sign-in?notice=signed_out';};
  const reader={
    metadata:async()=>({familyId:family,mintedAt:epoch,expiresAt:epoch+300000,refreshExpiresAt:epoch+86400000}),
    readVault:async()=>({familyId:rotated&&options.changedFamily?'other':family,mintedAt:epoch,expiresAt:rotated?clock+300000:epoch+300000,refreshExpiresAt:epoch+86400000,secret:new SealedCredential(rotated?'flint_cses_ROTATED_PLACEHOLDER':'flint_cses_PLACEHOLDER',[d.scanner]),refreshToken:new SealedCredential(rotated?'flint_cref_ROTATED_PLACEHOLDER':'flint_cref_PLACEHOLDER',[d.scanner])}),
    count:async(kind:string)=>kind==='pendingCount'?(options.queued?1:0):revoked?0:1,
  };
  const anonymous=anonymousSessionClient(undefined,async(input,init)=>{
    const request=new Request(input,init);
    if(request.url.endsWith('/customer-sessions/refresh')){assert.equal(request.headers.get('authorization'),null);revoked=true;return Response.json({error:{code:'CUSTOMER_SESSION_REFRESH_REUSED',message:'synthetic'}},{status:401});}
    assert.ok(request.headers.get('authorization')?.startsWith('Bearer flint_cses_'));
    return revoked&&!options.oldAccepted?Response.json({error:{code:'INVALID_CUSTOMER_SESSION',message:'synthetic'}},{status:401}):Response.json({data:{customer_id:customer,email:'unit@example.invalid',version:'1'}});
  });
  let boundaryCalls=0,verifyCalls=0,scanCalls=0;
  const ports={reader,anonymous,now:()=>clock,wait:async(ms:number)=>{clock+=ms;if(options.early&&!d.appMutations.length)d.appMutations.push({app:'accountA',operation:'CUSTOMER_SESSION_REFRESH',fingerprint:'early',timestamp:clock});},sync:async()=>{},verify:async()=>{verifyCalls++;},scan:async()=>{scanCalls++;for(const name of ['ledger.json','ledger.md'])assert.equal(/flint_(?:cses|cref)_/.test(await readFile(join(dir,name),'utf8')),false);d.scanner.assertClean();},boundary:async()=>{boundaryCalls++;}};
  return {d,ports,counts:()=>({boundaryCalls,verifyCalls,scanCalls}),reset:()=>{rotated=false;revoked=false;clock=epoch;url=c.origins.accountA+'/';d.appMutations=[];d.revocations=[];d.appResources=[];}};
}
test('full injected app replay and sign-out transitions produce only nonsecret evidence and stdout',async()=>temp(async dir=>{
  const flow=await flowFixture(dir),captured:string[]=[],original=process.stdout.write;
  process.stdout.write=((value:any)=>{captured.push(String(value));return true;}) as typeof process.stdout.write;
  try{
    const replay=await runAppRefreshTransition(flow.d,flow.ports);assert.ok(replay.includes('APP_CURRENT_SECRET_INVALID_AFTER_REUSE'));
    flow.reset();const signout=await runAppSignoutTransition(flow.d,flow.ports);assert.ok(signout.includes('OLD_APP_SECRET_INVALID_CUSTOMER_SESSION'));
    assert.equal(flow.counts().boundaryCalls,1);assert.equal(flow.counts().verifyCalls,3);assert.equal(flow.counts().scanCalls,3);
    for(const name of ['ledger.json','ledger.md'])assert.equal(/flint_(?:cses|cref)_/.test(await readFile(join(dir,name),'utf8')),false);
    assert.equal(/flint_(?:cses|cref)_/.test(captured.join('')),false);
  }finally{process.stdout.write=original;}
}));
test('injected replay row fails on early refresh, changed family, usable authority and a signed-in next page',async()=>{
  for(const [options,expected] of [
    [{early:true},'EARLY_REFRESH_DURING_WAIT'],[{changedFamily:true},'APP_REFRESH_FAMILY_CHANGED'],[{oldAccepted:true},'REUSE_DID_NOT_REVOKE_APP_FAMILY'],[{staySignedIn:true},'APP_DID_NOT_END_SESSION_AFTER_FAMILY_REVOCATION'],
  ] as const)await temp(async dir=>{const f=await flowFixture(dir,options);const original=process.stdout.write;process.stdout.write=(()=>true) as typeof process.stdout.write;try{await assert.rejects(()=>runAppRefreshTransition(f.d,f.ports),{code:expected});}finally{process.stdout.write=original;}});
});
test('injected sign-out row fails on an accepted CSRF negative, queued revocation or usable old app secret',async()=>{
  for(const [options,expected] of [[{csrfStatus:200},'ACCOUNT_CSRF_NOT_REJECTED'],[{queued:true},'APP_SIGNOUT_DID_NOT_REVOKE_EXACT_SESSION'],[{oldAccepted:true},'OLD_APP_SECRET_STILL_VALID']] as const)await temp(async dir=>{const f=await flowFixture(dir,options);await assert.rejects(()=>runAppSignoutTransition(f.d,f.ports),{code:expected});});
});

test('procfs filesystem root is injectable and descriptors prove the socket and database inode',async()=>temp(async dir=>{
  const root=join(dir,'proc'),uid=process.getuid!(),db=join(dir,'identity-a.sqlite');await writeFile(db,'synthetic',{mode:0o600});
  await mkdir(join(root,'101/fd'),{recursive:true});await mkdir(join(root,'net'));
  await writeFile(join(root,'stat'),'btime 1000\n');await writeFile(join(root,'101/status'),`PPid:\t100\nUid:\t${uid} ${uid} ${uid} ${uid}\n`);
  await writeFile(join(root,'101/cmdline'),Buffer.from(`${process.execPath}\0synthetic.ts\0`));await writeFile(join(root,'101/stat'),`101 (synthetic) S ${[...Array(18).fill('0'),'1234'].join(' ')}`);
  await symlink(checkoutRoot,join(root,'101/cwd'));await symlink(process.execPath,join(root,'101/exe'));await symlink(db,join(root,'101/fd/0'));await symlink('socket:[123]',join(root,'101/fd/1'));
  await writeFile(join(root,'net/tcp'),'header\n0: 0100007F:1068 00000000:0000 0A 0 0 0 10 0 123\n');await writeFile(join(root,'net/tcp6'),'header\n');
  const proc=new Procfs(root),info=await stat(db);assert.equal(await proc.available(),true);assert.equal((await proc.process(101)).startedAt,1012340);assert.equal(await proc.listens(101,4200),true);assert.equal(await proc.listens(101,4201),false);assert.equal(await proc.holds(101,info.dev,info.ino),true);assert.deepEqual(await proc.holders(info.dev,info.ino,uid),[101]);
}));

test('static vault boundaries reject secret sinks, forbidden tables, another SQLite importer and configurable clocks',()=>{
  for(const text of [
    'import {DatabaseSync} from "node:sqlite";',
    'const table="identity_actions";',
    'const held=await reader.readVault(); page.evaluate(()=>{},held.secret);',
    'const held=await reader.readVault(); ledger.action("n","A","op",[held.secret],()=>{});',
    'const held=await reader.readVault(); d.created.set("authority",held.secret);',
    'const held=await reader.readVault(); held.secret.use(value=>process.stdout.write(value));',
    'const held=await reader.readVault(); d.authority=held;',
  ])assert.throws(()=>validateVaultSources([{path:'/synthetic/support/other.ts',text}]));
  assert.throws(()=>validateVaultSources([{path:'/synthetic/scenarios/account.ts',text:'async function appRefreshAcceptance(){await config.sleep(config.delay)}'}]),{code:'APP_SESSION_REAL_TIMER_REQUIRED'});
  validateVaultSources([{path:'/synthetic/support/other.ts',text:'const held=await reader.readVault(); ledger.action("n","A","op",[{customer_session_id:held.familyId}],()=>{});'}]);
});
