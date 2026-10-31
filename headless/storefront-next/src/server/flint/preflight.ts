import type {Client} from '@flintpay/node';
import type {Auth} from './auth.ts';
import type {Config} from '../config.ts';
export type Preflight={sandboxId:string;cards:string};
export async function preflight(client:Client,auth:Auth,config:Config):Promise<Preflight> {
  const response=await client.merchants.getWithResponse(undefined,auth.merchant());
  const headers=response.meta.headers;
  if(headers['flint-mode']==='live')throw new Error('Live API responses are refused');
  const sandboxId=headers['flint-sandbox-id'];
  if(!sandboxId||config.sandboxGuard&&config.sandboxGuard!==sandboxId)throw new Error('Sandbox identity guard failed');
  return {sandboxId,cards:response.body.data.readiness.capabilities.find(item=>item.capability==='accept_card_payments')?.status??'not_available'};
}
