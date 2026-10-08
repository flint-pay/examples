import { html, raw } from 'hono/html';
import { copy, fill, message } from '../../copy.ts';
import { csrfField, money, noticeList, type Html } from '../components.ts';
import { formatMoney, multiplyMoney } from '../format.ts';
import { shell } from '../layout.ts';
import { variantLabel } from './catalog.ts';
import type { CartData, CartLine, PageContext } from '../types.ts';

function lineView(ctx: PageContext<CartData>, line: CartLine, locked: boolean): Html {
  const name = line.item.product.name;
  const variantName = line.item.variants.length > 1 ? variantLabel(line.variant) : '';
  const unit = line.variant.unit_price_money;
  const total = unit ? multiplyMoney(unit, line.quantity) : null;
  const id = line.line_id;
  return html`<li class="cart-line" data-testid="sf-cart-line-${id}">
    <img class="cart-image" src="/images/${line.item.slug}.svg" alt="" width="96" height="72" loading="lazy">
    <div class="cart-name">
      <a class="cart-title" href="/products/${line.item.slug}">${name}</a>
      ${variantName ? html`<span class="cart-variant">${variantName}</span>` : ''}
      <span class="cart-unit">${money(unit, formatMoney(unit))}</span>
    </div>
    <div class="cart-controls">
      ${locked
        ? html`<p class="cart-quantity-static">${copy.cart.quantity} <strong data-testid="sf-cart-quantity-${id}">${line.quantity}</strong></p>`
        : html`<form method="post" action="/cart/items/${id}" class="inline-form quantity-form">
        ${csrfField(ctx)}
        <label for="qty-${id}" class="visually-hidden">${fill(copy.cart.updateLabel, { name })}</label>
        <input id="qty-${id}" name="quantity" type="number" min="1" max="20" step="1" inputmode="numeric" value="${line.quantity}" required data-testid="sf-cart-quantity-${id}">
        <button class="button button-small" type="submit" aria-label="${fill(copy.cart.updateLabel, { name })}">${copy.cart.update}</button>
      </form>
      <form method="post" action="/cart/items/${id}/remove" class="inline-form">
        ${csrfField(ctx)}
        <button class="button button-quiet button-small" type="submit" aria-label="${fill(copy.cart.removeLabel, { name })}" data-testid="sf-cart-remove-${id}">${copy.cart.remove}</button>
      </form>`}
    </div>
    <p class="cart-total">${money(total, formatMoney(total))}</p>
  </li>`;
}

export function cartPage(ctx: PageContext<CartData>): Html {
  const { cart, locked, checkoutRef } = ctx.data;
  const empty = cart.lines.length === 0;
  const state = empty ? 'empty' : locked ? 'locked' : 'filled';
  const lockedKey = 'cart_locked_payment';
  const noticesCarryLock = ctx.notices.some((raw) => raw.split(':')[0] === lockedKey);
  const main = html`
    ${noticeList(ctx)}
    <h1>${copy.cart.title}</h1>
    ${empty
      ? html`<section class="state-panel" data-testid="sf-cart-empty"><p>${copy.cart.emptyBody}</p><a class="button button-primary" href="/#shop">${copy.cart.shop}</a></section>`
      : html`
    ${locked && !noticesCarryLock ? html`<p class="notice notice-warning" role="status" data-testid="sf-cart-locked">${message(lockedKey)}</p>` : ''}
    <div class="cart-layout">
      <ul class="cart-lines" role="list">${cart.lines.map((line) => lineView(ctx, line, locked === true))}</ul>
      <aside class="cart-summary" aria-labelledby="cart-summary-title">
        <h2 id="cart-summary-title">${copy.cart.summary}</h2>
        <p class="summary-row"><span>${copy.cart.subtotal}</span> ${money(cart.subtotal_money, formatMoney(cart.subtotal_money), 'sf-cart-subtotal')}</p>
        ${locked && checkoutRef
          ? html`<a class="button button-primary button-block" href="/checkout/${checkoutRef}" data-testid="sf-checkout-start">${copy.cart.returnToPayment}</a><p class="hint">${copy.cart.lockedBody}</p>`
          : html`<form method="post" action="/checkout">${csrfField(ctx)}<button class="button button-primary button-block" type="submit" data-testid="sf-checkout-start">${copy.cart.checkOut}</button></form>`}
      </aside>
    </div>`}`;
  return shell(ctx, { pageId: 'sf-cart', title: copy.cart.title, main, testid: 'sf-cart', state });
}
