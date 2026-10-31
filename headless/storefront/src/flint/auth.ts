import type {RequestOptions} from '@flintpay/node';
import type {CheckoutRecord} from '../store/db.ts';
type ReadOptions<M extends 'merchant'|'customer'|'checkout'>=Omit<RequestOptions<M>,'idempotencyKey'>&{idempotencyKey?:never};
type KeyedOptions<M extends 'merchant'|'customer'|'checkout'>=Omit<RequestOptions<M>,'idempotencyKey'>&{idempotencyKey:string};

// Writes send one attempt: the action journal replays them with their saved key and body.
// Reads keep the SDK's own retries (up to 3 attempts).
export function createAuth(apiKey:string) {
  function merchant():ReadOptions<'merchant'>;
  function merchant(idempotencyKey:string):KeyedOptions<'merchant'>;
  function merchant(idempotencyKey?:string):ReadOptions<'merchant'>|KeyedOptions<'merchant'> {return idempotencyKey?{apiKey,idempotencyKey,maxAttempts:1}:{apiKey};}
  function customer(secret:string):ReadOptions<'customer'>;
  function customer(secret:string,idempotencyKey:string):KeyedOptions<'customer'>;
  function customer(secret:string,idempotencyKey?:string):ReadOptions<'customer'>|KeyedOptions<'customer'> {return idempotencyKey?{customerToken:secret,idempotencyKey,maxAttempts:1}:{customerToken:secret};}
  function checkout(record:CheckoutRecord):ReadOptions<'checkout'>;
  function checkout(record:CheckoutRecord,idempotencyKey:string):KeyedOptions<'checkout'>;
  function checkout(record:CheckoutRecord,idempotencyKey?:string):ReadOptions<'checkout'>|KeyedOptions<'checkout'> {
    if(!record.checkout_session_id||!record.checkout_auth_token)throw new Error('checkout_credentials_missing');
    return idempotencyKey?{checkoutToken:record.checkout_auth_token,idempotencyKey,maxAttempts:1}:{checkoutToken:record.checkout_auth_token};
  }
  return {merchant,customer,checkout};
}
export type Auth = ReturnType<typeof createAuth>;
