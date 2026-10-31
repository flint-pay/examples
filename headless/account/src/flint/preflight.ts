import type {Client,BuyerCapabilities} from '@flintpay/node';
import type {Config} from '../config.ts';
import type {Auth} from './auth.ts';
export type Preflight={sandboxId:string;merchantId:string;cards:string;setupNeeded:boolean;capabilities:BuyerCapabilities|null;support:{email?:string;phone?:string;url?:string}};
export async function preflight(client:Client,auth:Auth,config:Config):Promise<Preflight>{
  const [response,settings]=await Promise.all([client.merchants.getWithResponse(undefined,auth.merchant()),client.settings.get(undefined,auth.merchant())]);
  const headers=response.meta.headers;
  if(headers['flint-mode']!=='test'&&headers['flint-mode']!=='sandbox')throw new Error('Sandbox mode required');
  const sandboxId=headers['flint-sandbox-id'];
  if(!sandboxId||config.sandboxGuard&&sandboxId!==config.sandboxGuard)throw new Error('Sandbox identity guard failed');
  const merchant=response.body.data;
  return {sandboxId,merchantId:merchant.merchant_id,cards:merchant.readiness.capabilities.find(item=>item.capability==='accept_card_payments')?.status??'not_available',setupNeeded:settings.customer_account?.mode!=='merchant_hosted'||settings.customer_account?.merchant_account_url!==config.appOrigin,capabilities:settings.customer_account?.buyer_capabilities??null,support:{email:merchant.support_email,phone:merchant.support_phone,url:merchant.support_url}};
}
