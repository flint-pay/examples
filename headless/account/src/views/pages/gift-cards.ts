import { html } from 'hono/html';
import { browserCopy, errorMessage, fill, giftCards as copy } from '../../copy.ts';
import {
  attrs,
  badge,
  button,
  card,
  confirmDialog,
  dialogTrigger,
  emptyState,
  errorSummary,
  field,
  fmtFor,
  hiddenInput,
  jsonBlock,
  linkButton,
  money,
  pageHeader,
  postForm,
  sectionError,
  timeEl,
  type Html,
} from '../components.ts';
import { path } from '../format.ts';
import { renderDocument } from '../layout.ts';
import type { BuyerGiftCard, GiftCardAddData, GiftCardData, GiftCardsData, RenderContext } from '../types.ts';

function giftStatusTone(status: BuyerGiftCard['status']) {
  return status === 'active' ? 'good' : status === 'frozen' ? 'warn' : 'neutral';
}

export function giftCardsPage(ctx: RenderContext<GiftCardsData>): Html {
  const { gift_cards } = ctx.data;
  let body: Html;
  if (gift_cards.status === 'error') {
    body = sectionError('your gift cards', gift_cards.error, '/gift-cards', 'ac-gift-cards-error');
  } else if (!gift_cards.value.items.length) {
    body = emptyState(copy.empty, linkButton('/gift-cards/add', copy.add, { variant: 'primary', testid: 'ac-gift-card-add' }), 'ac-gift-cards-empty');
  } else {
    body = html`<ul class="rows" data-state="loaded">${gift_cards.value.items.map(
      (giftCard) => html`<li class="row" data-testid="ac-gift-card-${giftCard.gift_card_id}">
        <a class="row-link" href="${path('/gift-cards', giftCard.gift_card_id)}"><span class="row-title">${fill(copy.masked, { last: giftCard.last_characters })}</span><span class="row-meta">${copy.available} ${money(giftCard.available_money)}</span></a>
        <span class="row-end">${badge(copy.statuses[giftCard.status] ?? giftCard.status, giftStatusTone(giftCard.status), { 'data-state': giftCard.status })}</span>
      </li>`,
    )}</ul>
    <p>${linkButton('/gift-cards/add', copy.add, { variant: 'primary', testid: 'ac-gift-card-add' })}</p>`;
  }
  const main = html`${pageHeader(copy.title, { testid: 'ac-gift-cards-title' })}
    ${card(html`${body}<p class="hint" data-testid="ac-gift-cards-note">${copy.note}</p>`, { testid: 'ac-gift-cards-list' })}`;
  return renderDocument(ctx, { pageId: 'ac-gift-cards', title: copy.title, testid: 'ac-gift-cards', main, nav: 'gift-cards' });
}

export function giftCardAddPage(ctx: RenderContext<GiftCardAddData>): Html {
  const tab = ctx.data.tab === 'link' ? 'link' : 'code';
  const errors = ctx.error?.field_errors;
  const boot = { copy: browserCopy.giftCardAdd, tab };
  const main = html`${pageHeader(copy.addTitle, { subtitle: copy.note, testid: 'ac-gift-card-add-title' })}
    ${errorSummary(ctx.error, { code: copy.codeLabel })}
    <section class="card" data-gift-add data-state="${tab}" data-testid="ac-gift-card-add-card">
      <div class="tabs js-only" role="tablist" aria-label="${copy.addTitle}">
        <button type="button" role="tab" id="tab-code" aria-controls="panel-code" aria-selected="${tab === 'code'}" tabindex="${tab === 'code' ? '0' : '-1'}" data-tab="code" class="tab">${copy.tabCode}</button>
        <button type="button" role="tab" id="tab-link" aria-controls="panel-link" aria-selected="${tab === 'link'}" tabindex="${tab === 'link' ? '0' : '-1'}" data-tab="link" class="tab">${copy.tabLink}</button>
      </div>
      <div role="tabpanel" id="panel-code" aria-labelledby="tab-code" data-panel="code"${attrs({ hidden: tab !== 'code' })}>
        <h2 class="no-js-only">${copy.tabCode}</h2>
        ${postForm(
          { action: '/gift-cards', csrf: ctx.csrf, testid: 'ac-gift-card-code-form' },
          html`${hiddenInput('credential_type', 'code')}
            ${field({ name: 'code', label: copy.codeLabel, autocomplete: 'off', required: true, spellcheck: false, errors, testid: 'ac-gift-card-add-code', sensitive: true, attributes: { autocapitalize: 'characters' } })}
            <div class="form-actions">${button({ label: copy.submit, type: 'submit', variant: 'primary', testid: 'ac-gift-card-code-submit' })}</div>`,
        )}
      </div>
      <div role="tabpanel" id="panel-link" aria-labelledby="tab-link" data-panel="link"${attrs({ hidden: tab !== 'link' })}>
        <h2 class="no-js-only">${copy.tabLink}</h2>
        <p class="alert alert-warn no-js-only" role="note">${copy.linkNeedsJs}</p>
        <form method="post" action="/gift-cards" class="js-only" data-gift-link-form data-testid="ac-gift-card-link-form" novalidate>
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <input type="hidden" name="credential_type" value="recipient_access" data-link-type>
          <input type="hidden" name="grant_id" value="" data-link-grant>
          <input type="hidden" name="recipient_access_token" value="" data-link-token>
          <div class="field" data-link-field>
            <label for="gift-link">${copy.linkLabel}</label>
            <p class="hint" id="gift-link-hint">${copy.linkHint}</p>
            <input id="gift-link" type="text" inputmode="url" autocomplete="off" spellcheck="false" autocapitalize="none" aria-describedby="gift-link-hint" data-testid="ac-gift-card-add-link" data-sensitive="true" data-link-input>
            <p class="field-error" id="gift-link-error" data-link-error data-testid="ac-gift-card-link-error" role="alert" hidden></p>
          </div>
          <div class="form-actions">${button({ label: copy.submit, type: 'submit', variant: 'primary', testid: 'ac-gift-card-link-submit' })}</div>
        </form>
      </div>
    </section>
    ${jsonBlock('gift-add-boot', boot)}
    <p class="back-link"><a href="/gift-cards">${copy.title}</a></p>`;
  void errorMessage;
  return renderDocument(ctx, { pageId: 'ac-gift-card-add', title: copy.addTitle, testid: 'ac-gift-card-add-page', main, nav: 'gift-cards', scripts: ['/js/gift-card-add.js'] });
}

