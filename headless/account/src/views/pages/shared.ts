import { html } from 'hono/html';
import {
  common,
  fill,
  invoices as invoicesCopy,
  orderStatus,
  paymentMethods as paymentMethodsCopy,
  returns as returnsCopy,
  subscriptions as subscriptionsCopy,
} from '../../copy.ts';
import { badge, money, type Html, type Tone } from '../components.ts';
import { addressLines } from '../format.ts';
import type {
  BuyerAction,
  BuyerInvoice,
  Order,
  PaymentMethod,
  ReturnResource,
  Subscription,
} from '../types.ts';

export function findAction(actions: BuyerAction[] | undefined, kind: string): BuyerAction | undefined {
  return actions?.find((action) => action.kind === kind);
}

export function availableAction(actions: BuyerAction[] | undefined, kind: string): BuyerAction | undefined {
  const action = findAction(actions, kind);
  return action && action.is_available ? action : undefined;
}

export interface StatusView {
  label: string;
  tone: Tone;
  state: string;
}

/** Plain-words order status. `processing` is true when a bank payment has not cleared. */
export function orderStatusView(order: Pick<Order, 'status' | 'payment_status' | 'refund_status' | 'fulfillment_status'>, processing = false): StatusView {
  if (order.refund_status === 'refunded') return { label: orderStatus.refunded, tone: 'neutral', state: 'refunded' };
  if (order.refund_status === 'partially_refunded') return { label: orderStatus.partially_refunded, tone: 'neutral', state: 'partially_refunded' };
  if (order.fulfillment_status === 'canceled') return { label: orderStatus.canceled, tone: 'neutral', state: 'canceled' };
  if (processing) return { label: orderStatus.processing, tone: 'info', state: 'processing' };
  if (order.payment_status === 'unpaid') return { label: orderStatus.unpaid, tone: 'warn', state: 'unpaid' };
  if (order.payment_status === 'partially_paid') return { label: orderStatus.partially_paid, tone: 'warn', state: 'partially_paid' };
  switch (order.fulfillment_status) {
    case 'fulfilled':
      return { label: orderStatus.fulfilled, tone: 'good', state: 'fulfilled' };
    case 'partially_fulfilled':
      return { label: orderStatus.partially_fulfilled, tone: 'info', state: 'partially_fulfilled' };
    case 'not_fulfilled':
      return { label: orderStatus.not_fulfilled, tone: 'info', state: 'preparing' };
    default:
      return { label: orderStatus.paid, tone: 'good', state: 'paid' };
  }
}

export function statusBadge(view: StatusView, testid?: string): Html {
  return badge(view.label, view.tone, { 'data-state': view.state, 'data-testid': testid });
}

export function subscriptionStatusView(subscription: Pick<Subscription, 'status' | 'cancel_at_period_end'>): StatusView {
  const label = subscriptionsCopy.statuses[subscription.status] ?? subscriptionsCopy.statuses.active ?? '';
  const tone: Tone =
    subscription.status === 'active' || subscription.status === 'trialing'
      ? 'good'
      : subscription.status === 'past_due'
        ? 'bad'
        : subscription.status === 'paused' || subscription.status === 'incomplete'
          ? 'warn'
          : 'neutral';
  return { label: subscriptionsCopy.statuses[subscription.status] ? label : String(subscription.status), tone, state: subscription.status };
}

export function invoiceStatusView(invoice: Pick<BuyerInvoice, 'status' | 'is_overdue'>, processing = false): StatusView {
  if (processing) return { label: 'Bank payment processing', tone: 'info', state: 'processing' };
  const label = invoicesCopy.statuses[invoice.status] ?? String(invoice.status);
  const tone: Tone =
    invoice.status === 'paid'
      ? 'good'
      : invoice.is_overdue
        ? 'bad'
        : invoice.status === 'open' || invoice.status === 'partially_paid'
          ? 'warn'
          : 'neutral';
  return { label, tone, state: invoice.is_overdue && (invoice.status === 'open' || invoice.status === 'partially_paid') ? 'overdue' : invoice.status };
}

export type ReturnState = 'requested' | 'approved' | 'awaiting_payment' | 'completed' | 'canceled' | 'declined';

