import { formatMoney, isZero, sameMoney } from '../../public/js/money.js';
import type { MoneyValue } from './types.ts';

export { formatMoney, isZero, sameMoney };

export interface FormatContext {
  timeZone: string;
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string, withTime: boolean): Intl.DateTimeFormat {
  const key = `${timeZone}|${withTime}`;
  let formatter = dateFormatters.get(key);
  if (!formatter) {
    // dateStyle and timeZoneName cannot be combined, so the fields are spelled out.
    const build = (zone: string) =>
      new Intl.DateTimeFormat(
        'en-US',
        withTime
          ? { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: zone }
          : { year: 'numeric', month: 'short', day: 'numeric', timeZone: zone },
      );
    try {
      formatter = build(timeZone);
    } catch {
      formatter = build('UTC');
    }
    dateFormatters.set(key, formatter);
  }
  return formatter;
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Oct 7, 2026" in the configured zone. Empty string for a missing or invalid value. */
export function formatDate(value: string | number | Date | null | undefined, timeZone = 'UTC'): string {
  const date = toDate(value);
  return date ? dateFormatter(timeZone, false).format(date) : '';
}

/** "Oct 7, 2026, 3:04 PM CDT". An absolute timestamp with its zone. */
export function formatDateTime(value: string | number | Date | null | undefined, timeZone = 'UTC'): string {
  const date = toDate(value);
  return date ? dateFormatter(timeZone, true).format(date) : '';
}

export function isoString(value: string | number | Date | null | undefined): string {
  const date = toDate(value);
  return date ? date.toISOString() : '';
}

/** Parses an exact integer string to a number for display counts. Returns 0 when invalid. */
export function countOf(value: string | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

export function moneyOrZero(money: MoneyValue | null | undefined, currency = 'USD'): MoneyValue {
  return money ?? { amount: '0', currency };
}

/** Joins address parts that exist into a single line. */
export function addressLines(address: {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
}): string[] {
  const cityLine = [address.city, [address.state, address.postal_code].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  return [address.line1, address.line2, cityLine, address.country && address.country !== 'US' ? address.country : null]
    .filter((line): line is string => Boolean(line));
}

/** True for an http or https URL. Used before printing a link the API supplied. */
export function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Escapes a value for use inside a JSON script block so it cannot close the element. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Builds an encoded path: path('/orders', id) gives /orders/{encoded id}. */
export function path(...segments: string[]): string {
  return segments
    .map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment)))
    .join('/');
}
