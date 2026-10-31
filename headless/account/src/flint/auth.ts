import type {RequestOptions} from '@flintpay/node';
import type {CheckoutRecord} from '../store/db.ts';
export type ReadOptions<A extends 'merchant'|'customer'|'checkout'>=Omit<RequestOptions<A>,'idempotencyKey'>&{idempotencyKey?:never};
export type Keyed<A extends 'merchant'|'customer'|'checkout'>=RequestOptions<A>&{idempotencyKey:string};
export function createAuth(apiKey:string){
  function merchant():ReadOptions<'merchant'>;
  function merchant(key:string):Keyed<'merchant'>;
  function merchant(key?:string):RequestOptions<'merchant'>{return key?{apiKey,idempotencyKey:key}:{apiKey};}
  function customer(secret:string):ReadOptions<'customer'>;
  function customer(secret:string,key:string):Keyed<'customer'>;
  function customer(secret:string,key?:string):RequestOptions<'customer'>{return key?{customerToken:secret,idempotencyKey:key}:{customerToken:secret};}
  function checkout(record:CheckoutRecord):ReadOptions<'checkout'>;
  function checkout(record:CheckoutRecord,key:string):Keyed<'checkout'>;
  function checkout(record:CheckoutRecord,key?:string):RequestOptions<'checkout'>{
    if(!record.checkout_session_id||!record.checkout_auth_token)throw new Error('checkout_credentials_missing');
    return {checkoutToken:record.checkout_auth_token,maxAttempts:1,...(key?{idempotencyKey:key}:{})};
  }
  return {merchant,customer,checkout};
}
export type Auth=ReturnType<typeof createAuth>;
