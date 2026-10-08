import type {Client,CreateCustomerVerificationRequestInput} from '@flintpay/node';
import {SdkError} from '@flintpay/node';
import type {Auth} from './auth.ts';
import {IdentityStore,digest,randomReference} from '../identity/index.ts';
import type {User,Session} from '../identity/index.ts';
import {LocalError,unknownOutcome} from './errors.ts';
type VerificationRequest={user_id:string;sandbox_id:string;sequence:number;idempotency_key:string|null;body:string|null};
export class IdentityBinding {
  client:Client;auth:Auth;identity:IdentityStore;sandboxId:string;
  constructor(client:Client,auth:Auth,identity:IdentityStore,sandboxId:string){
    this.client=client;this.auth=auth;this.identity=identity;this.sandboxId=sandboxId;
    // Keep uncertain issuances recoverable when their identity session is replaced.
    identity.db.exec('CREATE TABLE IF NOT EXISTS storefront_verification_requests(user_id TEXT NOT NULL,sandbox_id TEXT NOT NULL,sequence INTEGER NOT NULL DEFAULT 0,idempotency_key TEXT,body TEXT,PRIMARY KEY(user_id,sandbox_id))');
  }
  verificationRequest(user:User):VerificationRequest|undefined{
    return this.identity.db.prepare('SELECT * FROM storefront_verification_requests WHERE user_id=? AND sandbox_id=?').get(user.user_id,this.sandboxId) as VerificationRequest|undefined;
  }
  pending(session:Session){
    const current=this.identity.db.prepare('SELECT * FROM sessions WHERE session_hash=? AND expires_at>?').get(session.session_hash,Date.now()) as Session|undefined;
    if(!current||current.user_id!==session.user_id)throw new LocalError('SESSION_ENDED',401);
    return this.identity.pending(current);
  }
  reserveVerification(user:User,session:Session,body:CreateCustomerVerificationRequestInput):VerificationRequest|undefined{
    this.identity.db.exec('BEGIN IMMEDIATE');
    try{
      const prior=this.pending(session);
      let request=this.verificationRequest(user);
      if(!request?.idempotency_key){
        if(prior&&Date.now()-prior.created_at<30_000){this.identity.db.exec('COMMIT');return;}
        this.identity.db.prepare('INSERT OR IGNORE INTO storefront_verification_requests(user_id,sandbox_id) VALUES(?,?)').run(user.user_id,this.sandboxId);
        this.identity.db.prepare('UPDATE storefront_verification_requests SET sequence=sequence+1,idempotency_key=?,body=? WHERE user_id=? AND sandbox_id=?').run(randomReference('idem_'),JSON.stringify(body),user.user_id,this.sandboxId);
        request=this.verificationRequest(user)!;
      }
      this.identity.db.exec('COMMIT');return request;
    }catch(error){this.identity.db.exec('ROLLBACK');throw error;}
  }
  releaseVerification(request:VerificationRequest){
    this.identity.db.prepare('UPDATE storefront_verification_requests SET idempotency_key=NULL,body=NULL WHERE user_id=? AND sandbox_id=? AND idempotency_key=?').run(request.user_id,request.sandbox_id,request.idempotency_key);
  }
  async send(user:User,session:Session){
    const prior=this.pending(session);const outstanding=this.verificationRequest(user);
    if(!outstanding?.idempotency_key&&prior&&Date.now()-prior.created_at<30_000)return;
    let body:CreateCustomerVerificationRequestInput;
    if(outstanding?.body)body=JSON.parse(outstanding.body) as CreateCustomerVerificationRequestInput;
    else{
      let customers=await this.client.customers.list({email:user.email,page_size:2},this.auth.merchant());
      if(customers.data.length>1)throw new LocalError('CUSTOMER_BINDING_AMBIGUOUS',409);
      let customer=customers.data[0];
      if(!customer){
        try{customer=await this.client.customers.create({email:user.email,name:user.name},this.auth.merchant(this.identity.actionKey(`customer-${user.user_id}`)));}
        catch(error){
          if(!(error&&typeof error==='object'&&'code'in error&&error.code==='CUSTOMER_EMAIL_ALREADY_USED'))throw error;
          customers=await this.client.customers.list({email:user.email,page_size:2},this.auth.merchant());customer=customers.data[0];
        }
      }
      if(!customer)throw new LocalError('CUSTOMER_VERIFICATION_UNAVAILABLE',503);
      body={customer_id:customer.customer_id,email:user.email,purpose:'link_guest_purchases',channel:'email'};
    }
    if(this.identity.customerBoundElsewhere(user.user_id,this.sandboxId,body.customer_id))throw new LocalError('CUSTOMER_ALREADY_BOUND',409);
    const request=this.reserveVerification(user,session,body);if(!request)return;
    body=JSON.parse(request.body!) as CreateCustomerVerificationRequestInput;
    if(this.identity.customerBoundElsewhere(user.user_id,this.sandboxId,body.customer_id))throw new LocalError('CUSTOMER_ALREADY_BOUND',409);
    let verification;
    try{verification=await this.client.customerVerifications.create(body,this.auth.merchant(request.idempotency_key!));}
    catch(error){
      if(error instanceof SdkError&&error.outcome==='response'&&!unknownOutcome(error))this.releaseVerification(request);
      throw error;
    }
    this.identity.db.exec('BEGIN IMMEDIATE');
    try{
      // A late retry response must not overwrite a newer issuance's proof.
      if(this.verificationRequest(user)?.sequence===request.sequence){
        this.identity.setPending(session,{customer_verification_id:verification.customer_verification_id,customer_id:body.customer_id,email:body.email,purpose:'link_guest_purchases',created_at:Date.now()});
        this.releaseVerification(request);
      }
      this.identity.db.exec('COMMIT');
    }catch(error){this.identity.db.exec('ROLLBACK');throw error;}
  }
  async confirm(user:User,session:Session,code:string):Promise<number>{
    const pending=this.identity.pending(session);
    if(!pending||pending.email!==user.email||pending.purpose!=='link_guest_purchases')throw new LocalError('INVALID_CUSTOMER_ACCOUNT_REQUEST');
    if(!/^\d{6}$/.test(code))throw new LocalError('CUSTOMER_VERIFICATION_CODE_INVALID');
    if(!pending.confirmed){
      const verification=await this.client.customerVerifications.confirm(pending.customer_verification_id,{code},this.auth.merchant(this.identity.actionKey(`confirm-${pending.customer_verification_id}-${digest(code)}`)));
      if(verification.status!=='confirmed'||verification.customer_id!==pending.customer_id||verification.email!==user.email||verification.purpose!=='link_guest_purchases')throw new LocalError('CUSTOMER_VERIFICATION_NOT_CONFIRMED',409);
      pending.confirmed=true;this.identity.setPending(session,pending);
    }
    if(this.identity.customerBoundElsewhere(user.user_id,this.sandboxId,pending.customer_id))throw new LocalError('CUSTOMER_ALREADY_BOUND',409);
    this.identity.bind(user.user_id,this.sandboxId,pending.customer_id,pending.email);
    const linked=await this.client.customers.linkGuestPurchases(pending.customer_id,{customer_verification_id:pending.customer_verification_id},this.auth.merchant(this.identity.actionKey(`link-${pending.customer_verification_id}`)));
    this.identity.setPending(session,null);return Number(linked.linked_order_count);
  }
  async signOut(user:User|undefined){
    if(!user)return;
    for(const vault of this.identity.vaults(user.user_id)){
      if(vault.sandbox_id!==this.sandboxId)continue;
      await this.client.customerSessions.revoke(vault.customer_session_id,undefined,this.auth.merchant(this.identity.actionKey(`revoke-${vault.customer_session_id}`)));
      this.identity.deleteVault(user.user_id,vault.sandbox_id);
    }
  }
  async sweep(){
    this.identity.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    const stale=this.identity.db.prepare('SELECT user_id FROM customer_session_vault WHERE sandbox_id=? AND (refresh_expires_at<=? OR NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.user_id=customer_session_vault.user_id AND expires_at>?))').all(this.sandboxId,Date.now(),Date.now()) as {user_id:string}[];
    for(const row of stale){const user=this.identity.user(row.user_id);if(user)await this.signOut(user);}
  }
}
