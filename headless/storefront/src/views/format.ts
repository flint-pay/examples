import { formatMoney as formatMoneyShared, isPositive, isZero, minorToDecimal } from '../../public/js/money.js';
import type { Money } from './types.ts';

export { isPositive, isZero, minorToDecimal };

export function formatMoney(money: Money | null | undefined): string {
  return formatMoneyShared(money);
}

/** Sums money values of one currency. Returns null when currencies differ or a value is missing. */
export function sumMoney(values: (Money | null | undefined)[]): Money | null {
  let total = 0n;
  let currency: string | null = null;
  for (const value of values) {
    if (!value) return null;
    if (currency && currency !== value.currency) return null;
    currency = value.currency;
    total += BigInt(value.amount);
  }
  return currency ? { amount: total.toString(), currency } : null;
}

export function multiplyMoney(value: Money, quantity: number): Money {
  return { amount: (BigInt(value.amount) * BigInt(quantity)).toString(), currency: value.currency };
}

const dateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const longDateFormatter = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

/** Formats a calendar date (`2026-10-12`) or an ISO timestamp without shifting the day. */
export function formatDay(value: string | undefined | null, long = false): string {
  if (!value) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return (long ? longDateFormatter : dateFormatter).format(date);
}

export function addressLine(address: { line1?: string; line2?: string; city?: string; state?: string; postal_code?: string } | null | undefined): string {
  if (!address) return '';
  const street = [address.line1, address.line2].filter(Boolean).join(', ');
  const place = [address.city, [address.state, address.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [street, place].filter(Boolean).join(', ');
}

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
