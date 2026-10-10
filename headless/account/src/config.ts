export const SDK_VERSION='3.0.0-beta.20261009223830';
import {readBuild} from './build.ts';
import type {Build} from './build.ts';
import {isIP} from 'node:net';
import {challengeOrigin} from './flint/gift-challenge.ts';
export type Config={apiKey:string;apiBaseUrl:string;appOrigin:string;giftChallengeOrigin:string;port:number;sandboxGuard?:string;identityDatabasePath:string;appDatabasePath:string;cookieName:string;storefrontOrigin:string|null;sessionTtl:number;storeName:string;build?:Build};
export function origin(value:string,appOrigin=false):string {
  const url=new URL(value);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&!(appOrigin&&url.hostname.endsWith('.localhost')))throw new Error('invalid_origin');
  return url.origin;
}
function pageOriginProblem(appOrigin:string):string|undefined{
  const url=new URL(appOrigin),host=url.hostname,local=host==='localhost'||host.endsWith('.localhost')||host==='127.0.0.1';
  const dns=/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(host);
  if(appOrigin.length<=255&&url.port!=='0'&&dns&&host.split('.').every(label=>label.length<=63)&&(local||url.protocol==='https:'&&dns&&!isIP(host)&&host!=='withflintpay.com'&&!host.endsWith('.withflintpay.com')))return undefined;
  return "APP_ORIGIN: Flint must accept this origin as the checkout page origin. Use an https host name, http://localhost, or http://127.0.0.1. IP addresses other than 127.0.0.1, [::1], and withflintpay.com hosts don't work.";
}
export function readConfig(env:NodeJS.ProcessEnv=process.env):Config {
  const errors:string[]=[];
  const apiKey=env.FLINT_API_KEY?.trim()??'';
  if(!apiKey.startsWith('flint_test_'))errors.push('FLINT_API_KEY requires a sandbox test key');
  const origins:Record<string,string>={};
  for(const key of ['APP_ORIGIN','FLINT_API_BASE_URL',...(env.STOREFRONT_ORIGIN?['STOREFRONT_ORIGIN']:[])]){
    try{origins[key]=origin(env[key]??'',key==='APP_ORIGIN');}catch{errors.push(`${key} requires an HTTPS or loopback HTTP origin`);}
  }
  if(origins.APP_ORIGIN){const problem=pageOriginProblem(origins.APP_ORIGIN);if(problem)errors.push(problem);}
  if(!['https://api.staging.withflintpay.com','https://api.withflintpay.com'].includes(origins.FLINT_API_BASE_URL??''))errors.push('FLINT_API_BASE_URL requires a public Flint API origin');
  const port=Number(env.PORT??4200),sessionTtl=Number(env.CUSTOMER_SESSION_TTL_SECONDS??3600);
  if(!Number.isInteger(port)||port<1||port>65535)errors.push('PORT requires an integer from 1 to 65535');
  if(!Number.isInteger(sessionTtl)||sessionTtl<300||sessionTtl>86400)errors.push('CUSTOMER_SESSION_TTL_SECONDS requires 300 to 86400');
  const cookieName=env.SESSION_COOKIE_NAME??'account_session';
  if(!/^[A-Za-z0-9_]{1,80}$/.test(cookieName))errors.push('SESSION_COOKIE_NAME requires letters, digits, or underscores');
  if(errors.length)throw new Error(errors.join('\n'));
  return {apiKey,apiBaseUrl:origins.FLINT_API_BASE_URL!,appOrigin:origins.APP_ORIGIN!,giftChallengeOrigin:challengeOrigin(origins.FLINT_API_BASE_URL!),port,sessionTtl,cookieName,storefrontOrigin:origins.STOREFRONT_ORIGIN??null,sandboxGuard:env.FLINT_SANDBOX_ID,identityDatabasePath:env.IDENTITY_DATABASE_PATH??'./data/identity.sqlite',appDatabasePath:env.APP_DATABASE_PATH??'./data/account.sqlite',storeName:env.STORE_NAME??'Cedar & Stone',build:readBuild(env)};
}
