import { html, raw } from 'hono/html';
import { copy, fill, message } from '../../copy.ts';
import { csrfField, field, money, noticeList, type Html } from '../components.ts';
import { addressLine, formatDay, formatMoney, isPositive } from '../format.ts';
import { jsonForScript } from '../scrub.ts';
import { shell } from '../layout.ts';
import { amountRows } from './checkout.ts';
import type { CheckoutState, CompleteData, PageContext } from '../types.ts';

export type CompleteState = 'paid' | 'bank_processing' | 'subscription_active' | 'subscription_trialing' | 'confirming' | 'partially_paid';

export function deriveCompleteState(state: CheckoutState): CompleteState {
  if (state.kind === 'subscription') {
    const status = state.subscription?.status;
    if (!status) return 'confirming';
    return status === 'trialing' ? 'subscription_trialing' : 'subscription_active';
  }
  if (state.next === 'bank_processing') return 'bank_processing';
  const paymentStatus = state.order.payment_status;
  if (paymentStatus === 'paid') return 'paid';
  if (paymentStatus === 'partially_paid') return 'partially_paid';
  return 'confirming';
}

/**
 * A $0 trial is paid from creation, so a missing subscription with nothing in flight means the card
 * setup never ran. `next` is `new_payment` only when no attempt is open and none has an unknown outcome.
 */
export function trialSetupNotStarted(state: CheckoutState): boolean {
  return state.kind === 'subscription'
    && !state.order.subscription_id
    && BigInt(state.order.settlement_amounts?.outstanding_money?.amount ?? '1') === 0n
    && state.next === 'new_payment'
    && !['paid', 'partially_paid'].includes(state.session.status ?? '');
}

function accountLink(ctx: PageContext<CompleteData>, state: CheckoutState): Html {
  const origin = ctx.accountOrigin;
  if (!origin) return html``;
  const orderId = state.order.order_id;
  const signedIn = ctx.user !== null;
  const href = ctx.data.accountUrl ?? (signedIn ? `${origin}/orders/${encodeURIComponent(orderId)}` : `${origin}/sign-up?next=${encodeURIComponent(`/orders/${orderId}`)}`);
  return html`<a class="button" href="${href}" data-testid="sf-account-link">${signedIn ? copy.complete.trackOrder : copy.complete.createAccount}</a>`;
}

function itemsList(state: CheckoutState): Html {
  return html`<ul class="summary-lines" role="list" aria-label="${copy.complete.items}">${state.order.line_items.map((line) => html`<li class="summary-line">
    ${line.slug ? html`<img src="/images/${line.slug}.svg" alt="" width="56" height="42">` : ''}
    <span class="summary-line-name">${line.name}<span class="muted">${fill(copy.checkout.quantity, { n: line.quantity })}</span></span>
    <span>${money(line.total_money, formatMoney(line.total_money))}</span>
  </li>`)}</ul>`;
}

function destination(state: CheckoutState): Html {
  const dest = state.order.delivery_destination;
  const choice = state.delivery_selection?.choices?.[0];
  if (choice?.type === 'pickup') {
    const location = choice.pickup?.location;
    return html`<div data-testid="sf-complete-delivery"><h3>${copy.complete.pickupAt}</h3><p>${location?.name ?? choice.name}</p>${location?.address ? html`<p>${addressLine(location.address)}</p>` : ''}${location?.instructions ? html`<p class="muted">${location.instructions}</p>` : ''}</div>`;
  }
  if (!dest?.address) return html``;
  return html`<div data-testid="sf-complete-delivery"><h3>${copy.complete.deliveryTo}</h3>${dest.recipient?.name ? html`<p>${dest.recipient.name}</p>` : ''}<p>${addressLine(dest.address)}</p>${choice?.arrival_estimate ? html`<p class="muted">${fill(copy.checkout.arrives, { earliest: formatDay(choice.arrival_estimate.earliest_date), latest: formatDay(choice.arrival_estimate.latest_date) })}</p>` : ''}</div>`;
}

