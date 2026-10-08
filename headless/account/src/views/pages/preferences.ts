import { html } from 'hono/html';
import { browserCopy, common, emailPreferences as ep, errorMessage, fill, identity, linkPurchases as lp, plural, privacy as pv } from '../../copy.ts';
import {
  badge,
  button,
  card,
  checkboxField,
  confirmDialog,
  dialogTrigger,
  errorSummary,
  fmtFor,
  jsonBlock,
  linkButton,
  pageHeader,
  postForm,
  sectionError,
  supportContact,
  type Html,
} from '../components.ts';
import { renderDocument } from '../layout.ts';
import type { EmailPreferencesData, LinkPurchasesData, PrivacyData, RenderContext } from '../types.ts';
import { codeFlow } from './identity.ts';

export function emailPreferencesPage(ctx: RenderContext<EmailPreferencesData>): Html {
  const { signed_in, preferences, preferences_error } = ctx.data;
  const needsEmail = preferences_error?.code?.toLowerCase() === 'customer_email_required' || preferences_error?.message_key === 'customer_email_required';
  const initial = signed_in ? 'signed-in' : 'token-lookup';
  const boot = {
    endpoints: { lookup: '/email-preferences/lookup', unsubscribe: '/email-preferences/unsubscribe', signIn: '/sign-in?next=%2Femail-preferences' },
    signed_in,
    copy: browserCopy.emailPreferences,
  };

  const signedInPanel = signed_in
    ? html`<section data-mode="signed-in" data-testid="ac-pref-signed-in">
        ${
          needsEmail
            ? html`<p class="alert alert-warn" role="status" data-testid="ac-pref-no-email">${ep.noEmail}</p>`
            : preferences
              ? postForm(
                  { action: '/email-preferences', csrf: ctx.csrf, testid: 'ac-pref-form' },
                  html`<p class="muted">${ep.intro}</p>
                    ${checkboxField({ name: 'shipping_updates', label: ep.shippingUpdates, hint: ep.shippingUpdatesHint, checked: preferences.shipping_updates, testid: 'ac-pref-shipping-updates' })}
                    ${checkboxField({ name: 'checkout_reminders', label: ep.checkoutReminders, hint: ep.checkoutRemindersHint, checked: preferences.checkout_reminders, testid: 'ac-pref-checkout-reminders' })}
                    <div class="form-actions">${button({ label: ep.save, type: 'submit', variant: 'primary', testid: 'ac-pref-save' })}</div>`,
                )
              : sectionError('your email preferences', preferences_error ?? undefined, '/email-preferences', 'ac-pref-error')
        }
      </section>`
    : '';

  const tokenPanel = html`<section data-mode="token" ${signed_in ? 'hidden' : ''} data-testid="ac-pref-token">
      <p class="status-note js-only" role="status" data-token-view="lookup" data-testid="ac-pref-lookup">${ep.lookup}</p>
      <div data-token-view="confirm" hidden data-testid="ac-pref-confirm">
        <p class="confirm-question" data-confirm-text></p>
        <div class="form-actions">${button({ label: ep.unsubscribe, variant: 'primary', testid: 'ac-unsubscribe-button', attributes: { 'data-unsubscribe-button': 'true' } })}</div>
      </div>
      <div data-token-view="done" hidden role="status" data-testid="ac-pref-done"><p data-done-text></p></div>
      <div data-token-view="invalid" hidden role="alert" class="alert alert-error" data-testid="ac-pref-invalid"><p class="alert-title">${ep.invalid}</p><p><a href="/sign-in?next=%2Femail-preferences">${common.signIn}</a></p></div>
      <div data-token-view="missing" hidden data-testid="ac-pref-missing"><p>${ep.missing}</p>${signed_in ? '' : html`<p><a href="/sign-in?next=%2Femail-preferences" data-testid="ac-pref-sign-in">${ep.signInPrompt}</a></p>`}</div>
      <div data-token-view="retry" hidden role="alert" class="alert alert-error" data-testid="ac-pref-retry"><p class="alert-title">${ep.retry}</p></div>
    </section>
    <noscript><p class="alert alert-warn" data-testid="ac-pref-noscript">${ep.needsJs}</p><p><a href="/sign-in?next=%2Femail-preferences">${ep.signInPrompt}</a></p></noscript>`;

  const main = html`${pageHeader(ep.title, { testid: 'ac-email-preferences-title' })}
    ${errorSummary(ctx.error)}
    <section class="card" data-testid="ac-email-preferences" data-state="${initial}" data-email-preferences>
      ${signedInPanel}
      ${tokenPanel}
    </section>
    ${jsonBlock('prefs-boot', boot)}`;
  void errorMessage;
  return renderDocument(ctx, {
    pageId: 'ac-email-preferences',
    title: ep.title,
    testid: 'ac-email-preferences-page',
    main,
    nav: signed_in ? 'email-preferences' : undefined,
    shell: signed_in ? 'account' : 'auth',
    mainClass: signed_in ? undefined : 'main-auth',
    scripts: ['/js/email-preferences.js'],
  });
}

