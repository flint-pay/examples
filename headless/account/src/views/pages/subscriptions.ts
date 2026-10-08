import { html } from 'hono/html';
import { common, fill, plural, subscriptions as subs } from '../../copy.ts';
import {
  attrs,
  badge,
  button,
  card,
  checkboxField,
  dialog,
  dialogTrigger,
  emptyState,
  errorSummary,
  fmtFor,
  hiddenInput,
  linkButton,
  money,
  pageHeader,
  paginationLinks,
  postForm,
  sectionError,
  selectField,
  textareaField,
  timeEl,
  type Html,
} from '../components.ts';
import { path } from '../format.ts';
import { renderDocument } from '../layout.ts';
import type { BuyerAction, BuyerCapabilities, PaymentMethod, RenderContext, Subscription, SubscriptionData, SubscriptionsData } from '../types.ts';
import { availableAction, cardLabel, findAction, intervalLabel, orderNumberLabel, orderStatusView, statusBadge, subscriptionName, subscriptionStatusView } from './shared.ts';

export function subscriptionsPage(ctx: RenderContext<SubscriptionsData>): Html {
  const { subscriptions, page_token } = ctx.data;
  const fmt = fmtFor(ctx);
  let body: Html;
  if (subscriptions.status === 'error') {
    body = sectionError('your subscriptions', subscriptions.error, '/subscriptions', 'ac-subscriptions-error');
  } else if (!subscriptions.value.items.length) {
    body = emptyState(
      subs.empty,
      ctx.storefrontOrigin ? linkButton(`${ctx.storefrontOrigin.replace(/\/$/, '')}/#coffee-club`, subs.coffeeClub, { variant: 'primary', testid: 'ac-subscriptions-join' }) : undefined,
      'ac-subscriptions-empty',
    );
  } else {
    body = html`<table class="table responsive-table" data-state="loaded">
        <caption class="sr-only">${subs.title}</caption>
        <thead><tr><th scope="col">${subs.plan}</th><th scope="col">${subs.status}</th><th scope="col">${subs.nextCharge}</th></tr></thead>
        <tbody>${subscriptions.value.items.map((subscription) => {
          const status = subscriptionStatusView(subscription);
          return html`<tr data-testid="ac-subscription-row-${subscription.subscription_id}">
            <th scope="row" data-label="${subs.plan}"><a href="${path('/subscriptions', subscription.subscription_id)}">${subscriptionName(subscription)}</a></th>
            <td data-label="${subs.status}">${badge(status.label, status.tone, { 'data-state': status.state })}</td>
            <td data-label="${subs.nextCharge}">${
              subscription.next_billing_at && subscription.status !== 'canceled'
                ? fill(subs.nextChargeOn, { amount: fmt.money(subscription.recurring_amount_money), date: fmt.date(subscription.next_billing_at) })
                : subs.noNextCharge
            }</td>
          </tr>`;
        })}</tbody>
      </table>
      ${paginationLinks({ basePath: '/subscriptions', pageToken: page_token, nextPageToken: subscriptions.value.next_page_token, testid: 'ac-subscriptions', newerLabel: 'Newest subscriptions', olderLabel: 'Older subscriptions' })}`;
  }
  const main = html`${pageHeader(subs.title, { testid: 'ac-subscriptions-title' })}${card(body, { testid: 'ac-subscriptions-list' })}`;
  return renderDocument(ctx, { pageId: 'ac-subscriptions', title: subs.title, testid: 'ac-subscriptions', main, nav: 'subscriptions' });
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

const ACTION_ORDER = ['cancel', 'pause', 'resume', 'reactivate', 'update_payment_method', 'retry_payment'] as const;
type ActionKind = (typeof ACTION_ORDER)[number];

function endDate(subscription: Subscription): string | undefined {
  return subscription.current_period_end ?? subscription.next_billing_at;
}

/** The action that gets the primary style: required first, else the first available non-cancel action. */
export function primaryAction(actions: BuyerAction[]): ActionKind | null {
  const available = ACTION_ORDER.filter((kind) => availableAction(actions, kind));
  const required = available.find((kind) => findAction(actions, kind)?.is_required);
  if (required) return required;
  return available.find((kind) => kind !== 'cancel') ?? null;
}

function retryRegion(subscription: Subscription, retry: SubscriptionData['retry']): Html {
  if (!retry) {
    // Hidden until the buyer starts a retry. The page script shows it as "starting" on submit.
    return html`<div class="status-note" data-testid="ac-retry-status" data-state="idle" role="status" hidden data-starting-text="${subs.retryStarting}"><p data-retry-text></p></div>`;
  }
  const pending = retry.status === 'pending' || retry.status === 'processing';
  const state = pending ? 'in_progress' : retry.status === 'succeeded' ? 'succeeded' : 'failed';
  const message =
    state === 'in_progress'
      ? subs.retryInProgress
      : state === 'succeeded'
        ? subs.retrySucceeded
        : retry.failure?.message
          ? fill(subs.retryFailed, { message: retry.failure.message })
          : subs.retryFailedNoMessage;
  return html`<div class="${state === 'failed' ? 'alert alert-error' : state === 'succeeded' ? 'notice notice-info' : 'status-note'}" role="${state === 'failed' ? 'alert' : 'status'}" data-testid="ac-retry-status" data-state="${state}"${attrs({
    'data-retry-poll': pending ? 'true' : undefined,
    'data-poll-url': pending ? `${path('/subscriptions', subscription.subscription_id)}/retries/${encodeURIComponent(retry.subscription_payment_retry_id)}` : undefined,
    'data-still-working': subs.retryStillWorking,
  })}><p data-retry-text>${message}</p></div>`;
}

function cancelDialog(subscription: Subscription, capabilities: BuyerCapabilities | null, data: SubscriptionData, ctx: RenderContext): Html {
  const fmt = fmtFor(ctx);
  const base = path('/subscriptions', subscription.subscription_id);
  const errors = ctx.error?.field_errors;
  const values = data.values ?? {};
  const timing = capabilities?.cancellation_timing === 'buyer_chooses' ? 'buyer_chooses' : 'end_of_period';
  const date = endDate(subscription);
  const dateText = date ? fmt.date(date) : '';
  const reasons = capabilities?.cancellation_reasons ?? [];
  const pauseOffer =
    capabilities?.retention_offer?.kind === 'pause_instead' && capabilities.retention_offer.pause_cycles && availableAction(subscription.buyer_actions, 'pause')
      ? capabilities.retention_offer.pause_cycles
      : null;
  const periodCopy = dateText ? fill(subs.cancelConfirmPeriod, { date: dateText }) : subs.cancelConfirmPeriodNoDate;
  const choice = values.cancel_when === 'now' ? 'now' : 'period_end';

  return dialog({
    id: 'cancel-dialog',
    title: subs.cancelTitle,
    testid: 'ac-cancel-dialog',
    openOnLoad: data.dialog === 'cancel',
    children: html`
      ${
        pauseOffer
          ? postForm(
              { action: `${base}/pause`, csrf: ctx.csrf, className: 'offer-form' },
              html`${hiddenInput('cycles', String(pauseOffer))}<p class="offer">${button({ label: fill(subs.pauseInstead, { cycles: pauseOffer, periods: plural(pauseOffer, 'period', 'periods') }), type: 'submit', variant: 'secondary', testid: 'ac-retention-pause' })}</p>`,
            )
          : ''
      }
      ${postForm(
        { action: `${base}/cancel`, csrf: ctx.csrf, attributes: { 'data-cancel-form': 'true' } },
        html`
          ${
            timing === 'buyer_chooses'
              ? html`<fieldset class="choice-group"><legend>${subs.cancelWhen}</legend>
                  <div class="field field-check"><input type="radio" id="cancel-when-period" name="cancel_when" value="period_end"${attrs({ checked: choice === 'period_end' })} data-testid="ac-cancel-period"><label for="cancel-when-period">${dateText ? fill(subs.cancelAtPeriodEnd, { date: dateText }) : subs.cancelAtPeriodEndNoDate}</label></div>
                  <div class="field field-check"><input type="radio" id="cancel-when-now" name="cancel_when" value="now"${attrs({ checked: choice === 'now' })} data-testid="ac-cancel-now"><label for="cancel-when-now">${subs.cancelNow}</label></div>
                </fieldset>`
              : html`${hiddenInput('cancel_when', 'period_end')}<p data-testid="ac-cancel-ends">${dateText ? fill(subs.cancelEndsOn, { date: dateText }) : subs.cancelEndsPeriod}</p>`
          }
          ${
            reasons.length
              ? selectField({
                  name: 'reason',
                  label: subs.cancelReason,
                  placeholder: subs.cancelReasonPlaceholder,
                  required: true,
                  value: values.reason ?? '',
                  options: reasons.map((code) => ({ value: code, label: subs.cancellationReasons[code] ?? code })),
                  testid: 'ac-cancel-reason',
                  errors,
                })
              : ''
          }
          ${textareaField({ name: 'comment', label: subs.cancelComment, value: values.comment ?? '', rows: 3, maxlength: 500, testid: 'ac-cancel-comment', errors })}
          <p class="confirm-copy" data-confirm-copy="period_end"${attrs({ hidden: timing === 'buyer_chooses' && choice === 'now' })}>${periodCopy}</p>
          ${timing === 'buyer_chooses' ? html`<p class="confirm-copy" data-confirm-copy="now"${attrs({ hidden: choice !== 'now' })}>${subs.cancelConfirmNow}</p>` : ''}
          <div class="dialog-actions">
            <button type="button" class="btn btn-secondary" data-dialog-close>${subs.cancelKeep}</button>
            ${button({ label: subs.cancelSubmit, type: 'submit', variant: 'danger', testid: 'ac-cancel-confirm' })}
          </div>`,
      )}`,
  });
}

function pauseDialog(subscription: Subscription, capabilities: BuyerCapabilities | null, data: SubscriptionData, ctx: RenderContext): Html {
  const base = path('/subscriptions', subscription.subscription_id);
  const errors = ctx.error?.field_errors;
  const max = capabilities?.pause?.max_cycles;
  const limit = max && max > 0 ? max : 12;
  const options = Array.from({ length: limit }, (_, i) => ({
    value: String(i + 1),
    label: fill(subs.pauseCyclesOption, { cycles: i + 1, periods: plural(i + 1, 'period', 'periods') }),
  }));
  return dialog({
    id: 'pause-dialog',
    title: subs.pauseTitle,
    testid: 'ac-pause-dialog',
    openOnLoad: data.dialog === 'pause',
    children: postForm(
      { action: `${base}/pause`, csrf: ctx.csrf },
      html`<p class="hint">${subs.pauseHint}</p>
        ${selectField({ name: 'cycles', label: subs.pauseCycles, options, value: data.values?.cycles ?? '', placeholder: max ? subs.pausePlaceholder : 'Until I resume', required: Boolean(max), testid: 'ac-pause-cycles', errors })}
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-dialog-close>${common.cancel}</button>
          ${button({ label: subs.pauseSubmit, type: 'submit', variant: 'primary', testid: 'ac-pause-confirm' })}
        </div>`,
    ),
  });
}

function methodDialog(subscription: Subscription, methods: SubscriptionData['payment_methods'], data: SubscriptionData, ctx: RenderContext): Html {
  const base = path('/subscriptions', subscription.subscription_id);
  const errors = ctx.error?.field_errors;
  const currentId = subscription.payment_method?.payment_method_id;
  const addHref = `/payment-methods/new?return_to=${encodeURIComponent(base)}`;
  const selected = data.values?.payment_method_id ?? currentId ?? '';
  let list: Html;
  if (methods.status === 'error') {
    list = sectionError('your cards', methods.error, base, 'ac-method-error');
  } else {
    const usable = methods.value.filter((m: PaymentMethod) => m.status === 'active');
    list = usable.length
      ? html`<fieldset class="choice-group"><legend>${subs.methodIntro}</legend>
          ${usable.map((method, index) => {
            const ok = method.usage === 'off_session';
            const id = `method-${index}`;
            return html`<div class="field field-check" data-testid="ac-method-option-${method.payment_method_id}">
              <input type="radio" id="${id}" name="payment_method_id" value="${method.payment_method_id}"${attrs({ checked: ok && selected === method.payment_method_id, disabled: !ok, required: ok })}>
              <label for="${id}">${cardLabel(method.card)}${method.payment_method_id === currentId ? html` <span class="muted">(${subs.methodCurrent})</span>` : ''}${!ok ? html`<span class="hint"> ${subs.methodNotUsable}</span>` : ''}</label>
            </div>`;
          })}
        </fieldset>`
      : html`<p class="muted">${subs.methodNone}</p>`;
  }
  return dialog({
    id: 'method-dialog',
    title: subs.methodTitle,
    testid: 'ac-method-dialog',
    openOnLoad: data.dialog === 'payment_method',
    children: postForm(
      { action: `${base}/payment-method`, csrf: ctx.csrf },
      html`${errors?.payment_method_id ? html`<p class="field-error" data-testid="field-error-payment_method_id">${subs.methodNotUsable}</p>` : ''}
        ${list}
        <p><a href="${addHref}" data-testid="ac-method-add">${subs.methodAdd}</a></p>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-dialog-close>${common.cancel}</button>
          ${button({ label: subs.methodSubmit, type: 'submit', variant: 'primary', testid: 'ac-method-confirm' })}
        </div>`,
    ),
  });
}

export function subscriptionPage(ctx: RenderContext<SubscriptionData>): Html {
  const data = ctx.data;
  const subscription = data.subscription;
  const capabilities = data.capabilities;
  const fmt = fmtFor(ctx);
  const base = path('/subscriptions', subscription.subscription_id);
  const status = subscriptionStatusView(subscription);
  const primary = primaryAction(subscription.buyer_actions);
  const endsOn = endDate(subscription);
  const name = subscriptionName(subscription);

  const controls: Html[] = [];
  const dialogs: Html[] = [];
  for (const kind of ACTION_ORDER) {
    const action = findAction(subscription.buyer_actions, kind);
    if (!action) continue;
    const variant = kind === primary ? 'primary' : kind === 'cancel' ? 'danger' : 'secondary';
    const label = subs.actionLabels[kind] ?? kind;
    const testid = `ac-sub-action-${kind}`;
    if (!action.is_available) {
      if (kind === 'pause' && action.unavailable_reason === 'store_policy') {
        controls.push(html`<div class="action-disabled" data-testid="${testid}" data-state="unavailable"><button type="button" class="btn btn-secondary" disabled aria-describedby="pause-unavailable">${label}</button><p class="hint" id="pause-unavailable">${subs.unavailableStorePolicy}</p></div>`);
      }
      continue;
    }
    switch (kind) {
      case 'cancel':
        controls.push(dialogTrigger('cancel-dialog', label, { variant, testid }));
        dialogs.push(cancelDialog(subscription, capabilities, data, ctx));
        break;
      case 'pause':
        controls.push(dialogTrigger('pause-dialog', label, { variant, testid }));
        dialogs.push(pauseDialog(subscription, capabilities, data, ctx));
        break;
      case 'update_payment_method':
        controls.push(dialogTrigger('method-dialog', label, { variant, testid }));
        dialogs.push(methodDialog(subscription, data.payment_methods, data, ctx));
        break;
      default:
        controls.push(
          postForm(
            { action: `${base}/${kind === 'retry_payment' ? 'retry' : kind}`, csrf: ctx.csrf, className: 'inline-form', attributes: { 'data-retry-form': kind === 'retry_payment' ? 'true' : undefined } },
            button({ label, type: 'submit', variant, testid }),
          ),
        );
    }
  }

  const history =
    data.billing_history.status === 'error'
      ? sectionError('billing history', data.billing_history.error, base, 'ac-subscription-history-error')
      : data.billing_history.value.items.length
        ? html`<ul class="rows" data-testid="ac-subscription-history">${data.billing_history.value.items.map(
            (order) => html`<li class="row"><a class="row-link" href="${path('/orders', order.order_id)}"><span class="row-title">${fmt.date(order.created_at)}</span><span class="row-meta">${statusBadge(orderStatusView(order))} ${orderNumberLabel(order)}</span></a><span class="row-end">${money(order.pricing_amounts.total_money)}</span></li>`,
          )}</ul>`
        : html`<p class="muted">${subs.billingHistoryEmpty}</p>`;

  const methodText = subscription.payment_method?.card ? cardLabel(subscription.payment_method.card) : subs.noPaymentMethod;
  const nextCharge =
    subscription.status !== 'canceled' && subscription.next_billing_at && !subscription.cancel_at_period_end
      ? fill(subs.nextChargeOn, { amount: fmt.money(subscription.recurring_amount_money), date: fmt.date(subscription.next_billing_at) })
      : subs.noNextCharge;
  const interval = intervalLabel(subscription.billing_interval_count ?? subscription.subscription_plan?.billing_interval_count, subscription.billing_interval ?? subscription.subscription_plan?.billing_interval);

  const main = html`${pageHeader(name, { testid: 'ac-subscription-title' })}
    ${ctx.error ? html`<div data-state="action_error" data-testid="ac-subscription-action-error">${errorSummary(ctx.error, { reason: subs.cancelReason, cycles: subs.pauseCycles, payment_method_id: subs.methodTitle })}</div>` : ''}
    <div class="status-line">
      ${badge(status.label, status.tone, { 'data-state': status.state, 'data-testid': 'ac-subscription-status' })}
      ${subscription.cancel_at_period_end ? badge('Ends ' + fmt.date(endsOn), 'warn', { 'data-testid': 'ac-subscription-ending' }) : ''}
    </div>
    ${subscription.status === 'past_due' ? html`<div class="alert alert-warn" role="status" data-state="past_due" data-testid="ac-subscription-past-due"><p class="alert-title">${subs.pastDue}</p></div>` : ''}
    ${subscription.cancel_at_period_end && endsOn ? html`<div class="notice notice-warn" data-testid="ac-subscription-scheduled-cancel"><p>${fill(subs.scheduledCancel, { date: fmt.date(endsOn) })}</p></div>` : ''}
    ${subscription.status === 'paused' ? html`<div class="notice notice-info" data-testid="ac-subscription-paused"><p>${subs.pausedNotice}</p></div>` : ''}
    ${subscription.status === 'trialing' && subscription.trial_end ? html`<div class="notice notice-info"><p>${fill(subs.trialEnds, { date: fmt.date(subscription.trial_end) })}</p></div>` : ''}
    ${retryRegion(subscription, data.retry)}
    ${card(
      html`<h2 id="sub-details">${name}</h2>
        <dl class="facts">
          <div class="fact"><dt>${subs.status}</dt><dd>${status.label}</dd></div>
          <div class="fact"><dt>${subs.nextCharge}</dt><dd data-testid="ac-subscription-next">${nextCharge}</dd></div>
          ${interval ? html`<div class="fact"><dt>Billing</dt><dd>${interval}</dd></div>` : ''}
          <div class="fact"><dt>${subs.paymentMethod}</dt><dd data-testid="ac-subscription-method">${methodText}</dd></div>
        </dl>
        ${subscription.line_items?.length ? html`<h3>${subs.items}</h3><ul class="lines">${subscription.line_items.map((item) => html`<li class="line"><div class="line-main"><span class="line-name">${item.name}</span><span class="line-meta">Quantity ${item.quantity}</span></div><span class="line-total">${money(item.subtotal_money)}</span></li>`)}</ul>` : ''}`,
      { labelledBy: 'sub-details', testid: 'ac-subscription-details' },
    )}
    ${controls.length ? card(html`<h2 id="sub-actions">${subs.actions}</h2><div class="actions-row" data-testid="ac-subscription-actions">${controls}</div>`, { labelledBy: 'sub-actions' }) : ''}
    ${card(html`<h2 id="sub-history">${subs.billingHistory}</h2>${history}`, { labelledBy: 'sub-history', testid: 'ac-subscription-billing' })}
    ${dialogs}`;
  void timeEl;
  void checkboxField;
  return renderDocument(ctx, {
    pageId: 'ac-subscription',
    title: name,
    testid: 'ac-subscription',
    main,
    nav: 'subscriptions',
    scripts: ['/js/subscription.js'],
  });
}
