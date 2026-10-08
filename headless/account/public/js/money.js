// @ts-check
// Money formatting shared by the server renderer and the browser modules.
// Amounts are integer minor units in exact strings. Nothing here uses floating point.

/**
 * @typedef {{ amount: string, currency: string }} MoneyValue
 */

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
 * Splits an exact minor unit string into a decimal string using the currency's fraction digits.
 * @param {string} amount
 * @param {number} digits
 * @returns {string | null}
 */
export function minorToDecimal(amount, digits) {
  if (!/^-?\d+$/.test(amount)) return null;
  const negative = amount.startsWith('-');
  const raw = negative ? amount.slice(1) : amount;
  const padded = raw.padStart(digits + 1, '0');
  const whole = padded.slice(0, padded.length - digits);
  const fraction = digits > 0 ? padded.slice(padded.length - digits) : '';
  const trimmed = whole.replace(/^0+(?=\d)/, '');
  return `${negative ? '-' : ''}${trimmed}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Formats a MoneyValue or SignedMoney such as "$18.00". Returns an empty string for a missing value.
 * @param {MoneyValue | null | undefined} money
 * @returns {string}
 */
export function formatMoney(money) {
  if (!money || typeof money.amount !== 'string' || typeof money.currency !== 'string') return '';
  try {
    const formatter = formatterFor(money.currency);
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    const decimal = minorToDecimal(money.amount, digits);
    if (decimal === null) return `${money.amount} ${money.currency}`;
    // Intl.NumberFormat accepts exact decimal strings, so large amounts keep every digit.
    return formatter.format(/** @type {any} */ (decimal));
  } catch {
    return `${money.amount} ${money.currency}`;
  }
}

/**
 * True when two money values are the same amount in the same currency.
 * @param {MoneyValue | null | undefined} a
 * @param {MoneyValue | null | undefined} b
 */
export function sameMoney(a, b) {
  return Boolean(a && b && a.amount === b.amount && a.currency === b.currency);
}

/**
 * Converts a money value to the bounded number Stripe.js needs for Elements amounts.
 * Returns null when the exact value does not fit a safe integer.
 * @param {MoneyValue | null | undefined} money
 * @returns {number | null}
 */
export function stripeAmount(money) {
  if (!money || !/^\d+$/.test(money.amount)) return null;
  const value = Number(money.amount);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Adds two non-negative money values of the same currency using BigInt.
 * @param {MoneyValue} a
 * @param {MoneyValue} b
 * @returns {MoneyValue | null}
 */
export function addMoney(a, b) {
  if (a.currency !== b.currency || !/^-?\d+$/.test(a.amount) || !/^-?\d+$/.test(b.amount)) return null;
  return { amount: String(BigInt(a.amount) + BigInt(b.amount)), currency: a.currency };
}

/**
 * True when the amount is zero.
 * @param {MoneyValue | null | undefined} money
 */
export function isZero(money) {
  return Boolean(money && /^-?\d+$/.test(money.amount) && BigInt(money.amount) === 0n);
}
