import { html } from 'hono/html';
import { common, fill, home, orders as ordersCopy } from '../../copy.ts';
import { badge, card, emptyState, fmtFor, linkButton, money, pageHeader, sectionError, type Html } from '../components.ts';
import { path } from '../format.ts';
import { renderDocument } from '../layout.ts';
import type { BuyerAction, BuyerInvoice, HomeData, Order, RenderContext, Subscription } from '../types.ts';
import {
  invoiceStatusView,
  orderNumberLabel,
  orderStatusView,
  statusBadge,
  subscriptionName,
  subscriptionStatusView,
} from './shared.ts';

interface AttentionItem {
  kind: string;
  id: string;
  href: string;
  label: string;
  due_at?: string;
}

const SUBSCRIPTION_KINDS = ['update_payment_method', 'retry_payment'];
const RETURN_KINDS = ['ship_items', 'pay_balance'];

function requiredActions(actions: BuyerAction[] | undefined, kinds: string[]): BuyerAction[] {
  return (actions ?? []).filter((action) => action.is_required && kinds.includes(action.kind));
}

function labelFor(kind: string, name: string): string {
  const template = (home.attentionLabels as Record<string, string>)[kind] ?? home.attentionFallback;
  return fill(template, { name });
}

export function attentionItems(data: HomeData): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (data.subscriptions.status === 'ok') {
    for (const subscription of data.subscriptions.value.items) {
      for (const action of requiredActions(subscription.buyer_actions, SUBSCRIPTION_KINDS)) {
        items.push({
          kind: action.kind,
          id: subscription.subscription_id,
          href: path('/subscriptions', subscription.subscription_id),
          label: labelFor(action.kind, subscription.subscription_plan?.name ?? subscriptionName(subscription)),
          due_at: action.due_at,
        });
      }
    }
  }
  if (data.invoices.status === 'ok') {
    for (const invoice of data.invoices.value.items) {
      for (const action of requiredActions(invoice.buyer_actions, ['pay'])) {
        items.push({
          kind: 'pay',
          id: invoice.invoice_id,
          href: action.is_available ? `${path('/invoices', invoice.invoice_id)}/pay` : path('/invoices', invoice.invoice_id),
          label: labelFor('pay', invoice.invoice_number ?? invoice.invoice_id),
          due_at: action.due_at ?? invoice.due_at,
        });
      }
    }
  }
  if (data.returns.status === 'ok') {
    for (const ret of data.returns.value.items) {
      for (const action of requiredActions(ret.buyer_actions, RETURN_KINDS)) {
        items.push({
          kind: action.kind,
          id: ret.return_id,
          href: action.kind === 'pay_balance' && action.is_available ? `${path('/returns', ret.return_id)}/pay` : path('/returns', ret.return_id),
          label: labelFor(action.kind, ret.return_number),
          due_at: action.due_at,
        });
      }
    }
  }
  return items;
}

function recentOrderRow(order: Order, ctx: RenderContext): Html {
  const fmt = fmtFor(ctx);
  return html`<li class="row" data-testid="ac-recent-order-${order.order_id}">
    <a class="row-link" href="${path('/orders', order.order_id)}">
      <span class="row-title">${fill(ordersCopy.orderNumber, { number: orderNumberLabel(order) })}</span>
      <span class="row-meta">${fmt.date(order.created_at)}</span>
    </a>
    <span class="row-end">${statusBadge(orderStatusView(order))} ${money(order.pricing_amounts.total_money)}</span>
  </li>`;
}

function subscriptionRow(subscription: Subscription, ctx: RenderContext): Html {
  const fmt = fmtFor(ctx);
  const status = subscriptionStatusView(subscription);
  return html`<li class="row" data-testid="ac-home-subscription-${subscription.subscription_id}">
    <a class="row-link" href="${path('/subscriptions', subscription.subscription_id)}">
      <span class="row-title">${subscriptionName(subscription)}</span>
      ${subscription.next_billing_at ? html`<span class="row-meta">Next charge ${fmt.date(subscription.next_billing_at)}</span>` : ''}
    </a>
    <span class="row-end">${badge(status.label, status.tone, { 'data-state': status.state })}</span>
  </li>`;
}

function invoiceRow(invoice: BuyerInvoice, ctx: RenderContext): Html {
  const fmt = fmtFor(ctx);
  const status = invoiceStatusView(invoice);
  return html`<li class="row" data-testid="ac-home-invoice-${invoice.invoice_id}">
    <a class="row-link" href="${path('/invoices', invoice.invoice_id)}">
      <span class="row-title">${fill('Invoice {number}', { number: invoice.invoice_number ?? invoice.invoice_id })}</span>
      ${invoice.due_at ? html`<span class="row-meta">Due ${fmt.date(invoice.due_at)}</span>` : ''}
    </a>
    <span class="row-end">${badge(status.label, status.tone, { 'data-state': status.state })} ${money(invoice.outstanding_money)}</span>
  </li>`;
}

