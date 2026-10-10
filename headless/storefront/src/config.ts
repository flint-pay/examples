export const SDK_VERSION = "3.0.0-beta.20261009223830";
import { readBuild } from './build.ts';
import type { Build } from './build.ts';
import {isIP} from 'node:net';
import {challengeOrigin} from './flint/gift-challenge.ts';
export type Config = {
  apiKey: string;
  apiBaseUrl: string;
  appOrigin: string;
  giftChallengeOrigin: string;
  port: number;
  sandboxGuard?: string;
  webhookSecret?: string;
  identityDatabasePath: string;
  appDatabasePath: string;
  cookieName: string;
  accountOrigin?: string;
  checkoutTtl: number;
  storeName: string;
  build?: Build;
};

function origin(value: string, name: string, errors: string[]): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !(name==='APP_ORIGIN'&&url.hostname.endsWith('.localhost'))) throw new Error();
    return url.origin;
  } catch { errors.push(`${name}: an HTTPS origin or loopback HTTP origin is required`); return value; }
}

function pageOriginProblem(appOrigin:string):string|undefined{
  const url=new URL(appOrigin),host=url.hostname;
  const local=host==='localhost'||host.endsWith('.localhost')||host==='127.0.0.1';
  const dns=/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(host);
  if(appOrigin.length<=255&&url.port!=='0'&&dns&&host.split('.').every(label=>label.length<=63)&&(local||url.protocol==='https:'&&dns&&!isIP(host)&&host!=='withflintpay.com'&&!host.endsWith('.withflintpay.com')))return undefined;
  return "APP_ORIGIN: Flint must accept this origin as the checkout page origin. Use an https host name, http://localhost, or http://127.0.0.1. IP addresses other than 127.0.0.1, [::1], and withflintpay.com hosts don't work.";
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const errors: string[] = [];
  const apiKey = env.FLINT_API_KEY?.trim() ?? '';
  if (!apiKey.startsWith('flint_test_')) errors.push('FLINT_API_KEY: a sandbox test key is required; live credentials are refused');
  const apiBaseUrl = origin(env.FLINT_API_BASE_URL ?? '', 'FLINT_API_BASE_URL', errors);
  if (!['https://api.staging.withflintpay.com', 'https://api.withflintpay.com'].includes(apiBaseUrl)) errors.push('FLINT_API_BASE_URL: use the public Flint API origin');
  const appOrigin = origin(env.APP_ORIGIN ?? '', 'APP_ORIGIN', errors);
  if(URL.canParse(appOrigin)){const problem=pageOriginProblem(appOrigin);if(problem)errors.push(problem);}
  const accountOrigin = env.ACCOUNT_APP_ORIGIN ? origin(env.ACCOUNT_APP_ORIGIN, 'ACCOUNT_APP_ORIGIN', errors) : undefined;
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('PORT: an integer from 1 to 65535 is required');
  const checkoutTtl = Number(env.CHECKOUT_SESSION_TTL_SECONDS || 3600);
  if (!Number.isInteger(checkoutTtl) || checkoutTtl < 60 || checkoutTtl > 86400) errors.push('CHECKOUT_SESSION_TTL_SECONDS: use 60 to 86400');
  const cookieName = env.SESSION_COOKIE_NAME || 'storefront_session';
  if (!/^[A-Za-z0-9_]{1,80}$/.test(cookieName)) errors.push('SESSION_COOKIE_NAME: letters, digits, and underscores only');
  if (errors.length) throw new Error(errors.join('\n'));
  return {apiKey, apiBaseUrl, appOrigin, giftChallengeOrigin:challengeOrigin(apiBaseUrl), accountOrigin, port, checkoutTtl, cookieName, build:readBuild(env),
    sandboxGuard: env.FLINT_SANDBOX_ID || undefined, webhookSecret: env.FLINT_WEBHOOK_SECRET || undefined,
    identityDatabasePath: env.IDENTITY_DATABASE_PATH || './data/identity.sqlite',
    appDatabasePath: env.APP_DATABASE_PATH || './data/storefront.sqlite', storeName: env.STORE_NAME || 'Cedar & Stone'};
}
