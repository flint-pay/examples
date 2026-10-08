import { html } from 'hono/html';
import { common, fill, order as orderCopy, orders as ordersCopy, paymentStatus, paymentTypes, returnStart, trackingStatus } from '../../copy.ts';
import {
  button,
  card,
  checkboxField,
  emptyState,
  errorSummary,
  externalLink,
  fmtFor,
  hiddenInput,
  linkButton,
  money,
  pageHeader,
  paginationLinks,
  postForm,
  sectionError,
  selectField,
  supportContact,
  textareaField,
  timeEl,
  type Html,
} from '../components.ts';
import { countOf, isZero, path, safeExternalUrl } from '../format.ts';
import { renderDocument } from '../layout.ts';
import type {
  BuyerFulfillmentEvent,
  Fulfillment,
  Loaded,
  Order,
  OrderData,
  OrderReceiptData,
  OrdersData,
  PaymentIntent,
  RenderContext,
  ReturnStartData,
} from '../types.ts';
import {
  addressBlock,
  amountRows,
  availableAction,
  findAction,
  lineItems,
  orderNumberLabel,
  orderStatusView,
  cardName,
  statusBadge,
} from './shared.ts';

export function ordersPage(ctx: RenderContext<OrdersData>): Html {
  const fmt = fmtFor(ctx);
  const { orders, page_token } = ctx.data;
  let body: Html;
  if (orders.status === 'error') {
    body = sectionError('your orders', orders.error, '/orders', 'ac-orders-error');
  } else if (!orders.value.items.length) {
    body = emptyState(ordersCopy.empty, linkButton('/link-purchases', ordersCopy.findGuest, { testid: 'ac-orders-find-guest' }), 'ac-orders-empty');
  } else {
    body = html`<table class="table responsive-table" data-state="loaded">
        <caption class="sr-only">${ordersCopy.title}</caption>
        <thead><tr>
          <th scope="col">${ordersCopy.columns.order}</th>
          <th scope="col">${ordersCopy.columns.date}</th>
          <th scope="col">${ordersCopy.columns.status}</th>
          <th scope="col" class="num">${ordersCopy.columns.total}</th>
        </tr></thead>
        <tbody>${orders.value.items.map(
          (order) => html`<tr data-testid="ac-order-row-${order.order_id}">
            <th scope="row" data-label="${ordersCopy.columns.order}"><a href="${path('/orders', order.order_id)}">${fill(ordersCopy.orderNumber, { number: orderNumberLabel(order) })}</a></th>
            <td data-label="${ordersCopy.columns.date}">${timeEl(order.created_at, ctx)}</td>
            <td data-label="${ordersCopy.columns.status}">${statusBadge(orderStatusView(order))}</td>
            <td data-label="${ordersCopy.columns.total}" class="num">${money(order.pricing_amounts.total_money)}</td>
          </tr>`,
        )}</tbody>
      </table>
      ${paginationLinks({ basePath: '/orders', pageToken: page_token, nextPageToken: orders.value.next_page_token, testid: 'ac-orders' })}`;
  }
  void fmt;
  const main = html`${pageHeader(ordersCopy.title, { testid: 'ac-orders-title' })}${card(body, { testid: 'ac-orders-list' })}`;
  return renderDocument(ctx, { pageId: 'ac-orders', title: ordersCopy.title, testid: 'ac-orders', main, nav: 'orders' });
}

// ---------------------------------------------------------------------------
// Order detail
// ---------------------------------------------------------------------------

