import { html } from 'hono/html';
import { fill, invoices as invoicesCopy } from '../../copy.ts';
import {
  badge,
  card,
  emptyState,
  fmtFor,
  linkButton,
  money,
  pageHeader,
  paginationLinks,
  sectionError,
  timeEl,
  type Html,
} from '../components.ts';
import { isZero, path } from '../format.ts';
import { renderDocument } from '../layout.ts';
import type { InvoiceData, InvoicesData, RenderContext } from '../types.ts';
import { amountRows, availableAction, invoiceStatusView } from './shared.ts';

export function invoicesPage(ctx: RenderContext<InvoicesData>): Html {
  const { invoices, page_token } = ctx.data;
  let body: Html;
  if (invoices.status === 'error') {
    body = sectionError('your invoices', invoices.error, '/invoices', 'ac-invoices-error');
  } else if (!invoices.value.items.length) {
    body = emptyState(invoicesCopy.empty, undefined, 'ac-invoices-empty');
  } else {
    const columns = invoicesCopy.columns;
    body = html`<table class="table responsive-table" data-state="loaded">
        <caption class="sr-only">${invoicesCopy.title}</caption>
        <thead><tr>
          <th scope="col">${columns.invoice}</th><th scope="col">${columns.issued}</th><th scope="col">${columns.due}</th><th scope="col">${columns.status}</th><th scope="col" class="num">${columns.amount}</th>
        </tr></thead>
        <tbody>${invoices.value.items.map((invoice) => {
          const status = invoiceStatusView(invoice);
          return html`<tr data-testid="ac-invoice-row-${invoice.invoice_id}">
            <th scope="row" data-label="${columns.invoice}"><a href="${path('/invoices', invoice.invoice_id)}">${fill(invoicesCopy.number, { number: invoice.invoice_number ?? invoice.invoice_id })}</a></th>
            <td data-label="${columns.issued}">${timeEl(invoice.issued_at, ctx)}</td>
            <td data-label="${columns.due}">${timeEl(invoice.due_at, ctx)}</td>
            <td data-label="${columns.status}">${badge(status.label, status.tone, { 'data-state': status.state })}</td>
            <td data-label="${columns.amount}" class="num">${money(invoice.outstanding_money)}</td>
          </tr>`;
        })}</tbody>
      </table>
      ${paginationLinks({ basePath: '/invoices', pageToken: page_token, nextPageToken: invoices.value.next_page_token, testid: 'ac-invoices', newerLabel: 'Newest invoices', olderLabel: 'Older invoices' })}`;
  }
  const main = html`${pageHeader(invoicesCopy.title, { testid: 'ac-invoices-title' })}${card(body, { testid: 'ac-invoices-list' })}`;
  return renderDocument(ctx, { pageId: 'ac-invoices', title: invoicesCopy.title, testid: 'ac-invoices', main, nav: 'invoices' });
}

const CLOSED = new Set(['void', 'uncollectible', 'credited']);

