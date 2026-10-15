export type Config = {
  apiKey: string;
  apiBaseUrl: string;
  port: number;
  /** Current secret first, then the previous one while a rotation is in progress. Empty until setup writes one. */
  webhookSecrets: string[];
  endpointId?: string;
  webhookUrl?: string;
  sandboxGuard?: string;
  databasePath: string;
  catchUpIntervalSeconds: number;
  catchUpLookbackHours: number;
};

const API_ORIGINS = ['https://api.staging.withflintpay.com', 'https://api.withflintpay.com'];

/** A Flint signing secret is whsec_ followed by the canonical base64 encoding of exactly 32 bytes. */
export function validSigningSecret(value: string): boolean {
  if (!value.startsWith('whsec_')) return false;
  const encoded = value.slice('whsec_'.length);
  const bytes = Buffer.from(encoded, 'base64');
  return bytes.length === 32 && bytes.toString('base64') === encoded;
}

function integer(value: string | undefined, fallback: number, name: string, min: number, max: number, errors: string[]): number {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) errors.push(`${name}: use a whole number from ${min} to ${max}`);
  return parsed;
}

export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const errors: string[] = [];
  const apiKey = env.FLINT_API_KEY?.trim() ?? '';
  if (!apiKey.startsWith('flint_test_')) errors.push('FLINT_API_KEY: a sandbox test key is required; live credentials are refused');
  const apiBaseUrl = env.FLINT_API_BASE_URL?.trim() ?? '';
  if (!API_ORIGINS.includes(apiBaseUrl)) errors.push(`FLINT_API_BASE_URL: use ${API_ORIGINS.join(' or ')}`);
  const port = integer(env.PORT, Number.NaN, 'PORT', 1, 65535, errors);

  const webhookSecrets: string[] = [];
  for (const name of ['FLINT_WEBHOOK_SECRET', 'FLINT_WEBHOOK_PREVIOUS_SECRET'] as const) {
    const value = env[name]?.trim();
    if (!value) continue;
    if (!validSigningSecret(value)) errors.push(`${name}: expected a whsec_ signing secret from Flint`);
    else webhookSecrets.push(value);
  }
  if (env.FLINT_WEBHOOK_PREVIOUS_SECRET?.trim() && !env.FLINT_WEBHOOK_SECRET?.trim()) {
    errors.push('FLINT_WEBHOOK_PREVIOUS_SECRET: set FLINT_WEBHOOK_SECRET to the current secret as well');
  }

  const webhookUrl = env.WEBHOOK_URL?.trim() || undefined;
  if (webhookUrl) {
    const url = URL.canParse(webhookUrl) ? new URL(webhookUrl) : undefined;
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash) {
      errors.push('WEBHOOK_URL: use the public https URL Flint should post to, including the /webhooks/flint path');
    }
  }

  const config: Config = {
    apiKey,
    apiBaseUrl,
    port,
    webhookSecrets,
    endpointId: env.FLINT_WEBHOOK_ENDPOINT_ID?.trim() || undefined,
    webhookUrl,
    sandboxGuard: env.FLINT_SANDBOX_ID?.trim() || undefined,
    databasePath: env.DATABASE_PATH?.trim() || './data/webhooks.sqlite',
    catchUpIntervalSeconds: integer(env.CATCH_UP_INTERVAL_SECONDS, 300, 'CATCH_UP_INTERVAL_SECONDS', 0, 86400, errors),
    // Flint removes stored event payloads after 14 days, so catch-up can't read anything older.
    catchUpLookbackHours: integer(env.CATCH_UP_LOOKBACK_HOURS, 72, 'CATCH_UP_LOOKBACK_HOURS', 1, 336, errors),
  };
  if (errors.length) throw new Error(errors.join('\n'));
  return config;
}
