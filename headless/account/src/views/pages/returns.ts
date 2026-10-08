import { html } from 'hono/html';
import { fill, returns as returnsCopy } from '../../copy.ts';
import {
  badge,
  card,
  confirmDialog,
  dialogTrigger,
  emptyState,
  externalLink,
  fmtFor,
  linkButton,
  money,
  pageHeader,
  paginationLinks,
  sectionError,
  supportContact,
  timeEl,
  type Html,
} from '../components.ts';
import { addressLines, countOf, isZero, path, safeExternalUrl } from '../format.ts';
import { renderDocument } from '../layout.ts';
import type { RenderContext, ReturnData, ReturnsData } from '../types.ts';
import { amountRows, availableAction, returnState, returnStatusView } from './shared.ts';

export function returnsPage(ctx: RenderContext<ReturnsData>): Html {
  const { returns, page_token } = ctx.data;
  let body: Html;
  if (returns.status === 'error') {
    body = sectionError('your returns', returns.error, '/returns', 'ac-returns-error');
  } else if (!returns.value.items.length) {
    body = emptyState(returnsCopy.empty, undefined, 'ac-returns-empty');
  } else {
    const columns = returnsCopy.columns;
    body = html`<table class="table responsive-table" data-state="loaded">
        <caption class="sr-only">${returnsCopy.title}</caption>
        <thead><tr><th scope="col">${columns.return}</th><th scope="col">${columns.date}</th><th scope="col">${columns.status}</th><th scope="col">${columns.order}</th></tr></thead>
        <tbody>${returns.value.items.map((ret) => {
          const status = returnStatusView(ret);
          return html`<tr data-testid="ac-return-row-${ret.return_id}">
            <th scope="row" data-label="${columns.return}"><a href="${path('/returns', ret.return_id)}">${fill(returnsCopy.number, { number: ret.return_number })}</a></th>
            <td data-label="${columns.date}">${timeEl(ret.created_at, ctx)}</td>
            <td data-label="${columns.status}">${badge(status.label, status.tone, { 'data-state': status.state })}</td>
            <td data-label="${columns.order}"><a href="${path('/orders', ret.order_id)}">${ret.order?.order_number ?? ret.order_id}</a></td>
          </tr>`;
        })}</tbody>
      </table>
      ${paginationLinks({ basePath: '/returns', pageToken: page_token, nextPageToken: returns.value.next_page_token, testid: 'ac-returns', newerLabel: 'Newest returns', olderLabel: 'Older returns' })}`;
  }
  const main = html`${pageHeader(returnsCopy.title, { testid: 'ac-returns-title' })}${card(body, { testid: 'ac-returns-list' })}`;
  return renderDocument(ctx, { pageId: 'ac-returns', title: returnsCopy.title, testid: 'ac-returns', main, nav: 'returns' });
}

