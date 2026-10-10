import {assertChallengeLogs} from './challenge-hygiene.ts';
import type {ChallengeRow} from './challenge-hygiene.ts';
import { DatabaseSync } from 'node:sqlite';
import { timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';
import type { Stats } from 'node:fs';
import { constants } from 'node:fs';
import { lstat, realpath, readdir, readFile, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@flintpay/node';
import { alias, API_ORIGIN } from './config.ts';
import type { Config } from './config.ts';
import type { Driver } from './driver.ts';
import { HarnessError, invariant, apiFailure } from './safe.ts';
import { privateDirectory, checkoutRoot, readPrivate } from './private-files.ts';
import { Procfs } from './procfs.ts';
import { assertPairLock } from './lock.ts';
import { verifySourceCheckout } from './source.ts';
import { pinnedFetch } from './sdk.ts';
import { CredentialScanner } from './credential-scan.ts';
import { syncAppAudit } from './audit-feed.ts';

export const VAULT_QUERIES = Object.freeze({
  authority: "SELECT v.customer_session_id, v.secret, v.refresh_token, v.expires_at, v.refresh_expires_at FROM customer_session_vault v JOIN users u ON u.user_id = v.user_id WHERE u.email = ? AND u.flint_customer_id = ? AND u.flint_sandbox_id = ? AND v.sandbox_id = ? AND u.status = 'active'",
  metadata: "SELECT v.customer_session_id, v.expires_at, v.refresh_expires_at FROM customer_session_vault v JOIN users u ON u.user_id = v.user_id WHERE u.email = ? AND u.flint_customer_id = ? AND u.flint_sandbox_id = ? AND v.sandbox_id = ? AND u.status = 'active'",
  vaultCount: 'SELECT COUNT(*) AS n FROM customer_session_vault v JOIN users u ON u.user_id = v.user_id WHERE u.email = ? AND v.sandbox_id = ?',
  sessionCount: 'SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.user_id = s.user_id WHERE u.email = ?',
  pendingCount: 'SELECT COUNT(*) AS n FROM account_pending_revocations WHERE customer_session_id = ?',
});
export type VaultRow = 'AC-15' | 'AC-16'|ChallengeRow;
export class VaultGateError extends HarnessError {
  readonly status: 'PENDING' | 'BLOCKED' | 'FAIL';
  constructor(code: string, status: VaultGateError['status'] = 'FAIL') { super(code); this.status = status; }
}
function gate(ok: unknown, code: string, status: VaultGateError['status'] = 'FAIL'): asserts ok { if (!ok) throw new VaultGateError(code, status); }
export function vaultReadScope(value: string | undefined): Set<VaultRow> {
  if (!value) return new Set();
  const parts = value.split(',');
  gate(parts.length <= 4 && new Set(parts).size === parts.length && parts.every(p => p === 'AC-15' || p === 'AC-16'||p==='SF-GIFTCHALLENGE'||p==='AC-GIFTCHALLENGE'), 'APP_VAULT_READ_SCOPE_INVALID');
  return new Set(parts as VaultRow[]);
}
export async function authorizeVaultRow(config: Pick<Config, 'appVaultRead' | 'suite'>, row: VaultRow, platform = process.platform, proc = new Procfs()): Promise<void> {
  gate(vaultReadScope(config.appVaultRead).has(row) && (row !== 'AC-15' || config.suite === 'extended'), 'APP_VAULT_READ_NOT_AUTHORIZED_FOR_ROW', 'PENDING');
  gate(platform === 'linux' && await proc.available(), 'APP_VAULT_OWNERSHIP_PROOF_REQUIRES_LINUX_PROCFS', 'BLOCKED');
}
export class SealedCredential {
  #value: string;
  constructor(value: string, scanners: CredentialScanner[] = []) {
    gate(typeof value === 'string' && value.length > 0, 'APP_VAULT_AUTHORITY_INVALID'); this.#value = value;
    for (const scanner of scanners) scanner.addCredential(value);
    Object.freeze(this);
  }
  use<T>(fn: (value: string) => T): T { return fn(this.#value); }
  equals(other: SealedCredential): boolean { const a = Buffer.from(this.#value), b = Buffer.from(other.#value); return a.length === b.length && timingSafeEqual(a, b); }
  toJSON(): never { throw new HarnessError('SEALED_CREDENTIAL_SERIALIZATION'); }
  [Symbol.toPrimitive](): never { throw new HarnessError('SEALED_CREDENTIAL_SERIALIZATION'); }
  [inspect.custom](): string { return '[sealed]'; }
}
export function anonymousSessionClient(ids?: Set<string>, transport: typeof fetch = fetch): Client {
  return new Client({ baseUrl: API_ORIGIN, transport: pinnedFetch(transport, ids), maxAttempts: 1, timeoutMs: 30_000 });
}
export async function sessionCall<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); } catch (error) { throw apiFailure(error); }
}
export type OwnedChild = { name: string; pid: number; port: number; origin: string; artifact_id: string; identity_file: string; app_database_file: string };
export type OwnedApps = { schema_version: 1; run: string; target_commit: string; launcher_pid: number; private_dir_realpath: string; children: OwnedChild[] };
export function validateOwnedManifest(manifest: OwnedApps, config: Config, directory: string): void {
  const keys = (v: object, expected: string[]) => Object.keys(v).sort().join(',') === [...expected].sort().join(',');
  gate(manifest && keys(manifest, ['schema_version', 'run', 'target_commit', 'launcher_pid', 'private_dir_realpath', 'children']) && manifest.schema_version === 1 && manifest.run === config.run && manifest.target_commit === config.targetCommit && manifest.private_dir_realpath === directory && Number.isSafeInteger(manifest.launcher_pid) && manifest.launcher_pid > 0 && Array.isArray(manifest.children), 'OWNED_APP_MANIFEST_MISMATCH');
  gate(manifest.children.length === 3 && new Set(manifest.children.map(c => c.name)).size === 3 && new Set(manifest.children.map(c => c.pid)).size === 3, 'OWNED_APP_MANIFEST_MISMATCH');
  for (const child of manifest.children) {
    const name = child.name as keyof Config['origins'];
    gate(keys(child, ['name', 'pid', 'port', 'origin', 'artifact_id', 'identity_file', 'app_database_file']) && ['accountA', 'storefrontA', 'storefrontB'].includes(name) && Number.isSafeInteger(child.pid) && child.pid > 0 && child.origin === config.origins[name] && child.port === Number(new URL(child.origin).port) && child.artifact_id === config.builds[name] && child.app_database_file === `${name}.sqlite` && child.identity_file === (name === 'storefrontB' ? 'identity-b.sqlite' : 'identity-a.sqlite'), 'OWNED_APP_MANIFEST_MISMATCH');
  }
}
export async function verifyOwnedProcess(config: Config, manifest: OwnedApps, proc: Procfs, health: typeof fetch = fetch,appName:'accountA'|'storefrontA'='accountA'): Promise<void> {
  try {
    const uid = process.getuid!(), account = manifest.children.find(c => c.name === appName)!;
    const [child, launcher] = await Promise.all([proc.process(account.pid), proc.process(manifest.launcher_pid)]);
    gate(child.uid === uid && child.effectiveUid === uid && child.parent === manifest.launcher_pid && launcher.uid === uid && launcher.effectiveUid === uid, 'APP_PROCESS_OWNERSHIP_UNPROVEN');
    gate(launcher.command.length === 3 && launcher.executable === await realpath(process.execPath) && (launcher.command[0] === 'node' || launcher.command[0] === process.execPath) && resolve(launcher.cwd, launcher.command[1]) === join(checkoutRoot, 'headless/e2e/scripts/apps.ts') && launcher.command[2] === '--apply', 'APP_PROCESS_OWNERSHIP_UNPROVEN');
    const expected = [process.execPath, '--import', join(checkoutRoot, 'headless/e2e/support/app-audit.ts'), join(checkoutRoot,'headless',appName==='accountA'?'account':'storefront','src/server.ts')];
    gate(child.executable === await realpath(process.execPath) && JSON.stringify(child.command) === JSON.stringify(expected) && child.cwd === await realpath(checkoutRoot) && await proc.listens(account.pid, account.port), 'APP_PROCESS_OWNERSHIP_UNPROVEN');
    const response = await health(new URL('/healthz', account.origin), { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    gate(response.ok, 'APP_PROCESS_OWNERSHIP_UNPROVEN');
    const body = await response.json() as any;
    gate(body.build?.sha === config.targetCommit && body.build?.artifactId === account.artifact_id && body.sandbox_id === config.pins.A.sandboxId && body.mode === 'test' && Number.isFinite(Date.parse(body.build?.startedAt)) && Math.abs(Date.parse(body.build.startedAt) - child.startedAt) <= 3000, 'APP_PROCESS_OWNERSHIP_UNPROVEN');
  } catch { throw new VaultGateError('APP_PROCESS_OWNERSHIP_UNPROVEN'); }
}
export type FileIdentity = { dev: number; ino: number; size: number; files?: Record<string, {dev: number; ino: number}> };
export function assertVaultPath(path: string, info: Stats, actual: string, directory: boolean, uid = process.getuid!()): void {
  gate(!info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile() && info.nlink === 1) && info.uid === uid && (info.mode & 0o077) === 0 && actual === path, 'APP_VAULT_FILE_IDENTITY_MISMATCH');
}
export async function checkVaultFiles(directory: string): Promise<FileIdentity> {
  try {
    const files: NonNullable<FileIdentity['files']> = {};
    for (const suffix of ['', '/identity-a.sqlite', '/identity-a.sqlite-wal', '/identity-a.sqlite-shm']) {
      const path = directory + suffix, info = await lstat(path);
      assertVaultPath(path, info, await realpath(path), !suffix); files[suffix] = { dev: info.dev, ino: info.ino };
    }
    const info = await lstat(join(directory, 'identity-a.sqlite')); return { dev: info.dev, ino: info.ino, size: info.size, files };
  } catch { throw new VaultGateError('APP_VAULT_FILE_IDENTITY_MISMATCH'); }
}
export function assertSameFile(before: FileIdentity, after: FileIdentity): void { gate(before.dev === after.dev && before.ino === after.ino && after.size >= before.size && Object.entries(before.files ?? {}).every(([path, info]) => after.files?.[path]?.dev === info.dev && after.files?.[path]?.ino === info.ino), 'APP_VAULT_FILE_IDENTITY_MISMATCH'); }
export async function verifyVaultHolders(info: FileIdentity, manifest: OwnedApps, proc: Procfs): Promise<void> {
  try {
    const account = manifest.children.find(c => c.name === 'accountA')!;
    gate(await proc.holds(account.pid, info.dev, info.ino), 'APP_VAULT_FILE_IDENTITY_MISMATCH');
  } catch { throw new VaultGateError('APP_VAULT_FILE_IDENTITY_MISMATCH'); }
}
export async function verifyVaultAuthority(d: Driver, row: VaultRow): Promise<{ directory: string; manifest: OwnedApps; proc: Procfs }> {
  const proc = new Procfs(); await authorizeVaultRow(d.config, row, process.platform, proc);
  try { verifySourceCheckout(d.config); await assertPairLock(d.config); gate(d.operator.ledger.state.run === d.config.run, 'REVIEWED_SOURCE_CHECKOUT_REQUIRED'); }
  catch { throw new VaultGateError('REVIEWED_SOURCE_CHECKOUT_REQUIRED'); }
  await checkVaultFiles(resolve(d.config.privateDir));
  const directory = await privateDirectory(d.config.privateDir);
  let manifest: OwnedApps;
  try { manifest = await readPrivate<OwnedApps>(join(directory, 'owned-apps.json')); validateOwnedManifest(manifest, d.config, directory); }
  catch { throw new VaultGateError('OWNED_APP_MANIFEST_MISMATCH'); }
  await verifyOwnedProcess(d.config, manifest, proc);
  await verifyVaultHolders(await checkVaultFiles(directory), manifest, proc);
  return { directory, manifest, proc };
}
export function assertAppFamily(d: Driver, familyId: string): number {
  const owned = d.operator.ledger.state.resources.find(r => r.resource === familyId && r.type === 'customer_session' && r.sandbox === 'A');
  const events = d.appResources.filter(e => e.app === 'accountA' && e.id === familyId && e.type === 'customer_session' && e.created && e.customerId === d.fixtures.buyers.b1.customerId);
  gate(owned?.owned && owned.createdBy === d.config.run && owned.purpose === 'app-creation' && owned.sandboxId === d.config.pins.A.sandboxId && events.length > 0 && events.every(e => Number.isFinite(e.timestamp)), 'RUN_OWNED_APP_MINTED_BUYER_SESSION_REQUIRED', 'BLOCKED');
  gate(!d.operator.ledger.state.resources.some(r => r.resource === familyId && r.purpose === 'own-public-refresh-family'), 'RUN_OWNED_APP_MINTED_BUYER_SESSION_REQUIRED', 'BLOCKED');
  return Math.min(...events.map(e => e.timestamp));
}
export type VaultMetadata = { familyId: string; expiresAt: number; refreshExpiresAt: number; mintedAt: number };
export type VaultSnapshot = VaultMetadata & { secret: SealedCredential; refreshToken: SealedCredential };
export function vaultMetadata(d: Driver, rows: Record<string, any>[]): VaultMetadata {
  gate(rows.length === 1 && /^[A-Za-z0-9_-]+$/.test(rows[0].customer_session_id) && Number.isFinite(rows[0].expires_at) && Number.isFinite(rows[0].refresh_expires_at), 'RUN_OWNED_APP_MINTED_BUYER_SESSION_REQUIRED', 'BLOCKED');
  const r = rows[0]; return { familyId: r.customer_session_id, expiresAt: r.expires_at, refreshExpiresAt: r.refresh_expires_at, mintedAt: assertAppFamily(d, r.customer_session_id) };
  }

// A reader exists only for one row. Each short read re-verifies ownership and closes SQLite.
export class AppVault {
  readonly d: Driver; readonly row: VaultRow; readonly scanner = new CredentialScanner();
  constructor(d: Driver, row: VaultRow) { this.d = d; this.row = row; }
  async buyer(): Promise<{ email: string; customerId: string; sandboxId: string }> {
    await authorizeVaultRow(this.d.config, this.row);
    const email = alias(this.d.config, 'b1'), customerId = this.d.fixtures.buyers.b1.customerId, sandboxId = this.d.config.pins.A.sandboxId;
    const resource = this.d.operator.ledger.state.resources.find(r => r.resource === customerId && r.type === 'customer' && r.sandbox === 'A');
    gate(customerId && this.d.fixtures.buyers.b1.email === email && resource?.owned && resource.createdBy === this.d.config.run && resource.sandboxId === sandboxId && resource.purpose !== 'supplied-fixture' && resource.purpose !== 'app-reference', 'RUN_OWNED_APP_MINTED_BUYER_SESSION_REQUIRED', 'BLOCKED');
    const canonicalEmail = email.trim().toLowerCase();
    const customer = await this.d.operator.clients.clients.A.customers.get(customerId);
    gate(customer.customer_id === customerId && customer.email === canonicalEmail, 'RUN_OWNED_APP_MINTED_BUYER_SESSION_REQUIRED', 'BLOCKED');
    return { email: canonicalEmail, customerId, sandboxId };
  }
  async #query<T>(kind: keyof typeof VAULT_QUERIES, args: string[], consume: (rows: Record<string, any>[]) => T): Promise<T> {
    const { directory, manifest, proc } = await verifyVaultAuthority(this.d, this.row);
    const before = await checkVaultFiles(directory);
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(join(directory, 'identity-a.sqlite'), { readOnly: true }); db.exec('PRAGMA query_only=ON');
      assertSameFile(before, await checkVaultFiles(directory)); await verifyVaultHolders(before, manifest, proc);
      gate(Object.hasOwn(VAULT_QUERIES, kind), 'APP_VAULT_QUERY_FORBIDDEN');
      return consume(db.prepare(VAULT_QUERIES[kind]).all(...args));
    } catch (error) { if (error instanceof VaultGateError || error instanceof HarnessError) throw error; throw new VaultGateError('APP_VAULT_READ_FAILED'); }
    finally {
      db?.close();
      assertSameFile(before, await checkVaultFiles(directory)); await verifyVaultHolders(before, manifest, proc);
    }
  }
  async metadata(): Promise<VaultMetadata> {
    const b = await this.buyer(); await syncAppAudit(this.d);
    return this.#query('metadata', [b.email, b.customerId, b.sandboxId, b.sandboxId], rows => vaultMetadata(this.d, rows));
  }
  async readVault(): Promise<VaultSnapshot> {
    const b = await this.buyer(); await syncAppAudit(this.d);
    return this.#query('authority', [b.email, b.customerId, b.sandboxId, b.sandboxId], rows => {
      const metadata = vaultMetadata(this.d, rows), scanners = [this.d.scanner, this.scanner];
      return { ...metadata, secret: new SealedCredential(rows[0].secret, scanners), refreshToken: new SealedCredential(rows[0].refresh_token, scanners) };
    });
  }
  async count(kind: 'vaultCount' | 'sessionCount' | 'pendingCount', familyId?: string): Promise<number> {
    const b = await this.buyer();
    const args = kind === 'pendingCount' ? [familyId!] : kind === 'vaultCount' ? [b.email, b.sandboxId] : [b.email];
    if (kind === 'pendingCount') { gate(familyId && /^[A-Za-z0-9_-]+$/.test(familyId), 'APP_VAULT_QUERY_FORBIDDEN'); assertAppFamily(this.d, familyId); }
    return this.#query(kind, args, rows => { gate(rows.length === 1 && Number.isSafeInteger(rows[0].n) && rows[0].n >= 0, 'APP_VAULT_READ_FAILED'); return rows[0].n; });
  }
}
export async function assertVaultScans(d: Driver, scanner: CredentialScanner): Promise<void> {
  await d.guardCheck(); d.scanner.assertClean(); scanner.assertClean();
  const directory = await privateDirectory(d.config.privateDir);
  const status = await readPrivate<{ run: string; updated_at: string; violation_surfaces: string[] }>(join(directory, 'owned-apps-scan.json'));
  const age = Date.now() - Date.parse(status.updated_at);
  invariant(status.run === d.config.run && age >= 0 && age <= 15_000 && Array.isArray(status.violation_surfaces) && status.violation_surfaces.length === 0, 'OWNED_APP_CREDENTIAL_SCAN_REQUIRED');
  const scan = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      // App-owned SQLite contains its vault by design and is never a harness artifact.
      if (/^(identity-[ab]|accountA|storefront[AB])\.sqlite(?:-wal|-shm)?$/.test(entry.name)) continue;
      const path = join(dir, entry.name); invariant(!entry.isSymbolicLink(), 'PRIVATE_RUN_FILE_IDENTITY_MISMATCH');
      if (entry.isDirectory()) await scan(path);
      else if (entry.isFile()) { const text = (await readFile(path)).toString('utf8'); invariant(!/flint_(?:cses|cref)_/.test(text), 'APP_AUTHORITY_SERIALIZED'); d.scanner.scan(text, 'body'); scanner.scan(text, 'body'); }
    }
  };
  await scan(directory); d.scanner.assertClean(); scanner.assertClean();
}

