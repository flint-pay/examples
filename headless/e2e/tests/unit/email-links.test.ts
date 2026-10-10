import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, auditEmail, CHECKOUT_ORIGIN } from '../../support/email-links.ts';
import { parseLinks } from '../../support/inbox.ts';
import { API_ORIGIN } from '../../support/config.ts';
import { navigationDecision, validateRelayResponse } from '../../support/flint-boundary.ts';
import type { PreferenceRelayBinding } from '../../support/flint-boundary.ts';
import type { LinkRole, LinkConfig } from '../../support/email-links.ts';
import { Driver } from '../../support/driver.ts';
import type { Surface } from '../../support/credential-scan.ts';

const account = 'https://account.example.invalid';
const config: LinkConfig = { appOrigins: [account, 'http://localhost:4100'], apiOrigin: API_ORIGIN, checkoutOrigin: CHECKOUT_ORIGIN, merchantSupportUrl: 'https://support.example.invalid/help' };
const gift = `${CHECKOUT_ORIGIN}/gift-cards/gcg_${'0'.repeat(26)}?mode=test#token=PLACEHOLDER`;
const mail = (...hrefs: string[]) => ({ links: hrefs.map(href => ({ text: '', href })) });
const relay = `${API_ORIGIN}/account/PLACEHOLDER.PLACEHOLDER.PLACEHOLDER`;
const preference = `${API_ORIGIN}/email-preferences/PLACEHOLDER.PLACEHOLDER.PLACEHOLDER`;
const invoiceToken = `ivt_${'0'.repeat(64)}`;
const invoiceRelay = `${relay}#invoice_token=${invoiceToken}`;
const preferenceBinding: PreferenceRelayBinding = { merchantId: 'mer_PLACEHOLDER', sandboxId: 'menv_PLACEHOLDER' };
function preferenceDestination(binding = preferenceBinding): string {
  const query = new URLSearchParams({ flint_action: 'manage', flint_resource_type: 'email_preferences', flint_mode: 'sandbox', flint_merchant_id: binding.merchantId, flint_environment_id: binding.sandboxId });
  return `${account}/email-preferences?${query}#flint_email_preference_token=PLACEHOLDER`;
}

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
// Public fake JWT-shaped fixture, never a signed credential.
const fixtureToken = 'PUBLIC_FAKE_HEADER.PUBLIC_FAKE_PAYLOAD.PUBLIC_FAKE_SIGNATURE';
const fixtureRelay = `${API_ORIGIN}/account/${fixtureToken}`;
const fixturePreference = `${API_ORIGIN}/email-preferences/${fixtureToken}`;
test('HTML preference relay followed by a plaintext sentence period is audited once', () => {
  const html = `<a href="${fixtureRelay}">Order</a><a href="https://withflintpay.com/">Flint</a><a href="${fixturePreference}">Preferences</a>`;
  const links = parseLinks(html, `Manage preferences at ${fixturePreference}.`);
  assert.deepEqual(links.map(l => l.href), [fixtureRelay, 'https://withflintpay.com/', fixturePreference]);
  assert.deepEqual(classify({ links }, 'fulfillment_updates', config).map(r => r.verdict), ['pass', 'record', 'pass']);
  assert.deepEqual(auditEmail({ links }, 'fulfillment_updates', config).map(r => r.role), ['flint_account_link_relay', 'flint_brand_credit', 'flint_email_preferences_relay']);
});
test('a distinct plaintext relay with a period remains intact and fails audit', () => {
  const distinct = `${fixturePreference}OTHER.`;
  const links = parseLinks(`<a href="${fixturePreference}">Preferences</a>`, `Preferences at ${distinct}`);
  assert.deepEqual(links.map(l => l.href), [fixturePreference, distinct]);
  assert.equal(classify({ links }, 'fulfillment_updates', config)[1].code, 'EMAIL_FLINT_COMMERCE_LINK');
  assert.throws(() => auditEmail({ links }, 'fulfillment_updates', config), { message: 'EMAIL_FLINT_COMMERCE_LINK' });
});
test('a malformed HTML href ending with a period remains intact and fails audit', () => {
  const malformed = `${fixturePreference}.`;
  const links = parseLinks(`<a href="${fixturePreference}">Preferences</a><a href="${malformed}">Malformed</a>`, `Preferences at ${malformed}`);
  assert.deepEqual(links.map(l => l.href), [fixturePreference, malformed]);
  assert.equal(classify({ links }, 'fulfillment_updates', config)[1].code, 'EMAIL_FLINT_COMMERCE_LINK');
  assert.throws(() => auditEmail({ links }, 'fulfillment_updates', config), { message: 'EMAIL_FLINT_COMMERCE_LINK' });
});
test('plaintext punctuation is preserved without an exact HTML href match', () => {
  for (const html of ['', `<a href="${fixtureRelay}">Order</a>`]) {
    const links = parseLinks(html, `${fixturePreference} ${fixturePreference}. https://unknown.example.invalid/help.`);
    assert.deepEqual(links.slice(html ? 1 : 0).map(l => l.href), [fixturePreference, `${fixturePreference}.`, 'https://unknown.example.invalid/help.']);
    const result = classify({ links }, 'fulfillment_updates', config);
    assert.equal(result.at(-2)?.code, 'EMAIL_FLINT_COMMERCE_LINK');
    assert.equal(result.at(-1)?.code, 'EMAIL_UNDOCUMENTED_EXTERNAL_LINK');
    assert.throws(() => auditEmail({ links }, 'fulfillment_updates', config), { message: 'EMAIL_FLINT_COMMERCE_LINK' });
  }
});
test('LA-8 unknown Flint commerce links and nonloopback HTTP links fail', () => {
  for (const href of [`${CHECKOUT_ORIGIN}/checkout/PLACEHOLDER`, 'https://account.withflintpay.com/', `${API_ORIGIN}/payment-returns/PLACEHOLDER`, `${API_ORIGIN}/v1/orders`, 'https://withflintpay.com/pricing', 'https://withflintpay.com/?code=PLACEHOLDER', 'http://account.example.invalid/orders/ord_PLACEHOLDER']) assert.throws(() => auditEmail(mail(href), 'order_receipts', config));
});
test('LA-9 relay-shaped links cannot be admitted by the gift family', () => {
  for (const href of [relay, preference]) assert.throws(() => auditEmail(mail(gift, href), 'gift_card_notification', config));
});
test('invoice capability fragments require the exact trusted invoice relay and family', () => {
  assert.equal(auditEmail(mail(invoiceRelay), 'invoices', config)[0].role, 'flint_account_link_relay');
  for (const family of ['order_receipts', 'subscription_lifecycle', 'verification']) assert.throws(() => auditEmail(mail(invoiceRelay), family, config));
  for (const href of [
    `${relay}#invoice_token=`, `${invoiceRelay}&extra=PLACEHOLDER`, `${invoiceRelay}&invoice_token=${invoiceToken}`,
    `${relay}#token=${invoiceToken}`, `${relay}#invoice_token=%69vt_${'0'.repeat(64)}`,
    `${relay}#invoice_token=ivt_${'0'.repeat(63)}`, `${relay}?action=pause#invoice_token=${invoiceToken}`,
    invoiceRelay.replace(API_ORIGIN, CHECKOUT_ORIGIN), invoiceRelay.replace('/account/', '/email-preferences/'),
  ]) assert.throws(() => auditEmail(mail(href), 'invoices', config));
});
async function auditedInvoiceDriver(): Promise<Driver> {
  const pin = { key: 'flint_test_PLACEHOLDER' };
  const incoming = { ...mail(invoiceRelay), subject: '', from: '', receivedAt: '2000-01-01T00:00:00Z', text: '', html: '', codes: [] };
  const driver = new Driver({ pins: { A: pin, B: pin }, operatorPins: { A: pin, B: pin }, apiOrigin: API_ORIGIN, origins: { accountA: account } } as any,
    { buyers: { b1: { email: 'buyer@example.invalid' } }, values: {} } as any, {} as any, {} as any,
    { waitForEmail: async () => incoming, close: async () => {} });
  driver.supportUrls.set('A', undefined);
  await driver.email('b1', new Date('2000-01-01T00:00:00Z'), 'invoices');
  return driver;
}
test('invoice mail registers the fragment-free HTTP request and rejects capability leaks on every scanned surface', async () => {
  const driver = await auditedInvoiceDriver();
  assert.deepEqual([...driver.auditedRelays], [[relay, 'flint_account_link_relay']]);
  assert.equal(navigationDecision(relay, 'GET', true, driver.auditedRelays), 'email-relay');
  assert.equal(navigationDecision(invoiceRelay, 'GET', true, driver.auditedRelays), 'reject');
  driver.scanner.scan(relay, 'url'); driver.scanner.assertClean();
  for (const surface of ['url', 'cookie', 'storage', 'dom', 'body', 'console', 'child', 'request'] satisfies Surface[]) {
    const isolated = await auditedInvoiceDriver();
    isolated.scanner.scan(surface === 'url' ? `${account}/invoices/inv_PLACEHOLDER#invoice_token=${invoiceToken}` : invoiceToken, surface);
    assert.throws(() => isolated.scanner.assertClean(), { message: 'CREDENTIAL_LEAK' });
  }
});
test('merchant account relay responses must explicitly clear the inherited capability fragment', () => {
  const destination = `${account}/invoices/inv_PLACEHOLDER`;
  assert.equal(validateRelayResponse(relay, 307, `${destination}#`, 'flint_account_link_relay', config.appOrigins, account), `${destination}#`);
  for (const location of [destination, `${destination}#invoice_token=${invoiceToken}`, `${destination}#other=PLACEHOLDER`]) {
    assert.throws(() => validateRelayResponse(relay, 307, location, 'flint_account_link_relay', config.appOrigins, account), { message: 'ACCOUNT_RELAY_CLEAR_FRAGMENT_REQUIRED' });
  }
});
test('NB-1 email relay navigation requires this run audit, top-level GET and a nonrendering merchant redirect', () => {
  const audited = new Map<string, LinkRole>([[relay, 'flint_account_link_relay'], [preference, 'flint_email_preferences_relay']]);
  assert.equal(navigationDecision(relay, 'GET', true), 'reject'); assert.equal(navigationDecision(relay, 'GET', true, audited), 'email-relay');
  for (const [href, verb, main] of [[relay, 'POST', true], [relay, 'GET', false], [gift, 'GET', true], ['https://withflintpay.com/', 'GET', true]] as const) assert.equal(navigationDecision(href, verb, main, audited), 'reject');
  assert.equal(validateRelayResponse(relay, 307, `${account}/orders/ord_PLACEHOLDER#`, 'flint_account_link_relay', config.appOrigins, account), `${account}/orders/ord_PLACEHOLDER#`);
  for (const [status, location] of [[400, account], [200, account], [307, 'https://account.withflintpay.com/'], [307, 'https://user:PLACEHOLDER@account.example.invalid/'], [307, 'http://localhost:4100/']] as const) assert.throws(() => validateRelayResponse(relay, status, location, 'flint_account_link_relay', config.appOrigins, account));
  const destination = preferenceDestination();
  assert.equal(validateRelayResponse(preference, 303, destination, 'flint_email_preferences_relay', config.appOrigins, account, preferenceBinding), destination);
});
test('preference relays require all five unique routing hints bound to the audited merchant and sandbox', () => {
  const destination = preferenceDestination();
  const validate = (location: string, binding?: PreferenceRelayBinding) => validateRelayResponse(preference, 303, location, 'flint_email_preferences_relay', config.appOrigins, account, binding);
  assert.throws(() => validate(destination), { message: 'PREFERENCE_RELAY_BINDING_REQUIRED' });
  for (const binding of [{ ...preferenceBinding, merchantId: '' }, { ...preferenceBinding, sandboxId: '' }]) assert.throws(() => validate(destination, binding), { message: 'PREFERENCE_RELAY_BINDING_REQUIRED' });
  for (const [key, value] of new URL(destination).searchParams) {
    for (const change of ['missing', 'wrong', 'duplicate']) {
      const url = new URL(destination);
      if (change === 'missing') url.searchParams.delete(key);
      if (change === 'wrong') url.searchParams.set(key, value === 'sandbox' ? 'live' : 'OTHER');
      if (change === 'duplicate') url.searchParams.append(key, value);
      assert.throws(() => validate(url.href, preferenceBinding), { message: 'PREFERENCE_RELAY_ROUTING_REQUIRED' });
    }
  }
  for (const key of ['token', 'flint_email_preference_token', 'access_token', 'flint_resource_id', 'flint_source', 'extra']) {
    const url = new URL(destination); url.searchParams.append(key, 'PLACEHOLDER');
    assert.throws(() => validate(url.href, preferenceBinding), { message: 'PREFERENCE_RELAY_ROUTING_REQUIRED' });
  }
  for (const binding of [{ ...preferenceBinding, merchantId: 'mer_OTHER' }, { ...preferenceBinding, sandboxId: 'menv_OTHER' }]) assert.throws(() => validate(destination, binding), { message: 'PREFERENCE_RELAY_ROUTING_REQUIRED' });
});
test('preference relays preserve redirect, origin, path and single nonempty fragment token boundaries', () => {
  const destination = preferenceDestination();
  const validate = (location: string | undefined, status = 303) => validateRelayResponse(preference, status, location, 'flint_email_preferences_relay', config.appOrigins, account, preferenceBinding);
  for (const status of [200, 204, 400, 500]) assert.throws(() => validate(destination, status), { message: 'RELAY_MUST_REDIRECT_WITHOUT_DOCUMENT' });
  assert.throws(() => validate(undefined), { message: 'RELAY_MUST_REDIRECT_WITHOUT_DOCUMENT' });
  for (const origin of ['https://account.withflintpay.com', 'https://other.example.invalid', 'https://user:PLACEHOLDER@account.example.invalid']) assert.throws(() => validate(destination.replace(account, origin)), { message: 'RELAY_DESTINATION_FORBIDDEN' });
  assert.throws(() => validate(destination.replace(account, 'http://localhost:4100')), { message: 'EMAIL_RELAY_ACCOUNT_ORIGIN_REQUIRED' });
  for (const fragment of ['', '#token=PLACEHOLDER', '#flint_email_preference_token=', '#flint_email_preference_token=PLACEHOLDER&flint_email_preference_token=PLACEHOLDER', '#flint_email_preference_token=PLACEHOLDER&extra=PLACEHOLDER']) {
    const url = new URL(destination); url.hash = fragment;
    assert.throws(() => validate(url.href), { message: 'PREFERENCE_FRAGMENT_DESTINATION_REQUIRED' });
  }
  for (const path of ['/orders/ord_PLACEHOLDER', '/email-preferences/']) {
    const url = new URL(destination); url.pathname = path;
    assert.throws(() => validate(url.href), { message: 'PREFERENCE_FRAGMENT_DESTINATION_REQUIRED' });
  }
});
test('preference email auditing passes the selected run pin through the browser guard into relay validation', async () => {
  for (const buyer of ['b1', 'b1b'] as const) {
    const pins = {
      A: { key: 'flint_test_A_PLACEHOLDER', merchantId: 'mer_A_PLACEHOLDER', sandboxId: 'menv_A_PLACEHOLDER' },
      B: { key: 'flint_test_B_PLACEHOLDER', merchantId: 'mer_B_PLACEHOLDER', sandboxId: 'menv_B_PLACEHOLDER' },
    };
    const incoming = { ...mail(preference), subject: '', from: '', receivedAt: '2000-01-01T00:00:00Z', text: '', html: '', codes: [] };
    let handleRoute: (route: any) => Promise<void> = async () => { throw new Error('ROUTE_NOT_ATTACHED'); };
    const frame = { page: () => page, url: () => 'about:blank' };
    const page = { on: () => {}, mainFrame: () => frame };
    const context = { serviceWorkers: () => [], on: () => {}, route: async (_pattern: string, handler: typeof handleRoute) => { handleRoute = handler; }, pages: () => [page] };
    const driver = new Driver({ pins, operatorPins: pins, apiOrigin: API_ORIGIN, origins: { accountA: account } } as any,
      { buyers: { [buyer]: { email: 'buyer@example.invalid' } }, values: {} } as any, { newContext: async () => context } as any, {} as any,
      { waitForEmail: async () => incoming, close: async () => {} });
    const sandbox = buyer === 'b1b' ? 'B' : 'A';
    driver.supportUrls.set(sandbox, undefined);
    await driver.page('unsubscribe', sandbox);
    await driver.email(buyer, new Date('2000-01-01T00:00:00Z'), 'fulfillment_updates');
    const { merchantId, sandboxId } = pins[sandbox];
    const binding = { merchantId, sandboxId };
    assert.deepEqual([...driver.preferenceBindings], [[preference, binding]]);
    const destination = preferenceDestination(binding);
    let fulfilled = false, aborted = false;
    let responseDestination = preferenceDestination(pins[sandbox === 'A' ? 'B' : 'A']);
    const route = {
      request: () => ({ url: () => preference, method: () => 'GET', frame: () => frame, isNavigationRequest: () => true }),
      fetch: async () => ({ status: () => 303, headers: () => ({ location: responseDestination }) }),
      fulfill: async () => { fulfilled = true; },
      abort: async (reason: string) => { assert.equal(reason, 'blockedbyclient'); aborted = true; },
    };
    const guard = driver.guards.get(context as any)!;
    try {
      await handleRoute(route);
      assert.equal(fulfilled, false); assert.equal(aborted, true);
      assert.deepEqual([...guard.violations], ['RELAY_VALIDATION_FAILED']);
      guard.violations.clear(); aborted = false; responseDestination = destination;
      await handleRoute(route);
      assert.equal(fulfilled, true); assert.equal(aborted, false); assert.deepEqual([...guard.violations], []);
    }
    finally { guard.close(); }
  }
});