/** Says when no card paid: gift cards or discounts covered the order. */
function paymentLine(state: CheckoutState): Html {
  const total = state.order.pricing_amounts?.total_money ?? null;
  const gift = (state.order.gift_card_settlements ?? []).reduce((sum, item) => sum + BigInt(item.amount_money?.amount ?? '0'), 0n);
  const totalMinor = total ? BigInt(total.amount) : null;
  let text = '';
  if (gift > 0n && totalMinor !== null && gift >= totalMinor) text = copy.complete.paidWithGiftCard;
  else if (totalMinor === 0n) text = copy.complete.coveredByDiscounts;
  return text ? html`<p class="summary-row" data-testid="sf-complete-payment-method"><span>${text}</span></p>` : html``;
}

function receiptForm(ctx: PageContext<CompleteData>, state: CheckoutState): Html {
  return html`<form method="post" action="/checkout/${encodeURIComponent(state.checkout_ref)}/receipt" data-receipt-form class="stack">
    ${csrfField(ctx)}
    <p class="hint">${copy.complete.receiptHint}</p>
    <div class="actions"><button class="button" type="submit" data-testid="sf-send-receipt">${copy.complete.emailReceipt}</button></div>
    <p class="receipt-status" role="status" data-receipt-status data-testid="sf-receipt-status"></p>
  </form>`;
}

/**
 * Confirms a card the buyer chose to save at checkout. Flint keeps it pending until a code sent after
 * payment is entered here. Only a card saved with a phone number reaches this state, so nothing shows
 * for signed-in buyers, buyers the merchant named, or buyers who saved no phone.
 */
export function saveCardPanel(ctx: PageContext<CompleteData>, state: CheckoutState): Html {
  const save = state.session.payment_method_save;
  if (!save) return html``;
  const ref = encodeURIComponent(state.checkout_ref);
  const heading = html`<h3 id="save-card-title">${copy.complete.saveCardHeading}</h3>`;
  const wrap = (status: string, body: Html, extra: Html = html``): Html =>
    html`<section class="stack" aria-labelledby="save-card-title" data-save-card data-status="${status}" data-checkout-ref="${state.checkout_ref}" ${extra} data-testid="sf-save-confirm">${heading}${body}</section>`;
  if (save.status === 'saved') {
    const text = save.saved_with === 'email' ? copy.complete.saveCardSavedEmail : copy.complete.saveCardSavedText;
    return wrap('saved', html`<p role="status" data-testid="sf-save-confirm-saved">${text}</p>`);
  }
  if (save.status === 'expired') return wrap('expired', html`<p data-testid="sf-save-confirm-expired">${copy.complete.saveCardExpired}</p>`);
  if (save.status !== 'pending') return html``;

  const v = state.verification;
  const sent = v?.status === 'code_sent' && v.purpose === 'confirm_saved_payment_method';
  const emailOnly = save.email_confirmation_required;
  const status = html`<p class="receipt-status" role="status" data-save-card-status data-testid="sf-save-confirm-status"></p>`;
  if (!sent) {
    return wrap('pending', html`
      <p class="hint">${emailOnly ? copy.complete.saveCardEmailStep : copy.complete.saveCardIntro}</p>
      <div class="actions">
        ${emailOnly
          ? html`<button class="button" type="button" data-save-send="email" data-testid="sf-save-confirm-email">${copy.complete.saveCardSendEmail}</button>`
          : html`<button class="button" type="button" data-save-send="sms" data-testid="sf-save-confirm-text">${copy.complete.saveCardSendText}</button>
            <button class="button button-quiet" type="button" data-save-send="email" data-testid="sf-save-confirm-email">${copy.complete.saveCardEmailInstead}</button>`}
      </div>
      ${status}`, emailOnly ? html`` : html`data-auto-send="sms"`);
  }
  const bySms = v.delivery_channel === 'sms';
  const prompt = bySms ? message('returning_code_sms', { digits: v.phone_last_digits ?? save.phone_last_digits }) : message('returning_code_email', { email: v.masked_email });
  return wrap('code_sent', html`
    <form method="post" action="/checkout/${ref}/verification/confirm" data-save-card-form novalidate data-testid="sf-save-confirm-form">
      ${csrfField(ctx)}
      <p id="save-card-prompt">${prompt}</p>
      ${field({ id: 'save-card-code', name: 'code', label: copy.complete.saveCardCode, required: true, autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: 6, testid: 'sf-save-confirm-code', sensitive: true })}
      <div class="actions">
        <button class="button" type="submit" data-testid="sf-save-confirm-confirm">${copy.complete.saveCardConfirm}</button>
        <button class="button button-quiet" type="button" data-save-send="${bySms ? 'sms' : 'email'}" data-testid="sf-save-confirm-resend">${copy.complete.saveCardResend}</button>
        ${bySms && !emailOnly ? html`<button class="button button-quiet" type="button" data-save-send="email" data-testid="sf-save-confirm-email">${copy.complete.saveCardEmailInstead}</button>` : ''}
      </div>
    </form>
    ${status}`);
}