export function privacyPage(ctx: RenderContext<PrivacyData>): Html {
  const { requests } = ctx.data;
  const list =
    requests.status === 'error'
      ? sectionError('your requests', requests.error, '/privacy', 'ac-privacy-error')
      : requests.value.length
        ? html`<ul class="rows" data-testid="ac-deletion-status-list">${[...requests.value]
            .sort((a, b) => Date.parse(b.requested_at) - Date.parse(a.requested_at))
            .map(
              (request, index) => html`<li class="row" data-testid="ac-deletion-item-${request.customer_deletion_request_id}">
                <span class="row-title"${index === 0 ? html` data-testid="ac-deletion-status" data-state="${request.status}"` : ''}>${pv.statuses[request.status] ?? request.status}</span>
                <span class="row-meta">${fill(pv.requestedOn, { date: fmtFor(ctx).date(request.requested_at) })}</span>
              </li>`,
            )}</ul>`
        : html`<p class="muted" data-state="empty">${pv.noRequests}</p>`;
  const rejectedOrFailed = requests.status === 'ok' && requests.value.some((request) => request.status === 'rejected');
  const main = html`${pageHeader(pv.title, { testid: 'ac-privacy-title' })}
    ${card(
      html`<p>${pv.intro}</p>
        <p>${dialogTrigger('deletion-dialog', pv.request, { variant: 'danger', testid: 'ac-deletion-request' })}</p>`,
      { testid: 'ac-privacy-card' },
    )}
    ${card(html`<h2 id="deletion-requests">${pv.requests}</h2>${list}${rejectedOrFailed ? supportContact(ctx.support) : ''}`, { labelledBy: 'deletion-requests', testid: 'ac-deletion-requests' })}
    ${confirmDialog({ id: 'deletion-dialog', title: pv.confirmTitle, body: pv.confirmBody, action: '/privacy/deletion-request', csrf: ctx.csrf, confirmLabel: pv.confirmYes, cancelLabel: pv.confirmNo, danger: true, testid: 'ac-deletion-dialog', confirmTestid: 'ac-deletion-confirm' })}`;
  void badge;
  return renderDocument(ctx, { pageId: 'ac-privacy', title: pv.title, testid: 'ac-privacy', main, nav: 'privacy' });
}

export function linkPurchasesPage(ctx: RenderContext<LinkPurchasesData>): Html {
  const { state, email, sentAt, linked_order_count } = ctx.data;
  let body: Html;
  if (state === 'done') {
    const count = linked_order_count ?? 0;
    body = html`<div class="auth-card" data-state="done" data-testid="ac-link-purchases-done">
      <p role="status" data-testid="ac-link-result" data-count="${count}">${count > 0 ? fill(lp.doneSome, { count, orders: plural(count, 'order', 'orders') }) : fill(lp.doneNone, { email })}</p>
      <p class="actions-row">${linkButton('/orders', lp.viewOrders, { variant: 'primary', testid: 'ac-link-view-orders' })}${postForm({ action: '/link-purchases/send', csrf: ctx.csrf, className: 'inline-form' }, button({ label: lp.searchAgain, type: 'submit', testid: 'ac-link-search-again' }))}</p>
    </div>`;
  } else {
    body = codeFlow({
      base: '/link-purchases',
      email,
      state: state === 'code_sent' ? 'code_sent' : 'idle',
      sentAt,
      csrf: ctx.csrf,
      error: ctx.error,
      ids: { root: 'ac-link-purchases-flow', code: 'ac-link-code', send: 'ac-link-send', confirm: 'ac-link-confirm', resend: 'ac-link-resend' },
      idleText: lp.intro,
      sentText: lp.sent,
      sendLabel: lp.send,
      confirmLabel: lp.confirm,
      resendLabel: lp.resend,
    });
  }
  const main = html`${pageHeader(lp.title, { testid: 'ac-link-purchases-title' })}
    ${errorSummary(ctx.error, { code: identity.codeLabel })}
    <div data-testid="ac-link-purchases" data-state="${state}" class="link-purchases">${body}</div>`;
  return renderDocument(ctx, { pageId: 'ac-link-purchases', title: lp.title, testid: 'ac-link-purchases-page', main, nav: 'orders', scripts: ['/js/verify-email.js'] });
}
