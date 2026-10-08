import type {RequestOptions} from '@flintpay/node';
import type {CheckoutRecord} from '../store/db.ts';
export type ReadOptions<A extends 'merchant'|'customer'|'checkout'>=Omit<RequestOptions<A>,'idempotencyKey'>&{idempotencyKey?:never};
export function createAuth(apiKey:string){
  function merchant():ReadOptions<'merchant'>;
  function merchant(key:string):RequestOptions<'merchant'>;
  function merchant(key?:string):RequestOptions<'merchant'>{return key?{apiKey,idempotencyKey:key}:{apiKey};}
  function customer(secret:string):ReadOptions<'customer'>;
  function customer(secret:string,key:string):RequestOptions<'customer'>;
  function customer(secret:string,key?:string):RequestOptions<'customer'>{return key?{customerToken:secret,idempotencyKey:key}:{customerToken:secret};}
  function checkout(record:CheckoutRecord):ReadOptions<'checkout'>;
  function checkout(record:CheckoutRecord,key:string):RequestOptions<'checkout'>;
  function checkout(record:CheckoutRecord,key?:string):RequestOptions<'checkout'>{
    if(!record.checkout_session_id||!record.checkout_auth_token)throw new Error('checkout_credentials_missing');
    return {authMode:'checkout' as const,maxAttempts:1,credentials:{CheckoutSessionIDHeader:record.checkout_session_id,CheckoutSessionSecretHeader:record.checkout_auth_token},...(key?{idempotencyKey:key}:{})};
  }
  return {merchant,customer,checkout};
}
export type Auth=ReturnType<typeof createAuth>;
