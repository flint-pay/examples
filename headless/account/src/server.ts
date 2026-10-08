import {serve} from '@hono/node-server';
import {readConfig} from './config.ts';
import {createClient} from './flint/client.ts';
import {createAuth} from './flint/auth.ts';
import {preflight} from './flint/preflight.ts';
import {IdentityStore} from './identity/index.ts';
import {Store} from './store/db.ts';
import {createApp} from './app.ts';
const config=readConfig();
const client=createClient(config.apiBaseUrl);
const readiness=await preflight(client,createAuth(config.apiKey),config);
const identity=new IdentityStore(config.identityDatabasePath),store=new Store(config.appDatabasePath);
const {app,sessions}=createApp({config,client,identity,store,preflight:readiness});
const server=serve({fetch:app.fetch,port:config.port,hostname:new URL(config.appOrigin).hostname});
const sweep=setInterval(()=>sessions.sweep().catch(()=>console.warn(JSON.stringify({event:'session_sweep_failed'}))),600000);sweep.unref();
console.info(JSON.stringify({event:'ready',origin:config.appOrigin,cards:readiness.cards,setupNeeded:readiness.setupNeeded}));
let stopping=false;
async function stop(){if(stopping)return;stopping=true;clearInterval(sweep);server.close(async()=>{await client.close();store.close();identity.close();});}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
