import {createHash,randomBytes,scrypt as nodeScrypt,timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {chmodSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

export const SESSION_TTL=30*24*60*60*1000;
const alphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function randomReference(prefix:string):string{return prefix+Array.from(randomBytes(20),byte=>alphabet[byte&31]).join('');}
export function digest(value:string):string{return createHash('sha256').update(value).digest('hex');}
export function equalSecret(a:string,b:string):boolean {
  const left=Buffer.from(a);const right=Buffer.from(b);
  return left.length===right.length&&timingSafeEqual(left,right);
}
export function normalizeEmail(value:string):string{return value.trim().toLowerCase();}
function derive(password:string,salt:Buffer):Promise<Buffer>{
  return new Promise((resolve,reject)=>nodeScrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:128*1024*1024},(error,key)=>error?reject(error):resolve(key)));
}
export async function hashPassword(password:string):Promise<string>{
  const salt=randomBytes(16);const key=await derive(password,salt);
  return `scrypt$32768$8$1$${salt.toString('hex')}$${key.toString('hex')}`;
}
export async function verifyPassword(password:string,encoded:string|undefined):Promise<boolean>{
  const parts=(encoded??'').split('$');
  const valid=parts.length===6&&parts[0]==='scrypt'&&parts[1]==='32768'&&parts[2]==='8'&&parts[3]==='1'&&/^[a-f0-9]{32}$/.test(parts[4]??'')&&/^[a-f0-9]{128}$/.test(parts[5]??'');
  const salt=valid?Buffer.from(parts[4]!, 'hex'):Buffer.alloc(16);
  const expected=valid?Buffer.from(parts[5]!, 'hex'):Buffer.alloc(64);
  const actual=await derive(password,salt);
  return timingSafeEqual(actual,expected)&&valid;
}
export type User={user_id:string;email:string;name:string;password_hash:string;created_at:number;email_verified_at:number|null;flint_customer_id:string|null;flint_sandbox_id:string|null;status:'active'|'closed'};
export type PendingVerification={customer_verification_id:string;customer_id:string;email:string;purpose:string;created_at:number;confirmed?:boolean;confirm_key?:string};
export type Session={session_hash:string;user_id:string|null;csrf_token:string;created_at:number;last_seen_at:number;expires_at:number;pending_verification:string|null;flash:string|null};
export type CustomerVault={user_id:string;sandbox_id:string;customer_session_id:string;secret:string;refresh_token:string;expires_at:number;refresh_expires_at:number};