/** Names how a payment was made. Uses payment_source when present, else selected_payment_option. */
export function paymentMethodLabel(payment: Partial<Pick<PaymentIntent, 'payment_source' | 'selected_payment_option'>>): string {
  const source = payment.payment_source;
  if (source?.type === 'card' && source.card?.last4) {
    return cardName({ brand: source.card.brand ?? 'card', last4: source.card.last4, exp_month: 0, exp_year: 0 });
  }
  if (source?.type === 'ach_debit' && source.ach_debit?.last4) return `${paymentTypes.ach_debit} ending ${source.ach_debit.last4}`;
  const kind = source?.type ?? payment.selected_payment_option;
  return (kind && Object.hasOwn(paymentTypes, kind) ? (paymentTypes as Record<string, string>)[kind] : undefined) ?? paymentTypes.unknown;
}

function paymentStatusWord(status: string): string {
  return (paymentStatus as Record<string, string>)[status] ?? paymentStatus.unknown;
}

export function hasProcessingPayment(payments: Loaded<PaymentIntent[]>): boolean {
  return payments.status === 'ok' && payments.value.some((payment) => payment.status === 'processing');
}

function paymentSection(order: Order, payments: Loaded<PaymentIntent[]>, ctx: RenderContext): Html {
  if (payments.status === 'error') return sectionError('your payments', payments.error, path('/orders', order.order_id), 'ac-order-payments-error');
  if (!payments.value.length) return html`<p class="muted" data-state="empty">${orderCopy.paymentNone}</p>`;
  return html`<ul class="rows" data-testid="ac-order-payments">${payments.value.map(
    (payment) => html`<li class="row" data-testid="ac-payment-${payment.payment_intent_id}" data-state="${payment.status}">
      <span class="row-title">${fill(orderCopy.paymentLine, { method: paymentMethodLabel(payment), status: paymentStatusWord(payment.status) })}</span>
      <span class="row-end">${money(payment.amount_money)}${payment.created_at ? html` <span class="muted">${timeEl(payment.created_at, ctx)}</span>` : ''}</span>
    </li>`,
  )}</ul>`;
}

function refundSection(order: Order, refunds: OrderData['refunds'], ctx: RenderContext): Html {
  if (refunds.status === 'error') return sectionError('your refunds', refunds.error, path('/orders', order.order_id), 'ac-order-refunds-error');
  if (!refunds.value.length) return html``;
  const fmt = fmtFor(ctx);
  return card(
    html`<h2 id="refunds-title">${orderCopy.refunds}</h2><ul class="rows" data-testid="ac-order-refunds">${refunds.value.map(
      (refund) => html`<li class="row"><span class="row-title">${fill(orderCopy.refundLine, { amount: fmt.money(refund.amount_money), date: fmt.date(refund.created_at) })}</span></li>`,
    )}</ul>`,
    { labelledBy: 'refunds-title' },
  );
}

export function sortedEvents(events: BuyerFulfillmentEvent[]): BuyerFulfillmentEvent[] {
  return [...events].sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at));
}

function eventLabel(event: BuyerFulfillmentEvent): string {
  const key = event.current_status ?? event.event_type;
  return trackingStatus[key] ?? trackingStatus[event.event_type] ?? trackingStatus.custom ?? '';
}

function needsTracking(fulfillments: Loaded<Fulfillment[]>, events: Loaded<BuyerFulfillmentEvent[]>): boolean {
  if (events.status === 'ok' && events.value.length) return true;
  if (fulfillments.status !== 'ok') return true;
  return fulfillments.value.some((f) => f.type === 'shipment' || f.type === 'local_delivery');
}

