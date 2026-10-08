// Keeps credentials and provider secrets out of the HTML document. The checkout
// page embeds the buyer-safe state as JSON for public/js/checkout.js. Provider
// client secrets only travel in the JSON response of the pay, resume, and
// attempt jobs, never in a page.

const DROP_KEYS = new Set([
  'client_secret',
  'client_action',
  'checkout_auth_token',
  'checkout_session_id',
  'checkout_session_ids',
  'superseding_checkout_session_id',
  'recovery_payment_attempt_id',
  'customer_verification_id',
  'refresh_token',
  'secret',
  'metadata',
]);

const BANNED_PREFIXES = ['flint_test_', 'flint_live_', 'ckat_', 'cklt_', 'flint_cses_', 'flint_cref_', 'whsec_', 'cs_'];

function bannedString(value: string): boolean {
  return BANNED_PREFIXES.some((prefix) => value.startsWith(prefix)) || value.includes('_secret_');
}

export function scrubForBrowser<T>(input: T): T {
  return scrub(input) as T;
}

function scrub(value: unknown): unknown {
  if (typeof value === 'string') return bannedString(value) ? undefined : value;
  if (Array.isArray(value)) return value.map(scrub).filter((item) => item !== undefined);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (DROP_KEYS.has(key)) continue;
      const cleaned = scrub(child);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return value;
}

/** JSON safe to place inside a `<script type="application/json">` element. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(new RegExp('\\u2028', 'g'), '\\u2028')
    .replace(new RegExp('\\u2029', 'g'), '\\u2029');
}