export class IdentityStore {
  db:DatabaseSync;
  constructor(path:string){
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    if(path!==':memory:')chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(user_id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password_hash TEXT NOT NULL,created_at INTEGER NOT NULL,email_verified_at INTEGER,flint_customer_id TEXT,flint_sandbox_id TEXT,status TEXT NOT NULL DEFAULT 'active',UNIQUE(flint_sandbox_id,flint_customer_id));
      CREATE TABLE IF NOT EXISTS sessions(session_hash TEXT PRIMARY KEY,user_id TEXT,csrf_token TEXT NOT NULL,created_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,pending_verification TEXT,flash TEXT);
      CREATE TABLE IF NOT EXISTS customer_session_vault(user_id TEXT NOT NULL,sandbox_id TEXT NOT NULL,customer_session_id TEXT NOT NULL,secret TEXT NOT NULL,refresh_token TEXT NOT NULL,expires_at INTEGER NOT NULL,refresh_expires_at INTEGER NOT NULL,PRIMARY KEY(user_id,sandbox_id));
      CREATE TABLE IF NOT EXISTS identity_actions(action_key TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL,created_at INTEGER NOT NULL);
    `);
  }
  user(id:string):User|undefined{return this.db.prepare('SELECT * FROM users WHERE user_id=?').get(id) as User|undefined;}
  userByEmail(email:string):User|undefined{return this.db.prepare('SELECT * FROM users WHERE email=?').get(normalizeEmail(email)) as User|undefined;}
  async createUser(name:string,email:string,password:string):Promise<User>{
    const userId=randomReference('usr_');
    const encoded=await hashPassword(password);
    this.db.prepare('INSERT INTO users(user_id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)').run(userId,normalizeEmail(email),name.trim(),encoded,Date.now());
    return this.user(userId)!;
  }
  session(token:string|undefined):Session|undefined{
    if(!token||!/^[A-Za-z0-9_-]{43}$/.test(token))return undefined;
    const hash=digest(token);
    const row=this.db.prepare('SELECT * FROM sessions WHERE session_hash=? AND expires_at>?').get(hash,Date.now()) as Session|undefined;
    if(row){this.db.prepare('UPDATE sessions SET last_seen_at=?,expires_at=? WHERE session_hash=?').run(Date.now(),Date.now()+SESSION_TTL,hash);row.expires_at=Date.now()+SESSION_TTL;}
    return row;
  }
  createSession(userId:string|null=null):{token:string;session:Session}{
    const token=randomBytes(32).toString('base64url');const hash=digest(token);const now=Date.now();
    this.db.prepare('INSERT INTO sessions(session_hash,user_id,csrf_token,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?)').run(hash,userId,randomBytes(32).toString('base64url'),now,now,now+SESSION_TTL);
    return {token,session:this.session(token)!};
  }
  rotate(session:Session,userId:string|null):{token:string;session:Session}{
    this.db.exec('BEGIN IMMEDIATE');
    try{const next=this.createSession(userId);this.db.prepare('DELETE FROM sessions WHERE session_hash=?').run(session.session_hash);this.db.exec('COMMIT');return next;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  destroy(session:Session){this.db.prepare('DELETE FROM sessions WHERE session_hash=?').run(session.session_hash);}
  isBound(user:User|undefined,sandboxId:string):user is User{return !!user&&user.status==='active'&&!!user.email_verified_at&&!!user.flint_customer_id&&user.flint_sandbox_id===sandboxId;}
  pending(session:Session):PendingVerification|null{return session.pending_verification?JSON.parse(session.pending_verification) as PendingVerification:null;}
  setPending(session:Session,pending:PendingVerification|null){
    session.pending_verification=pending?JSON.stringify(pending):null;
    this.db.prepare('UPDATE sessions SET pending_verification=? WHERE session_hash=?').run(session.pending_verification,session.session_hash);
  }
  customerBoundElsewhere(userId:string,sandboxId:string,customerId:string):boolean{
    return !!this.db.prepare('SELECT user_id FROM users WHERE flint_sandbox_id=? AND flint_customer_id=? AND user_id<>?').get(sandboxId,customerId,userId);
  }
  bind(userId:string,sandboxId:string,customerId:string,email:string){
    const result=this.db.prepare("UPDATE users SET email_verified_at=?,flint_sandbox_id=?,flint_customer_id=? WHERE user_id=? AND email=? AND status='active'").run(Date.now(),sandboxId,customerId,userId,normalizeEmail(email));
    if(result.changes!==1)throw new Error('identity_changed');
  }
  actionKey(action:string):string{
    this.db.prepare('INSERT OR IGNORE INTO identity_actions VALUES(?,?,?)').run(action,randomReference('idem_'),Date.now());
    return (this.db.prepare('SELECT idempotency_key FROM identity_actions WHERE action_key=?').get(action) as {idempotency_key:string}).idempotency_key;
  }
  vault(userId:string,sandboxId:string):CustomerVault|undefined{return this.db.prepare('SELECT * FROM customer_session_vault WHERE user_id=? AND sandbox_id=?').get(userId,sandboxId) as CustomerVault|undefined;}
  saveVault(vault:CustomerVault){this.db.prepare('INSERT OR REPLACE INTO customer_session_vault VALUES(?,?,?,?,?,?,?)').run(vault.user_id,vault.sandbox_id,vault.customer_session_id,vault.secret,vault.refresh_token,vault.expires_at,vault.refresh_expires_at);}
  vaults(userId:string):CustomerVault[]{return this.db.prepare('SELECT * FROM customer_session_vault WHERE user_id=?').all(userId) as CustomerVault[];}
  deleteVault(userId:string,sandboxId:string){this.db.prepare('DELETE FROM customer_session_vault WHERE user_id=? AND sandbox_id=?').run(userId,sandboxId);}
  close(){this.db.close();}
}
