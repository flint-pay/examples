import 'server-only';
import {randomUUID} from 'node:crypto';
import {headers} from 'next/headers';
import {LocalError,appError,errorStatus,unknownOutcome} from './flint/errors.ts';
import type {AppError} from './flint/errors.ts';
import {logLaunchInvalid,logRequest} from './security/log.ts';
import {equalSecret,digest} from './identity/index.ts';
import {requireVisitor,visitor} from './session.ts';
import type {Visitor} from './session.ts';
import {projectState} from './checkout-view.ts';

export type Body=Record<string,unknown>;
export type RouteContext=Visitor&{req:Request;requestId:string;ref?:string;body:()=>Promise<Body>};
type Params={params:Promise<Record<string,string|string[]>>};

const MAX_BODY=65536;
const GIFT_LOCAL_CODES=['GIFT_CHALLENGE_EXPIRED','GIFT_CHALLENGE_SESSION_CHANGED','GIFT_CHALLENGE_CODE_CHANGED','GIFT_CHALLENGE_ORDER_CHANGED','CHECKOUT_PAYMENT_RESOLVING','PAYMENT_ATTEMPT_IN_PROGRESS'];

export function json(value:unknown,status=200):Response{
  return Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
}

async function readBody(req:Request):Promise<Body>{
  if(!req.headers.get('content-type')?.includes('application/json'))throw new LocalError('INVALID_INPUT');
  const text=await req.text();
  if(text.length>MAX_BODY)throw new LocalError('REQUEST_TOO_LARGE',413);
  let value:unknown;
  try{value=text?JSON.parse(text):{};}catch{throw new LocalError('INVALID_INPUT');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new LocalError('INVALID_INPUT');
  return value as Body;
}

/** The client address for rate limits. Behind a proxy, trust only the address it appends. */
export async function clientIp():Promise<string>{
  const forwarded=(await headers()).get('x-forwarded-for');
  return forwarded?.split(',').at(-1)?.trim()||'direct';
}

export function limited(found:Visitor,ip:string,kind:string,count:number,window:number,emailKey=''){
  if(!found.rt.limits.take(`${kind}:session:${found.session.session_hash}`,count,window)||!found.rt.limits.take(`${kind}:ip:${ip}:${digest(emailKey)}`,count,window))throw new LocalError('RATE_LIMITED',429);
}

/**
 * Wraps a JSON route handler the checkout page calls. Every request that changes data must come from
 * this app's origin, carry the session's CSRF token, and belong to an existing session. Errors become
 * `{error, state}` with the buyer-safe checkout state when there is one, so the page can re-render.
 */
export function route(handler:(ctx:RouteContext)=>Promise<Response>){
  return async(req:Request,{params}:Params):Promise<Response>=>{
    const started=Date.now();const requestId=randomUUID();const path=new URL(req.url).pathname;
    const raw=(await params).ref;const ref=typeof raw==='string'?raw:undefined;
    let found:Visitor|undefined;let response:Response;
    try{
      const mutating=!['GET','HEAD','OPTIONS'].includes(req.method);
      if(Number(req.headers.get('content-length')??0)>MAX_BODY)throw new LocalError('REQUEST_TOO_LARGE',413);
      if(mutating){
        found=await requireVisitor();
        if(req.headers.get('origin')!==found.rt.config.appOrigin)throw new LocalError('CSRF_ORIGIN_REJECTED',403);
        const csrf=req.headers.get('x-csrf-token');
        if(!csrf||!equalSecret(csrf,found.session.csrf_token))throw new LocalError('CSRF_TOKEN_REJECTED',403);
      }else{
        found=await visitor({mutating:false});
        if(!found)throw new LocalError('SESSION_ENDED',401);
      }
      let cached:Promise<Body>|undefined;
      response=await handler({...found,req,requestId,ref,body:()=>cached??=readBody(req)});
    }catch(error){
      response=await failure(error,found,path,ref);
    }
    response.headers.set('X-Request-Id',requestId);
    logRequest({request_id:requestId,route:path,status:response.status,duration_ms:Date.now()-started});
    return response;
  };
}

async function failure(error:unknown,found:Visitor|undefined,path:string,ref:string|undefined):Promise<Response>{
  const mapped:AppError=appError(error);const status=errorStatus(error);
  if(!(error instanceof LocalError)&&!(error&&typeof error==='object'&&'kind'in error))console.error(error);
  // Flint failures are logged by code and request ID only, so the log never holds buyer or credential data.
  else if(status>=500)console.warn(JSON.stringify({event:'flint_error',route:path,code:mapped.code,kind:mapped.kind,flint_request_id:mapped.request_id,...(error instanceof Error&&mapped.code==='UNKNOWN_ERROR'?{name:error.name,message:error.message.slice(0,200)}:{})}));
  if(path.endsWith('/gift-card/challenge')&&unknownOutcome(error))mapped.message_key='gift_challenge_unconfirmed';
  if(mapped.code==='INVALID_PAGE_ORIGIN')logLaunchInvalid('invalid_page_origin',mapped.request_id);
  if(mapped.code==='REQUEST_TOO_LARGE')mapped.message_key='generic_error';
  const localChallenge=path.endsWith('/gift-card/challenge')&&GIFT_LOCAL_CODES.includes(mapped.code);
  let state:unknown;
  if(found&&ref&&status!==404&&!localChallenge){
    try{found.rt.checkouts.owned(ref,found.session,found.user);state=(await projectState(found.rt,ref,found.user)).state;}catch{/* the error stands on its own */}
  }
  return json({error:mapped,state},status);
}
