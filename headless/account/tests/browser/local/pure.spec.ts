// Pure logic and text checks. No browser page is opened.
import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMessage, fieldMessage, fill, noticeText, declineMessage, plural } from '../../../src/copy.ts';
import { addressLines, countOf, formatDate, formatDateTime, path as safePath, safeExternalUrl, safeJson } from '../../../src/views/format.ts';
import { isPageId, renderPage } from '../../../src/views/index.ts';
import { acceptsNewPayment, derivePhase, payBlocker, shouldDropAffirm, workFor } from '../../../public/js/payment-phase.js';
import { addMoney, formatMoney, isZero, minorToDecimal, sameMoney, stripeAmount } from '../../../public/js/money.js';
import { parseGiftCardLink } from '../../../public/js/gift-link.js';
import { allPageIds, attempt, context, pageContext, paymentState, usd } from '../support/fixtures.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'test-results' || name === 'playwright-report') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

test.describe('money', () => {
  test('formats exact minor units without rounding', () => {
    expect(formatMoney(usd(1800))).toBe('$18.00');
    expect(formatMoney(usd(5))).toBe('$0.05');
    expect(formatMoney({ amount: '-250', currency: 'USD' })).toBe('-$2.50');
    expect(formatMoney({ amount: '1500', currency: 'JPY' })).toBe('¥1,500');
    expect(formatMoney({ amount: '123456789012345678', currency: 'USD' })).toBe('$1,234,567,890,123,456.78');
    expect(formatMoney(undefined)).toBe('');
  });
  test('splits minor units by fraction digits', () => {
    expect(minorToDecimal('100', 2)).toBe('1.00');
    expect(minorToDecimal('7', 2)).toBe('0.07');
    expect(minorToDecimal('12', 0)).toBe('12');
    expect(minorToDecimal('abc', 2)).toBeNull();
  });
  test('stripeAmount only accepts safe integers', () => {
    expect(stripeAmount(usd(12000))).toBe(12000);
    expect(stripeAmount({ amount: '99999999999999999999', currency: 'USD' })).toBeNull();
    expect(stripeAmount({ amount: '-1', currency: 'USD' })).toBeNull();
  });
  test('adds and compares with BigInt', () => {
    expect(addMoney(usd('9007199254740993'), usd(1))).toEqual({ amount: '9007199254740994', currency: 'USD' });
    expect(addMoney(usd(1), { amount: '1', currency: 'EUR' })).toBeNull();
    expect(sameMoney(usd(5), usd('5'))).toBe(true);
    expect(isZero(usd(0))).toBe(true);
    expect(isZero(usd(1))).toBe(false);
  });
});

