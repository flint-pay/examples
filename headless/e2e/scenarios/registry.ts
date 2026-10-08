import matrix from './matrix.json' with { type: 'json' };
import { storefront } from './storefront.ts';
import { account } from './account.ts';
import { crossApp } from './cross-app.ts';
import type { Scenario } from './storefront.ts';
import { settlement } from './settlement.ts';
import { invariant } from '../support/safe.ts';

export const handlers: Record<string, Scenario> = { ...storefront, ...account, ...crossApp, ...settlement };
export const rows = [...matrix, ...[
  { id: 'SF-05Z2', plan: 'resolved zero-balance contract', apps: 'storefront', buyer: 'guest', sandbox: 'A', tier: 'e2e', schedule: 'nightly', prq: [], assert: 'Public action pay with exact zero outstanding and no processor source settles once.' },
  { id: 'SF-05Z1', plan: 'resolved fully gift-funded contract', apps: 'storefront', buyer: 'guest', sandbox: 'A', tier: 'e2e', schedule: 'nightly', prq: [], assert: 'Latest gift estimate revision and exact allocation settle without processor source.' },
  { id: 'SF-05Z3', plan: 'resolved changed gift allocation contract', apps: 'storefront', buyer: 'guest', sandbox: 'A', tier: 'e2e', schedule: 'nightly', prq: [], assert: 'A real competing redemption invalidates displayed gift allocation; no stale pay call, reapproval settles once.' },
  { id: 'AC-15API', plan: 'public own-session family supplemental coverage', apps: 'harness', buyer: 'disposable', sandbox: 'A', tier: 'e2e', schedule: 'extended', prq: [], assert: 'Harness-created session refresh rotates authority; superseded-token replay revokes only that public session family. Does not satisfy application vault replay.' },
  { id: 'SF-GIFTCHALLENGE', plan: 'public challenge root fix', apps: 'storefront', buyer: 'guest', sandbox: 'A', tier: 'e2e', schedule: 'nightly', prq: ['PRQ-GIFT-CHALLENGE'], assert: 'Real public challenge completes without merchant-auth bypass.' },
  { id: 'SF-ACH-MICRODEP', plan: 'settled instant-only support boundary', apps: 'storefront', buyer: 'guest', sandbox: 'A', tier: 'e2e', schedule: 'nightly', prq: ['PRQ-ACH'], assert: 'Unsupported microdeposit path shows truthful recovery and cannot settle.' },
]];
export const executionOrder = ['U-01', 'SF-01', 'SF-03', 'SF-04', 'SF-05', 'SF-06', 'SF-07', 'SF-08', 'SF-09', 'SF-10', 'SF-11', 'SF-13', 'SF-14', 'SF-02', 'AC-01', 'AC-02', 'AC-09', 'SF-12', 'SF-15', 'SF-16', 'SF-17', 'SF-18', 'SF-19', 'SF-20', 'SF-21', 'SF-22', 'SF-22M', 'SF-23', 'SF-24', 'SF-25', 'SF-26', 'SF-26X', 'AC-03', 'AC-05', 'AC-05A', 'AC-06', 'AC-07', 'AC-08', 'AC-10', 'AC-11', 'AC-12', 'AC-13', 'AC-15API', 'AC-14', 'AC-15', 'AC-16', 'AC-17', 'X-01', 'I-01', 'I-02', 'I-03', 'AC-04', 'SF-05Z2', 'SF-05Z1', 'SF-05Z3', 'SF-GIFTCHALLENGE', 'SF-ACH-MICRODEP', 'B-01'];
export const dependencies: Record<string, string[]> = {
  'AC-01': ['SF-02', 'SF-14'], 'AC-02': ['AC-01'], 'AC-03': ['SF-02', 'AC-01'], 'AC-04': ['AC-03', 'SF-20', 'AC-05', 'AC-06'],
  'AC-05': ['AC-01'], 'AC-05A': ['AC-05'], 'AC-06': ['AC-03'], 'AC-07': ['SF-19', 'AC-09'], 'AC-08': ['AC-07'], 'AC-09': ['AC-01'],
  'AC-10': ['AC-01'], 'AC-11': ['AC-01'], 'AC-12': ['AC-01'], 'AC-13': ['AC-03'], 'AC-14': ['AC-01'], 'AC-15': ['AC-01'], 'AC-16': ['AC-01'], 'AC-17': ['AC-01'],
  'SF-12': ['AC-09'], 'SF-18': ['SF-15'], 'SF-19': ['AC-01'], 'I-01': ['AC-05', 'SF-24'], 'I-02': ['AC-03', 'AC-13'], 'I-03': ['AC-01', 'SF-24'], 'X-01': ['AC-01'],
  'B-01': ['SF-01', 'SF-07', 'SF-08', 'SF-09', 'SF-11', 'SF-14', 'SF-22', 'AC-03', 'AC-05', 'AC-06', 'AC-07', 'AC-09', 'AC-10', 'AC-13'],
};
export const fixturePrerequisites: Record<string, string[]> = {
  'AC-15API': ['sessionDisposableCustomerId'], 'AC-02': ['guestLinkProofs'], 'AC-03': ['plans.shipOrder', 'trackingNumber'],
  'AC-06': ['returnEligibleOrder', 'returnReasonId', 'plans.decideReturnAsExchange', 'withdrawReturnId'],
  'AC-07': ['alternateOffSessionMethod', 'secondSubscription'], 'AC-08': ['pastDueSubscription', 'plans.makePastDue'],
  'AC-10': ['b2NewEmail'], 'AC-14': ['plans.prepareDeletion'], 'AC-16': ['independentRevocationSession'], 'I-03': ['sameEmailCustomerB', 'sameEmailVerificationB'],
  'SF-21': ['checkoutMinimumTtlSeconds'], 'SF-24': ['sandboxSmsPhone'], 'SF-26': ['signedWebhookEnvelope', 'webhookCheckoutRef'], 'SF-26X': ['realWebhookForwarding'],
  'SF-05Z2': ['zeroBalancePromotion'], 'SF-GIFTCHALLENGE': ['challengeCheckoutRef', 'providerSteps.gift-public-challenge'], 'SF-ACH-MICRODEP': ['providerSteps.ach-microdeposit-attempt'],
};
export function validateRegistry(): void {
  invariant(matrix.length === 52 && new Set(rows.map(r => r.id)).size === rows.length, 'SETTLED_MATRIX_REQUIRED');
  invariant(executionOrder.length === rows.length && new Set(executionOrder).size === rows.length, 'EXECUTION_ORDER_INCOMPLETE');
  invariant(rows.every(r => typeof handlers[r.id] === 'function' && executionOrder.includes(r.id)), 'SCENARIO_IMPLEMENTATION_MISSING');
  for (const [id, deps] of Object.entries(dependencies)) for (const dep of deps) invariant(executionOrder.indexOf(dep) < executionOrder.indexOf(id), 'SCENARIO_DEPENDENCY_ORDER');
}