export async function assertGiftChallengeSqlite(directory:string,manifest:OwnedApps,proc:Procfs,row:ChallengeRow,codes:readonly string[]):Promise<void>{
  const app=row==='SF-GIFTCHALLENGE'?'storefrontA':'accountA',child=manifest.children.find(c=>c.name===app),account=manifest.children.find(c=>c.name==='accountA'),storefront=manifest.children.find(c=>c.name==='storefrontA');
  gate(child&&account&&storefront&&child.app_database_file===`${app}.sqlite`&&account.identity_file==='identity-a.sqlite'&&storefront.identity_file==='identity-a.sqlite','OWNED_APP_MANIFEST_MISMATCH');
  const identities=new Map<string,{before:FileIdentity;owners:number[]}>();
  const holders=async(info:FileIdentity,owners:number[])=>{
    gate((await Promise.all(owners.map(pid=>proc.holds(pid,info.dev,info.ino)))).every(Boolean),'APP_VAULT_FILE_IDENTITY_MISMATCH');
  };
  try{
    const vaultBefore=await checkVaultFiles(directory);await verifyVaultHolders(vaultBefore,manifest,proc);
    for(const [file,owners] of [[child.app_database_file,[child.pid]],['identity-a.sqlite',[account.pid]]] as const){
      for(const suffix of ['', '-wal','-shm']){
        const path=join(directory,file+suffix),info=await lstat(path);assertVaultPath(path,info,await realpath(path),false);
        const before={dev:info.dev,ino:info.ino,size:info.size};await holders(before,[...owners]);identities.set(path,{before,owners:[...owners]});
        const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
        try{
          const opened=await handle.stat();assertSameFile(before,{dev:opened.dev,ino:opened.ino,size:opened.size});
          const bytes=await handle.readFile(),text=bytes.toString('utf8');
          gate(!/(gccp_[A-Za-z0-9_-]+|gccf_[A-Za-z0-9_.-]+|\/gift-card-challenge\/[^\s"?#]+)/.test(text)&&codes.every(code=>!bytes.includes(Buffer.from(code))),'CHALLENGE_AUTHORITY_IN_APP_SQLITE');
        }finally{await handle.close();}
      }
    }
    for(const [path,{before,owners}] of identities){const after=await lstat(path);assertVaultPath(path,after,await realpath(path),false);assertSameFile(before,{dev:after.dev,ino:after.ino,size:after.size});await holders(before,owners);}
    assertSameFile(vaultBefore,await checkVaultFiles(directory));await verifyVaultHolders(vaultBefore,manifest,proc);
  }catch(error){if(error instanceof VaultGateError)throw error;throw new VaultGateError('APP_VAULT_FILE_IDENTITY_MISMATCH');}
}
export async function assertGiftChallengePersistence(d:Driver,row:ChallengeRow,codes:readonly string[]):Promise<void>{
  const {directory,manifest,proc}=await verifyVaultAuthority(d,row);
  await verifyOwnedProcess(d.config,manifest,proc,fetch,'storefrontA');
  await assertGiftChallengeSqlite(directory,manifest,proc,row,codes);
  await assertChallengeLogs(directory,d.config.run,d.config.targetCommit,row,codes);await assertVaultScans(d,new CredentialScanner());
}
