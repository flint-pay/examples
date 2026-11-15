import {Client} from '@flintpay/node';
export function createClient(baseUrl:string,transport:typeof fetch=fetch):Client{
  return new Client({baseUrl,ambientCredentials:false,maxAttempts:1,transport:async(input,init)=>{
    const response=await transport(input,{...init,redirect:'error'});
    if(response.headers.get('Flint-Mode')==='live'){await response.body?.cancel();throw new Error('Live API responses are refused');}
    return response;
  }});
}