test.describe('payment phase', () => {
  const base = paymentState();
  test('derives every phase the page can start in', () => {
    expect(derivePhase(base)).toBe('ready');
    expect(derivePhase(paymentState({ payment_collection: null }))).toBe('unavailable');
    expect(derivePhase(paymentState({ expired: true }))).toBe('expired');
    expect(derivePhase(paymentState({ next: 'done', attempt: attempt('succeeded') }))).toBe('succeeded');
    expect(derivePhase(paymentState({ next: 'bank_processing', attempt: attempt('processing') }))).toBe('bank_processing');
    expect(derivePhase(paymentState({ next: 'wait', attempt: attempt('processing') }))).toBe('waiting');
    expect(derivePhase(paymentState({ next: 'resume', attempt: attempt('requires_retry') }))).toBe('resuming');
    expect(derivePhase(paymentState({ next: 'authenticate', attempt: attempt('requires_action') }))).toBe('authenticating');
    expect(derivePhase(paymentState({ next: 'pay_remaining', attempt: attempt('partially_succeeded') }))).toBe('pay_remaining');
    expect(derivePhase(paymentState({ total_changed: true }))).toBe('total_changed');
    expect(derivePhase(paymentState({ recovery_mode: true, next: 'resume', attempt: attempt('requires_retry') }))).toBe('recovery');
    expect(derivePhase(paymentState({ next: 'capture', attempt: attempt('requires_capture') }))).toBe('unavailable');
  });
  test('a failed attempt is a decline, a canceled one is not', () => {
    expect(derivePhase(paymentState({ attempt: attempt('failed'), decline: { code: 'incorrect_cvc' } }))).toBe('declined');
    expect(derivePhase(paymentState({ attempt: attempt('canceled'), decline: { code: 'payment_attempt_canceled' } }))).toBe('ready');
  });
  test('an open action after a provider return is an unfinished Affirm application', () => {
    const leg = { payment_intent_id: 'pi_1', status: 'open' as const, amount_money: usd(100), payment_option: 'affirm' };
    expect(derivePhase(paymentState({ next: 'authenticate', returned: true, attempt: attempt('requires_action', { legs: [leg] }) }))).toBe('affirm_incomplete');
    const card = { ...leg, payment_option: 'card' };
    expect(derivePhase(paymentState({ next: 'authenticate', returned: true, attempt: attempt('requires_action', { legs: [card] }) }))).toBe('authenticating');
    expect(derivePhase(paymentState({ next: 'authenticate', returned: false, attempt: attempt('requires_action', { legs: [leg] }) }))).toBe('authenticating');
  });
  test('work to do without the buyer', () => {
    expect(workFor(paymentState({ next: 'authenticate' }))).toBe('authenticate');
    expect(workFor(paymentState({ next: 'resume' }))).toBe('resume');
    expect(workFor(paymentState({ next: 'wait' }))).toBe('wait');
    expect(workFor(paymentState({ next: 'new_payment' }))).toBe('none');
  });
  test('only some phases accept a new payment', () => {
    for (const phase of ['ready', 'declined', 'pay_remaining', 'total_changed'] as const) expect(acceptsNewPayment(phase)).toBe(true);
    for (const phase of ['waiting', 'resuming', 'authenticating', 'bank_processing', 'succeeded', 'recovery', 'expired', 'unavailable', 'affirm_incomplete'] as const) {
      expect(acceptsNewPayment(phase)).toBe(false);
    }
  });
  test('pay blockers name the reason', () => {
    const open = { elementsComplete: true, usingSaved: false, hasSaved: false, busy: false };
    expect(payBlocker({ phase: 'ready', ...open })).toBeNull();
    expect(payBlocker({ phase: 'ready', ...open, elementsComplete: false })).toBe('elements_incomplete');
    expect(payBlocker({ phase: 'ready', ...open, busy: true })).toBe('attempt_open');
    expect(payBlocker({ phase: 'waiting', ...open })).toBe('attempt_open');
    expect(payBlocker({ phase: 'expired', ...open })).toBe('session_not_open');
    expect(payBlocker({ phase: 'ready', elementsComplete: false, usingSaved: true, hasSaved: true, busy: false })).toBeNull();
  });
  test('Affirm is dropped only after the declines the spec names', () => {
    expect(shouldDropAffirm({ code: 'payment_method_declined', payment_option: 'affirm' })).toBe(true);
    expect(shouldDropAffirm({ code: 'payment_method_temporarily_unavailable', payment_option: 'affirm' })).toBe(true);
    expect(shouldDropAffirm({ code: 'payment_not_completed', payment_option: 'affirm' })).toBe(false);
    expect(shouldDropAffirm({ code: 'payment_action_expired', payment_option: 'affirm' })).toBe(false);
    expect(shouldDropAffirm({ code: 'payment_method_declined', payment_option: 'card' })).toBe(false);
  });
});

test.describe('gift card links', () => {
  // Explicitly constructed so the sample is plainly synthetic: gcg_ plus 26 Crockford base 32 characters.
  const grant = `gcg_${'0'.repeat(26)}`;
  // Lowercase is rejected. An all-zero grant has no case, so this uses letters that do.
  const lowercaseGrant = `gcg_${'a'.repeat(26)}`;
  test('reads the grant and token without opening the link', () => {
    expect(parseGiftCardLink(`https://example.test/gift-cards/${grant}#token=tok_value_1`)).toEqual({ grantId: grant, token: 'tok_value_1' });
    expect(parseGiftCardLink(`  https://checkout.example.test/gift-cards/${grant}/#a=1&token=t_2  `)).toEqual({ grantId: grant, token: 't_2' });
    expect(parseGiftCardLink(`https://example.test/gift-cards/${grant}?mode=test#token=t_3`)).toEqual({ grantId: grant, token: 't_3' });
    expect(parseGiftCardLink(`http://localhost:4100/gift-cards/${grant}#token=t_4`)).toEqual({ grantId: grant, token: 't_4' });
    expect(parseGiftCardLink(`http://127.0.0.1/gift-cards/${grant}#token=t_5`)).toEqual({ grantId: grant, token: 't_5' });
  });
  test('the token may be 4096 characters and no more', () => {
    expect(parseGiftCardLink(`https://example.test/gift-cards/${grant}#token=${'a'.repeat(4096)}`)?.token).toHaveLength(4096);
    expect(parseGiftCardLink(`https://example.test/gift-cards/${grant}#token=${'a'.repeat(4097)}`)).toBeNull();
  });
  test('rejects anything it cannot read', () => {
    const bad = [
      '',
      'not a url',
      `ftp://example.test/gift-cards/${grant}#token=t`,
      `http://example.test/gift-cards/${grant}#token=t`,
      `https://user:pass@example.test/gift-cards/${grant}#token=t`,
      'https://example.test/gift-cards/#token=t',
      `https://example.test/other/${grant}#token=t`,
      `https://example.test/gift-cards/${grant}`,
      `https://example.test/gift-cards/${grant}#token=`,
      `https://example.test/gift-cards/${grant}#other=t`,
      `https://example.test/gift-cards/${grant}/extra#token=t`,
      `https://example.test/gift-cards/${grant}//#token=t`,
      'https://example.test/gift-cards/gcg_abc123#token=t',
      `https://example.test/gift-cards/${lowercaseGrant}#token=t`,
      `https://example.test/gift-cards/gcg_0123456789ABCDEFGHIJKMNPQR#token=t`,
      `https://example.test/gift-cards/${grant}X#token=t`,
    ];
    for (const value of bad) expect(parseGiftCardLink(value), value).toBeNull();
  });
});

