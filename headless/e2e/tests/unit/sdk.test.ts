import test from 'node:test';
import assert from 'node:assert/strict';
import { VerifiedClients } from '../../support/sdk.ts';

test('merchant readiness gates card and requested Affirm checks within the payments domain', async () => {
  for (const [domain, card, affirm, requested, expected] of [
    ['payments', 'ready', 'ready', true, undefined],
    ['payments', 'ready', 'blocked', false, undefined],
    ['payments', 'ready', 'pending', true, 'AFFIRM_READINESS_CONTRADICTION'],
    ['payments', 'blocked', 'ready', true, 'PAYMENT_READINESS_CONTRADICTION'],
    ['money_movement', 'ready', 'ready', true, 'PAYMENT_READINESS_CONTRADICTION'],
  ] as const) {
    const clients = {
      verifyContext: async () => {}, verified: new Set(),
      fixtures: { readiness: { A: { cards: true, affirm: requested } } },
      clients: { A: { merchants: { get: async () => ({ readiness: { capabilities: [
        { domain, capability: 'accept_card_payments', status: card },
        { domain, capability: 'accept_affirm_payments', status: affirm },
      ] } }) } } },
    } as unknown as VerifiedClients;
    const verify = () => VerifiedClients.prototype.verify.call(clients, 'A');
    if (expected) { await assert.rejects(verify(), { code: expected }); assert.equal(clients.verified.has('A'), false); }
    else { await verify(); assert.equal(clients.verified.has('A'), true); }
  }
});