function subscriptionBody(ctx: PageContext<CompleteData>, state: CheckoutState, trialing: boolean): Html {
  const sub = state.subscription!;
  const plan = sub.subscription_plan?.name ?? state.session.subscription_terms?.plan_name ?? state.order.subscription_plan?.name ?? '';
  const card = sub.payment_method?.card;
  const next = sub.next_billing_at ?? sub.trial_end;
  const statusText = sub.status === 'trialing' ? copy.complete.statusTrialing : sub.status === 'active' ? copy.complete.statusActive : fill(copy.complete.statusOther, { status: sub.status.replace(/_/g, ' ') });
  return html`<dl class="facts">
    <div><dt>${copy.complete.plan}</dt><dd>${plan}</dd></div>
    <div><dt>${copy.complete.status}</dt><dd data-testid="sf-subscription-status" data-status="${sub.status}">${statusText}</dd></div>
    ${trialing
      ? html`<div><dt>${copy.complete.trialEnds}</dt><dd>${formatDay(sub.trial_end, true)}</dd></div>
        <div><dt>${copy.complete.firstCharge}</dt><dd>${money(sub.recurring_amount_money ?? null, formatMoney(sub.recurring_amount_money))}${sub.next_billing_at ? html` on ${formatDay(sub.next_billing_at, true)}` : ''}</dd></div>`
      : html`<div><dt>${copy.complete.nextCharge}</dt><dd>${next ? html`${money(sub.recurring_amount_money ?? null, formatMoney(sub.recurring_amount_money))} on ${formatDay(next, true)}` : ''}</dd></div>`}
    ${card ? html`<div><dt>${copy.complete.paymentMethod}</dt><dd>${fill(copy.complete.cardEnding, { brand: card.brand.charAt(0).toUpperCase() + card.brand.slice(1), last4: card.last4 })}</dd></div>` : ''}
  </dl>
  ${ctx.accountOrigin ? html`<p><a class="button" href="${ctx.accountOrigin}/subscriptions/${encodeURIComponent(sub.subscription_id)}" data-testid="sf-account-link">${copy.complete.manage}</a></p>` : ''}`;
}

