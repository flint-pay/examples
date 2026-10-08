import { join } from 'node:path';
import type { Config, Sandbox } from './config.ts';
import type { Fixtures } from './fixtures.ts';

export type OwnedApp = { name: string; app: string; sandbox: Sandbox; origin: string; identity: string; cookie: string };
export function appEnvironment(config: Config, fixtures: Fixtures, directory: string, secret: string, app: OwnedApp): NodeJS.ProcessEnv {
  const pin = config.pins[app.sandbox];
  return {
    FLINT_API_KEY: pin.key, FLINT_API_BASE_URL: config.apiOrigin, FLINT_SANDBOX_ID: pin.sandboxId, APP_ORIGIN: app.origin, PORT: new URL(app.origin).port,
    APP_DATABASE_PATH: join(directory, `${app.name}.sqlite`), IDENTITY_DATABASE_PATH: join(directory, app.identity), SESSION_COOKIE_NAME: app.cookie,
    ACCOUNT_APP_ORIGIN: config.origins.accountA, STOREFRONT_ORIGIN: config.origins.storefrontA, CUSTOMER_SESSION_TTL_SECONDS: '300',
    FLINT_WEBHOOK_SECRET: secret, BUILD_SHA: config.targetCommit, BUILD_ARTIFACT_ID: config.builds[app.name], E2E_RUN_ID: config.run,
    E2E_APP_AUDIT_DIR: directory, E2E_APP_AUDIT_NAME: app.name, E2E_APP_AUDIT_SANDBOX: app.sandbox,
    ...(fixtures.values.checkoutMinimumTtlSeconds ? { CHECKOUT_SESSION_TTL_SECONDS: String(fixtures.values.checkoutMinimumTtlSeconds) } : {}),
  };
}
