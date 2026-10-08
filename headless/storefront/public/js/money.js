// @ts-check
// Pure money helpers shared by the server views and the browser. Amounts are
// exact integer strings in minor units; no float arithmetic touches them.

/** @typedef {{ amount: string, currency: string }} Money */

/** @type {Map<string, Intl.NumberFormat>} */
const formatters = new Map();

/** @param {string} currency */
function formatterFor(currency) {
  let formatter = formatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    formatters.set(currency, formatter);
  }
  return formatter;
}

/**
 * @param {string} amount
 * @param {string} currency
 */
export function minorToDecimal(amount, currency) {
  const digits = formatterFor(currency).resolvedOptions().maximumFractionDigits ?? 2;
  /** @type {bigint} */
  let value;
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

/** @param {Money | null | undefined} money */
export function formatMoney(money) {
  if (!money) return '';
  const decimal = minorToDecimal(money.amount, money.currency);
  return formatterFor(money.currency).format(/** @type {any} */ (decimal));
}

/** @param {Money | null | undefined} money */
export function isZero(money) {
  if (!money) return false;
  try {
    return BigInt(money.amount) === 0n;
  } catch {
    return false;
  }
}

/** @param {Money | null | undefined} money */
export function isPositive(money) {
  if (!money) return false;
  try {
    return BigInt(money.amount) > 0n;
  } catch {
    return false;
  }
}

/**
 * @param {Money | null | undefined} a
 * @param {Money | null | undefined} b
 */
export function sameMoney(a, b) {
  if (!a || !b) return a === b;
  return a.amount === b.amount && a.currency === b.currency;
}
