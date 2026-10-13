// Money helpers shared by server and client components. Amounts are exact
// integer strings in minor units; no float arithmetic touches them.

export type Money = { amount: string; currency: string };

const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(currency: string): Intl.NumberFormat {
  let formatter = formatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    formatters.set(currency, formatter);
  }
  return formatter;
}

export function minorToDecimal(amount: string, currency: string): string {
  const digits = formatterFor(currency).resolvedOptions().maximumFractionDigits ?? 2;
  let value: bigint;
  try {
    value = BigInt(amount);
  } catch {
    return '0';
  }
  const negative = value < 0n;
  const text = (negative ? -value : value).toString().padStart(digits + 1, '0');
  const whole = text.slice(0, text.length - digits);
  const fraction = digits === 0 ? '' : `.${text.slice(text.length - digits)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

export function formatMoney(money: Money | null | undefined): string {
  if (!money) return '';
  const decimal = minorToDecimal(money.amount, money.currency);
  // Intl accepts decimal strings exactly; the cast only satisfies older lib typings.
  return formatterFor(money.currency).format(decimal as unknown as number);
}

export function isZero(money: Money | null | undefined): boolean {
  if (!money) return false;
  try {
    return BigInt(money.amount) === 0n;
  } catch {
    return false;
  }
}

export function isPositive(money: Money | null | undefined): boolean {
  if (!money) return false;
  try {
    return BigInt(money.amount) > 0n;
  } catch {
    return false;
  }
}

export function sameMoney(a: Money | null | undefined, b: Money | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.amount === b.amount && a.currency === b.currency;
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
