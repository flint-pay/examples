import { html } from 'hono/html';
import { browserCopy, fill, pay } from '../../copy.ts';
import { addMoney, isZero } from '../../../public/js/money.js';
import { derivePhase, hasPaymentCollection, type PaymentPhase } from '../../../public/js/payment-phase.js';
import {
  attrs,
  button,
  fmtFor,
  jsonBlock,
  linkButton,
  money,
  pageHeader,
  supportContact,
  timeEl,
  type Html,
} from '../components.ts';
import { path } from '../format.ts';
import { renderDocument } from '../layout.ts';
import type {
  InvoicePaySummary,
  MoneyValue,
  PaymentPageData,
  PaymentState,
  RenderContext,
  ReturnPaySummary,
} from '../types.ts';
import { cardLabel, lineItems } from './shared.ts';

export interface PaymentEndpoints {
  state: string;
  submit: string;
  resume: string;
  attempt: string;
  cancel_attempt: string;
  /** The provider return route. The browser navigates here after done or bank_processing. */
  complete: string;
  /** The resource page. */
  detail: string;
  /** The pay page itself, used for Start again and Check again. */
  page: string;
}

export function paymentEndpoints(surface: PaymentPageData['surface'], resourceId: string): PaymentEndpoints {
  const detail = path(surface === 'invoice' ? '/invoices' : '/returns', resourceId);
  const base = `${detail}/pay`;
  return {
    state: `${base}/state`,
    submit: `${base}/submit`,
    resume: `${base}/resume`,
    attempt: `${base}/attempt`,
    cancel_attempt: `${base}/cancel-attempt`,
    complete: `${base}/return`,
    detail,
    page: base,
  };
}

/** The initial data-state of the payment region. JS takes over from `loading`. */
export function initialPaymentState(phase: PaymentPhase): string {
  switch (phase) {
    case 'ready':
    case 'declined':
    case 'pay_remaining':
    case 'total_changed':
      return 'loading';
    default:
      return phase;
  }
}

/**
 * Builds the JSON embedded in the page. Field by field, so nothing else from the backend object
 * reaches the browser. Provider client secrets are never part of it.
 */
export function serializePaymentState(state: PaymentState): Record<string, unknown> {
  return {
    order: {
      order_number: state.order.order_number,
      pricing_amounts: state.order.pricing_amounts,
      settlement_amounts: state.order.settlement_amounts,
    },
    payment_collection: state.payment_collection,
    attempt: state.attempt
      ? {
          order_payment_attempt_id: state.attempt.order_payment_attempt_id,
          status: state.attempt.status,
          is_resumable: state.attempt.is_resumable,
          mode: state.attempt.mode,
          failure_code: state.attempt.failure_code,
          expected_outstanding_money: state.attempt.expected_outstanding_money,
          legs: state.attempt.legs?.map((leg) => ({
            payment_intent_id: leg.payment_intent_id,
            status: leg.status,
            amount_money: leg.amount_money,
            payment_option: leg.payment_option,
          })),
        }
      : null,
    next: state.next,
    approved_outstanding_money: state.approved_outstanding_money,
    pending_action_id: state.pending_action_id,
    decline: state.decline ?? null,
    saved_methods: (state.saved_methods ?? []).map((method) => ({
      payment_method_id: method.payment_method_id,
      status: method.status,
      usage: method.usage,
      label: cardLabel(method.card),
    })),
    shipping: state.shipping ?? null,
    recovery_mode: Boolean(state.recovery_mode),
    expired: Boolean(state.expired),
    total_changed: Boolean(state.total_changed),
    returned: Boolean(state.returned),
    notices: state.notices ?? [],
  };
}

function currentPayLabel(surface: PaymentPageData['surface'], amount: MoneyValue): string {
  return fill(surface === 'invoice' ? pay.payInvoice : pay.payReturn, { amount: fmtFor({}).money(amount) });
}

function invoiceSummary(summary: InvoicePaySummary, state: PaymentState | null, ctx: RenderContext): Html {
  const { invoice } = summary;
  const due = state?.approved_outstanding_money ?? invoice.currently_due_money ?? invoice.outstanding_money;
  return html`<h2>${pay.summaryInvoice}</h2>
    <dl class="facts" data-testid="ac-invoice-pay-summary">
      <div class="fact"><dt>${pay.invoiceNumber}</dt><dd data-testid="ac-invoice-pay-number">${invoice.invoice_number ?? invoice.invoice_id}</dd></div>
      ${invoice.due_at ? html`<div class="fact"><dt>${pay.dueDate}</dt><dd>${timeEl(invoice.due_at, ctx)}</dd></div>` : ''}
      <div class="fact fact-strong"><dt>${pay.amountDueNow}</dt><dd>${money(due, { testid: 'ac-invoice-pay-amount', className: 'money-large' })}</dd></div>
    </dl>
    <p><a href="${path('/invoices', invoice.invoice_id)}/pdf" data-testid="ac-invoice-pay-pdf">${pay.downloadPdf}</a></p>`;
}

