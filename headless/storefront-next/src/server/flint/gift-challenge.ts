import {createHash,randomBytes} from 'node:crypto';
import {SdkError} from '@flintpay/node';
import type {Client,CheckoutSession} from '@flintpay/node';
import type {Auth} from './auth.ts';
import type {CheckoutRecord} from '../store/db.ts';

export type GiftChallengeOutcome=
  |{kind:'challenge';reason:'proof_required'|'proof_rejected';url:string}
  |{kind:'origin_required'}
  |{kind:'unavailable';cause:'reason_unknown'|'next_action_missing'|'url_untrusted'|'session_mismatch'|'session_not_open'};

function object(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}

export function challengeOrigin(apiBaseUrl:string):string{
  if(apiBaseUrl==='https://api.staging.withflintpay.com')return 'https://checkout.staging.withflintpay.com';
  if(apiBaseUrl==='https://api.withflintpay.com')return 'https://checkout.withflintpay.com';
  throw new Error('unsupported_api_origin');
}

export function trustedChallengeUrl(raw:unknown,expectedOrigin:string):string|null{
  if(typeof raw!=='string'||raw.length>2048)return null;
  try{
    const url=new URL(raw);
    if(url.href!==raw||url.protocol!=='https:'||url.origin!==expectedOrigin||url.username||url.password||url.search||url.hash||!/^\/gift-card-challenge\/[A-Za-z0-9_.-]{1,256}$/.test(url.pathname))return null;
    return raw;
  }catch{return null;}
}

export function challengeFromError(error:unknown,expectedOrigin:string):GiftChallengeOutcome|null{
  if(!(error instanceof SdkError)||error.code!=='GIFT_CARD_CHALLENGE_REQUIRED')return null;
  if(error.status!==400)return {kind:'unavailable',cause:'reason_unknown'};
  const details=object(error.details)?error.details:undefined;
  const reason=details?.reason;
  if(reason==='page_origin_required')return {kind:'origin_required'};
  if(reason!=='proof_required'&&reason!=='proof_rejected')return {kind:'unavailable',cause:'reason_unknown'};
  const remediation=object(details?.remediation)?details.remediation:undefined;
  const actions=Array.isArray(remediation?.next_actions)?remediation.next_actions:[];
  const matches=actions.filter((action):action is Record<string,unknown>=>object(action)&&action.action_type==='complete_gift_card_challenge');
  if(matches.length!==1)return {kind:'unavailable',cause:'next_action_missing'};
  const url=trustedChallengeUrl(matches[0]!.url,expectedOrigin);
  return url?{kind:'challenge',reason,url}:{kind:'unavailable',cause:'url_untrusted'};
}

export async function confirmWithSession(outcome:GiftChallengeOutcome,readSession:()=>Promise<CheckoutSession>,expectedSessionId:string):Promise<GiftChallengeOutcome>{
  if(outcome.kind!=='challenge')return outcome;
  try{
    const session=await readSession();
    return session.checkout_session_id===expectedSessionId&&session.status==='open'&&!session.recovery_mode&&session.gift_card_challenge?.url===outcome.url?outcome:{kind:'unavailable',cause:'session_mismatch'};
  }catch(error){
    if(error instanceof SdkError&&['INVALID_CHECKOUT_SESSION','CHECKOUT_SESSION_NOT_OPEN','CHECKOUT_SESSION_EXPIRED','CHECKOUT_RECOVERY_RESTRICTED'].includes(error.code??''))return {kind:'unavailable',cause:'session_not_open'};
    throw error;
  }
}

export function newChallengeId():string{return `gch_${randomBytes(24).toString('base64url')}`;}
export function sessionTag(challengeId:string,checkoutSessionId:string):string{return createHash('sha256').update(`flint-examples.gift-challenge.v1\n${challengeId}\n${checkoutSessionId}`).digest('base64url');}
export function validProof(value:unknown):value is string{return typeof value==='string'&&/^[\x21-\x7E]{1,2048}$/.test(value);}

export function applyWithProof(client:Client,auth:Auth,record:CheckoutRecord,giftCardCode:string,revision:string,key:string,proof:string){
  return client.orders.applyGiftCard(record.order_id!,{gift_card_code:giftCardCode,order_revision:revision,'Flint-Gift-Card-Challenge':proof},auth.checkout(record,key));
}
