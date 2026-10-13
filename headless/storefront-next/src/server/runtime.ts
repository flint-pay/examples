import 'server-only';
import type {Client} from '@flintpay/node';
import {readConfig} from './config.ts';
import type {Config} from './config.ts';
import {createAuth} from './flint/auth.ts';
import type {Auth} from './flint/auth.ts';
import {createClient} from './flint/client.ts';
import {preflight} from './flint/preflight.ts';
import type {Preflight} from './flint/preflight.ts';
import {Catalog} from './flint/catalog.ts';
import {Checkouts} from './flint/checkouts.ts';
import {IdentityBinding} from './flint/identity-binding.ts';
import {IdentityStore} from './identity/index.ts';
import {Store} from './store/db.ts';
import {Carts} from './store/cart.ts';
import {PaymentEngine} from './payments/engine.ts';
import {RateLimiter} from './security/rate-limit.ts';

export type Runtime={config:Config;preflight:Preflight;client:Client;auth:Auth;store:Store;identity:IdentityStore;catalog:Catalog;carts:Carts;payments:PaymentEngine;checkouts:Checkouts;binding:IdentityBinding;limits:RateLimiter};

async function boot():Promise<Runtime>{
  const config=readConfig();const client=createClient(config.apiBaseUrl,config.sandboxGuard);const auth=createAuth(config.apiKey);
  const ready=await preflight(client,auth,config);
  const store=new Store(config.appDatabasePath);const identity=new IdentityStore(config.identityDatabasePath);
  const catalog=new Catalog(client,auth);const carts=new Carts(store,catalog);const payments=new PaymentEngine(client,auth,store);
  const checkouts=new Checkouts(client,auth,store,identity,config,ready.sandboxId,carts,payments);
  const binding=new IdentityBinding(client,auth,identity,ready.sandboxId);
  const cleanup=setInterval(()=>{store.cleanup();void binding.sweep().catch(()=>console.error('Customer session cleanup failed'));},10*60_000);cleanup.unref();
  console.info(`Storefront ready at ${config.appOrigin} (sandbox ${ready.sandboxId}, cards ${ready.cards})`);
  return {config,preflight:ready,client,auth,store,identity,catalog,carts,payments,checkouts,binding,limits:new RateLimiter()};
}

// One runtime per server process. Development reloads keep it on globalThis so SQLite handles and locks are not duplicated.
const holder=globalThis as typeof globalThis&{__storefrontRuntime?:Promise<Runtime>};
export function runtime():Promise<Runtime>{
  holder.__storefrontRuntime??=boot().catch(error=>{holder.__storefrontRuntime=undefined;throw error;});
  return holder.__storefrontRuntime;
}