export function invoicePage(ctx: RenderContext<InvoiceData>): Html {
  const { invoice, credit_notes, awaiting_payment, processing } = ctx.data;
  const fmt = fmtFor(ctx);
  const base = path('/invoices', invoice.invoice_id);
  const closed = CLOSED.has(invoice.status);
  const isProcessing = Boolean(processing) && invoice.status !== 'paid' && !closed;
  const status = invoiceStatusView(invoice, isProcessing);
  const state = closed ? 'void_or_uncollectible' : status.state;
  const payAction = availableAction(invoice.buyer_actions, 'pay');
  const dueNow = !isZero(invoice.currently_due_money) ? invoice.currently_due_money : invoice.outstanding_money;
  const snapshot = invoice.snapshot;
  const pricing = snapshot?.pricing_amounts;
  const number = invoice.invoice_number ?? invoice.invoice_id;
  const waiting = Boolean(awaiting_payment) && invoice.status !== 'paid' && !closed;

  const amounts = amountRows([
    ...(pricing ? [{ label: 'Subtotal', value: money(pricing.subtotal_money) }] : []),
    ...(pricing && !isZero(pricing.discount_money) ? [{ label: 'Discounts', value: html`-${money(pricing.discount_money)}` }] : []),
    ...(pricing && !isZero(pricing.charge_money) ? [{ label: 'Charges', value: money(pricing.charge_money) }] : []),
    ...(pricing ? [{ label: 'Tax', value: money(pricing.tax_money) }] : []),
    ...(pricing ? [{ label: invoicesCopy.total, value: money(pricing.total_money), strong: true }] : []),
    ...(!isZero(invoice.credit_money) ? [{ label: 'Credit applied', value: money(invoice.credit_money) }] : []),
    { label: invoicesCopy.paidSoFar, value: money(invoice.paid_money, { testid: 'ac-invoice-paid' }) },
    { label: invoicesCopy.amountDue, value: money(invoice.outstanding_money, { testid: 'ac-invoice-outstanding' }), strong: true },
  ]);

  const items = snapshot?.line_items?.length
    ? html`<ul class="lines" data-testid="ac-invoice-lines">${snapshot.line_items.map(
        (item, index) => html`<li class="line" data-testid="ac-invoice-line-${index + 1}"><div class="line-main"><span class="line-name">${item.name}</span><span class="line-meta">Quantity ${item.quantity}</span></div><span class="line-total">${money(item.total_money)}</span></li>`,
      )}</ul>`
    : '';

  const creditNotes =
    credit_notes.status === 'error'
      ? sectionError('credit notes', credit_notes.error, base, 'ac-invoice-credit-notes-error')
      : credit_notes.value.length
        ? html`<ul class="rows" data-testid="ac-credit-notes">${credit_notes.value.map(
            (note) => html`<li class="row" data-testid="ac-credit-note-${note.credit_note_id}">
              <span class="row-title">${fill(invoicesCopy.creditNoteLine, { number: note.credit_note_number, amount: fmt.money(note.total_money) })}</span>
              <span class="row-end"><a href="${base}/credit-notes/${encodeURIComponent(note.credit_note_id)}/pdf">${invoicesCopy.downloadCreditNote}</a></span>
            </li>`,
          )}</ul>`
        : '';

  const message = closed
    ? html`<p class="calm" data-state="void_or_uncollectible" data-testid="ac-invoice-closed">${invoicesCopy.closed}</p>`
    : isProcessing
      ? html`<p class="status-note" role="status" data-state="processing" data-testid="ac-invoice-processing">${invoicesCopy.processing}</p>`
      : invoice.status === 'paid'
        ? html`<p class="calm" data-state="paid" data-testid="ac-invoice-paid-note">${invoicesCopy.paidMessage}</p>`
        : '';

  const main = html`${pageHeader(fill(invoicesCopy.number, { number }), {
    subtitle: [invoice.issued_at ? fill(invoicesCopy.issued, { date: fmt.date(invoice.issued_at) }) : '', invoice.due_at ? fill(invoicesCopy.due, { date: fmt.date(invoice.due_at) }) : ''].filter(Boolean).join('. '),
    testid: 'ac-invoice-title',
  })}
    <div class="status-line" data-invoice-id="${invoice.invoice_id}">
      ${badge(status.label, status.tone, { 'data-state': state, 'data-testid': 'ac-invoice-status' })}
      ${invoice.is_overdue && !closed && invoice.status !== 'paid' ? badge(invoicesCopy.overdue, 'bad', { 'data-testid': 'ac-invoice-overdue' }) : ''}
    </div>
    ${message}
    ${
      waiting
        ? html`<div class="status-note" role="status" data-invoice-poll data-url="${base}/status" data-state="checking" data-testid="ac-invoice-poll"><p data-poll-text>${invoicesCopy.checking}</p></div>`
        : ''
    }
    <div class="actions-row">
      ${linkButton(`${base}/pdf`, invoicesCopy.downloadPdf, { testid: 'ac-invoice-pdf' })}
      ${payAction && !closed && !isProcessing && invoice.status !== 'paid' ? linkButton(`${base}/pay`, fill(invoicesCopy.pay, { amount: fmt.money(dueNow) }), { variant: 'primary', testid: 'ac-invoice-pay' }) : ''}
    </div>
    ${invoice.memo ? card(html`<h2>${invoicesCopy.memo}</h2><p>${invoice.memo}</p>`, { testid: 'ac-invoice-memo' }) : ''}
    ${card(html`<h2 id="inv-items">${invoicesCopy.items}</h2>${items}${amounts}`, { labelledBy: 'inv-items', testid: 'ac-invoice-items' })}
    ${
      invoice.schedule_entries?.length
        ? card(
            html`<h2>${invoicesCopy.installment}</h2><ul class="rows">${invoice.schedule_entries.map(
              (entry) => html`<li class="row"><span class="row-title">${entry.kind}</span><span class="row-meta">${entry.status}</span><span class="row-end">${money(entry.outstanding_money)}</span></li>`,
            )}</ul>`,
            { testid: 'ac-invoice-schedule' },
          )
        : ''
    }
    ${invoice.late_fees?.length ? card(html`<h2>${invoicesCopy.lateFees}</h2><ul class="rows">${invoice.late_fees.map((fee) => html`<li class="row"><span class="row-title">${fmt.date(fee.assessed_at)}</span><span class="row-end">${money(fee.amount_money)}</span></li>`)}</ul>`) : ''}
    ${credit_notes.status === 'error' || credit_notes.value.length ? card(html`<h2>${invoicesCopy.creditNotes}</h2>${creditNotes}`, { testid: 'ac-invoice-credit-notes' }) : ''}`;
  return renderDocument(ctx, {
    pageId: 'ac-invoice',
    title: fill(invoicesCopy.number, { number }),
    testid: 'ac-invoice',
    main,
    nav: 'invoices',
    scripts: waiting ? ['/js/invoice-poll.js'] : [],
  });
}
