export type HintDecision={kind:'none'}|{kind:'reject';notice?:'wrong_environment'}|{kind:'resource';type:'order'|'subscription'|'invoice'|'return';id:string;path:string}|{kind:'preferences';path:string};
const sources=new Set(['order_receipts','fulfillment_updates','subscription_lifecycle','dunning','invoices','returns']);
export function resourceHint(url:URL,merchantId:string,sandboxId:string):HintDecision{
  const q=url.searchParams;if(![...q.keys()].some(key=>key.startsWith('flint_')))return {kind:'none'};
  const known=new Set(['flint_merchant_id','flint_resource_type','flint_resource_id','flint_action','flint_mode','flint_environment_id','flint_source']);
  for(const [key]of q)if(key.startsWith('flint_')&&(!known.has(key)||q.getAll(key).length!==1))return {kind:'reject'};
  if(q.get('flint_merchant_id')!==merchantId||q.get('flint_mode')!=='sandbox'||q.get('flint_environment_id')!==sandboxId)return {kind:'reject',notice:'wrong_environment'};
  const type=q.get('flint_resource_type'),action=q.get('flint_action'),source=q.get('flint_source');
  if(source&&!sources.has(source))return {kind:'reject'};
  if(type==='email_preferences'&&action==='manage')return {kind:'preferences',path:'/email-preferences'};
  const plural:Record<string,string>={order:'orders',subscription:'subscriptions',invoice:'invoices',return:'returns'};
  if(!type||!plural[type]||action!==(type==='order'||type==='invoice'?'view':'manage'))return {kind:'reject'};
  const id=q.get('flint_resource_id');if(!id||!/^[A-Za-z0-9_-]{1,200}$/.test(id))return {kind:'reject'};
  return {kind:'resource',type:type as 'order'|'subscription'|'invoice'|'return',id,path:`/${plural[type]}/${id}`};
}