export function returnState(ret: Pick<ReturnResource, 'status' | 'decision_status' | 'buyer_actions' | 'completion_blockers'>): ReturnState {
  if (ret.status === 'canceled') return 'canceled';
  if (ret.status === 'declined') return 'declined';
  if (ret.status === 'completed') return 'completed';
  if (availableAction(ret.buyer_actions, 'pay_balance')) return 'awaiting_payment';
  if (ret.status === 'open' || ret.decision_status === 'approved' || ret.decision_status === 'partially_approved') return 'approved';
  return 'requested';
}

export function returnStatusView(ret: Parameters<typeof returnState>[0]): StatusView {
  const state = returnState(ret);
  const tone: Tone = state === 'completed' ? 'good' : state === 'awaiting_payment' ? 'warn' : state === 'approved' ? 'info' : state === 'requested' ? 'info' : 'neutral';
  return { label: returnsCopy.statusLabels[state] ?? state, tone, state };
}

export function cardBrand(brand: string | undefined): string {
  if (!brand) return 'Card';
  const names: Record<string, string> = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', diners: 'Diners Club', jcb: 'JCB', unionpay: 'UnionPay' };
  return names[brand] ?? brand.charAt(0).toUpperCase() + brand.slice(1);
}

/** "Visa ending 4242" */
export function cardName(card: PaymentMethod['card']): string {
  if (!card) return 'Card';
  return fill(common.endingIn, { brand: cardBrand(card.brand), last4: card.last4 });
}

/** "Visa ending 4242, expires 12/28" */
export function cardLabel(card: PaymentMethod['card']): string {
  if (!card) return 'Card';
  return fill(common.endingInExpires, {
    brand: cardBrand(card.brand),
    last4: card.last4,
    month: String(card.exp_month).padStart(2, '0'),
    year: String(card.exp_year).slice(-2),
  });
}

export function paymentMethodStatusLabel(status: string): string {
  return paymentMethodsCopy.statusLabels[status] ?? status;
}

/** Items list shared by order, receipt, and payment summaries. */
export function lineItems(items: Order['line_items'], testidPrefix = 'ac-line'): Html {
  return html`<ul class="lines" data-testid="${testidPrefix}s">${items.map(
    (item, index) => html`<li class="line" data-testid="${testidPrefix}-${index + 1}">
      <div class="line-main">
        <span class="line-name">${item.name}</span>
        ${
          item.selected_options?.length
            ? html`<span class="line-meta">${item.selected_options.map((option) => `${option.option_name}: ${option.value}`).join(', ')}</span>`
            : ''
        }
        ${
          item.modifiers?.length
            ? html`<span class="line-meta">${item.modifiers.filter((m) => m.show_on_receipt).map((m) => m.text_value ?? m.name).join(', ')}</span>`
            : ''
        }
        <span class="line-meta">${common.quantity} ${item.quantity}</span>
      </div>
      <span class="line-total">${money(item.total_money)}</span>
    </li>`,
  )}</ul>`;
}

export interface AmountRow {
  label: string;
  value: Html;
  testid?: string;
  strong?: boolean;
}

export function amountRows(rows: AmountRow[]): Html {
  return html`<dl class="amounts">${rows.map(
    (row) => html`<div class="${row.strong ? 'amount-row amount-total' : 'amount-row'}"><dt>${row.label}</dt><dd${row.testid ? html` data-testid="${row.testid}"` : ''}>${row.value}</dd></div>`,
  )}</dl>`;
}

export function addressBlock(address: Parameters<typeof addressLines>[0] | undefined, name?: string | null): Html {
  if (!address) return html``;
  const lines = addressLines(address);
  return html`<address class="address">${name ? html`<span>${name}</span><br>` : ''}${lines.map((line, i) => html`${i > 0 ? html`<br>` : ''}${line}`)}</address>`;
}

/** Subscription display name: the plan name, else the first line item. */
export function subscriptionName(subscription: Pick<Subscription, 'subscription_plan' | 'line_items' | 'subscription_id'>): string {
  return subscription.subscription_plan?.name || subscription.line_items?.[0]?.name || 'Subscription';
}

export function orderNumberLabel(order: Pick<Order, 'order_number' | 'order_id'>): string {
  return order.order_number || order.order_id;
}

/** "Every month" or "Every 3 months". */
export function intervalLabel(count: number | undefined, interval: string | undefined): string {
  if (!interval) return '';
  const units = subscriptionsCopy.intervals[interval];
  const n = count && count > 0 ? count : 1;
  if (!units) return '';
  if (n === 1) return `Every ${units[0]}`;
  return fill(subscriptionsCopy.every, { count: n, unit: units[1] });
}
