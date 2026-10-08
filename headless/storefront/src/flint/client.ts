import {Client} from '@flintpay/node';
export function createClient(baseUrl:string,sandboxGuard?:string):Client {
  return new Client({baseUrl,timeoutMs:20_000,maxAttempts:1,transport:async(input,init)=>{
    const response=await fetch(input,init);
    if(response.headers.get('Flint-Mode')==='live')throw new Error('Live API responses are refused');
    const sandbox=response.headers.get('Flint-Sandbox-Id');
    if(sandboxGuard&&sandbox&&sandbox!==sandboxGuard)throw new Error('Sandbox identity guard failed');
    return response;
  }});
}
