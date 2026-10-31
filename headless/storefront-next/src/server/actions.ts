'use server';

import {headers} from 'next/headers';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {LocalError,appError} from './flint/errors.ts';
import type {ErrorScope} from './flint/errors.ts';
import {normalizeEmail,verifyPassword} from './identity/index.ts';
import {returnPath} from './security/paths.ts';
import {viewPath} from './flint/view-data.ts';
import {buyerSafe} from './flint/projection.ts';
import {email,field,password,text} from './input.ts';
import {clientIp,limited} from './http.ts';
import {requireUser,requireVisitor,setSessionCookie} from './session.ts';
import type {Visitor} from './session.ts';

// Server actions behind the store's forms. Each works as a plain form post without JavaScript.
// Next.js rejects actions from other origins; each one also checks the origin against APP_ORIGIN.

export type ActionError={code:string;message_key:string;request_id?:string};
export type FormState={error?:ActionError;fieldErrors?:Record<string,string>;values?:Record<string,string>;notice?:string;cartCount?:number;at?:number};

async function changeRequest():Promise<Visitor>{
  const found=await requireVisitor();
  if((await headers()).get('origin')!==found.rt.config.appOrigin)throw new LocalError('CSRF_ORIGIN_REJECTED',403);
  return found;
}

function toError(error:unknown,scope?:ErrorScope):ActionError{
  const mapped=appError(error,scope);
  if(!(error instanceof LocalError)&&!(error&&typeof error==='object'&&'kind'in error))console.error(error);
  return {code:mapped.code,message_key:mapped.message_key,...(mapped.request_id?{request_id:mapped.request_id}:{})};
}

function cartError(error:unknown):ActionError{
  const mapped=toError(error);
  return ['CHECKOUT_PAYMENT_RESOLVING','PAYMENT_ATTEMPT_IN_PROGRESS','ORDER_PAYMENT_ATTEMPT_ACTIVE','OPERATION_IN_PROGRESS'].includes(mapped.code)?{...mapped,message_key:'cart_locked_payment'}:mapped;
}

function cartCount(found:Visitor):number{
  const cart=found.rt.carts.current(found.session,found.user);
  return found.rt.carts.lines(cart).reduce((sum,line)=>sum+line.quantity,0);
}

// ----- Cart -----

export async function addToCart(_previous:FormState,form:FormData):Promise<FormState>{
  try{
    const found=await changeRequest();const {catalog,carts,checkouts}=found.rt;
    const slug=text(field(form,'product_slug'));const item=await catalog.product(slug);
    const variantId=text(field(form,'variant_id')??item.product.default_variant_id);const quantity=carts.quantity(field(form,'quantity')??1);
    if(!item.variants.some(variant=>variant.variant_id===variantId&&variant.available_for_sale))throw new LocalError('PRODUCT_UNAVAILABLE');
    const cart=carts.current(found.session,found.user);
    await checkouts.editCart(cart,()=>carts.add(cart,slug,variantId,quantity));
    revalidatePath('/','layout');
    return {notice:'added_to_cart',cartCount:cartCount(found),at:Date.now()};
  }catch(error){return {error:cartError(error),at:Date.now()};}
}

export async function updateCartLine(_previous:FormState,form:FormData):Promise<FormState>{
  try{
    const found=await changeRequest();const {carts,checkouts,store}=found.rt;
    const cart=carts.current(found.session,found.user);const line=carts.lines(cart).find(line=>line.line_id===field(form,'line_id'));
    if(!line)throw new LocalError('CART_LINE_MISSING',404);
    const remove=field(form,'intent')==='remove';const quantity=remove?null:carts.quantity(field(form,'quantity'));
    await checkouts.editCart(cart,async()=>{if(remove)store.run('DELETE FROM cart_lines WHERE line_id=?',line.line_id);else store.run('UPDATE cart_lines SET quantity=? WHERE line_id=?',quantity!,line.line_id);});
    revalidatePath('/','layout');
    return {cartCount:cartCount(found),at:Date.now()};
  }catch(error){revalidatePath('/cart');return {error:cartError(error),at:Date.now()};}
}

export async function startCheckout(_previous:FormState):Promise<FormState>{
  let target:string;
  try{
    const found=await changeRequest();limited(found,await clientIp(),'checkout',10,60_000);
    const record=await found.rt.checkouts.start(found.rt.carts.current(found.session,found.user),found.session,found.user);
    target=`/checkout/${record.checkout_ref}`;
  }catch(error){return {error:toError(error),at:Date.now()};}
  redirect(target);
}

export async function startSubscription(_previous:FormState,form:FormData):Promise<FormState>{
  let target:string;
  try{
    const found=await changeRequest();limited(found,await clientIp(),'checkout',10,60_000);
    const plan=await found.rt.catalog.plan(text(field(form,'plan_slug')));
    const record=await found.rt.checkouts.subscribe(plan.plan.subscription_plan_id,found.session,found.user);
    target=`/checkout/${record.checkout_ref}`;
  }catch(error){return {error:toError(error),at:Date.now()};}
  redirect(target);
}

// ----- Identity -----