test.describe('copy', () => {
  test('error messages resolve by key, then code, then kind', () => {
    expect(errorMessage({ message_key: 'total_changed' }, { amount: '$5.00' })).toBe('Your total changed to $5.00. Check it, then pay.');
    expect(errorMessage({ code: 'CANCEL_IMMEDIATELY_NOT_ALLOWED' })).toBe('You can cancel at the end of the billing period.');
    expect(errorMessage({ kind: 'rate_limited' })).toContain('Too many tries');
    expect(errorMessage({ code: 'SOMETHING_NEW', kind: 'validation' })).toBe('Check the highlighted fields and try again.');
    expect(errorMessage({ code: 'SOMETHING_NEW' })).toBe('Something went wrong on our side. Try again.');
    expect(errorMessage(undefined)).toBe('Something went wrong on our side. Try again.');
    expect(fieldMessage('pause_duration_too_long')).toBe('Choose a shorter pause.');
  });
  test('never prints server message text', () => {
    expect(errorMessage({ code: 'INVALID_LOGIN' } as never)).toBe('Email or password is incorrect.');
  });
  test('notices fill parameters and pluralize', () => {
    expect(noticeText('not_in_account')).toContain('We couldn\'t find that in your account');
    expect(noticeText({ key: 'receipt_sent', params: { email: 'a@example.test' } })).toBe('Receipt sent to a@example.test.');
    expect(noticeText({ key: 'email_confirmed', params: { count: 0 } })).toBe('Your email is confirmed.');
    expect(noticeText({ key: 'email_confirmed', params: { count: 1 } })).toBe('Your email is confirmed. We added 1 earlier order to your account.');
    expect(noticeText({ key: 'email_confirmed', params: { count: 3 } })).toBe('Your email is confirmed. We added 3 earlier orders to your account.');
    expect(noticeText('no_such_notice')).toBeNull();
  });
  test('declines map by code with a default', () => {
    expect(declineMessage('incorrect_cvc')).toBe("The security code doesn't match. Check it and try again.");
    expect(declineMessage('payment_method_declined')).toBe("Affirm didn't approve this purchase. Pay another way.");
    expect(declineMessage('card_declined')).toBe('Your payment was declined. Try another card or payment method.');
    expect(declineMessage(undefined)).toBe('Your payment was declined. Try another card or payment method.');
  });
  test('fill leaves unknown placeholders and plural picks a form', () => {
    expect(fill('Hi {name} {x}', { name: 'A' })).toBe('Hi A {x}');
    expect(plural(1, 'order', 'orders')).toBe('order');
    expect(plural(2, 'order', 'orders')).toBe('orders');
  });
});

