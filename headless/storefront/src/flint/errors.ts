import {SdkError} from '@flintpay/node';
export type AppError={kind:'validation'|'conflict'|'auth'|'not_found'|'rate_limited'|'unavailable'|'unknown_outcome'|'bug';code:string;message_key:string;request_id?:string};
export class LocalError extends Error {
  code:string;status:number;
  constructor(code:string,status=400){super(code);this.code=code;this.status=status;}
}
export function errorStatus(error:unknown):number{return error instanceof SdkError ? error.kind==='validation'&&error.outcome==='not_sent'?400:error.status??503 : error instanceof LocalError ? error.status : 500;}
export function unknownOutcome(error:unknown):boolean{return error instanceof SdkError&&(error.outcome==='unknown'||(error.status??0)>=500||['IDEMPOTENCY_KEY_IN_PROGRESS','GIFT_CARDS_UNAVAILABLE'].includes(error.code??''));}
export function appError(error:unknown):AppError {
  const status=errorStatus(error);
  const code=error instanceof SdkError||error instanceof LocalError ? error.code||'UNKNOWN_ERROR' : 'UNKNOWN_ERROR';
  const kind=code==='INVALID_PAGE_ORIGIN'?'bug':unknownOutcome(error)?'unknown_outcome':status===401?'auth':status===404?'not_found':status===429?'rate_limited':status===409?'conflict':status>=500?'unavailable':[400,402,403,422].includes(status)?'validation':'bug';
  const giftKeys:Record<string,string>={GIFT_CHALLENGE_EXPIRED:'gift_challenge_expired',GIFT_CHALLENGE_SESSION_CHANGED:'gift_card_apply_again',GIFT_CHALLENGE_CODE_CHANGED:'gift_card_apply_again',GIFT_CHALLENGE_ORDER_CHANGED:'gift_card_apply_again',GIFT_CARD_CHALLENGE_ORIGIN_REQUIRED:'gift_challenge_origin_required',GIFT_CARD_CHALLENGE_UNAVAILABLE:'gift_card_challenge_required',INVALID_PAGE_ORIGIN:'generic_error'};
  return {kind,code,message_key:giftKeys[code]??(code==='ORDER_CHANGED_REFRESH_REQUIRED'?'total_changed':code==='GIFT_CARD_CHALLENGE_REQUIRED'?'gift_card_challenge_required':code.toLowerCase()),request_id:error instanceof SdkError?error.meta?.requestId:undefined};
}
