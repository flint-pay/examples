import type {MoneyValue} from '@flintpay/node';
export function moneyEqual(a:MoneyValue,b:MoneyValue):boolean{return a.currency===b.currency&&BigInt(a.amount)===BigInt(b.amount);}
export function decimalMinor(value:string):string {
  if(!/^\d{1,9}(\.\d{1,2})?$/.test(value))throw new Error('invalid_amount');
  const [whole,fraction='']=value.split('.');return (BigInt(whole!)*100n+BigInt(fraction.padEnd(2,'0'))).toString();
}
export function formatMoney(money:MoneyValue):string {
  const units=new Intl.NumberFormat('en-US',{style:'currency',currency:money.currency});
  const amount=BigInt(money.amount);const digits=units.resolvedOptions().maximumFractionDigits??2;
  const scale=10n**BigInt(digits);const negative=amount<0n;const absolute=negative?-amount:amount;
  const parts=units.formatToParts(negative?-1:1);
  const integers=new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(absolute/scale);
  return parts.map(part=>part.type==='integer'?integers:part.type==='fraction'?(absolute%scale).toString().padStart(digits,'0'):part.type==='group'?'':part.value).join('');
}
