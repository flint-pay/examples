import {serve} from '@hono/node-server';
import {SdkError} from '@flintpay/node';
import {readConfig} from './config.ts';
import {createClient} from './flint/client.ts';
import {createAuth} from './flint/auth.ts';
import {preflight} from './flint/preflight.ts';
import {createApp} from './app.ts';

async function main(){
  const config=readConfig();const client=createClient(config.apiBaseUrl,config.sandboxGuard);const auth=createAuth(config.apiKey);
  const readiness=await preflight(client,auth,config);const runtime=createApp({config,client,preflight:readiness});
  const server=serve({fetch:runtime.app.fetch,port:config.port});
  const cleanup=setInterval(()=>{runtime.store.cleanup();void runtime.binding.sweep().catch(()=>console.error('Customer session cleanup failed'));},10*60_000);cleanup.unref();
  console.info(`Ready at ${config.appOrigin} (sandbox ${readiness.sandboxId}, cards ${readiness.cards})`);
  for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{clearInterval(cleanup);server.close(()=>{runtime.store.close();runtime.identity.close();process.exit(0);});});
}
try{await main();}catch(error){
  console.error(error instanceof SdkError?`Startup failed: ${error.code??error.kind}${error.meta?.requestId?` (request ${error.meta.requestId})`:''}`:error instanceof Error?error.message:'Startup failed');process.exitCode=1;
}
