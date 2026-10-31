import type {Address,MoneyValue,OrderTaxLocationFullAddressRequestInput} from '@flintpay/node';
import {LocalError} from './flint/errors.ts';
import {normalizeEmail} from './identity/index.ts';

export type Body=Record<string,unknown>;

export function text(value:unknown,max=255):string{if(typeof value!=='string'||value.length>max)throw new LocalError('INVALID_INPUT');return value.trim();}
export function password(value:unknown):string{if(typeof value!=='string'||value.length>256)throw new LocalError('INVALID_INPUT');return value;}
export function email(value:unknown):string{const normalized=normalizeEmail(text(value));if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))throw new LocalError('INVALID_EMAIL');return normalized;}
export function phone(value:unknown):string|null{
  const raw=text(value,32).replace(/[\s().-]/g,'');if(!raw)return null;
  const normalized=/^\d{10}$/.test(raw)?`+1${raw}`:raw;
  if(!/^\+[1-9]\d{1,14}$/.test(normalized))throw new LocalError('INVALID_PHONE');return normalized;
}
export function asRecord(value:unknown):Body{if(!value||typeof value!=='object'||Array.isArray(value))throw new LocalError('INVALID_INPUT');return value as Body;}
export function approvedMoney(value:unknown):MoneyValue{const record=asRecord(value);const amount=text(record.amount,20);const currency=text(record.currency,3);if(!/^\d+$/.test(amount)||!/^[A-Z]{3}$/.test(currency))throw new LocalError('INVALID_AMOUNT');return {amount:amount as `${bigint}`,currency};}
export function sameBillingAddress(saved:(Omit<Address,'line2'>&{line2?:string|null})|null|undefined,address:OrderTaxLocationFullAddressRequestInput):boolean{
  return !!saved&&(['line1','city','state','postal_code','country'] as const).every(field=>saved[field]===address[field])&&(saved.line2??'').trim()===(address.line2??'').trim();
}
/** Reads a form field from a server action's FormData as the JSON routes read a body field. */
export function field(form:FormData,name:string):unknown{const value=form.get(name);return value===null?undefined:value;}
