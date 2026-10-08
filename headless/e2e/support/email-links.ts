import { API_ORIGIN } from './config.ts';
import { invariant } from './safe.ts';
import type { Mail } from './inbox.ts';

export const CHECKOUT_ORIGIN = 'https://checkout.staging.withflintpay.com';
export const accountRelayPath = /^\/account\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export const preferenceRelayPath = /^\/email-preferences\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export const recipientPath = /^\/gift-cards\/gcg_[0-9A-HJKMNP-TV-Z]{26}$/;
export const accountFamilies = new Set(['order_receipts', 'fulfillment_updates', 'subscription_lifecycle', 'dunning', 'returns', 'invoices']);
export type LinkRole = 'contact' | 'bad_scheme' | 'app' | 'flint_brand_credit' | 'flint_account_link_relay' | 'flint_email_preferences_relay' | 'flint_hosted_gift_recipient_access' | 'misplaced_gift_recipient_link' | 'merchant_support' | 'provider_or_carrier' | 'flint_commerce_or_unknown' | 'unknown_external';
export type LinkClassification = { role: LinkRole; verdict: 'ignore' | 'pass' | 'record' | 'excluded_hosted_surface' | 'fail'; code?: string };
export type LinkConfig = { appOrigins: string[]; apiOrigin: typeof API_ORIGIN; checkoutOrigin: typeof CHECKOUT_ORIGIN; merchantSupportUrl?: string };
export function classify(mail: Pick<Mail, 'links'>, family: string, config: LinkConfig): LinkClassification[] {
  invariant(config.apiOrigin === API_ORIGIN && config.checkoutOrigin === CHECKOUT_ORIGIN, 'EMAIL_ORIGIN_PIN_REQUIRED');
  const results = mail.links.map(({ href }): LinkClassification => {
    let u: URL; try { u = new URL(href); } catch { return { role: 'bad_scheme', verdict: 'fail', code: 'EMAIL_LINK_SCHEME' }; }
    const fail = (role: LinkRole, code: string): LinkClassification => ({ role, verdict: 'fail', code });
    if (['mailto:', 'tel:'].includes(u.protocol)) return { role: 'contact', verdict: 'ignore' };
    if (u.username || u.password || u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && config.appOrigins.includes(u.origin))) return fail('bad_scheme', 'EMAIL_LINK_SCHEME');
    if (recipientPath.test(u.pathname) && family !== 'gift_card_notification') return fail('misplaced_gift_recipient_link', 'EMAIL_GIFT_RECIPIENT_LINK_OUT_OF_FAMILY');
    if (config.appOrigins.includes(u.origin)) return [...u.searchParams.keys()].some(k => /^(email|password|code|secret|client_secret|access_token|token|checkout_auth_token)$/i.test(k)) ? fail('app', 'EMAIL_SENSITIVE_QUERY') : { role: 'app', verdict: 'pass' };
    if (u.origin === 'https://withflintpay.com' && u.pathname === '/' && !u.search && !u.hash) return { role: 'flint_brand_credit', verdict: 'record' };
    if (u.origin === config.apiOrigin && accountRelayPath.test(u.pathname)) {
      const entries = [...u.searchParams.entries()];
      return accountFamilies.has(family) && !u.hash && (!u.search || entries.length === 1 && entries[0][0] === 'action' && ['skip', 'update-delivery', 'pause'].includes(entries[0][1])) ? { role: 'flint_account_link_relay', verdict: 'pass' } : fail('flint_account_link_relay', 'EMAIL_ACCOUNT_RELAY_INVALID');
    }
    if (u.origin === config.apiOrigin && preferenceRelayPath.test(u.pathname)) return accountFamilies.has(family) && !u.search && !u.hash ? { role: 'flint_email_preferences_relay', verdict: 'pass' } : fail('flint_email_preferences_relay', 'EMAIL_PREFERENCE_RELAY_INVALID');
    if (family === 'gift_card_notification' && recipientPath.test(u.pathname)) {
      return u.origin === config.checkoutOrigin && u.search === '?mode=test' && /^#token=.+/.test(u.hash) && !!new URLSearchParams(u.hash.slice(1)).get('token') ? { role: 'flint_hosted_gift_recipient_access', verdict: 'excluded_hosted_surface' } : fail('flint_hosted_gift_recipient_access', 'EMAIL_GIFT_RECIPIENT_LINK_INVALID');
    }
    if (config.merchantSupportUrl) { const support = new URL(config.merchantSupportUrl); if (u.origin === support.origin && u.pathname === support.pathname && u.search === support.search && u.hash === support.hash) return { role: 'merchant_support', verdict: 'record' }; }
    if (/(^|\.)(stripe\.com|stripe\.network|usps\.com|ups\.com|fedex\.com)$/i.test(u.hostname)) return { role: 'provider_or_carrier', verdict: 'record' };
    if (/(^|\.)withflintpay\.com$/i.test(u.hostname)) return fail('flint_commerce_or_unknown', 'EMAIL_FLINT_COMMERCE_LINK');
    return fail('unknown_external', 'EMAIL_UNDOCUMENTED_EXTERNAL_LINK');
  });
  if (family === 'gift_card_notification' && results.filter(r => r.role === 'flint_hosted_gift_recipient_access').length !== 1) results.push({ role: 'flint_hosted_gift_recipient_access', verdict: 'fail', code: 'EMAIL_GIFT_RECIPIENT_LINK_COUNT' });
  return results;
}
export function auditEmail(mail: Pick<Mail, 'links'>, family: string, config: LinkConfig): LinkClassification[] {
  const results = classify(mail, family, config); const failed = results.find(r => r.verdict === 'fail'); invariant(!failed, failed?.code ?? 'EMAIL_LINK_AUDIT_FAILED'); return results;
}