function rememberValues(form:FormData,names:string[]):Record<string,string>{
  const values:Record<string,string>={};
  for(const name of names){const value=form.get(name);if(typeof value==='string'&&value.length<=(name==='name'?200:255)&&buyerSafe(value)!==undefined)values[name]=value.trim();}
  return values;
}

function identityFailure(error:unknown,values:Record<string,string>):FormState{
  const mapped=toError(error);
  const fieldName=mapped.code==='INVALID_EMAIL'||mapped.code==='EMAIL_ALREADY_REGISTERED'?'email':mapped.code==='PASSWORD_TOO_SHORT'?'password':undefined;
  const key=mapped.code==='INVALID_EMAIL'?'email_invalid':mapped.code==='EMAIL_ALREADY_REGISTERED'?'email_already_used':'password_too_short';
  if(mapped.code==='INVALID_SIGN_IN')mapped.message_key='sign_in_failed';
  return fieldName?{fieldErrors:{[fieldName]:key},values,at:Date.now()}:{error:mapped,values,at:Date.now()};
}

/** Moves the guest cart and guest checkouts to the account, then replaces the session so its old token stops working. */
async function signInAs(found:Visitor,user:NonNullable<Visitor['user']>){
  const {checkouts,store,identity}=found.rt;
  await checkouts.mergeCart(found.session,user);
  store.run('UPDATE checkouts SET user_id=? WHERE session_hash=? AND user_id IS NULL',user.user_id,found.session.session_hash);
  const rotated=identity.rotate(found.session,user.user_id);await setSessionCookie(found.rt,rotated.token);
}

export async function signUp(_previous:FormState,form:FormData):Promise<FormState>{
  const values=rememberValues(form,['name','email']);const next=returnPath(field(form,'next'));
  try{
    const found=await changeRequest();const {identity}=found.rt;
    limited(found,await clientIp(),'signup',5,60*60_000);
    const address=email(field(form,'email'));const name=text(field(form,'name'),200);const secret=password(field(form,'password'));
    if(!name||secret.length<10)throw new LocalError('PASSWORD_TOO_SHORT');
    if(identity.userByEmail(address))throw new LocalError('EMAIL_ALREADY_REGISTERED',409);
    await signInAs(found,await identity.createUser(name,address,secret));
  }catch(error){return identityFailure(error,values);}
  revalidatePath('/','layout');
  redirect(`/verify-email?next=${encodeURIComponent(next)}`);
}

export async function signIn(_previous:FormState,form:FormData):Promise<FormState>{
  const values=rememberValues(form,['email']);const next=returnPath(field(form,'next'));let bound=false;
  try{
    const found=await changeRequest();const {identity,preflight}=found.rt;
    const address=email(field(form,'email'));limited(found,await clientIp(),'signin',5,15*60_000,normalizeEmail(address));
    const user=identity.userByEmail(address);
    if(!await verifyPassword(password(field(form,'password')),user?.password_hash)||!user)throw new LocalError('INVALID_SIGN_IN',401);
    if(user.status==='closed')throw new LocalError('ACCOUNT_CLOSED',403);
    await signInAs(found,user);bound=identity.isBound(user,preflight.sandboxId);
  }catch(error){return identityFailure(error,values);}
  revalidatePath('/','layout');
  redirect(bound?next:`/verify-email?next=${encodeURIComponent(next)}`);
}

export async function signOut():Promise<void>{
  try{
    const found=await changeRequest();
    await found.rt.binding.signOut(found.user);found.rt.identity.destroy(found.session);
    await setSessionCookie(found.rt,found.rt.identity.createSession().token);
  }catch(error){console.error(toError(error).code);}
  revalidatePath('/','layout');
  redirect('/sign-in?notice=signed_out');
}

export async function sendEmailCode(_previous:FormState,form:FormData):Promise<FormState>{
  const next=returnPath(field(form,'next'));
  try{
    const found=await changeRequest();limited(found,await clientIp(),'verification',3,15*60_000);
    await found.rt.binding.send(requireUser(found),found.session);
  }catch(error){
    const mapped=toError(error);
    if(mapped.code==='SESSION_ENDED')redirect(`/sign-in?next=${encodeURIComponent(next)}`);
    return {error:mapped,at:Date.now()};
  }
  redirect(`/verify-email?next=${encodeURIComponent(next)}`);
}

export async function confirmEmailCode(_previous:FormState,form:FormData):Promise<FormState>{
  const next=returnPath(field(form,'next'));let linked=0;
  try{
    const found=await changeRequest();
    linked=await found.rt.binding.confirm(requireUser(found),found.session,text(field(form,'code'),6));
  }catch(error){
    const mapped=toError(error,'verification');
    if(mapped.code==='SESSION_ENDED')redirect(`/sign-in?next=${encodeURIComponent(next)}`);
    return {error:mapped,fieldErrors:mapped.code==='CUSTOMER_VERIFICATION_CODE_INVALID'?{code:'customer_verification_code_invalid'}:undefined,at:Date.now()};
  }
  revalidatePath('/','layout');
  const target=new URL(viewPath(next),'https://store.invalid');target.searchParams.set('notice',linked>0?`email_confirmed_linked:${linked}`:'email_confirmed');
  redirect(target.pathname+target.search+target.hash);
}