export function homePage(ctx: RenderContext<HomeData>): Html {
  const data = ctx.data;
  const attention = attentionItems(data);
  const allLoaded = [data.orders, data.subscriptions, data.invoices, data.returns].every((section) => section.status === 'ok');
  const name = ctx.user?.name?.trim();
  const greeting = name ? fill(home.greeting, { name }) : home.greetingNoName;

  const attentionSection = attention.length
    ? html`<section class="card attention" aria-labelledby="attention-title" data-state="attention" data-testid="ac-attention">
        <h2 id="attention-title">${home.attention}</h2>
        <ul class="rows">${attention.map(
          (item) => html`<li class="row row-action" data-testid="ac-attention-${item.kind}-${item.id}">
            <a class="row-link-full" href="${item.href}">
              <span class="row-text"><span class="row-title">${item.label}</span>${item.due_at ? html`<span class="row-meta">${fill(home.attentionDue, { date: fmtFor(ctx).date(item.due_at) })}</span>` : ''}</span>
              <span class="btn btn-primary btn-small" aria-hidden="true">${common.view}</span>
            </a>
          </li>`,
        )}</ul>
      </section>`
    : allLoaded
      ? html`<section class="card" data-state="nothing_needed" data-testid="ac-attention-clear"><p class="calm">${home.caughtUp}</p></section>`
      : html``;

  const ordersSection =
    data.orders.status === 'error'
      ? sectionError(home.sections.orders, data.orders.error, '/', 'ac-home-orders-error')
      : data.orders.value.items.length
        ? html`<ul class="rows" data-state="loaded">${data.orders.value.items.slice(0, 3).map((order) => recentOrderRow(order, ctx))}</ul>
          <p>${linkButton('/orders', common.viewAll, { testid: 'ac-view-all-orders' })}</p>`
        : emptyState(
            home.noOrders,
            ctx.storefrontOrigin ? linkButton(ctx.storefrontOrigin, home.shopLink, { variant: 'primary', testid: 'ac-home-shop' }) : undefined,
            'ac-home-new-account',
          );

  const activeSubscriptions =
    data.subscriptions.status === 'ok'
      ? data.subscriptions.value.items.filter((s) => ['trialing', 'active', 'paused', 'past_due'].includes(s.status))
      : [];
  const subscriptionsSection =
    data.subscriptions.status === 'error'
      ? sectionError(home.sections.subscriptions, data.subscriptions.error, '/', 'ac-home-subscriptions-error')
      : activeSubscriptions.length
        ? html`<ul class="rows">${activeSubscriptions.map((s) => subscriptionRow(s, ctx))}</ul>`
        : html`<p class="muted">${home.noSubscriptions}</p>`;

  const openInvoices =
    data.invoices.status === 'ok' ? data.invoices.value.items.filter((i) => i.status === 'open' || i.status === 'partially_paid') : [];
  const invoicesSection =
    data.invoices.status === 'error'
      ? sectionError(home.sections.invoices, data.invoices.error, '/', 'ac-home-invoices-error')
      : openInvoices.length
        ? html`<ul class="rows">${openInvoices.map((i) => invoiceRow(i, ctx))}</ul>`
        : html`<p class="muted">${home.noInvoices}</p>`;

  const main = html`${pageHeader(home.title, { subtitle: greeting, testid: 'ac-home-title' })}
    ${
      ctx.setupNeeded
        ? html`<div class="alert alert-warn" role="note" data-state="setup_needed" data-testid="ac-setup-needed"><p class="alert-title">${home.setupNeededTitle}</p><p>${home.setupNeededBody}</p></div>`
        : ''
    }
    ${attentionSection}
    ${data.returns.status === 'error' ? sectionError(home.sections.returns, data.returns.error, '/', 'ac-home-returns-error') : ''}
    ${card(html`<h2 id="recent-orders-title">${home.recentOrders}</h2>${ordersSection}`, { labelledBy: 'recent-orders-title', testid: 'ac-home-orders' })}
    <div class="grid-two">
      ${card(html`<h2 id="subs-title">${home.activeSubscriptions}</h2>${subscriptionsSection}`, { labelledBy: 'subs-title', testid: 'ac-home-subscriptions' })}
      ${card(html`<h2 id="invoices-title">${home.openInvoices}</h2>${invoicesSection}`, { labelledBy: 'invoices-title', testid: 'ac-home-invoices' })}
    </div>`;
  return renderDocument(ctx, { pageId: 'ac-home', title: home.title, testid: 'ac-home', main, nav: 'overview' });
}
