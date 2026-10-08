import { html } from 'hono/html';
import { browserCopy, fill, giftPay, pay } from '../../copy.ts';
import { addMoney, isZero } from '../../../public/js/money.js';
import { derivePhase, hasGiftCards, hasPaymentCollection, isSettlement, processorMoney, type PaymentPhase } from '../../../public/js/payment-phase.js';
import {
  attrs,
  button,
  fmtFor,
  field,
  jsonBlock,
  linkButton,
  money,
  pageHeader,
  postForm,
  hiddenInput,
  supportContact,
  timeEl,
  type Html,
} from '../components.ts';
import { path } from '../format.ts';
import { renderDocument } from '../layout.ts';
import type {
  GiftPayBoot,
  GiftUnconfirmed,
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
    collection_kind: state.collection_kind,
    gift_editable: state.gift_editable,
    gift_unconfirmed: state.gift_unconfirmed ?? null,
    order: {
      order_number: state.order.order_number,
      pricing_amounts: state.order.pricing_amounts,
      settlement_amounts: state.order.settlement_amounts,
      order_revision: state.order.order_revision,
      gift_card_tender_enabled: state.order.gift_card_tender_enabled,
      gift_cards: state.order.gift_cards,
      gift_card_estimate: state.order.gift_card_estimate,
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

function currentPayLabel(surface: PaymentPageData['surface'], state: PaymentState): string {
  if (isSettlement(state)) return giftPay.payConfirm;
  return fill(surface === 'invoice' ? pay.payInvoice : pay.payReturn, { amount: fmtFor({}).money(processorMoney(state)) });
}

/** What the gift cards cover when they pay for the whole amount. */
function settlementText(surface: PaymentPageData['surface'], state: PaymentState): string {
  const covered = state.order.gift_card_estimate?.gift_card_money;
  return fill(surface === 'invoice' ? giftPay.settlementInvoice : giftPay.settlementReturn, { gift_card_money: covered ? fmtFor({}).money(covered) : '' });
}

/** The gift card and card split, when both pay for one amount. */
function splitText(state: PaymentState): string {
  const estimate = state.order.gift_card_estimate;
  if (isSettlement(state) || !hasGiftCards(state) || !estimate?.can_pay) return '';
  const format = fmtFor({});
  return fill(giftPay.split, { gift_card_money: format.money(estimate.gift_card_money), processor_money: format.money(estimate.processor_money) });
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
  const settlement = isSettlement(state);
  // A gift card settlement has no payment form to wait for, so it starts in its resting phase.
  const initial = settlement && ['ready', 'declined', 'pay_remaining', 'total_changed'].includes(phase) ? phase : initialPaymentState(phase);
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
      <p class="status-note" data-payment-settlement role="status" data-testid="ac-settlement-explanation"${attrs({ hidden: !settlement })}>${settlement ? settlementText(data.surface, state) : ''}</p>
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
      <div class="pay-actions js-only" data-pay-actions${needsElements || (settlement && phase !== 'unavailable') ? '' : ' hidden'}>
        <button type="button" class="btn btn-primary btn-pay" id="pay-button" data-testid="ac-pay-button" data-pay-button disabled aria-describedby="pay-blocker">${currentPayLabel(data.surface, state)}</button>
        <p class="pay-blocker" id="pay-blocker" data-pay-blocker data-testid="ac-pay-blocker">${settlement ? '' : pay.loading}</p>
      </div>
    </div>
    ${jsonBlock('payment-boot', boot)}
  </section>`;
}

function giftChallengePanel(): Html {
  return html`<div class="gift-challenge" data-gift-challenge role="group" aria-labelledby="gift-challenge-intro" data-testid="ac-gift-challenge" data-state="none" hidden>
      <p id="gift-challenge-intro" class="gift-challenge-intro" tabindex="-1">${giftPay.challengeIntro}</p>
      <div class="gift-challenge-host skeleton" data-gift-challenge-host data-testid="ac-gift-challenge-host"></div>
      <p class="gift-challenge-status" data-gift-challenge-status role="status" data-testid="ac-gift-challenge-status"></p>
      <p class="field-error" data-gift-challenge-message role="alert" tabindex="-1" data-testid="ac-gift-challenge-message" hidden></p>
      <div class="gift-challenge-actions">
        <button type="button" class="btn btn-secondary" data-gift-challenge-retry data-testid="ac-gift-challenge-retry" hidden>${giftPay.challengeRetry}</button>
        <button type="button" class="btn btn-link" data-gift-challenge-cancel aria-label="${giftPay.challengeCancelLabel}" data-testid="ac-gift-challenge-cancel">${giftPay.challengeCancel}</button>
      </div>
    </div>`;
}

/** What the section says while an apply or remove has an unknown outcome. */
function unconfirmedText(unconfirmed: GiftUnconfirmed): string {
  if (!unconfirmed.can_check) return giftPay.unconfirmedWait;
  if (unconfirmed.kind === 'apply') return giftPay.unconfirmedApply;
  return unconfirmed.last_characters ? fill(giftPay.unconfirmedRemove, { last: unconfirmed.last_characters }) : giftPay.unconfirmedRemoveAny;
}

/**
 * Gift cards on the payment page: apply a code, the verification Flint can ask for, and the cards
 * already applied. Rendered only when the order can take gift cards and the launch is ready.
 */
function giftSection(data: PaymentPageData, state: PaymentState, ctx: RenderContext<PaymentPageData>): Html {
  const unconfirmed = state.gift_unconfirmed ?? null;
  if (data.launch !== 'ready' || (state.order.gift_card_tender_enabled !== true && !unconfirmed)) return html``;
  const editable = state.gift_editable;
  const cards = state.order.gift_cards ?? [];
  if (!editable && cards.length === 0 && !unconfirmed) return html``;
  // An apply can be checked again only with the same code, so the form returns while it can be.
  const showApply = editable || (unconfirmed?.kind === 'apply' && unconfirmed.can_check);
  const endpoints = paymentEndpoints(data.surface, data.resource_id);
  const format = fmtFor(ctx);
  const allocations = new Map((state.order.gift_card_estimate?.gift_cards ?? []).map((card) => [card.gift_card_id, card.amount_money]));
  const split = splitText(state);
  const boot: GiftPayBoot = {
    surface: data.surface,
    resource_id: data.resource_id,
    endpoints: { apply: `${endpoints.page}/gift-card`, challenge: `${endpoints.page}/gift-card/challenge`, page: endpoints.page },
    // The challenge origin only. The frame address arrives with the answer to an Apply.
    challenge: { origin: ctx.giftChallengeOrigin ?? '', slow_after_ms: 60000, max_mounts: 3 },
    copy: browserCopy.giftPay,
  };
  return html`<section class="card card-gift" aria-labelledby="gift-heading" data-gift-pay data-testid="ac-gift-card" data-challenge-state="none">
    <h2 id="gift-heading" tabindex="-1">${giftPay.heading}</h2>
    ${unconfirmed
      ? html`<p id="gift-unconfirmed" class="gift-unconfirmed" data-gift-unconfirmed data-testid="ac-gift-unconfirmed" tabindex="-1">${unconfirmedText(unconfirmed)}</p>`
      : ''}
    ${unconfirmed?.kind === 'remove' && unconfirmed.can_check
      ? postForm(
          { action: `${endpoints.page}/gift-card/${encodeURIComponent(unconfirmed.gift_card_id)}/remove`, csrf: ctx.csrf, className: 'gift-recheck', testid: 'ac-gift-card-recheck-form' },
          html`${hiddenInput('_action_id', crypto.randomUUID())}<button type="submit" class="btn btn-secondary" data-testid="ac-gift-card-recheck" aria-label="${unconfirmed.last_characters ? fill(giftPay.checkAgainLabel, { last: unconfirmed.last_characters }) : giftPay.checkAgain}">${giftPay.checkAgain}</button>`,
        )
      : ''}
    ${showApply
      ? postForm(
          { action: boot.endpoints.apply, csrf: ctx.csrf, className: 'gift-apply js-only', testid: 'ac-gift-card-form', noValidate: true, attributes: { 'data-gift-apply-form': true } },
          html`${field({ name: 'gift_card_code', label: giftPay.codeLabel, autocomplete: 'off', spellcheck: false, testid: 'ac-gift-card-code', sensitive: true, attributes: { autocapitalize: 'characters', ...(unconfirmed ? { 'aria-describedby': 'gift-unconfirmed gift-card-error' } : {}) } })}
            ${button({ label: giftPay.apply, type: 'submit', variant: 'secondary', testid: 'ac-gift-card-apply' })}`,
        )
      : ''}
    <p class="field-error" id="gift-card-error" role="alert" data-gift-error data-testid="ac-gift-card-error" hidden></p>
    <p class="gift-reload" data-gift-reload hidden><a href="${endpoints.page}" data-testid="ac-gift-card-reload">${giftPay.reloadLink}</a></p>
    ${giftChallengePanel()}
    ${cards.length
      ? html`<ul class="rows gift-applied" aria-label="${giftPay.applied}">${cards.map((card, index) => {
          const amount = allocations.get(card.gift_card_id);
          const label = fill(giftPay.ending, { last: card.last_characters });
          return html`<li class="row" data-testid="ac-gift-card-applied-${index + 1}">
            <span class="row-main"><span class="row-title">${label}</span>${amount ? html`<span class="row-meta">${fill(giftPay.amount, { amount: format.money(amount) })}</span>` : ''}</span>
            ${editable
              ? postForm(
                  { action: `${endpoints.page}/gift-card/${encodeURIComponent(card.gift_card_id)}/remove`, csrf: ctx.csrf, className: 'inline-form', testid: `ac-gift-card-remove-${index + 1}` },
                  html`${hiddenInput('_action_id', crypto.randomUUID())}<button type="submit" class="btn btn-link btn-small" aria-label="${fill(giftPay.removeLabel, { last: card.last_characters })}">${giftPay.remove}</button>`,
                )
              : ''}
          </li>`;
        })}</ul>`
      : ''}
    <p class="hint" data-gift-split data-testid="ac-gift-split"${attrs({ hidden: !split })}>${split}</p>
    ${jsonBlock('gift-pay-boot', boot)}
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
  const settlement = Boolean(data.state && isSettlement(data.state));
  const needsModule = Boolean(
    data.state && data.launch === 'ready' && phase && !['unavailable', 'expired', 'succeeded', 'bank_processing'].includes(phase) && (hasPaymentCollection(data.state) || data.state.next !== 'new_payment' || settlement),
  );
  // A settlement runs the payment module without Stripe.js: no payment form is shown.
  const needsStripe = needsModule && !settlement;
  const gift = data.state ? giftSection(data, data.state, ctx) : html``;
  const hasGift = Boolean(
    data.state &&
      data.launch === 'ready' &&
      (data.state.order.gift_card_tender_enabled === true || data.state.gift_unconfirmed) &&
      (data.state.gift_editable || (data.state.order.gift_cards?.length ?? 0) > 0 || data.state.gift_unconfirmed),
  );
  const testid = isInvoice ? 'ac-invoice-pay' : 'ac-return-pay';
  const main = html`${pageHeader(title, { subtitle: data.returned ? pay.returnedHelp : undefined, testid: `${testid}-title` })}
    <div class="pay-layout">
      <div class="pay-main">${gift}${paymentRegion(data, ctx)}</div>
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
    scripts: [...(needsModule ? ['/js/stripe-payment.js'] : []), ...(hasGift ? ['/js/gift-card-pay.js'] : [])],
  });
}

export function invoicePayPage(ctx: RenderContext<PaymentPageData>): Html {
  return payPage(ctx);
}

export function returnPayPage(ctx: RenderContext<PaymentPageData>): Html {
  return payPage(ctx);
}