function deliverySection(data: OrderData, ctx: RenderContext): Html {
  const { order, fulfillments, packages, events } = data;
  const retry = path('/orders', order.order_id);
  const destination = order.delivery_destination;
  const pickups = fulfillments.status === 'ok' ? fulfillments.value.filter((f) => f.type === 'pickup' && f.pickup_details) : [];
  const fmt = fmtFor(ctx);

  const destinationBlock = destination
    ? html`<div class="stack-small" data-testid="ac-order-destination"><h3>${orderCopy.shipTo}</h3>${addressBlock(destination.address, destination.recipient?.name)}</div>`
    : '';
  const pickupBlock = pickups.map(
    (fulfillment) => html`<div class="stack-small" data-testid="ac-order-pickup"><h3>${orderCopy.pickupAt}</h3>
      <p>${fulfillment.pickup_details?.location_name ?? ''}</p>
      ${fulfillment.pickup_details?.address ? addressBlock(fulfillment.pickup_details.address) : ''}
      ${fulfillment.pickup_details?.instructions ? html`<p class="muted">${fulfillment.pickup_details.instructions}</p>` : ''}
      ${fulfillment.pickup_details?.ready_at ? html`<p>${fill(orderCopy.pickupReady, { date: fmt.dateTime(fulfillment.pickup_details.ready_at) })}</p>` : ''}
    </div>`,
  );

  let timeline: Html;
  if (events.status === 'error') {
    timeline = sectionError('tracking', events.error, retry, 'ac-order-tracking-error');
  } else if (events.value.length) {
    const sorted = sortedEvents(events.value);
    timeline = html`<ol class="timeline" data-state="loaded" data-testid="ac-tracking">${sorted.map(
      (event, index) => html`<li class="timeline-item" data-testid="ac-tracking-event-${index + 1}" data-event-type="${event.event_type}">
        <p class="timeline-status">${eventLabel(event)}</p>
        ${event.location_description ? html`<p class="timeline-place">${event.location_description}</p>` : ''}
        <p class="timeline-time">${timeEl(event.occurred_at, ctx, true)}</p>
      </li>`,
    )}</ol>`;
  } else if (needsTracking(fulfillments, events)) {
    timeline = html`<p class="muted" data-state="no_delivery_yet" data-testid="ac-no-delivery-yet">${orderCopy.trackingNone}</p>`;
  } else {
    timeline = html``;
  }

  let packageBlock: Html = html``;
  if (packages.status === 'error') {
    packageBlock = sectionError('packages', packages.error, retry, 'ac-order-packages-error');
  } else if (packages.value.length) {
    packageBlock = html`<h3>${orderCopy.packages}</h3><ul class="rows" data-testid="ac-packages">${packages.value.map((pkg) => {
      const trackingUrl = safeExternalUrl(pkg.tracking_url);
      return html`<li class="row" data-testid="ac-package-${pkg.package_id}">
        <span class="row-title">${pkg.carrier ? fill(orderCopy.carrier, { carrier: pkg.carrier }) : orderCopy.packages}</span>
        <span class="row-meta">${pkg.tracking_number ? fill(orderCopy.trackingNumber, { number: pkg.tracking_number }) : ''}</span>
        ${trackingUrl ? html`<span class="row-end">${externalLink(trackingUrl, orderCopy.trackPackage, { testid: 'ac-package-track' })}</span>` : ''}
      </li>`;
    })}</ul>`;
  }

  return card(html`<h2 id="delivery-title">${orderCopy.delivery}</h2>${destinationBlock}${pickupBlock}${timeline}${packageBlock}`, {
    labelledBy: 'delivery-title',
    testid: 'ac-order-delivery',
  });
}

function orderAmounts(order: Order): Html {
  const pricing = order.pricing_amounts;
  const settlement = order.settlement_amounts;
  const rows = [
    { label: orderCopy.subtotal, value: money(pricing.subtotal_money), testid: 'ac-order-subtotal' },
    ...(!isZero(pricing.discount_money) ? [{ label: orderCopy.discounts, value: html`-${money(pricing.discount_money)}`, testid: 'ac-order-discounts' }] : []),
    ...(!isZero(pricing.charge_money) ? [{ label: orderCopy.shipping, value: money(pricing.charge_money), testid: 'ac-order-charges' }] : []),
    ...(!isZero(pricing.requested_tip_money) ? [{ label: orderCopy.tip, value: money(pricing.requested_tip_money), testid: 'ac-order-tip' }] : []),
    { label: orderCopy.tax, value: money(pricing.tax_money), testid: 'ac-order-tax' },
    { label: orderCopy.total, value: money(pricing.total_money, { testid: 'ac-order-total' }), strong: true },
    ...(settlement && !isZero(settlement.paid_money) ? [{ label: orderCopy.paid, value: money(settlement.paid_money), testid: 'ac-order-paid' }] : []),
    ...(settlement && !isZero(settlement.refunded_money) ? [{ label: orderCopy.refunded, value: money(settlement.refunded_money), testid: 'ac-order-refunded' }] : []),
    ...(settlement && !isZero(settlement.outstanding_money) ? [{ label: orderCopy.amountDue, value: money(settlement.outstanding_money), testid: 'ac-order-outstanding' }] : []),
  ];
  return amountRows(rows);
}

