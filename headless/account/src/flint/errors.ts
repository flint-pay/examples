import {SdkError} from '@flintpay/node';
export type AppError={kind:'validation'|'conflict'|'auth'|'not_found'|'rate_limited'|'unavailable'|'unknown_outcome'|'bug';code:string;message_key:string;request_id?:string};
export class LocalError extends Error {
  code:string;status:number;
  constructor(code:string,status=400){super(code);this.code=code;this.status=status;}
}
type Detail={code?:unknown;reason?:unknown;remediation?:unknown};
function detailObject(error:unknown):(Detail&{details?:Detail[]})|undefined{return error instanceof SdkError&&error.details&&typeof error.details==='object'?error.details as Detail&{details?:Detail[]}:undefined;}
/** The stable reason Flint attaches to a failure, from the first error detail that has one. */
export function sdkReason(error:unknown):string|undefined{const body=detailObject(error),reason=(Array.isArray(body?.details)?body.details.find(item=>typeof item?.reason==='string')?.reason:undefined)??body?.reason;return typeof reason==='string'?reason:undefined;}
/** True when Flint refused the credential itself: an ended, expired, revoked, or unknown customer session or checkout token. */
export function credentialRejected(error:unknown):boolean{return error instanceof SdkError&&error.code==='INVALID_CREDENTIAL';}
/** True when a checkout session can no longer be used by this credential: rejected, ended, or restricted to payment recovery. */
export function checkoutSessionUnusable(error:unknown):boolean{
  if(error instanceof LocalError)return error.code==='CHECKOUT_SESSION_NOT_OPEN';
  return credentialRejected(error)||error instanceof SdkError&&error.code==='FORBIDDEN'&&sdkReason(error)?.startsWith('checkout_recovery')===true;
}
export function errorStatus(error:unknown):number{return error instanceof SdkError ? error.status??503 : error instanceof LocalError ? error.status : 500;}
export function unknownOutcome(error:unknown):boolean{return !(error instanceof LocalError)&&(!(error instanceof SdkError)||error.outcome==='unknown'||['transport','deadline','protocol','cancelled'].includes(error.kind)||(error.status??0)>=500||['IDEMPOTENCY_KEY_IN_PROGRESS','GIFT_CARDS_UNAVAILABLE'].includes(error.code??''));}
export function appError(error:unknown):AppError {
  const status=errorStatus(error);
  const code=error instanceof SdkError||error instanceof LocalError ? error.code||'UNKNOWN_ERROR' : 'UNKNOWN_ERROR';
  const kind=code==='INVALID_PAGE_ORIGIN'?'bug':unknownOutcome(error)?'unknown_outcome':status===401?'auth':status===404?'not_found':status===429?'rate_limited':status===409?'conflict':status>=500?'unavailable':status===400||status===422||status===403?'validation':'bug';
  const giftKeys:Record<string,string>={GIFT_CHALLENGE_EXPIRED:'gift_challenge_expired',GIFT_CHALLENGE_SESSION_CHANGED:'gift_card_apply_again_pay',GIFT_CHALLENGE_CODE_CHANGED:'gift_card_apply_again_pay',GIFT_CHALLENGE_ORDER_CHANGED:'gift_card_apply_again_pay',GIFT_CARD_CHALLENGE_ORIGIN_REQUIRED:'gift_challenge_origin_required',GIFT_CARD_CHALLENGE_UNAVAILABLE:'gift_card_challenge_required',GIFT_CARDS_NOT_EDITABLE:'gift_card_apply_again_pay',GIFT_CARD_CHANGE_UNCONFIRMED:'gift_card_change_unconfirmed',INVALID_PAGE_ORIGIN:'generic_error'};
  return {kind,code,message_key:giftKeys[code]??(code==='EMAIL_ALREADY_USED'?'email_taken':code==='CSRF_REJECTED'?'csrf_failed':code==='ORDER_CHANGED_REFRESH_REQUIRED'?'total_changed':code==='GIFT_CARD_CHALLENGE_REQUIRED'?'gift_card_challenge_required':code.toLowerCase()),request_id:error instanceof SdkError?error.meta?.requestId:undefined};
}
export function giftPayError(error:unknown):AppError{
  const result=appError(error),keys:Record<string,string>={GIFT_CARD_UNAVAILABLE:'gift_card_unavailable_pay',RESOURCE_NOT_FOUND:'gift_card_unavailable_pay',INVALID_GIFT_CARD_CODE:'gift_card_unavailable_pay',INVALID_GIFT_CARD_SELECTION:'invalid_gift_card_selection_pay',ORDER_CHANGED_REFRESH_REQUIRED:'gift_card_apply_again_pay',VERSION_CONFLICT:'gift_card_apply_again_pay',ACTION_BODY_MISMATCH:'gift_card_apply_again_pay',GIFT_CARD_CHANGE_UNCONFIRMED:'gift_card_change_unconfirmed'};
  return {...result,message_key:keys[result.code]??result.message_key};
}
