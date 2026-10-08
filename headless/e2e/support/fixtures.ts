import { readPrivate } from './private-files.ts';
import { invariant } from './safe.ts';
import { money } from './money.ts';
import matrix from '../scenarios/matrix.json' with { type: 'json' };
import type { Config, Sandbox, Buyer } from './config.ts';

export type Attestation = { merchantId: string; sandboxId: string; providerId: string; mode: 'test'; checkedAt: string; cards: boolean; affirm: boolean; achSettlement: boolean; achDebitEmails: boolean; automaticTax: boolean; worker: boolean; publicGiftChallenge: boolean };
export type ExistingResource = { type: string; id: string; sandbox: Sandbox; owner: string; reviewAt: string; ownedByRun: boolean; cleanup: string };
export type Fixtures = {
  schema_version: 1; run: string;
  readiness: Record<Sandbox, Attestation>;
  buyers: Record<Buyer, { email: string; password: string; customerId?: string; verified: boolean }>;
  resources: ExistingResource[];
  settingsAuthority: Partial<Record<Sandbox, { runOwned: boolean; owner: string; reviewAt: string }>>;
  products: Record<string, { productId: string; variantId: string; unitPrice: { amount: string; currency: string } }>;
  plans: Record<string, string>;
  values: Record<string, any>;
  // These receipts describe independent local checks. They do not establish e2e PASS.
  localChecks?: { targetCommit: string; passed: string[] };
  operatorPlan?: PlanStep[];
  confirmedBlockers?: { id: string; code: string; authority: string }[];
  acceptedExceptions?: { id: string; acceptedByUser: true; reference: string }[];
};
export type CreatePath = { path: string; type: string; cleanup: string; reviewAt: string };
export type PlanStep = { name: string; sandbox: Sandbox; operation: string; args: any[]; creates: CreatePath[]; purpose: string };
export async function loadFixtures(config: Config): Promise<Fixtures> {
  const f = await readPrivate<Fixtures>(config.fixtureFile);
  assertFixtureSecretsAbsent(f);
  validateFixtureShape(f);
  invariant(f.schema_version === 1 && f.run === config.run && Array.isArray(f.resources), 'FIXTURE_MANIFEST_INVALID');
  for (const s of ['A', 'B'] as const) {
    const r = f.readiness?.[s], pin = config.pins[s];
    invariant(r && r.mode === 'test' && r.merchantId === pin.merchantId && r.sandboxId === pin.sandboxId && r.providerId === pin.providerId, 'PROVIDER_TUPLE_MISMATCH');
    invariant(Date.now() - Date.parse(r.checkedAt) >= 0 && Date.now() - Date.parse(r.checkedAt) < 24 * 3600_000, 'PROVIDER_READINESS_STALE');
  }
  for (const r of f.resources) invariant(['A', 'B'].includes(r.sandbox) && r.owner && r.cleanup && Number.isFinite(Date.parse(r.reviewAt)), 'EXISTING_RESOURCE_DISPOSITION_REQUIRED');
  return f;
}
export function atPath(value: any, path: string): any {
  invariant(/^[a-zA-Z0-9_.]+$/.test(path), 'RESPONSE_PATH_INVALID');
  return path.split('.').reduce((v, key) => v?.[key], value);
}

export function validateFixtureShape(f: Fixtures): void {
  assertFixtureSecretsAbsent(f); assertSessionExceptions(f.acceptedExceptions);
  invariant(f && f.schema_version === 1 && typeof f.run === 'string' && Array.isArray(f.resources), 'FIXTURE_MANIFEST_INVALID');
  for (const role of ['b1', 'b2', 'd', 'b1b'] as const) {
    const buyer = f.buyers?.[role];
    invariant(buyer && typeof buyer.email === 'string' && /^[^\s@]+@[^\s@]+$/.test(buyer.email) && typeof buyer.password === 'string' && buyer.password.length > 0 && typeof buyer.verified === 'boolean', 'BUYER_CONFIGURATION_INVALID');
    if (buyer.customerId !== undefined) invariant(/^[A-Za-z0-9_-]+$/.test(buyer.customerId), 'BUYER_RESOURCE_INVALID');
  }
  invariant(f.values && typeof f.values === 'object' && !Array.isArray(f.values) && f.products && f.plans && f.settingsAuthority, 'FIXTURE_MANIFEST_INVALID');
  for (const s of ['A', 'B'] as const) {
    const r = f.readiness?.[s];
    invariant(r && ['cards', 'affirm', 'achSettlement', 'achDebitEmails', 'automaticTax', 'worker', 'publicGiftChallenge'].every(k => typeof r[k as keyof Attestation] === 'boolean'), 'READINESS_BOOLEAN_REQUIRED');
  }
  const ids = new Set<string>();
  for (const r of f.resources) {
    invariant(typeof r.id === 'string' && /^[A-Za-z0-9_-]+$/.test(r.id) && typeof r.type === 'string' && /^[a-z_]+$/.test(r.type) && typeof r.ownedByRun === 'boolean', 'FIXTURE_RESOURCE_INVALID');
    const id = `${r.sandbox}:${r.type}:${r.id}`; invariant(!ids.has(id), 'DUPLICATE_FIXTURE_RESOURCE'); ids.add(id);
  }
  for (const product of Object.values(f.products)) { invariant(product && /^[A-Za-z0-9_-]+$/.test(product.productId) && /^[A-Za-z0-9_-]+$/.test(product.variantId), 'PRODUCT_FIXTURE_INVALID'); money(product.unitPrice); }
  const rowIds = new Set([...matrix.map(r => r.id), 'SF-05Z2', 'SF-05Z1', 'SF-05Z3', 'AC-15API', 'SF-GIFTCHALLENGE','AC-GIFTCHALLENGE','SF-ACH-MICRODEP']);
  const exceptions = new Set<string>();
  for (const e of f.acceptedExceptions ?? []) { invariant(rowIds.has(e.id) && !exceptions.has(e.id) && e.acceptedByUser === true && /^[A-Z0-9_-]{3,100}$/.test(e.reference), 'USER_EXCEPTION_REQUIRED'); exceptions.add(e.id); }
  for (const b of f.confirmedBlockers ?? []) invariant(/^PRQ-[A-Z0-9_-]+$/.test(b.id) && /^[A-Z0-9_-]{3,100}$/.test(b.code) && /^[A-Z0-9_-]{3,100}$/.test(b.authority), 'CONFIRMED_BLOCKER_AUTHORITY_REQUIRED');
}

export function assertFixtureSecretsAbsent(value: unknown): void {
  if (typeof value === 'string') invariant(!/flint_(?:cses|cref|test|live)_/.test(value), 'FIXTURE_SECRET_FORBIDDEN');
  else if (Array.isArray(value)) value.forEach(assertFixtureSecretsAbsent);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    invariant(!['secret', 'refresh_token', 'customer_session_secret'].includes(key), 'FIXTURE_SECRET_FORBIDDEN'); assertFixtureSecretsAbsent(item);
  }
}
export function assertSessionExceptions(exceptions: Fixtures['acceptedExceptions']): void {
  invariant(!(exceptions ?? []).some(e => e.id === 'AC-15' || e.id === 'AC-16'||e.id==='SF-GIFTCHALLENGE'||e.id==='AC-GIFTCHALLENGE'), 'EXCEPTION_NOT_PERMITTED_FOR_ROW');
}
