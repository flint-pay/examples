import { existsSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkoutRoot } from './private-files.ts';
import { vaultReadScope } from './app-vault.ts';
import { Results } from './results.ts';
import type { Config } from './config.ts';
import type { Fixtures } from './fixtures.ts';
import { atPath } from './fixtures.ts';
import { fixturePrerequisites, rows } from '../scenarios/registry.ts';

export type GiftSdkEvidence={pin:string;installed:string;resolved:string};
export function giftChallengeSdkReady(evidence:readonly GiftSdkEvidence[]):boolean{
  if(evidence.length!==3)return false;const version=evidence[0]?.pin;
  if(!version||!/^3\.0\.0-beta\.\d{14}$/.test(version)||version<'3.0.0-beta.20261008013000')return false;
  return evidence.every(item=>{if(item.pin!==version||item.installed!==version)return false;try{const url=new URL(item.resolved);return url.protocol==='https:'&&url.hostname==='registry.npmjs.org'&&!url.username&&!url.password&&url.pathname.endsWith('.tgz');}catch{return false;}});
}
export function giftChallengeReadiness(evidence:readonly GiftSdkEvidence[],attestation:Pick<Fixtures['readiness']['A'],'publicGiftChallenge'|'checkedAt'>):{ready:boolean;code:string}{const sdk=giftChallengeSdkReady(evidence);return {ready:sdk&&attestation.publicGiftChallenge===true&&Number.isFinite(Date.parse(attestation.checkedAt)),code:sdk?'STAGING_GIFT_CHALLENGE_RELEASE_REQUIRED':'PINNED_SDK_PUBLIC_GIFT_CHALLENGE_UNAVAILABLE'};}
export function localGiftSdkEvidence():GiftSdkEvidence[]{
  try{return ['storefront','account','e2e'].map(app=>{const root=join(checkoutRoot,'headless',app),read=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
    return {pin:read(join(root,'package.json')).dependencies['@flintpay/node'],installed:read(join(root,'node_modules/@flintpay/node/package.json')).version,resolved:read(join(root,'package-lock.json')).packages['node_modules/@flintpay/node'].resolved};
  });}catch{return [];}
}
export function inventoryReadiness(config: Config, fixtures: Fixtures, results: Results): void {
  const root = (id: string, ready: boolean, code: string, blocked = false) => {
    const confirmed = fixtures.confirmedBlockers?.find(b => b.id === id);
    results.root({ id, status: ready ? 'RESOLVED' : blocked || confirmed ? 'BLOCKED' : 'PENDING', code: ready ? 'VERIFIED' : confirmed?.code ?? code, ...(confirmed ? { authority: confirmed.authority } : {}) });
  };
  root('PRQ-INBOX', !!config.inbox && !!config.inboxAddress, 'REAL_INBOX_CONFIGURATION_REQUIRED');
  root('PRQ-ACH', Object.values(fixtures.readiness).every(r => r.achSettlement && r.achDebitEmails), 'SUPPORT_RECORDED_ACH_SETTLEMENT_AND_EMAILS_REQUIRED');
  root('PRQ-AFFIRM', Object.values(fixtures.readiness).every(r => r.affirm), 'AFFIRM_PROVIDER_ADMISSION_REQUIRED');
  root('PRQ-TAX', fixtures.readiness.A.automaticTax, 'SANDBOX_AUTOMATIC_TAX_CONNECTION_REQUIRED');
  root('PRQ-SANDBOX-B', true, 'TWO_SANDBOX_PINS_REQUIRED');
  root('PRQ-STAGING-RUNTIME', fixtures.readiness.A.worker, 'TARGET_WORKER_READINESS_REQUIRED');
  root('PRQ-FLINT-CLI', !!fixtures.values.realWebhookForwarding?.owned && !!fixtures.values.realWebhookForwarding?.ready, 'PARENT_OWNED_REAL_FORWARDER_REQUIRED');
  root('PRQ-WALLET-DEVICE', !!fixtures.values.walletOperatorEnabled || !!fixtures.values.walletObservations, 'SAFARI_APPLE_PAY_CHROME_GOOGLE_PAY_OPERATOR_REQUIRED');
  vaultReadScope(config.appVaultRead);
  root('PRQ-APP-VAULT-AUTHORITY', false, 'APP_VAULT_RUNTIME_OWNERSHIP_GATES_REQUIRED');
  root('PRQ-ACCOUNT-CREDENTIAL-BOUNDARY-TEST', existsSync(join(checkoutRoot, 'headless/account/tests/unit/credential-boundary.test.ts')), 'ACCOUNT_CREDENTIAL_BOUNDARY_TEST_REQUIRED');
  root('PRQ-GIFT-FUNDING', !!fixtures.values.giftFundingCustomerId || !!fixtures.values.giftFundingBuyerEmail, 'SANCTIONED_REAL_GIFT_FUNDING_CUSTOMER_REQUIRED');
  const giftChallenge=giftChallengeReadiness(localGiftSdkEvidence(),fixtures.readiness.A);
  root('PRQ-GIFT-CHALLENGE',giftChallenge.ready,giftChallenge.code);
  for (const [id, fields] of Object.entries(fixturePrerequisites)) root(`PRQ-FIXTURE-${id}`, fields.every(p => atPath(fixtures.values, p) !== undefined), 'SANCTIONED_EXISTING_FIXTURE_OR_PUBLIC_OPERATOR_PLAN_REQUIRED');
  for (const id of ['SF-13', 'SF-14', 'AC-17']) root(`PRQ-PROVIDER-${id}`, ['ach-instant-success', 'ach-instant-processing', 'ach-instant-failure'].every(k => !!fixtures.values.providerSteps?.[k]), 'REAL_INSTANT_BANK_PROVIDER_STEPS_REQUIRED');
  for (const id of ['SF-15', 'SF-16', 'SF-17', 'AC-05A']) root(`PRQ-PROVIDER-${id}`, ['affirm-select', 'affirm-approve', 'affirm-decline', 'affirm-cancel'].every(k => !!fixtures.values.providerSteps?.[k]), 'REAL_AFFIRM_PROVIDER_STEPS_REQUIRED');
}
export function prerequisites(id: string): string[] {
  const row = rows.find(r => r.id === id)!;
  return [...row.prq, ...(['SF-05', 'SF-05Z1', 'SF-05Z3', 'AC-12'].includes(id) ? ['PRQ-GIFT-FUNDING'] : []), ...(fixturePrerequisites[id] ? [`PRQ-FIXTURE-${id}`] : []), ...(['SF-13', 'SF-14', 'AC-17', 'SF-15', 'SF-16', 'SF-17', 'AC-05A'].includes(id) ? [`PRQ-PROVIDER-${id}`] : []), ...(['AC-15', 'AC-16','SF-GIFTCHALLENGE','AC-GIFTCHALLENGE'].includes(id) ? ['PRQ-APP-VAULT-AUTHORITY'] : []), ...(id === 'AC-16' ? ['PRQ-ACCOUNT-CREDENTIAL-BOUNDARY-TEST'] : [])];
}
export function unresolvedSuitePrerequisites(config: Pick<Config, 'suite'>, fixtures: Pick<Fixtures, 'acceptedExceptions'>, results: Pick<Results, 'roots'>): string[] {
  const exceptions = new Set((fixtures.acceptedExceptions ?? []).map(entry => entry.id));
  const required = new Set(rows.filter(row => !exceptions.has(row.id) && (row.schedule !== 'extended' || config.suite === 'extended')).flatMap(row => prerequisites(row.id)));
  return [...required].filter(id => results.roots.get(id)?.status !== 'RESOLVED').sort();
}
