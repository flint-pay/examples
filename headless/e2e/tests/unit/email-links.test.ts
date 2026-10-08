import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, auditEmail, CHECKOUT_ORIGIN } from '../../support/email-links.ts';
import { API_ORIGIN } from '../../support/config.ts';
import { navigationDecision, validateRelayResponse } from '../../support/flint-boundary.ts';
import type { LinkRole, LinkConfig } from '../../support/email-links.ts';

const account = 'https://account.example.invalid';
const config: LinkConfig = { appOrigins: [account, 'http://localhost:4100'], apiOrigin: API_ORIGIN, checkoutOrigin: CHECKOUT_ORIGIN, merchantSupportUrl: 'https://support.example.invalid/help' };
const gift = `${CHECKOUT_ORIGIN}/gift-cards/gcg_${'0'.repeat(26)}?mode=test#token=PLACEHOLDER`;
const mail = (...hrefs: string[]) => ({ links: hrefs.map(href => ({ text: '', href })) });
const relay = `${API_ORIGIN}/account/PLACEHOLDER.PLACEHOLDER.PLACEHOLDER`;
const preference = `${API_ORIGIN}/email-preferences/PLACEHOLDER.PLACEHOLDER.PLACEHOLDER`;

test('LA-1 exact gift family recipient, brand, contacts and merchant support classify without URLs in evidence', () => {
  const result = auditEmail(mail(gift, 'https://withflintpay.com/', 'mailto:buyer@example.invalid', 'tel:+12025550123', config.merchantSupportUrl!), 'gift_card_notification', config);
  assert.deepEqual(result.map(r => r.verdict), ['excluded_hosted_surface', 'record', 'ignore', 'ignore', 'record']);
  assert.equal(JSON.stringify(result).includes('PLACEHOLDER'), false); assert.equal(JSON.stringify(result).includes('http'), false);
});
test('LA-2 recipient link count is exactly one and no duplicate email fixture can pass', () => {
  for (const hrefs of [[], [gift, gift]]) assert.throws(() => auditEmail(mail(...hrefs), 'gift_card_notification', config), { message: 'EMAIL_GIFT_RECIPIENT_LINK_COUNT' });
});
test('LA-3 recipient-shaped links are forbidden outside the gift notification family on every host', () => {
  for (const href of [gift, gift.replace(CHECKOUT_ORIGIN, account), gift.replace(CHECKOUT_ORIGIN, 'https://shop.example.invalid')]) assert.throws(() => auditEmail(mail(href), 'order_receipts', config), { message: 'EMAIL_GIFT_RECIPIENT_LINK_OUT_OF_FAMILY' });
});
test('LA-4 recipient classification cannot widen host, test mode, grant length, alphabet or fragment', () => {
  for (const href of [gift.replace(CHECKOUT_ORIGIN, 'https://checkout.withflintpay.com'), gift.replace('?mode=test', ''), gift.replace('#token=PLACEHOLDER', ''), gift.replace('#token=PLACEHOLDER', '#token='), gift.replace('gcg_', 'gift_'), gift.replace('0'.repeat(26), 'I'.repeat(26)), gift.replace('mode=test', 'mode=live'), gift.replace('mode=test', 'mode=test&extra=PLACEHOLDER')]) assert.ok(classify(mail(href), 'gift_card_notification', config).some(r => r.verdict === 'fail'));
});
test('LA-5 receipt relay, exact brand and carrier classify by role', () => {
  assert.deepEqual(auditEmail(mail(relay, 'https://withflintpay.com/', 'https://tools.usps.com/go/TrackConfirmAction'), 'order_receipts', config).map(r => r.role), ['flint_account_link_relay', 'flint_brand_credit', 'provider_or_carrier']);
});
test('LA-6 subscription actions use the exact allowlist without duplicate or extra parameters', () => {
  for (const action of ['skip', 'update-delivery', 'pause']) auditEmail(mail(`${relay}?action=${action}`), 'subscription_lifecycle', config);
  for (const query of ['action=other', 'action=pause&action=pause', 'action=pause&email=buyer%40example.invalid']) assert.throws(() => auditEmail(mail(`${relay}?${query}`), 'subscription_lifecycle', config));
});
test('LA-7 preference relay is limited to unsubscribe email families and carries no query or fragment', () => {
  auditEmail(mail(preference), 'fulfillment_updates', config);
  for (const [href, family] of [[preference, 'verification'], [`${preference}?token=PLACEHOLDER`, 'fulfillment_updates'], [`${preference}#token=PLACEHOLDER`, 'fulfillment_updates']]) assert.throws(() => auditEmail(mail(href), family, config));
});
test('LA-8 unknown Flint commerce links and nonloopback HTTP links fail', () => {
  for (const href of [`${CHECKOUT_ORIGIN}/checkout/PLACEHOLDER`, 'https://account.withflintpay.com/', `${API_ORIGIN}/payment-returns/PLACEHOLDER`, `${API_ORIGIN}/v1/orders`, 'https://withflintpay.com/pricing', 'https://withflintpay.com/?code=PLACEHOLDER', 'http://account.example.invalid/orders/ord_PLACEHOLDER']) assert.throws(() => auditEmail(mail(href), 'order_receipts', config));
});
test('LA-9 relay-shaped links cannot be admitted by the gift family', () => {
  for (const href of [relay, preference]) assert.throws(() => auditEmail(mail(gift, href), 'gift_card_notification', config));
});
test('NB-1 email relay navigation requires this run audit, top-level GET and a nonrendering merchant redirect', () => {
  const audited = new Map<string, LinkRole>([[relay, 'flint_account_link_relay'], [preference, 'flint_email_preferences_relay']]);
  assert.equal(navigationDecision(relay, 'GET', true), 'reject'); assert.equal(navigationDecision(relay, 'GET', true, audited), 'email-relay');
  for (const [href, verb, main] of [[relay, 'POST', true], [relay, 'GET', false], [gift, 'GET', true], ['https://withflintpay.com/', 'GET', true]] as const) assert.equal(navigationDecision(href, verb, main, audited), 'reject');
  assert.equal(validateRelayResponse(relay, 307, `${account}/orders/ord_PLACEHOLDER`, 'flint_account_link_relay', config.appOrigins, account), `${account}/orders/ord_PLACEHOLDER`);
  for (const [status, location] of [[400, account], [200, account], [307, 'https://account.withflintpay.com/'], [307, 'https://user:PLACEHOLDER@account.example.invalid/'], [307, 'http://localhost:4100/']] as const) assert.throws(() => validateRelayResponse(relay, status, location, 'flint_account_link_relay', config.appOrigins, account));
  validateRelayResponse(preference, 303, `${account}/email-preferences#token=PLACEHOLDER`, 'flint_email_preferences_relay', config.appOrigins, account);
  for (const location of [`${account}/email-preferences?token=PLACEHOLDER`, `${account}/orders/ord_PLACEHOLDER#token=PLACEHOLDER`, `${account}/email-preferences`]) assert.throws(() => validateRelayResponse(preference, 303, location, 'flint_email_preferences_relay', config.appOrigins, account));
});
