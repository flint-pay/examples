import type {Client} from '@flintpay/node';
import type {Auth} from './auth.ts';
import type {Config} from '../config.ts';
export type Preflight={sandboxId:string;cards:string};
export async function preflight(client:Client,auth:Auth,config:Config):Promise<Preflight> {
  const response=await client.capabilities.listWithResponse({capability:'accept_card_payments'},auth.merchant());
  const headers=response.meta.headers;
  if(headers['flint-mode']==='live')throw new Error('Live API responses are refused');
  const sandboxId=headers['flint-sandbox-id'];
  if(!sandboxId||config.sandboxGuard&&config.sandboxGuard!==sandboxId)throw new Error('Sandbox identity guard failed');
  return {sandboxId,cards:response.body.data[0]?.status??'not_available'};
}