test.describe('format helpers', () => {
  test('dates use the configured zone and show an absolute time', () => {
    expect(formatDate('2026-10-07T03:30:00Z', 'America/Chicago')).toBe('Oct 6, 2026');
    expect(formatDateTime('2026-10-07T15:04:00Z', 'America/Chicago')).toBe('Oct 7, 2026, 10:04 AM CDT');
    expect(formatDate('not a date')).toBe('');
    expect(formatDateTime(undefined)).toBe('');
  });
  test('JSON for script blocks cannot close the element', () => {
    const separator = String.fromCharCode(0x2028);
    const json = safeJson({ a: '</script><script>alert(1)</script>', b: `${separator}&` });
    expect(json).not.toContain('<');
    expect(json).not.toContain('>');
    expect(JSON.parse(json)).toEqual({ a: '</script><script>alert(1)</script>', b: `${separator}&` });
    expect(json).not.toContain(separator);
  });
  test('only http and https URLs are linked', () => {
    expect(safeExternalUrl('https://carrier.example.test/x')).toBe('https://carrier.example.test/x');
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,hi')).toBeNull();
    expect(safeExternalUrl(undefined)).toBeNull();
  });
  test('paths encode ids', () => {
    expect(safePath('/orders', 'ord/../x?y')).toBe('/orders/ord%2F..%2Fx%3Fy');
  });
  test('address lines skip empty parts', () => {
    expect(addressLines({ line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' })).toEqual(['1 Main', 'Austin, TX 78701']);
    expect(countOf('12')).toBe(12);
    expect(countOf('x')).toBe(0);
  });
});

test.describe('render boundary', () => {
  test('knows every page id and rejects others', () => {
    for (const id of allPageIds) expect(isPageId(id)).toBe(true);
    expect(isPageId('ac-nope')).toBe(false);
    expect(() => renderPage('ac-nope' as never, context({}) as never)).toThrow(/Unknown page id/);
  });
  test('needs data', () => {
    expect(() => renderPage('ac-home', { ...context({}), data: undefined } as never)).toThrow(/needs context.data/);
  });
  test('escapes hostile values in text, attributes, titles, and JSON blocks', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const ctx = pageContext('ac-home', 'default');
    ctx.user = { name: payload, email: 'a@example.test' };
    ctx.storeName = 'Cedar </title><script>alert(1)</script>';
    const html = renderPage('ac-home', ctx);
    expect(html).not.toContain(payload);
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    const pay = pageContext('ac-invoice-pay', 'default');
    pay.data.buyer = { name: '</script><script>alert(2)</script>', email: 'a@example.test' };
    const payHtml = renderPage('ac-invoice-pay', pay);
    expect(payHtml).not.toContain('<script>alert(2)');
    const boot = /<script type="application\/json" id="payment-boot">([\s\S]*?)<\/script>/.exec(payHtml);
    expect(boot).not.toBeNull();
    expect(JSON.parse(boot?.[1] ?? '{}').buyer.name).toBe('</script><script>alert(2)</script>');
  });
  test('payment pages never embed a provider client secret or a Flint credential', () => {
    const state = paymentState({ next: 'authenticate', attempt: attempt('requires_action'), pending_action_id: 'pa_1' });
    const html = renderPage('ac-invoice-pay', { ...pageContext('ac-invoice-pay'), data: { ...pageContext('ac-invoice-pay').data, state } });
    expect(html).not.toMatch(/client_secret|client_action|flint_test_|flint_live_|ckat_|cklt_|flint_cses_|flint_cref_|whsec_|_secret_/);
  });
});

test.describe('public text rules', () => {
  const owned = [
    'src/copy.ts',
    'src/views',
    'public',
    'tests/browser',
    'playwright.config.ts',
    'README.md',
  ];
  const files = owned
    .map((entry) => join(root, entry))
    .flatMap((full) => {
      try {
        return statSync(full).isDirectory() ? walk(full) : [full];
      } catch {
        return [];
      }
    })
    .filter((file) => /\.(ts|js|css|svg|md|html|json)$/.test(file));

  test('no em or en dashes in owned files', () => {
    const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
    const bad = files.filter((file) => dashes.test(readFileSync(file, 'utf8'))).map((file) => relative(root, file));
    expect(bad).toEqual([]);
  });
  test('no credentials or real-looking identifiers in owned files', () => {
    const patterns = [/flint_(?:test|live)_[A-Za-z0-9]{8,}/, /\bckat_[A-Za-z0-9]{6,}/, /\bcklt_[A-Za-z0-9]{6,}/, /flint_cses_[A-Za-z0-9]{6,}/, /flint_cref_[A-Za-z0-9]{6,}/, /whsec_[A-Za-z0-9]{6,}/, /sk_(?:test|live)_/];
    const bad: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of patterns) if (pattern.test(text)) bad.push(`${relative(root, file)} matches ${pattern}`);
    }
    expect(bad).toEqual([]);
  });
  test('browser modules never call a Flint host or the Flint API', () => {
    const modules = files.filter((file) => file.includes(join('public', 'js')));
    for (const file of modules) {
      const text = readFileSync(file, 'utf8');
      expect(text, relative(root, file)).not.toMatch(/withflintpay\.com|api\.flint|\/v1\//);
      expect(text, relative(root, file)).not.toMatch(/X-Portal|Flint-Merchant|Flint-Buyer|X-Checkout-Session/i);
    }
  });
  test('no inline event handlers, inline scripts, or javascript: links in views', () => {
    const views = files.filter((file) => file.includes(join('src', 'views')) && file.endsWith('.ts'));
    for (const file of views) {
      const text = readFileSync(file, 'utf8');
      expect(text, relative(root, file)).not.toMatch(/\son(?:click|change|submit|load|error)=/i);
      expect(text, relative(root, file)).not.toContain('javascript:');
    }
  });
});
