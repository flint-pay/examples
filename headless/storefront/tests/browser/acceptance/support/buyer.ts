export function browserBuyerEmail(env: NodeJS.ProcessEnv): string {
  const email = env.E2E_BROWSER_BUYER_EMAIL, run = env.E2E_RUN_ID;
  if (!/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(run ?? '') || !email || !/^[^\s@]+@[^\s@]+$/.test(email) || !email.includes(`+fx-${run}-b1@`)) throw new Error('Run-scoped browser buyer required');
  return email;
}
export function requireBrowserLifecycle(env: NodeJS.ProcessEnv): void {
  browserBuyerEmail(env);
  if (!env.E2E_APP_AUDIT_DIR || env.E2E_APP_AUDIT_NAME !== 'storefrontA' || env.E2E_APP_AUDIT_SANDBOX !== 'A' || !env.NODE_OPTIONS?.includes('headless/e2e/support/app-audit.ts')) throw new Error('Audited browser lifecycle required');
}