export function returnPage(ctx: RenderContext<ReturnData>): Html {
  const { return: ret, packages } = ctx.data;
  const fmt = fmtFor(ctx);
  const base = path('/returns', ret.return_id);
  const state = returnState(ret);
  const status = returnStatusView(ret);
  const payBalance = availableAction(ret.buyer_actions, 'pay_balance');
  const withdraw = availableAction(ret.buyer_actions, 'withdraw');
  const summary = ret.financial_summary;
  const closed = state === 'completed' || state === 'canceled' || state === 'declined';

  // What happens next: handoff first, then the other blockers in plain words.
  const handoffs = ret.handoff_requirements ?? [];
  const blockerCodes = [...new Set((ret.completion_blockers ?? []).map((b) => b.code))].filter((code) => code !== 'handoff_pending' || !handoffs.length);
  const nextSteps = !closed
    ? html`${handoffs.map(
        (handoff) => html`<li class="next-step" data-testid="ac-return-handoff">
          <p class="next-title">${returnsCopy.sendBack}</p>
          ${handoff.destination.name ? html`<p>${fill(returnsCopy.sendBackTo, { name: handoff.destination.name })}</p>` : ''}
          ${handoff.destination.address ? html`<address class="address">${addressLines(handoff.destination.address).map((line, i) => html`${i > 0 ? html`<br>` : ''}${line}`)}</address>` : ''}
          ${handoff.instructions ? html`<p class="muted">${handoff.instructions}</p>` : ''}
          ${handoff.expires_at ? html`<p>${fill(returnsCopy.sendBackBy, { date: fmt.date(handoff.expires_at) })}</p>` : ''}
        </li>`,
      )}${blockerCodes.map((code) => {
        const blocker = ret.completion_blockers.find((b) => b.code === code);
        const text = returnsCopy.blockers[code] ?? blocker?.message ?? '';
        return text ? html`<li class="next-step" data-testid="ac-return-blocker-${code}"><p>${text}</p></li>` : '';
      })}`
    : '';
  const hasNext = !closed && (handoffs.length > 0 || blockerCodes.some((code) => returnsCopy.blockers[code] || ret.completion_blockers.find((b) => b.code === code)?.message));

  const labels = packages.status === 'ok' ? packages.value.map((pkg) => ({ pkg, url: safeExternalUrl(pkg.label_url) })).filter((item) => item.url) : [];

  const itemsList = html`<ul class="lines" data-testid="ac-return-items">${ret.line_items.map(
    (line, index) => html`<li class="line" data-testid="ac-return-item-${index + 1}">
      <div class="line-main">
        <span class="line-name">${line.name}</span>
        ${line.selected_options?.length ? html`<span class="line-meta">${line.selected_options.map((o) => `${o.option_name}: ${o.value}`).join(', ')}</span>` : ''}
        <span class="line-meta">Quantity ${line.requested_quantity}${line.return_reason_name ? `, ${line.return_reason_name}` : ''}</span>
      </div>
    </li>`,
  )}</ul>`;

  const rows = [
    ...(!isZero(summary.returned_total_money) ? [{ label: returnsCopy.returned, value: money(summary.returned_total_money) }] : []),
    ...(!isZero(summary.replacement_total_money) ? [{ label: returnsCopy.replacement, value: money(summary.replacement_total_money) }] : []),
    ...(!isZero(summary.credit_money) ? [{ label: returnsCopy.creditApplied, value: money(summary.credit_money) }] : []),
    ...(!isZero(summary.refunded_money) ? [{ label: returnsCopy.refunded, value: money(summary.refunded_money) }] : []),
    ...(!isZero(summary.due_from_buyer_money) ? [{ label: returnsCopy.balanceDue, value: money(summary.due_from_buyer_money, { testid: 'ac-return-balance' }), strong: true }] : []),
  ];

  const main = html`${pageHeader(fill(returnsCopy.number, { number: ret.return_number }), {
    subtitle: ret.created_at ? `Requested ${fmt.date(ret.created_at)}` : undefined,
    testid: 'ac-return-title',
  })}
    <div class="status-line">
      ${badge(status.label, status.tone, { 'data-state': state, 'data-testid': 'ac-return-status' })}
      <p class="status-note" data-testid="ac-return-status-note">${returnsCopy.statusExplain[state] ?? ''}</p>
    </div>
    <div class="actions-row">
      ${payBalance ? linkButton(`${base}/pay`, fill(returnsCopy.duePayBalance, { amount: fmt.money(summary.due_from_buyer_money) }), { variant: 'primary', testid: 'ac-return-pay' }) : ''}
      ${withdraw ? dialogTrigger('withdraw-dialog', returnsCopy.withdraw, { variant: 'danger', testid: 'ac-return-withdraw' }) : ''}
      ${labels.map(({ url }) => externalLink(url ?? '', returnsCopy.returnLabelLink, { testid: 'ac-return-label' }))}
    </div>
    ${
      !closed
        ? card(html`<h2 id="next-title">${returnsCopy.whatNext}</h2>${hasNext ? html`<ul class="next-steps">${nextSteps}</ul>` : html`<p class="muted">${returnsCopy.nothingNext}</p>`}`, { labelledBy: 'next-title', testid: 'ac-return-next' })
        : state === 'declined'
          ? card(html`<p>${returnsCopy.statusExplain.declined}</p>${supportContact(ctx.support)}`, { testid: 'ac-return-declined' })
          : ''
    }
    ${card(html`<h2 id="return-items">${returnsCopy.items}</h2>${itemsList}`, { labelledBy: 'return-items' })}
    ${rows.length ? card(html`<h2 id="return-summary">${returnsCopy.summary}</h2>${amountRows(rows)}`, { labelledBy: 'return-summary', testid: 'ac-return-summary' }) : ''}
    ${packages.status === 'error' ? sectionError('return packages', packages.error, base, 'ac-return-packages-error') : ''}
    <p class="back-link"><a href="${path('/orders', ret.order_id)}">Back to order</a></p>
    ${
      withdraw
        ? confirmDialog({
            id: 'withdraw-dialog',
            title: returnsCopy.withdrawConfirmTitle,
            body: returnsCopy.withdrawConfirm,
            action: `${base}/withdraw`,
            csrf: ctx.csrf,
            confirmLabel: returnsCopy.withdrawYes,
            cancelLabel: returnsCopy.withdrawNo,
            danger: true,
            testid: 'ac-return-withdraw-dialog',
            confirmTestid: 'ac-return-withdraw-confirm',
          })
        : ''
    }`;
  void countOf;
  return renderDocument(ctx, { pageId: 'ac-return', title: fill(returnsCopy.number, { number: ret.return_number }), testid: 'ac-return', main, nav: 'returns' });
}
