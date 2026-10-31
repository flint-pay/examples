import {Client} from '@flintpay/node';

// Reads retry in the SDK (up to 3 attempts, honoring Retry-After), so the transport only guards the response.
// Writes pass maxAttempts 1 (flint/auth.ts) and replay from the action journal with their saved key.
export function createClient(baseUrl:string,sandboxGuard?:string):Client {
  return new Client({baseUrl,timeoutMs:20_000,transport:async(input,init)=>{
    const response=await fetch(input,init);
    if(response.headers.get('Flint-Mode')==='live')throw new Error('Live API responses are refused');
    const sandbox=response.headers.get('Flint-Sandbox-Id');
    if(sandboxGuard&&sandbox&&sandbox!==sandboxGuard)throw new Error('Sandbox identity guard failed');
    return response;
  }});
}