export function giftCardPage(ctx: RenderContext<GiftCardData>): Html {
  const { gift_card: giftCard, transactions } = ctx.data;
  const fmt = fmtFor(ctx);
  if (!giftCard) {
    const main = html`${pageHeader(copy.title, { testid: 'ac-gift-card-title' })}
      ${card(html`<p data-testid="ac-gift-card-missing">${copy.removedByCodeChange}</p><p>${linkButton('/gift-cards/add', copy.add, { variant: 'primary' })} ${linkButton('/gift-cards', copy.title)}</p>`, { testid: 'ac-gift-card-removed' })}`;
    return renderDocument(ctx, { pageId: 'ac-gift-card', title: copy.title, testid: 'ac-gift-card', main, nav: 'gift-cards' });
  }
  const base = path('/gift-cards', giftCard.gift_card_id);
  const history =
    transactions.status === 'error'
      ? sectionError('the history', transactions.error, base, 'ac-gift-card-history-error')
      : transactions.value.length
        ? html`<ul class="rows" data-testid="ac-gift-card-history">${transactions.value.map(
            (tx, index) => html`<li class="row" data-testid="ac-gift-card-tx-${index + 1}">
              <span class="row-title">${copy.transactionTypes[tx.transaction_type] ?? 'Updated'}</span>
              <span class="row-meta">${timeEl(tx.posted_at, ctx)}, ${fill(copy.balanceAfter, { amount: fmt.money(tx.balance_after_money) })}</span>
              <span class="row-end">${money(tx.amount_money)}</span>
            </li>`,
          )}</ul>`
        : html`<p class="muted">${copy.historyEmpty}</p>`;
  const main = html`${pageHeader(fill(copy.masked, { last: giftCard.last_characters }), { testid: 'ac-gift-card-title' })}
    <div class="status-line">${badge(copy.statuses[giftCard.status] ?? giftCard.status, giftStatusTone(giftCard.status), { 'data-state': giftCard.status, 'data-testid': 'ac-gift-card-status' })}</div>
    ${card(
      html`<dl class="facts" data-testid="ac-gift-card-balances">
        <div class="fact fact-strong"><dt>${copy.available}</dt><dd>${money(giftCard.available_money, { testid: 'ac-gift-card-available', className: 'money-large' })}</dd></div>
        <div class="fact"><dt>${copy.balance}</dt><dd>${money(giftCard.balance_money, { testid: 'ac-gift-card-balance' })}</dd></div>
        <div class="fact"><dt>${copy.reserved}</dt><dd>${money(giftCard.reserved_money, { testid: 'ac-gift-card-reserved' })}</dd></div>
      </dl>
      <p class="actions-row">${linkButton(base, copy.refresh, { testid: 'ac-gift-card-refresh' })}${dialogTrigger('remove-gift-card', copy.remove, { variant: 'danger', testid: 'ac-gift-card-remove' })}</p>
      <p class="hint">${copy.note}</p>`,
      { testid: 'ac-gift-card-details' },
    )}
    ${card(html`<h2 id="gc-history">${copy.history}</h2>${history}`, { labelledBy: 'gc-history' })}
    ${confirmDialog({ id: 'remove-gift-card', title: copy.removeTitle, body: copy.removeConfirm, action: `${base}/remove`, csrf: ctx.csrf, confirmLabel: copy.removeYes, cancelLabel: copy.removeNo, danger: true, confirmTestid: 'ac-gift-card-remove-confirm' })}
    <p class="back-link"><a href="/gift-cards">${copy.title}</a></p>`;
  return renderDocument(ctx, { pageId: 'ac-gift-card', title: copy.title, testid: 'ac-gift-card', main, nav: 'gift-cards' });
}
