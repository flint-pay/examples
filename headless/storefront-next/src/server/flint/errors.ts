import {SdkError} from '@flintpay/node';
export type AppError={kind:'validation'|'conflict'|'auth'|'not_found'|'rate_limited'|'unavailable'|'unknown_outcome'|'bug';code:string;message_key:string;request_id?:string};
export class LocalError extends Error {
  code:string;status:number;
  constructor(code:string,status=400){super(code);this.code=code;this.status=status;}
}
export function errorStatus(error:unknown):number{return error instanceof SdkError ? error.kind==='validation'&&error.outcome==='not_sent'?400:error.status??503 : error instanceof LocalError ? error.status : 500;}
export function unknownOutcome(error:unknown):boolean{return error instanceof SdkError&&(error.outcome==='unknown'||(error.status??0)>=500||error.code==='IDEMPOTENCY_KEY_IN_PROGRESS');}

/** Where an error came from, for conditions whose public code is shared by several refusals. */
export type ErrorScope='payment'|'verification'|'delivery';
export function scopeOfPath(path:string):ErrorScope|undefined{
  if(/\/(pay|resume|cancel-attempt|attempt)$/.test(path))return 'payment';
  if(/\/(verification(\/confirm)?|verify-email\/(send|confirm))$/.test(path))return 'verification';
  if(/\/(delivery\/quote|delivery\/select|pickup-locations)$/.test(path))return 'delivery';
}

type Facts={detail?:string;reason?:string;param?:string;resource_type?:string};
const text=(value:unknown)=>typeof value==='string'?value:undefined;
/** The first detail of a Flint error: its detail code, reason, request field and resource type. */
export function facts(error:unknown):Facts{
  if(!(error instanceof SdkError))return {};
  const body=error.details as {param?:unknown;details?:unknown}|undefined;
  const first=Array.isArray(body?.details)&&body.details[0]&&typeof body.details[0]==='object'?body.details[0] as Record<string,unknown>:{};
  return {detail:text(first.code),reason:text(first.reason),param:text(first.param)??text(body?.param),resource_type:text(first.resource_type)};
}

/**
 * The condition a Flint error stands for, under the names this app's copy and flows use.
 * Flint publishes shared codes (VERSION_CONFLICT, ACTION_NOT_ALLOWED, ...) and tells refusals apart by
 * reason, request field and resource, so a refusal several routes share is named only in its scope.
 */
