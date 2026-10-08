import { html } from 'hono/html';
import { browserCopy, common, fill, paymentMethods as pm } from '../../copy.ts';
import {
  badge,
  button,
  card,
  confirmDialog,
  dialogTrigger,
  emptyState,
  jsonBlock,
  linkButton,
  pageHeader,
  postForm,
  sectionError,
  type Html,
} from '../components.ts';
import { path } from '../format.ts';
import { renderDocument } from '../layout.ts';
import type {
  PaymentMethod,
  PaymentMethodNewData,
  PaymentMethodReturnData,
  PaymentMethodsData,
  RenderContext,
} from '../types.ts';
import { cardName, paymentMethodStatusLabel } from './shared.ts';

function statusTone(status: string) {
  return status === 'active' ? 'good' : status === 'pending' ? 'info' : status === 'failed' || status === 'expired' ? 'bad' : 'neutral';
}

export function paymentMethodsPage(ctx: RenderContext<PaymentMethodsData>): Html {
  const { payment_methods: methods, default_payment_method_id } = ctx.data;
  let body: Html;
  if (methods.status === 'error') {
    body = sectionError('your cards', methods.error, '/payment-methods', 'ac-payment-methods-error');
  } else {
    const visible = methods.value.filter((method) => method.status !== 'removed');
    if (!visible.length) {
      body = emptyState(pm.empty, linkButton('/payment-methods/new', pm.add, { variant: 'primary', testid: 'ac-add-card' }), 'ac-payment-methods-empty');
    } else {
      body = html`<ul class="rows cards" data-state="loaded">${visible.map((method: PaymentMethod) => {
        const id = method.payment_method_id;
        const isDefault = id === default_payment_method_id;
        const canDefault = method.status === 'active' && method.usage === 'off_session' && !isDefault;
        const dialogId = `remove-${id}`;
        const removeDialog = confirmDialog({
            id: dialogId,
            title: pm.removeTitle,
            body: pm.removeConfirm,
            action: `${path('/payment-methods', id)}/remove`,
            csrf: ctx.csrf,
            confirmLabel: pm.removeYes,
            cancelLabel: pm.removeNo,
            danger: true,
            testid: `ac-card-remove-dialog-${id}`,
            confirmTestid: 'ac-card-remove-confirm',
          });
        return html`<li class="row row-card" data-testid="ac-card-${id}" data-state="${method.status}">
          <div class="row-main">
            <span class="row-title">${cardName(method.card)}</span>
            <span class="row-meta">${method.card ? fill(pm.expires, { month: String(method.card.exp_month).padStart(2, '0'), year: String(method.card.exp_year).slice(-2) }) : ''}</span>
            <span class="row-meta">${method.usage === 'off_session' ? pm.usageOffSession : pm.usageOnSession}</span>
          </div>
          <div class="row-badges">
            ${isDefault ? badge(common.defaultBadge, 'good', { 'data-testid': 'ac-card-default' }) : ''}
            ${method.status !== 'active' ? badge(paymentMethodStatusLabel(method.status), statusTone(method.status), { 'data-state': method.status }) : ''}
          </div>
          <div class="row-actions">
            ${canDefault ? postForm({ action: `${path('/payment-methods', id)}/default`, csrf: ctx.csrf, className: 'inline-form' }, button({ label: pm.setDefault, type: 'submit', testid: 'ac-card-set-default' })) : ''}
            ${dialogTrigger(dialogId, pm.remove, { variant: 'danger', testid: 'ac-card-remove' })}
          </div>
          ${removeDialog}
        </li>`;
      })}</ul>
      <p>${linkButton('/payment-methods/new', pm.add, { variant: 'primary', testid: 'ac-add-card' })}</p>`;
    }
  }
  const main = html`${pageHeader(pm.title, { testid: 'ac-payment-methods-title' })}${card(body, { testid: 'ac-payment-methods-list' })}`;
  return renderDocument(ctx, { pageId: 'ac-payment-methods', title: pm.title, testid: 'ac-payment-methods', main, nav: 'payment-methods' });
}

