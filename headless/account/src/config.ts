export const SDK_VERSION='3.0.0-beta.20261007031000';
import {readBuild} from './build.ts';
import type {Build} from './build.ts';
export type Config={apiKey:string;apiBaseUrl:string;appOrigin:string;port:number;sandboxGuard?:string;identityDatabasePath:string;appDatabasePath:string;cookieName:string;storefrontOrigin:string|null;sessionTtl:number;storeName:string;build?:Build};
export function origin(value:string):string {
  const url=new URL(value);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('invalid_origin');
  return url.origin;
}
export function readConfig(env:NodeJS.ProcessEnv=process.env):Config {
  const errors:string[]=[];
  const apiKey=env.FLINT_API_KEY?.trim()??'';
  if(!apiKey.startsWith('flint_test_'))errors.push('FLINT_API_KEY requires a sandbox test key');
  const origins:Record<string,string>={};
  for(const key of ['APP_ORIGIN','FLINT_API_BASE_URL',...(env.STOREFRONT_ORIGIN?['STOREFRONT_ORIGIN']:[])]){
    try{origins[key]=origin(env[key]??'');}catch{errors.push(`${key} requires an HTTPS or loopback HTTP origin`);}
  }
  if(!['https://api.staging.withflintpay.com','https://api.withflintpay.com'].includes(origins.FLINT_API_BASE_URL??''))errors.push('FLINT_API_BASE_URL requires a public Flint API origin');
  const port=Number(env.PORT??4200),sessionTtl=Number(env.CUSTOMER_SESSION_TTL_SECONDS??3600);
  if(!Number.isInteger(port)||port<1||port>65535)errors.push('PORT requires an integer from 1 to 65535');
  if(!Number.isInteger(sessionTtl)||sessionTtl<300||sessionTtl>86400)errors.push('CUSTOMER_SESSION_TTL_SECONDS requires 300 to 86400');
  const cookieName=env.SESSION_COOKIE_NAME??'account_session';
  if(!/^[A-Za-z0-9_]{1,80}$/.test(cookieName))errors.push('SESSION_COOKIE_NAME requires letters, digits, or underscores');
  if(errors.length)throw new Error(errors.join('\n'));
  return {apiKey,apiBaseUrl:origins.FLINT_API_BASE_URL!,appOrigin:origins.APP_ORIGIN!,port,sessionTtl,cookieName,storefrontOrigin:origins.STOREFRONT_ORIGIN??null,sandboxGuard:env.FLINT_SANDBOX_ID,identityDatabasePath:env.IDENTITY_DATABASE_PATH??'./data/identity.sqlite',appDatabasePath:env.APP_DATABASE_PATH??'./data/account.sqlite',storeName:env.STORE_NAME??'Cedar & Stone',build:readBuild(env)};
}
