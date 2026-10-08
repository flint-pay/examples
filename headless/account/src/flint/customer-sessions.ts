import type {Client,CustomerSession,RequestOptions} from '@flintpay/node';
import type {Config} from '../config.ts';
import {IdentityStore,digest} from '../identity/index.ts';
import type {User,CustomerVault} from '../identity/index.ts';
import {ResourceLocks} from '../store/db.ts';
import type {Auth} from './auth.ts';
import {LocalError} from './errors.ts';
export class CustomerSessions {
  identity:IdentityStore;client:Client;auth:Auth;config:Config;sandboxId:string;locks:ResourceLocks;
  constructor(identity:IdentityStore,client:Client,auth:Auth,config:Config,sandboxId:string){this.identity=identity;this.client=client;this.auth=auth;this.config=config;this.sandboxId=sandboxId;this.locks=new ResourceLocks(identity.db);identity.db.exec('CREATE TABLE IF NOT EXISTS account_customer_session_generation(user_id TEXT NOT NULL,sandbox_id TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(user_id,sandbox_id)); CREATE TABLE IF NOT EXISTS account_pending_revocations(customer_session_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,sandbox_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,created_at INTEGER NOT NULL)');}
  save(user:User,session:CustomerSession):CustomerVault {
    if(session.customer_id!==user.flint_customer_id)throw new LocalError('INVALID_CUSTOMER_SESSION',401);
    const vault={user_id:user.user_id,sandbox_id:this.sandboxId,customer_session_id:session.customer_session_id,secret:session.secret,refresh_token:session.refresh_token,expires_at:Date.parse(session.expires_at),refresh_expires_at:Date.parse(session.refresh_token_expires_at)};
    if(!Number.isFinite(vault.expires_at)||!Number.isFinite(vault.refresh_expires_at))throw new LocalError('INVALID_CUSTOMER_SESSION',401);
    this.identity.saveVault(vault);return vault;
  }
  resetVault(user:User){this.identity.db.prepare('INSERT INTO account_customer_session_generation(user_id,sandbox_id,generation) VALUES(?,?,2) ON CONFLICT(user_id,sandbox_id) DO UPDATE SET generation=generation+1').run(user.user_id,this.sandboxId);this.identity.deleteVault(user.user_id,this.sandboxId);}
  invalidate(user:User){this.identity.db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.user_id);this.resetVault(user);}
  async handle(user:User,error:unknown):Promise<never>{
    const code=error&&typeof error==='object'&&'code'in error?String(error.code):'';
    if(code==='CUSTOMER_SESSION_REFRESH_REUSED'){
      // The binding comes from verified local identity, never a caller's customer selector.
      await this.client.customers.revokeSessions(user.flint_customer_id!,undefined,this.auth.merchant(this.identity.actionKey(`revoke-reused:${user.user_id}:${digest(this.identity.vault(user.user_id,this.sandboxId)?.refresh_token??'')}`))).catch(()=>{});
      console.warn(JSON.stringify({event:'customer_session_refresh_reused'}));
    }
    if(['CUSTOMER_SESSION_REFRESH_REUSED','CUSTOMER_SESSION_REFRESH_EXPIRED','INVALID_CUSTOMER_SESSION'].includes(code)){this.invalidate(user);throw new LocalError('SESSION_ENDED',401);}
    throw error;
  }
  async vault(user:User,forceSecret?:string):Promise<CustomerVault>{
    if(!this.identity.isBound(this.identity.user(user.user_id),this.sandboxId))throw new LocalError('SESSION_ENDED',401);
    return this.locks.locked(`customer-session:${this.sandboxId}:${user.user_id}`,async assertOwnership=>{
      const vault=this.identity.vault(user.user_id,this.sandboxId);
      try{
        assertOwnership();
        if(!vault){
          this.identity.db.prepare('INSERT OR IGNORE INTO account_customer_session_generation VALUES(?,?,1)').run(user.user_id,this.sandboxId);
          const generation=(this.identity.db.prepare('SELECT generation FROM account_customer_session_generation WHERE user_id=? AND sandbox_id=?').get(user.user_id,this.sandboxId) as {generation:number}).generation;
          const key=this.identity.actionKey(`session-create:${this.sandboxId}:${user.user_id}:${generation}`);
          const session=await this.client.customerSessions.create({customer_id:user.flint_customer_id!,expires_in_seconds:String(this.config.sessionTtl)},this.auth.merchant(key));
          return this.save(user,session);
        }
        if(vault.refresh_expires_at<=Date.now())throw new LocalError('CUSTOMER_SESSION_REFRESH_EXPIRED',401);
        if(vault.expires_at>Date.now()+60000&&(!forceSecret||forceSecret!==vault.secret))return vault;
        const key=this.identity.actionKey(`session-refresh:${this.sandboxId}:${digest(vault.refresh_token)}`);
        const session=await this.client.customerSessions.refresh({refresh_token:vault.refresh_token},{idempotencyKey:key});
        assertOwnership();return this.save(user,session);
      }catch(error){
        if(!vault){const deletions=await this.client.customerDeletionRequests.list({customer_id:user.flint_customer_id!,status:'completed'},this.auth.merchant()).catch(()=>null);if(deletions?.data.length){this.identity.db.prepare("UPDATE users SET status='closed' WHERE user_id=?").run(user.user_id);this.invalidate(user);throw new LocalError('ACCOUNT_CLOSED',401);}}
        return this.handle(user,error);}
    });
  }
  async call<T>(user:User,fn:(options:RequestOptions<'customer'>)=>Promise<T>,key?:string):Promise<T>{
    let vault=await this.vault(user);
    try{return await fn(key?this.auth.customer(vault.secret,key):this.auth.customer(vault.secret));}
    catch(error){
      const code=error&&typeof error==='object'&&'code'in error?error.code:undefined;
      const latest=this.identity.vault(user.user_id,this.sandboxId);
      if(code==='CUSTOMER_SESSION_EXPIRED'||code==='INVALID_CUSTOMER_SESSION'&&latest&&latest.secret!==vault.secret){
        vault=await this.vault(user,vault.secret);
        try{return await fn(key?this.auth.customer(vault.secret,key):this.auth.customer(vault.secret));}catch(retryError){return this.handle(user,retryError);}
      }
      return this.handle(user,error);
    }
  }
  async revoke(user:User){
    await this.locks.locked(`customer-session:${this.sandboxId}:${user.user_id}`,async()=>{
      const vault=this.identity.vault(user.user_id,this.sandboxId);
      try{if(vault){
        const key=this.identity.actionKey(`revoke:${vault.customer_session_id}`);
        this.identity.db.prepare('INSERT OR IGNORE INTO account_pending_revocations VALUES(?,?,?,?,?)').run(vault.customer_session_id,user.user_id,this.sandboxId,key,Date.now());
        await this.client.customerSessions.revoke(vault.customer_session_id,undefined,this.auth.merchant(key));
        this.identity.db.prepare('DELETE FROM account_pending_revocations WHERE customer_session_id=?').run(vault.customer_session_id);
      }}finally{this.resetVault(user);}
    });
  }
  async sweep(){
    const revocations=this.identity.db.prepare('SELECT customer_session_id,idempotency_key FROM account_pending_revocations WHERE sandbox_id=?').all(this.sandboxId) as {customer_session_id:string;idempotency_key:string}[];
    for(const pending of revocations){await this.client.customerSessions.revoke(pending.customer_session_id,undefined,this.auth.merchant(pending.idempotency_key));this.identity.db.prepare('DELETE FROM account_pending_revocations WHERE customer_session_id=?').run(pending.customer_session_id);}
    const vaults=this.identity.db.prepare('SELECT * FROM customer_session_vault WHERE sandbox_id=? AND user_id NOT IN (SELECT user_id FROM sessions WHERE expires_at>?)').all(this.sandboxId,Date.now()) as CustomerVault[];
    for(const vault of vaults){const user=this.identity.user(vault.user_id);if(user)await this.revoke(user);}
  }
}