export function completePage(ctx: PageContext<CompleteData>): Html {
  const state = ctx.data.state;
  const view = deriveCompleteState(state);
  const orderNumber = state.order.order_number;
  const paid = state.order.settlement_amounts?.paid_money ?? null;
  const outstanding = state.order.settlement_amounts?.outstanding_money ?? null;
  const heading =
    view === 'paid' ? copy.complete.paidTitle
    : view === 'bank_processing' ? copy.complete.bankTitle
    : view === 'subscription_active' ? copy.complete.activeTitle
    : view === 'subscription_trialing' ? copy.complete.trialTitle
    : view === 'partially_paid' ? copy.complete.partialTitle
    : copy.complete.confirmingTitle;
  const body =
    view === 'confirming'
      ? html`<div class="state-panel" data-region="complete" data-poll data-poll-interval="2000" data-poll-max="60000">
          <p role="status">${state.kind === 'subscription' ? copy.complete.subscriptionPending : copy.complete.confirmingBody}</p>
          <a class="button" href="/checkout/${encodeURIComponent(state.checkout_ref)}/complete" data-check-again data-testid="sf-check-again">${copy.complete.checkAgain}</a>
        </div>`
      : view === 'bank_processing'
        ? html`<div class="state-panel" data-region="complete"><p>${copy.complete.bankBody}</p>${orderNumber ? html`<p>${copy.complete.orderNumber} <strong data-testid="sf-complete-order-number">${orderNumber}</strong></p>` : ''}${itemsList(state)}${accountLink(ctx, state)}</div>`
        : view === 'partially_paid'
          ? html`<div class="state-panel" data-region="complete"><p>${fill(copy.complete.partialBody, { paid: formatMoney(paid), remaining: formatMoney(outstanding) })}</p><p>${fill(copy.complete.partialSupport, { store: ctx.storeName })}</p>${orderNumber ? html`<p>${copy.complete.orderNumber} <strong data-testid="sf-complete-order-number">${orderNumber}</strong></p>` : ''}${support(state)}</div>`
          : view === 'subscription_active' || view === 'subscription_trialing'
            ? html`<div data-region="complete">${subscriptionBody(ctx, state, view === 'subscription_trialing')}</div>`
            : html`<div data-region="complete" class="complete-grid">
              <div class="stack">
                ${orderNumber ? html`<p>${copy.complete.orderNumber} <strong data-testid="sf-complete-order-number">${orderNumber}</strong></p>` : ''}
                ${itemsList(state)}
                ${destination(state)}
              </div>
              <div class="stack">
                <h3>${copy.complete.amounts}</h3>
                ${amountRows(state)}
                ${paymentLine(state)}
                ${paid && isPositive(paid) ? html`<p class="summary-row summary-strong"><span>${copy.complete.paidAmount}</span> ${money(paid, formatMoney(paid))}</p>` : ''}
                ${ctx.data.paidSignal ? html`<p class="hint" data-testid="sf-paid-signal">${copy.complete.flintSignal}</p>` : ''}
                ${saveCardPanel(ctx, state)}
                ${receiptForm(ctx, state)}
                ${accountLink(ctx, state)}
                <p><a class="button-link" href="/">${copy.complete.continueShopping}</a></p>
              </div>
            </div>`;
  const main = html`
    ${noticeList(ctx, { store: ctx.storeName })}
    <section class="stack" aria-labelledby="complete-title">
      <h1 id="complete-title" tabindex="-1" data-testid="sf-complete-status" data-status="${view}">${heading}</h1>
      ${body}
    </section>`;
  const email = state.order.buyer_contact?.email ?? '';
  const strings = {
    receipt_sent: email ? fill(message('receipt_sent'), { email }) : 'We emailed your receipt.',
    receipt_recently_sent: message('receipt_recently_sent'),
    order_receipt_recipient_limit_reached: message('order_receipt_recipient_limit_reached'),
    generic_error: message('generic_error'),
    network_error: message('network_error'),
    still_confirming: message('still_confirming'),
    rate_limited: message('customer_verification_rate_limited'),
    code_invalid: message('save_card_code_invalid'),
    text_unavailable: message('customer_verification_text_unavailable'),
    email_unavailable: message('payment_method_save_email_unavailable'),
    not_ready: message('payment_method_save_not_ready'),
  };
  const withData = html`${main}<script type="application/json" id="complete-messages">${raw(jsonForScript(strings))}</script>`;
  return shell(ctx, { pageId: 'sf-complete', title: heading, main: withData, testid: 'sf-complete', state: view, scripts: ['/js/complete.js'] });
}

function support(state: CheckoutState): Html {
  const s = state.session.merchant_support;
  if (!s?.email && !s?.phone) return html``;
  return html`<p>${s?.email ? html`<a href="mailto:${s.email}">${s.email}</a>` : ''} ${s?.phone ?? ''}</p>`;
}