export function orderPage(ctx: RenderContext<OrderData>): Html {
  const data = ctx.data;
  const order = data.order;
  const processing = hasProcessingPayment(data.payments);
  const status = orderStatusView(order, processing);
  const number = orderNumberLabel(order);
  const receipt = availableAction(order.buyer_actions, 'resend_receipt');
  const startReturn = findAction(order.buyer_actions, 'start_return');

  let returnControl: Html = html``;
  if (startReturn?.is_available) {
    returnControl = linkButton(`${path('/orders', order.order_id)}/return`, orderCopy.startReturn, { testid: 'ac-start-return' });
  } else if (startReturn) {
    const reason = startReturn.unavailable_reason ?? 'store_policy';
    const text = (orderCopy.unavailableReasons as Record<string, string>)[reason] ?? orderCopy.unavailableReasons.store_policy;
    returnControl = html`<div class="return-unavailable" data-testid="ac-return-unavailable" data-reason="${reason}"><p>${text}</p>${reason === 'store_policy' || !(reason in orderCopy.unavailableReasons) ? supportContact(ctx.support) : ''}</div>`;
  }

  const actions = html`<div class="actions-row">
    ${
      receipt
        ? postForm(
            { action: `${path('/orders', order.order_id)}/receipt`, csrf: ctx.csrf, className: 'inline-form' },
            button({ label: orderCopy.sendReceipt, type: 'submit', testid: 'ac-send-receipt' }),
          )
        : ''
    }
    ${linkButton(`${path('/orders', order.order_id)}/receipt`, orderCopy.printReceipt, { testid: 'ac-print-receipt' })}
    ${startReturn?.is_available ? returnControl : ''}
  </div>
  ${startReturn && !startReturn.is_available ? returnControl : ''}`;

  const main = html`${pageHeader(fill(ordersCopy.orderNumber, { number }), {
    subtitle: order.created_at ? fill(orderCopy.placedOn, { date: fmtFor(ctx).date(order.created_at) }) : undefined,
    testid: 'ac-order-title',
  })}
  <div class="status-line">
    ${statusBadge(status, 'ac-order-status')}
    ${processing ? html`<p class="status-note" role="status" data-state="processing_payment" data-testid="ac-order-processing">${orderCopy.processing}</p>` : ''}
  </div>
  ${actions}
  ${card(html`<h2 id="items-title">${orderCopy.items}</h2>${lineItems(order.line_items)}${orderAmounts(order)}`, { labelledBy: 'items-title', testid: 'ac-order-items' })}
  ${card(html`<h2 id="payment-title">${orderCopy.payment}</h2>${paymentSection(order, data.payments, ctx)}`, { labelledBy: 'payment-title', testid: 'ac-order-payment' })}
  ${refundSection(order, data.refunds, ctx)}
  ${deliverySection(data, ctx)}`;
  return renderDocument(ctx, { pageId: 'ac-order', title: fill(ordersCopy.orderNumber, { number }), testid: 'ac-order', main, nav: 'orders' });
}

