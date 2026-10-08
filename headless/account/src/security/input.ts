import {LocalError} from '../flint/errors.ts';
export function text(value:unknown,max=255):string {if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw new LocalError('INVALID_INPUT');return value.trim();}
export function required(value:unknown,max=255):string {const v=text(value,max);if(!v)throw new LocalError('INVALID_INPUT');return v;}
export function id(value:unknown):string {const v=required(value,200);if(!/^[A-Za-z0-9_-]+$/.test(v))throw new LocalError('INVALID_INPUT');return v;}
export function giftRecipient(value:unknown,token:unknown):{credential_type:'recipient_access';grant_id:string;recipient_access_token:string}{
  if(typeof value!=='string'||value.length!==30||!/^gcg_[0-9A-HJKMNP-TV-Z]{26}$/.test(value)||typeof token!=='string'||!token.length||token.length>4096)throw new LocalError('INVALID_INPUT');
  return {credential_type:'recipient_access',grant_id:value,recipient_access_token:token};
}
export function bool(value:unknown):boolean {return value===true||value==='true'||value==='on'||value==='1';}
export function code(value:unknown):string {const v=text(value,6);if(!/^\d{6}$/.test(v))throw new LocalError('CUSTOMER_VERIFICATION_CODE_INVALID');return v;}
export function email(value:unknown):string {const v=required(value,254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))throw new LocalError('INVALID_EMAIL');return v;}
export function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new LocalError('INVALID_INPUT');return value as Record<string,unknown>;}