export function condition(error:unknown,scope?:ErrorScope):string|undefined{
  if(!(error instanceof SdkError))return error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:undefined;
  const {detail,reason,param,resource_type}=facts(error);
  switch(error.code){
    case 'VERSION_CONFLICT':return param==='expected_delivery_selection_id'?'DELIVERY_SELECTION_CHANGED':param?.startsWith('replace_')?error.code:'ORDER_CHANGED_REFRESH_REQUIRED';
    case 'LIMIT_EXCEEDED':return scope==='payment'&&error.status===409?'GIFT_CARD_INSUFFICIENT_VALUE':error.code;
    case 'DELIVERY_REQUOTE_REQUIRED':return reason==='quote_expired'?'DELIVERY_QUOTE_EXPIRED':reason==='selection_changed'?'DELIVERY_SELECTION_CHANGED':'DELIVERY_QUOTE_STALE';
    case 'PAYMENT_ATTEMPT_ACTIVE':return 'ORDER_PAYMENT_ATTEMPT_ACTIVE';
    case 'OPERATION_IN_PROGRESS':return scope==='payment'?'PAYMENT_ATTEMPT_STILL_PROCESSING':error.code;
    case 'PAYMENT_OPTION_UNAVAILABLE':return reason==='action_window_too_short'?'PAYMENT_ACTION_WINDOW_TOO_SHORT':error.code;
    case 'ACTION_NOT_ALLOWED':
      if(reason==='terminal_status'&&resource_type==='checkout_session')return 'CHECKOUT_SESSION_NOT_OPEN';
      if(scope==='payment'){
        if(reason==='terminal_status')return 'PAYMENT_SOURCE_UNAVAILABLE';
        if(reason==='unsupported_state')return 'PAYMENT_ATTEMPT_NOT_RESUMABLE';
        if(reason==='configuration_required'&&resource_type==='order')return 'ORDER_TAX_NOT_READY';
      }
      return error.code;
    case 'FORBIDDEN':return reason==='checkout_recovery_restricted'?'CHECKOUT_RECOVERY_RESTRICTED':reason==='checkout_session_payment_required'?'CHECKOUT_SESSION_PAYMENT_REQUIRED':error.code;
    case 'INVALID_REQUEST':
      if(param==='payment_intents'&&detail==='REQUIRED')return 'PAYMENT_LEG_SELECTION_REQUIRED';
      if(scope==='verification'&&param==='code'&&detail==='INVALID_VALUE')return 'CUSTOMER_VERIFICATION_CODE_INVALID';
      if(param==='timezone')return 'INVALID_TIMEZONE';
      return error.code;
    case 'ALREADY_EXISTS':return param==='email'?'CUSTOMER_EMAIL_ALREADY_USED':error.code;
    case 'LIMIT_REACHED':return reason==='saved_card_codes'?'PAYMENT_METHOD_SAVE_CODE_LIMIT_REACHED':reason==='verification_codes'?'CUSTOMER_VERIFICATION_RATE_LIMITED':error.code;
    case 'SERVICE_UNAVAILABLE':
      // A 503 that says the outcome is unknown, or needs repair, is not the service refusing before it acted.
      if(reason==='outcome_unknown'||reason==='repair_required')return error.code;
      return scope==='verification'?'CUSTOMER_VERIFICATION_UNAVAILABLE':scope==='delivery'?'DELIVERY_SERVICE_UNAVAILABLE':error.code;
    default:return error.code;
  }
}

/** True when Flint refused the checkout credential because its session has ended. */
export function sessionEnded(error:unknown):boolean{
  if(!(error instanceof SdkError))return false;
  const {reason}=facts(error);
  return error.code==='INVALID_CREDENTIAL'&&(reason==='unknown'||reason==='session_ended')||condition(error)==='CHECKOUT_SESSION_NOT_OPEN';
}
export function appError(error:unknown,scope?:ErrorScope):AppError {
  const status=errorStatus(error);
  const code=error instanceof SdkError||error instanceof LocalError ? condition(error,scope)||'UNKNOWN_ERROR' : 'UNKNOWN_ERROR';
  const kind=code==='INVALID_PAGE_ORIGIN'?'bug':unknownOutcome(error)?'unknown_outcome':status===401?'auth':status===404?'not_found':status===429?'rate_limited':status===409?'conflict':status>=500?'unavailable':[400,402,403,422].includes(status)?'validation':'bug';
  const giftKeys:Record<string,string>={GIFT_CHALLENGE_EXPIRED:'gift_challenge_expired',GIFT_CHALLENGE_SESSION_CHANGED:'gift_card_apply_again',GIFT_CHALLENGE_CODE_CHANGED:'gift_card_apply_again',GIFT_CHALLENGE_ORDER_CHANGED:'gift_card_apply_again',GIFT_CARD_CHALLENGE_ORIGIN_REQUIRED:'gift_challenge_origin_required',GIFT_CARD_CHALLENGE_UNAVAILABLE:'gift_card_challenge_required',INVALID_PAGE_ORIGIN:'generic_error'};
  return {kind,code,message_key:giftKeys[code]??(code==='ORDER_CHANGED_REFRESH_REQUIRED'?'total_changed':code==='GIFT_CARD_CHALLENGE_REQUIRED'?'gift_card_challenge_required':code.toLowerCase()),request_id:error instanceof SdkError?error.meta?.requestId:undefined};
}
