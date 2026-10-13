import {hasMessage,parseNotice} from '../shared/copy.ts';

/**
 * Notices a redirect may carry in `?notice=`. Only listed keys are shown, and only a count may ride
 * along as a parameter, so a crafted link can't put arbitrary text on the page.
 */
export function noticesFrom(params:Record<string,string|string[]|undefined>,allowed:string[]):string[]{
  const raw=params.notice;const value=Array.isArray(raw)?raw[0]:raw;
  if(!value)return [];
  const {key,param}=parseNotice(value);
  if(!allowed.includes(key)||!hasMessage(key))return [];
  if(param!==undefined&&!/^\d{1,4}$/.test(param))return [];
  return [value];
}