export function paymentMethodNewPage(ctx: RenderContext<PaymentMethodNewData>): Html {
  const boot = {
    endpoints: {
      setup: '/payment-methods/new/setup',
      status: '/payment-methods/{id}/status',
      complete: '/payment-methods/new/return',
      list: '/payment-methods',
    },
    return_to: ctx.data.return_to ?? null,
    copy: browserCopy.cardSetup,
  };
  const main = html`${pageHeader(pm.newTitle, { subtitle: pm.newIntro, testid: 'ac-payment-method-new-title' })}
    ${card(
      html`<div id="card-setup" class="card-setup" data-testid="ac-card-setup" data-state="loading" data-confirm-timeout-ms="30000" data-card-setup aria-busy="true">
        <noscript><p class="alert alert-warn">JavaScript is needed to add a card.</p></noscript>
        <div class="alert alert-error" data-setup-message role="alert" tabindex="-1" data-testid="ac-card-setup-message" hidden></div>
        <div class="status-note" data-setup-confirming role="status" hidden data-testid="ac-card-confirming"><p data-setup-confirming-text>${pm.confirmingMessage}</p><p data-setup-check hidden>${button({ label: pm.checkAgain, variant: 'secondary', testid: 'ac-card-check-again', attributes: { 'data-setup-check-button': 'true' } })}</p></div>
        <div class="payment-element-wrap" data-setup-wrap><div id="setup-element" class="payment-element skeleton" aria-label="${pm.newLoading}" data-testid="ac-card-element"></div></div>
        <p data-setup-restart hidden><a class="btn btn-primary" href="/payment-methods/new" data-testid="ac-card-try-another">${pm.tryAnother}</a></p>
        <div class="pay-actions js-only" data-setup-actions>
          <button type="button" class="btn btn-primary btn-pay" id="save-card-button" data-testid="ac-card-save" data-setup-submit disabled aria-describedby="setup-blocker">${pm.newSubmit}</button>
          <p class="pay-blocker" id="setup-blocker" data-setup-blocker>${pm.newLoading}</p>
        </div>
      </div>
      ${jsonBlock('card-setup-boot', boot)}`,
      { testid: 'ac-card-setup-card' },
    )}
    <p class="back-link"><a href="/payment-methods">${pm.newBack}</a></p>`;
  return renderDocument(ctx, {
    pageId: 'ac-payment-method-new',
    title: pm.newTitle,
    testid: 'ac-payment-method-new',
    main,
    nav: 'payment-methods',
    stripe: true,
    scripts: ['/js/card-setup.js'],
  });
}

export function paymentMethodReturnPage(ctx: RenderContext<PaymentMethodReturnData>): Html {
  const method = ctx.data.payment_method;
  const boot = {
    endpoints: { status: '/payment-methods/{id}/status', complete: '/payment-methods/new/return', list: '/payment-methods' },
    payment_method_id: method?.payment_method_id ?? null,
    status: method?.status ?? null,
    copy: browserCopy.cardSetup,
  };
  const state = !method ? 'nothing' : method.status === 'failed' ? 'setup_failed' : 'confirming';
  const main = html`${pageHeader(pm.returnTitle, { testid: 'ac-payment-method-return-title' })}
    ${card(
      html`<div id="card-setup" class="card-setup" data-testid="ac-card-setup" data-state="${state}" data-confirm-timeout-ms="30000" data-card-return>
        ${
          !method
            ? html`<p data-testid="ac-card-return-nothing">${pm.returnNothing}</p><p>${linkButton('/payment-methods', pm.newBack)}</p>`
            : method.status === 'failed'
              ? html`<div class="alert alert-error" role="alert" data-testid="ac-card-setup-message"><p class="alert-title">${pm.setupFailed} ${pm.failedCard}</p></div><p>${linkButton('/payment-methods/new', pm.add, { variant: 'primary' })}</p>`
              : html`<div class="status-note" role="status" data-testid="ac-card-confirming"><p data-setup-confirming-text>${pm.confirmingMessage}</p><p data-setup-check hidden>${button({ label: pm.checkAgain, variant: 'secondary', testid: 'ac-card-check-again', attributes: { 'data-setup-check-button': 'true' } })}</p></div>`
        }
      </div>
      ${jsonBlock('card-setup-boot', boot)}`,
      { testid: 'ac-card-return-card' },
    )}`;
  return renderDocument(ctx, {
    pageId: 'ac-payment-method-return',
    title: pm.returnTitle,
    testid: 'ac-payment-method-return',
    main,
    nav: 'payment-methods',
    scripts: method && method.status !== 'failed' ? ['/js/card-setup.js'] : [],
  });
}
