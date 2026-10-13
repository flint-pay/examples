import 'server-only';
import {randomBytes} from 'node:crypto';
import {cookies,headers} from 'next/headers';
import {redirect} from 'next/navigation';
import {digest} from './identity/index.ts';
import type {Session,User} from './identity/index.ts';
import {LocalError} from './flint/errors.ts';
import {runtime} from './runtime.ts';
import type {Runtime} from './runtime.ts';
import {returnPath} from './security/paths.ts';
import {SESSION_MINTED_HEADER} from '../shared/session-header.ts';

export type Visitor={rt:Runtime;session:Session;user:User|undefined};

/**
 * The session for this request. A token the proxy minted for this request is adopted on first read;
 * any other unknown token is refused, so a session can't be planted from outside.
 */
export async function visitor(options:{mutating:boolean}):Promise<Visitor|undefined>{
  // Reading cookies first marks every page dynamic, so nothing that needs the API key renders at build time.
  const jar=await cookies();const rt=await runtime();const token=jar.get(rt.config.cookieName)?.value;
  let session=rt.identity.session(token);
  if(!session&&!options.mutating&&token&&(await headers()).get(SESSION_MINTED_HEADER)===token){
    const now=Date.now();
    rt.identity.db.prepare('INSERT OR IGNORE INTO sessions(session_hash,user_id,csrf_token,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?)').run(digest(token),null,randomBytes(32).toString('base64url'),now,now,now+30*24*60*60*1000);
    session=rt.identity.session(token);
  }
  if(!session)return undefined;
  const user=session.user_id?rt.identity.user(session.user_id):undefined;
  return {rt,session,user};
}

/** For pages: an expired or unknown cookie is replaced by a fresh session, then the page loads again. */
export async function pageVisitor(path:string):Promise<Visitor>{
  const found=await visitor({mutating:false});
  if(found)return found;
  redirect(`/session/renew?next=${encodeURIComponent(returnPath(path))}`);
}

/** For server actions and JSON routes that change data. */
export async function requireVisitor():Promise<Visitor>{
  const found=await visitor({mutating:true});
  if(!found)throw new LocalError('SESSION_ENDED',401);
  return found;
}

export async function setSessionCookie(rt:Runtime,token:string){
  (await cookies()).set(rt.config.cookieName,token,{httpOnly:true,secure:rt.config.appOrigin.startsWith('https:'),sameSite:'lax',path:'/',maxAge:30*24*60*60});
}

export function requireUser(found:Visitor):User{
  if(!found.user||found.user.status==='closed')throw new LocalError('SESSION_ENDED',401);
  return found.user;
}