function returnSummary(summary: ReturnPaySummary, state: PaymentState | null): Html {
  const due = state?.approved_outstanding_money ?? summary.return.financial_summary.due_from_buyer_money;
  const credits = state?.order.return_credit_settlements ?? [];
  const creditTotal = credits.reduce<MoneyValue | null>((total, credit) => (total ? addMoney(total, credit.amount_money) : credit.amount_money), null);
  return html`<h2>${pay.balanceTitle}</h2>
    <div data-testid="ac-return-pay-summary">
      ${state && state.order.line_items.length ? html`<h3>${pay.itemsComing}</h3>${lineItems(state.order.line_items, 'ac-return-pay-item')}` : ''}
      ${creditTotal && !isZero(creditTotal) ? html`<dl class="amounts"><div class="amount-row"><dt>${pay.creditApplied}</dt><dd>-${money(creditTotal, { testid: 'ac-return-pay-credit' })}</dd></div></dl>` : ''}
      <dl class="facts"><div class="fact fact-strong"><dt>${pay.amountDueNow}</dt><dd>${money(due, { testid: 'ac-return-pay-amount', className: 'money-large' })}</dd></div></dl>
    </div>`;
}

function summaryPanel(data: PaymentPageData, ctx: RenderContext): Html {
  const state = data.state;
  const total = state?.approved_outstanding_money;
  const summary = data.surface === 'invoice' ? invoiceSummary(data.summary as InvoicePaySummary, state, ctx) : returnSummary(data.summary as ReturnPaySummary, state);
  return html`<aside class="pay-summary" aria-label="${data.surface === 'invoice' ? pay.summaryInvoice : pay.balanceTitle}">
    <details class="summary-collapse" open data-collapse-narrow>
      <summary>${pay.amountDueNow} ${total ? money(total, { className: 'money-large' }) : ''}</summary>
      <div class="summary-body">${summary}</div>
    </details>
  </aside>`;
}

function conflictBlock(data: PaymentPageData): Html {
  const endpoints = paymentEndpoints(data.surface, data.resource_id);
  const text = data.surface === 'invoice' ? pay.surfaceConflictInvoice : pay.surfaceConflictReturn;
  return html`<section class="card" aria-labelledby="payment-heading"><h2 id="payment-heading">${pay.paymentHeading}</h2>
    <div data-testid="ac-payment" data-state="${data.launch}" role="status">
      <p>${text}</p>
      <p>${linkButton(endpoints.page, pay.checkAgain, { variant: 'primary', testid: 'ac-check-again' })} ${linkButton(endpoints.detail, data.surface === 'invoice' ? pay.backToInvoice : pay.backToReturn)}</p>
    </div></section>`;
}

