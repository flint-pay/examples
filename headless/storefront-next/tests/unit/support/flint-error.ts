import {errors} from '@flintpay/node';
import {SdkError} from '@flintpay/node';
import type {SdkErrorDetails} from '@flintpay/node';

const types:Record<number,string>={400:'validation_error',401:'authentication_error',403:'authorization_error',404:'not_found_error',409:'conflict_error',429:'rate_limit_error',503:'unavailable_error'};

/** A Flint error body: a public code with its first detail's reason, field and resource. */
export function flintErrorBody(status:number,code:string,detail:Record<string,unknown>={},remediation:Record<string,unknown>|null={retry:'none'}){
  return {type:types[status]??'internal_error',code,message:'Fixture refusal.',doc_url:`https://developers.withflintpay.com/docs/errors#${code.toLowerCase()}`,error_source:'integration',remediation,request_id:`req_${'0'.repeat(26)}`,details:[{code,message:'Fixture refusal.',...detail}]};
}

/** The SdkError the SDK raises for that body. */
export function flintError(status:number,code:string,detail:Record<string,unknown>={},remediation:Record<string,unknown>|null={retry:'none'}):SdkError{
  const ErrorClass=status>=500?errors.ServerError:status===409?errors.ConflictError:status===401?errors.AuthenticationError:status===403?errors.PermissionError:errors.InvalidRequestError;
  const body=flintErrorBody(status,code,detail,remediation);
  return new ErrorClass('Fixture refusal.',{status,code,outcome:'response',details:body.details,param:typeof detail.param==='string'?detail.param:undefined,remediation:remediation?{...remediation,retry:remediation.retry as 'none'|'same_request'|'after_refresh'}:undefined,body});
}
