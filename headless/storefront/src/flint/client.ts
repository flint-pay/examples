import {Client} from '@flintpay/node';

// The SDK makes one attempt per call, so reads retry here: a GET is safe to repeat, and a brief Flint
// or network error shouldn't fail a page. Writes send once; the action journal replays them with their key.
const READ_ATTEMPTS=3;
const RETRY_STATUSES=new Set([429,500,502,503,504]);
const MAX_RETRY_AFTER_SECONDS=2;

export function createClient(baseUrl:string,sandboxGuard?:string):Client {
  return new Client({baseUrl,timeoutMs:20_000,transport:async(input,init)=>{
    const response=await fetchRetryingReads(input,init);
    if(response.headers.get('Flint-Mode')==='live')throw new Error('Live API responses are refused');
    const sandbox=response.headers.get('Flint-Sandbox-Id');
    if(sandboxGuard&&sandbox&&sandbox!==sandboxGuard)throw new Error('Sandbox identity guard failed');
    return response;
  }});
}

/** Sends a request, retrying a GET or HEAD after a network error, 429, or 5xx with a short jittered backoff. */
export async function fetchRetryingReads(input:RequestInfo|URL,init?:RequestInit,send:typeof fetch=fetch):Promise<Response>{
  const method=(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase();
  const attempts=method==='GET'||method==='HEAD'?READ_ATTEMPTS:1;
  for(let attempt=1;;attempt++){
    let delay=100*2**(attempt-1)*(0.5+Math.random());
    try{
      const response=await send(input,init);
      if(attempt>=attempts||!RETRY_STATUSES.has(response.status))return response;
      const retryAfter=Number(response.headers.get('Retry-After'));
      if(retryAfter>MAX_RETRY_AFTER_SECONDS)return response;
      if(retryAfter>0)delay=retryAfter*1000;
      await response.body?.cancel();
    }catch(error){
      if(attempt>=attempts||init?.signal?.aborted)throw error;
    }
    await pause(delay,init?.signal);
  }
}

function pause(ms:number,signal?:AbortSignal|null):Promise<void>{
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(signal.reason);
    const stop=()=>{clearTimeout(timer);reject(signal!.reason);};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},ms);
    signal?.addEventListener('abort',stop,{once:true});
  });
}