function paymentRegion(data: PaymentPageData, ctx: RenderContext): Html {
  const state = data.state;
  if (!state) return conflictBlock(data);
  const endpoints = paymentEndpoints(data.surface, data.resource_id);
  const phase = derivePhase(state);
  const initial = initialPaymentState(phase);
  const needsElements = initial === 'loading';
  const boot = {
    surface: data.surface,
    resource_id: data.resource_id,
    endpoints,
    buyer: { name: data.buyer.name ?? null, email: data.buyer.email },
    store_name: ctx.storeName,
    support: ctx.support ?? null,
    state: serializePaymentState(state),
    copy: browserCopy.payment,
  };
  return html`<section class="card" aria-labelledby="payment-heading">
    <h2 id="payment-heading">${pay.paymentHeading}</h2>
    <div class="payment" id="payment" data-testid="ac-payment" data-state="${initial}" data-phase="${phase}" data-surface="${data.surface}" data-still-after-ms="60000" data-payment-root${attrs({ 'aria-busy': needsElements ? 'true' : undefined })}>
      <noscript><p class="alert alert-warn">${pay.noscript}</p></noscript>
      <div class="payment-banner" data-payment-banner role="status" data-testid="ac-payment-banner" hidden></div>
      <div class="alert alert-error" data-payment-message role="alert" tabindex="-1" data-testid="ac-payment-message" hidden></div>
      <div class="payment-static" data-payment-static ${phase === 'unavailable' ? '' : 'hidden'} data-testid="ac-payment-unavailable">
        <p>${fill(pay.unavailable, { store: ctx.storeName })}</p>${supportContact(ctx.support)}
      </div>
      <div class="payment-static" data-payment-expired ${phase === 'expired' ? '' : 'hidden'}>
        <p>${pay.expired}</p><p>${linkButton(endpoints.page, pay.startAgain, { variant: 'primary', testid: 'ac-start-again' })}</p>
      </div>
      <div class="payment-progress js-only" data-payment-progress hidden>
        <p data-payment-progress-text></p>
        <p data-payment-check hidden>${button({ label: pay.checkAgain, variant: 'secondary', testid: 'ac-check-again', attributes: { 'data-payment-check-button': 'true' } })}</p>
      </div>
      <div class="payment-remaining" data-payment-remaining hidden data-testid="ac-pay-remaining"></div>
      <fieldset class="saved-methods" data-saved-methods hidden>
        <legend>${pay.savedMethods}</legend>
        <div data-saved-list></div>
        <div class="saved-option"><input type="radio" name="payment_choice" id="choice-new" value="new" data-testid="ac-use-new-method" checked><label for="choice-new">${pay.useNew}</label></div>
      </fieldset>
      <div class="wallets" data-wallets hidden data-testid="ac-wallets">
        <p class="wallets-heading">${pay.expressHeading}</p>
        <div id="express-checkout-element"></div>
      </div>
      <div class="payment-element-wrap" data-element-wrap${needsElements ? '' : ' hidden'}>
        <div id="payment-element" class="payment-element skeleton" data-testid="ac-payment-element" aria-label="${pay.loading}"></div>
      </div>
      <div class="affirm-actions" data-affirm-actions hidden>
        ${button({ label: pay.continueAffirm, variant: 'primary', testid: 'ac-affirm-continue', attributes: { 'data-affirm-continue': 'true' } })}
        ${button({ label: pay.payAnotherWay, variant: 'secondary', testid: 'ac-pay-another-way', attributes: { 'data-pay-another-way': 'true' } })}
      </div>
      <div class="pay-actions js-only" data-pay-actions${needsElements ? '' : ' hidden'}>
        <button type="button" class="btn btn-primary btn-pay" id="pay-button" data-testid="ac-pay-button" data-pay-button disabled aria-describedby="pay-blocker">${currentPayLabel(data.surface, state.approved_outstanding_money)}</button>
        <p class="pay-blocker" id="pay-blocker" data-pay-blocker data-testid="ac-pay-blocker">${pay.loading}</p>
      </div>
    </div>
    ${jsonBlock('payment-boot', boot)}
  </section>`;
}

function payPage(ctx: RenderContext<PaymentPageData>): Html {
  const data = ctx.data;
  const isInvoice = data.surface === 'invoice';
  const summary = data.summary;
  const number = isInvoice ? ((summary as InvoicePaySummary).invoice.invoice_number ?? data.resource_id) : (summary as ReturnPaySummary).return.return_number;
  const title = data.returned ? pay.returnedTitle : isInvoice ? fill(pay.invoiceTitle, { number }) : pay.returnTitle;
  // Stripe.js is only loaded when the page can collect a payment or run a provider action.
  const phase = data.state ? derivePhase(data.state) : null;
  const needsStripe = Boolean(
    data.state && data.launch === 'ready' && phase && !['unavailable', 'expired', 'succeeded', 'bank_processing'].includes(phase) && (hasPaymentCollection(data.state) || data.state.next !== 'new_payment'),
  );
  const testid = isInvoice ? 'ac-invoice-pay' : 'ac-return-pay';
  const main = html`${pageHeader(title, { subtitle: data.returned ? pay.returnedHelp : undefined, testid: `${testid}-title` })}
    <div class="pay-layout">
      <div class="pay-main">${paymentRegion(data, ctx)}</div>
      ${summaryPanel(data, ctx)}
    </div>
    <p class="back-link"><a href="${paymentEndpoints(data.surface, data.resource_id).detail}">${isInvoice ? pay.backToInvoice : pay.backToReturn}</a></p>`;
  return renderDocument(ctx, {
    pageId: testid,
    title,
    testid,
    main,
    nav: isInvoice ? 'invoices' : 'returns',
    stripe: needsStripe,
    scripts: needsStripe ? ['/js/stripe-payment.js'] : [],
  });
}

export function invoicePayPage(ctx: RenderContext<PaymentPageData>): Html {
  return payPage(ctx);
}

export function returnPayPage(ctx: RenderContext<PaymentPageData>): Html {
  return payPage(ctx);
}
