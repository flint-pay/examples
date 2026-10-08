import type {AppError} from './errors.ts';
import {buyerSafe} from './projection.ts';
import {returnPath} from '../security/paths.ts';
export type PageId='sf-home'|'sf-product'|'sf-cart'|'sf-subscribe'|'sf-checkout'|'sf-complete'|'sign-in'|'sign-up'|'verify-email'|'return-elsewhere'|'not-found'|'error';
export type ViewContext={storeName:string;csrf:string;user:{name:string;email:string}|null;cartCount:number;accountOrigin:string|null;appOrigin:string;giftChallengeOrigin?:string;data:Record<string,unknown>;notices:string[];error?:AppError;form?:{values?:Record<string,string>;errors?:Record<string,string>};path?:string};

// Navigation context carries return hints, never transient notices or credentials.
export function viewPath(value:unknown,depth=0):string{
  const path=returnPath(value);if(depth>4)return '/';
  const url=new URL(path,'https://view.invalid');if(buyerSafe(decodeURIComponent(url.pathname))===undefined)return '/';
  for(const [key,item] of [...url.searchParams]){
    if(key==='notice'||/password|secret|token|credential|(?:^|_)csrf$|(?:^|_)code$|checkout_session_id|customer_verification_id/i.test(key)||buyerSafe(item)===undefined)url.searchParams.delete(key);
    else if(key==='next')url.searchParams.set(key,viewPath(item,depth+1));
  }
  if(buyerSafe(decodeURIComponent(url.hash))===undefined)url.hash='';
  return url.pathname+url.search+url.hash;
}