export function orderReceiptPage(ctx: RenderContext<OrderReceiptData>): Html {
  const { order, payments, refunds } = ctx.data;
  const number = orderNumberLabel(order);
  const fmt = fmtFor(ctx);
  const main = html`<div class="receipt" data-testid="ac-receipt">
    <p class="no-print"><a href="${path('/orders', order.order_id)}">${returnStart.backToOrder}</a>
      <button type="button" class="btn btn-secondary js-only" data-print data-testid="ac-print">${common.print}</button></p>
    <h1 id="page-title" tabindex="-1">${fill(orderCopy.receiptTitle, { number })}</h1>
    <p>${fill(orderCopy.receiptFrom, { store: ctx.storeName })}</p>
    <p>${order.created_at ? fill(orderCopy.placedOn, { date: fmt.dateTime(order.created_at) }) : ''}</p>
    <p class="muted">${orderCopy.receiptIntro}</p>
    ${lineItems(order.line_items)}
    ${orderAmounts(order)}
    <h2>${orderCopy.payment}</h2>
    ${payments.status === 'ok' ? (payments.value.length ? html`<ul class="rows">${payments.value.map((payment) => html`<li class="row"><span class="row-title">${fill(orderCopy.paymentLine, { method: paymentMethodLabel(payment), status: paymentStatusWord(payment.status) })}</span><span class="row-end">${money(payment.amount_money)}</span></li>`)}</ul>` : html`<p class="muted">${orderCopy.paymentNone}</p>`) : sectionError('your payments', payments.error, `${path('/orders', order.order_id)}/receipt`)}
    ${refunds.status === 'ok' && refunds.value.length ? html`<h2>${orderCopy.refunds}</h2><ul class="rows">${refunds.value.map((refund) => html`<li class="row"><span class="row-title">${fill(orderCopy.refundLine, { amount: fmt.money(refund.amount_money), date: fmt.date(refund.created_at) })}</span></li>`)}</ul>` : ''}
    ${order.delivery_destination ? html`<h2>${orderCopy.shipTo}</h2>${addressBlock(order.delivery_destination.address, order.delivery_destination.recipient?.name)}` : ''}
  </div>`;
  return renderDocument(ctx, { pageId: 'ac-order-receipt', title: fill(orderCopy.receiptTitle, { number }), testid: 'ac-order-receipt', main, shell: 'bare', hideNotices: true });
}

// ---------------------------------------------------------------------------
// Start a return
// ---------------------------------------------------------------------------

