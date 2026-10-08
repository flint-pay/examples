import {SdkError} from '@flintpay/node';
export type AppError={kind:'validation'|'conflict'|'auth'|'not_found'|'rate_limited'|'unavailable'|'unknown_outcome'|'bug';code:string;message_key:string;request_id?:string};
export class LocalError extends Error {
  code:string;status:number;
  constructor(code:string,status=400){super(code);this.code=code;this.status=status;}
}
export function errorStatus(error:unknown):number{return error instanceof SdkError ? error.status??503 : error instanceof LocalError ? error.status : 500;}
export function unknownOutcome(error:unknown):boolean{return !(error instanceof LocalError)&&(!(error instanceof SdkError)||error.outcome==='unknown'||['transport','deadline','protocol','cancelled'].includes(error.kind)||(error.status??0)>=500||error.code==='IDEMPOTENCY_KEY_IN_PROGRESS');}
export function appError(error:unknown):AppError {
  const status=errorStatus(error);
  const code=error instanceof SdkError||error instanceof LocalError ? error.code||'UNKNOWN_ERROR' : 'UNKNOWN_ERROR';
  const kind=unknownOutcome(error)?'unknown_outcome':status===401?'auth':status===404?'not_found':status===429?'rate_limited':status===409?'conflict':status>=500?'unavailable':status===400||status===422||status===403?'validation':'bug';
  return {kind,code,message_key:code==='EMAIL_ALREADY_USED'?'email_taken':code==='CSRF_REJECTED'?'csrf_failed':code==='ORDER_CHANGED_REFRESH_REQUIRED'?'total_changed':code==='GIFT_CARD_CHALLENGE_REQUIRED'?'gift_card_challenge_required':code.toLowerCase(),request_id:error instanceof SdkError?error.meta?.requestId:undefined};
}
