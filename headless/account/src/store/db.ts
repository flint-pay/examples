import {DatabaseSync} from 'node:sqlite';
import type {SQLInputValue} from 'node:sqlite';
import {chmodSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {LocalError,unknownOutcome} from '../flint/errors.ts';
export class ResourceLocks {
  db:DatabaseSync;
  constructor(db:DatabaseSync){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS account_resource_locks(resource TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at INTEGER NOT NULL)');}
  async locked<T>(resource:string,fn:(assertOwnership:()=>void)=>Promise<T>):Promise<T>{
    const owner=randomUUID(),deadline=Date.now()+15000;
    while(true){
      this.db.exec('BEGIN IMMEDIATE');let acquired=false;
      try{this.db.prepare('DELETE FROM account_resource_locks WHERE resource=? AND expires_at<?').run(resource,Date.now());acquired=this.db.prepare('INSERT OR IGNORE INTO account_resource_locks VALUES(?,?,?)').run(resource,owner,Date.now()+120000).changes===1;this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
      if(acquired)break;
      if(Date.now()>deadline)throw new LocalError('ACTION_IN_PROGRESS',409);
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    const assertOwnership=()=>{if(!this.db.prepare('SELECT owner FROM account_resource_locks WHERE resource=? AND owner=? AND expires_at>?').get(resource,owner,Date.now()))throw new LocalError('ACTION_IN_PROGRESS',409);};
    const heartbeat=setInterval(()=>this.db.prepare('UPDATE account_resource_locks SET expires_at=? WHERE resource=? AND owner=?').run(Date.now()+120000,resource,owner),20000);heartbeat.unref();
    try{return await fn(assertOwnership);}finally{clearInterval(heartbeat);this.db.prepare('DELETE FROM account_resource_locks WHERE resource=? AND owner=?').run(resource,owner);}
  }
}
export type CheckoutRecord={checkout_ref:string;user_id:string;sandbox_id:string;resource_type:'invoice'|'return';resource_id:string;resolution_id:string|null;order_id:string;checkout_session_id:string;checkout_auth_token:string;generation:number;last_attempt_id:string|null;pay_seq:number;resume_seq:number;status:string;created_at:number;updated_at:number};
export type ActionRecord={action_id:string;resource:string;kind:string;idempotency_key:string;body:string|null;body_hash:string;status:string;attempt_id:string|null;result:string|null;created_at:number;retry_after:number};
export class Store extends ResourceLocks {
  constructor(path:string){
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
    const db=new DatabaseSync(path);if(path!==':memory:')chmodSync(path,0o600);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');super(db);
    db.exec(`CREATE TABLE IF NOT EXISTS payment_checkouts(checkout_ref TEXT PRIMARY KEY,user_id TEXT NOT NULL,sandbox_id TEXT NOT NULL,resource_type TEXT NOT NULL,resource_id TEXT NOT NULL,resolution_id TEXT,order_id TEXT NOT NULL,checkout_session_id TEXT NOT NULL,checkout_auth_token TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 1,last_attempt_id TEXT,pay_seq INTEGER NOT NULL DEFAULT 0,resume_seq INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'open',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(user_id,sandbox_id,resource_type,resource_id));
      CREATE TABLE IF NOT EXISTS actions(action_id TEXT PRIMARY KEY,resource TEXT NOT NULL,kind TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,body TEXT,body_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempt_id TEXT,result TEXT,created_at INTEGER NOT NULL,retry_after INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS unresolved_payment ON actions(resource) WHERE kind IN ('pay','resume','cancel') AND status IN ('pending','unknown');
      CREATE TABLE IF NOT EXISTS pending_cards(user_id TEXT NOT NULL,sandbox_id TEXT NOT NULL,payment_method_id TEXT NOT NULL,return_to TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,sandbox_id));
      CREATE TABLE IF NOT EXISTS pending_email(user_id TEXT NOT NULL,sandbox_id TEXT NOT NULL,request TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,sandbox_id));
      CREATE TABLE IF NOT EXISTS local_email_reservations(email TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
    `);
  }
  get<T>(sql:string,...values:SQLInputValue[]):T|undefined{return this.db.prepare(sql).get(...values) as T|undefined;}
  all<T>(sql:string,...values:SQLInputValue[]):T[]{return this.db.prepare(sql).all(...values) as T[];}
  run(sql:string,...values:SQLInputValue[]){return this.db.prepare(sql).run(...values);}
  transaction<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  action(resource:string,kind:string,body:unknown,nonce?:string):ActionRecord{
    const json=JSON.stringify(body),hash=createHash('sha256').update(json).digest('hex');
    return this.transaction(()=>{
      const actionId=nonce?createHash('sha256').update(`${resource}:${kind}:${nonce}`).digest('hex'):undefined;
      const existing=actionId?this.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',actionId):this.get<ActionRecord>("SELECT * FROM actions WHERE resource=? AND kind=? AND (status IN ('pending','unknown') OR (body_hash=? AND created_at>?)) ORDER BY created_at DESC LIMIT 1",resource,kind,hash,Date.now()-600000);
      if(existing){if(existing.body_hash!==hash)throw new LocalError('ACTION_BODY_MISMATCH',409);return existing;}
      const key=randomUUID();this.run('INSERT INTO actions(action_id,resource,kind,idempotency_key,body,body_hash,created_at) VALUES(?,?,?,?,?,?,?)',actionId??key,resource,kind,key,json,hash,Date.now());
      return this.get<ActionRecord>('SELECT * FROM actions WHERE action_id=?',actionId??key)!;
    });
  }
  async mutate<T>(resource:string,kind:string,body:unknown,send:(key:string)=>Promise<T>,nonce?:string):Promise<T>{
    return this.locked(`mutation:${resource}`,async assertOwnership=>{
      const job=this.action(resource,kind,body,nonce);
      if(job.status==='succeeded')return JSON.parse(job.result!) as T;
      if(job.status==='rejected')throw new LocalError('ACTION_ALREADY_REJECTED',409);
      assertOwnership();
      try{const result=await send(job.idempotency_key);this.run("UPDATE actions SET status='succeeded',body=NULL,result=? WHERE action_id=?",JSON.stringify(result??null),job.action_id);return result;}
      catch(error){this.run('UPDATE actions SET status=?,body=CASE WHEN ? THEN body ELSE NULL END WHERE action_id=?',unknownOutcome(error)?'unknown':'rejected',unknownOutcome(error)?1:0,job.action_id);throw error;}
    });
  }
  checkout(userId:string,sandboxId:string,type:string,resourceId:string):CheckoutRecord|undefined{return this.get<CheckoutRecord>('SELECT * FROM payment_checkouts WHERE user_id=? AND sandbox_id=? AND resource_type=? AND resource_id=?',userId,sandboxId,type,resourceId);}
  close(){this.db.close();}
}
