export { formatMoney, isPositive, isZero, minorToDecimal, multiplyMoney, sumMoney } from './money.ts';

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

export function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
