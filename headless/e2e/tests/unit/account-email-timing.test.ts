import test from 'node:test';
import assert from 'node:assert/strict';
import { account } from '../../scenarios/account.ts';
import type { Driver } from '../../support/driver.ts';

test('AC-02 correlates verification email with the resend after the wrong code', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2000-01-01T00:00:00Z') });
  const sends: number[] = [], deliveries: { receivedAt: number; code: string }[] = [], confirmations: string[] = [];
  class Locator {
    async _expect(expression: string, options: { expectedText: { string: string }[]; isNot: boolean }) {
      assert.equal(expression, 'to.have.text'); assert.equal(options.isNot, false);
      assert.deepEqual(confirmations, ['000000']);
      const received = "That code isn't right";
      return { matches: received.includes(options.expectedText[0].string), received, log: [] };
    }
  }
  const page = {
    getByRole: (role: string) => { assert.equal(role, 'alert'); return new Locator(); },
    waitForTimeout: async (milliseconds: number) => { assert.equal(milliseconds, 31_000); t.mock.timers.tick(milliseconds); },
  };
  const driver = {
    fixtures: {
      buyers: { b1: { verified: true, customerId: 'cus_BUYER_ONE_PLACEHOLDER' }, b2: { customerId: 'cus_BUYER_TWO_PLACEHOLDER' } },
      values: { guestLinkProofs: { otherCustomerVerificationId: 'cv_OTHER_PLACEHOLDER', usedVerificationId: 'cv_USED_PLACEHOLDER' } },
    },
    config: { run: '20000101T000000Z-00000000', origins: { accountA: 'https://account.example.invalid' } },
    page: async () => page,
    login: async () => {},
    goto: async (_page: unknown, _origin: string, path: string) => { assert.equal(path, '/link-purchases'); },
    form: async (_page: unknown, path: string, values?: { code: string }) => {
      if (path === '/link-purchases/send') {
        sends.push(Date.now()); t.mock.timers.tick(200);
        deliveries.push({ receivedAt: Date.now(), code: sends.length === 1 ? '111111' : '222222' });
      } else {
        assert.equal(path, '/link-purchases/confirm'); confirmations.push(values!.code);
      }
    },
    email: async (buyer: string, after: Date, family: string) => {
      assert.equal(buyer, 'b1'); assert.equal(family, 'verification'); assert.equal(sends.length, 2);
      assert.equal(after.getTime(), sends[1]); assert.ok(after.getTime() > deliveries[0].receivedAt);
      const matches = deliveries.filter(mail => mail.receivedAt >= after.getTime());
      assert.equal(matches.length, 1); return { codes: [matches[0].code] };
    },
    operator: { clients: { writable: async () => ({ customers: { linkGuestPurchases: async (_customer: string, proof: { customer_verification_id: string }) => {
      throw { code: proof.customer_verification_id === 'cv_OTHER_PLACEHOLDER' ? 'CUSTOMER_VERIFICATION_CUSTOMER_MISMATCH' : 'CUSTOMER_VERIFICATION_USED' };
    } } }) } },
  } as unknown as Driver;
  assert.deepEqual(await account['AC-02'](driver), ['WRONG_CODE_RESEND_MISMATCH_AND_USED_PROOF']);
  assert.deepEqual(confirmations, ['000000', '222222']);
});
