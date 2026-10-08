import type {RequestOptions} from '@flintpay/node';
import type {CheckoutRecord} from '../store/db.ts';
type ReadOptions<M extends 'merchant'|'customer'|'checkout'>=Omit<RequestOptions<M>,'idempotencyKey'>&{idempotencyKey?:never};

export function createAuth(apiKey:string) {
  function merchant():ReadOptions<'merchant'>;
  function merchant(idempotencyKey:string):RequestOptions<'merchant'>;
  function merchant(idempotencyKey?:string):RequestOptions<'merchant'> {return {apiKey,idempotencyKey,maxAttempts:1};}
  function customer(secret:string):ReadOptions<'customer'>;
  function customer(secret:string,idempotencyKey:string):RequestOptions<'customer'>;
  function customer(secret:string,idempotencyKey?:string):RequestOptions<'customer'> {return {customerToken:secret,idempotencyKey,maxAttempts:1};}
  function checkout(record:CheckoutRecord):ReadOptions<'checkout'>;
  function checkout(record:CheckoutRecord,idempotencyKey:string):RequestOptions<'checkout'>;
  function checkout(record:CheckoutRecord,idempotencyKey?:string):RequestOptions<'checkout'> {
    if(!record.checkout_session_id||!record.checkout_auth_token)throw new Error('checkout_credentials_missing');
    return {authMode:'checkout',credentials:{CheckoutSessionIDHeader:record.checkout_session_id,CheckoutSessionSecretHeader:record.checkout_auth_token},idempotencyKey,maxAttempts:1};
  }
  const checkoutHeaders = (record:CheckoutRecord) => {
    if(!record.checkout_session_id||!record.checkout_auth_token)throw new Error('checkout_credentials_missing');
    return {'X-Checkout-Session-ID':record.checkout_session_id,'X-Checkout-Session-Secret':record.checkout_auth_token};
  };
  return {merchant,customer,checkout,checkoutHeaders};
}
export type Auth = ReturnType<typeof createAuth>;