export function returnStartPage(ctx: RenderContext<ReturnStartData>): Html {
  const { order, eligibility, reasons, values = {} } = ctx.data;
  const errors = ctx.error?.field_errors;
  const lines = eligibility.line_items;
  const backHref = path('/orders', order.order_id);
  const isEligible = (line: ReturnStartData['eligibility']['line_items'][number]) =>
    line.is_self_service_enabled && line.eligibility.status === 'eligible' && countOf(line.eligibility.eligible_quantity) > 0;
  const eligibleCount = lines.filter(isEligible).length;

  const reasonOptions = (line: (typeof lines)[number]) => {
    const suggested = line.suggested_return_reasons ?? [];
    const source = suggested.length
      ? suggested.map((reason) => ({ id: reason.return_reason_id, name: reason.name, note: reason.is_note_required }))
      : reasons.map((reason) => ({ id: reason.return_reason_id, name: reason.name, note: reason.is_note_required }));
    return source.map((reason) => ({ value: reason.id, label: reason.name, attributes: { 'data-note-required': reason.note ? 'true' : undefined } }));
  };

  const ineligibleReason = (line: (typeof lines)[number]): string => {
    const reason = line.eligibility.reason;
    const map = returnStart.ineligibleReasons as Record<string, string>;
    if (!line.is_self_service_enabled) return map.selfService ?? returnStart.ineligibleReasons.fallback;
    return map[reason] ?? returnStart.ineligibleReasons.fallback;
  };

  const rows = lines.map((line, index) => {
    const id = line.order_line_item_id;
    if (!isEligible(line)) {
      return { eligible: false as const, node: html`<li class="return-line return-line-ineligible" data-testid="ac-return-row-${id}" data-state="ineligible"><p class="line-name">${line.name}</p><p class="muted">${ineligibleReason(line)}</p></li>` };
    }
    const max = countOf(line.eligibility.eligible_quantity);
    const prefix = `line_${index}`;
    const selected = values[`${prefix}_selected`] === 'on';
    const quantityOptions = Array.from({ length: Math.min(max, 99) }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }));
    return {
      eligible: true as const,
      node: html`<li class="return-line" data-testid="ac-return-row-${id}" data-state="${selected ? 'selected' : 'idle'}" data-return-line>
        ${hiddenInput(`${prefix}_order_line_item_id`, id)}
        ${hiddenInput(`${prefix}_fulfillment_id`, line.fulfillment_id)}
        ${checkboxField({ name: `${prefix}_selected`, label: fill(returnStart.selectLine, { name: line.name }), checked: selected, testid: `ac-return-line-${id}`, attributes: { 'data-return-select': 'true' } })}
        ${line.eligibility.expires_at ? html`<p class="muted">${fill(returnStart.returnBy, { date: fmtFor(ctx).date(line.eligibility.expires_at) })}</p>` : ''}
        <div class="return-line-fields" data-return-fields>
          ${selectField({ name: `${prefix}_quantity`, label: `${returnStart.quantityLabel} (${fill(returnStart.quantityMax, { max })})`, options: quantityOptions, value: values[`${prefix}_quantity`] ?? '1', testid: `ac-return-quantity-${id}`, errors })}
          ${selectField({ name: `${prefix}_reason`, label: returnStart.reasonLabel, options: reasonOptions(line), value: values[`${prefix}_reason`] ?? '', placeholder: returnStart.reasonPlaceholder, testid: `ac-return-reason-${id}`, errors, attributes: { 'data-return-reason': 'true' } })}
          ${textareaField({ name: `${prefix}_note`, label: returnStart.noteLabel, value: values[`${prefix}_note`] ?? '', rows: 2, maxlength: 500, hint: returnStart.noteOptional, testid: `ac-return-note-${id}`, errors })}
        </div>
      </li>`,
    };
  });

  const labels: Record<string, string> = {};
  lines.forEach((line, index) => {
    labels[`line_${index}_reason`] = line.name;
    labels[`line_${index}_quantity`] = line.name;
    labels[`line_${index}_note`] = line.name;
  });

  const body =
    eligibleCount === 0
      ? html`<div class="empty" data-state="nothing_eligible" data-testid="ac-return-nothing"><p>${returnStart.nothingEligible}</p>${supportContact(ctx.support)}</div>
        ${rows.length ? html`<ul class="return-lines">${rows.map((row) => row.node)}</ul>` : ''}`
      : postForm(
          { action: `${path('/orders', order.order_id)}/return`, csrf: ctx.csrf, attributes: { 'data-return-form': 'true' } },
          html`${hiddenInput('line_count', String(lines.length))}
            <ul class="return-lines">${rows.map((row) => row.node)}</ul>
            <p class="hint">${returnStart.reviewNote}</p>
            <div class="form-actions">${button({ label: returnStart.submit, type: 'submit', variant: 'primary', testid: 'ac-return-submit' })}${linkButton(backHref, returnStart.backToOrder)}</div>`,
        );

  const main = html`${pageHeader(returnStart.title, { subtitle: eligibleCount ? returnStart.intro : undefined, testid: 'ac-return-start-title' })}
    ${errorSummary(ctx.error, labels)}
    ${card(body, { testid: 'ac-return-form-card' })}`;
  return renderDocument(ctx, { pageId: 'ac-return-start', title: returnStart.title, testid: 'ac-return-start', main, nav: 'orders', scripts: ['/js/return-start.js'] });
}
