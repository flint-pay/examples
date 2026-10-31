import {SdkError} from '@flintpay/node';
import type {SdkErrorDetails} from '@flintpay/node';

const kinds:Record<number,ConstructorParameters<typeof SdkError>[0]>={400:'validation',401:'authentication',403:'authentication',404:'not_found',409:'conflict',429:'rate_limit'};
const types:Record<number,string>={400:'validation_error',401:'authentication_error',403:'authorization_error',404:'not_found_error',409:'conflict_error',429:'rate_limit_error',503:'unavailable_error'};

/** A Flint error body: a public code with its first detail's reason, field and resource. */
export function flintErrorBody(status:number,code:string,detail:Record<string,unknown>={},remediation:Record<string,unknown>|null={retry:'none'}){
  return {type:types[status]??'internal_error',code,message:'Fixture refusal.',doc_url:`https://developers.withflintpay.com/docs/errors#${code.toLowerCase()}`,error_source:'integration',remediation,request_id:'req_01KWM6WAHG3N9Q8T2V5XRZ7C4D',details:[{code,message:'Fixture refusal.',...detail}]};
}

/** The SdkError the SDK raises for that body. */
export function flintError(status:number,code:string,detail:Record<string,unknown>={},remediation:Record<string,unknown>|null={retry:'none'}):SdkError{
  return new SdkError(kinds[status]??'server','Fixture refusal.','response',false,{status,headers:{},attempts:1,durationMs:1},code,flintErrorBody(status,code,detail,remediation) as unknown as SdkErrorDetails);
}
