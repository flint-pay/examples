import { html, raw } from 'hono/html';
import { copy, fill, intervalUnit, message } from '../../copy.ts';
import { csrfField, noticeList, pageError, type Html } from '../components.ts';
import { formatMoney, multiplyMoney, slugify, sumMoney } from '../format.ts';
import { shell } from '../layout.ts';
import type { CatalogItem, HomeData, Money, PageContext, PlanItem, ProductData, ProductVariant, SubscribeData, SubscriptionPlan } from '../types.ts';

export function priceLabel(item: CatalogItem): string {
  const range = item.product.price_range;
  const min = range?.min_unit_price_money ?? item.variants[0]?.unit_price_money ?? null;
  const max = range?.max_unit_price_money ?? min;
  if (!min) return '';
  if (max && max.amount !== min.amount) return fill(copy.home.from, { price: formatMoney(min) });
  return formatMoney(min);
}

export function variantLabel(variant: ProductVariant): string {
  return variant.name ?? variant.selected_options?.map((option) => option.value).join(', ') ?? '';
}

/** Recurring price of a plan: the sum of its line items. Display only; Flint prices the order. */
export function planRecurring(plan: SubscriptionPlan): Money | null {
  const lines = plan.line_items ?? [];
  if (!lines.length) return null;
  const parts: (Money | null)[] = lines.map((line) => (line.unit_price_money ? multiplyMoney(line.unit_price_money, line.quantity) : null));
  return sumMoney(parts);
}

export function planBilling(plan: SubscriptionPlan): string {
  const price = formatMoney(planRecurring(plan));
  const count = plan.billing_interval_count;
  const unit = intervalUnit(plan.billing_interval, count);
  if (!price) return '';
  const every = count === 1 ? { price, unit } : { price, unit, count };
  if (plan.trial_period_days) {
    return fill(count === 1 ? copy.home.afterTrial : copy.home.afterTrialMany, { ...every, days: plan.trial_period_days });
  }
  return fill(count === 1 ? copy.home.perIntervalOne : copy.home.perInterval, every);
}

function productCard(item: CatalogItem): Html {
  const name = item.product.name;
  return html`<li class="card" data-testid="sf-product-card-${item.slug}">
    <a class="card-link" href="/products/${item.slug}" aria-label="${fill(copy.home.viewProduct, { name })}">
      <img class="card-image" src="/images/${item.slug}.svg" alt="" width="640" height="480" loading="lazy">
      <span class="card-body">
        <span class="card-title">${name}</span>
        <span class="card-price money">${priceLabel(item)}</span>
      </span>
    </a>
  </li>`;
}

function planCard(item: PlanItem): Html {
  const { plan, slug } = item;
  return html`<li class="card plan-card" data-testid="sf-plan-card-${slug}">
    <div class="card-body">
      <h3 class="card-title">${plan.name}</h3>
      <p class="plan-billing">${planBilling(plan)}</p>
      ${plan.trial_period_days ? html`<p class="plan-trial">${fill(copy.home.trialNote, { days: plan.trial_period_days })}</p>` : ''}
      <a class="button button-primary" href="/subscribe/${slug}" aria-label="${copy.home.subscribe}: ${plan.name}">${copy.home.subscribe}</a>
    </div>
  </li>`;
}

export function homePage(ctx: PageContext<HomeData>): Html {
  const { data } = ctx;
  const failed = data.loadFailed === true;
  const empty = !failed && (data.setupNeeded === true || (data.products.length === 0 && data.plans.length === 0));
  const state = failed ? 'error' : empty ? 'empty_setup_needed' : 'loaded';
  const cardsNotReady = data.cards !== undefined && data.cards !== 'ready';
  const main = html`
    ${noticeList(ctx)}
    ${cardsNotReady ? html`<p class="notice notice-warning" role="status" data-testid="sf-cards-not-ready">${copy.home.cardsNotReady}</p>` : ''}
    <section class="hero" aria-labelledby="hero-title">
      <h1 id="hero-title">${copy.home.heroTitle}</h1>
      <p class="lead">${copy.home.heroBody}</p>
    </section>
    ${failed
      ? html`<section class="state-panel" data-testid="sf-home-error" aria-labelledby="home-error-title"><h2 id="home-error-title" class="visually-hidden">${copy.home.shopHeading}</h2><p role="alert">${copy.home.errorBody}</p><a class="button" href="/">${copy.home.tryAgain}</a></section>`
      : empty
        ? html`<section class="state-panel" data-testid="sf-setup-needed" aria-labelledby="setup-title"><h2 id="setup-title">${copy.home.setupNeededTitle}</h2><p>${copy.home.setupNeededBody}</p></section>`
        : html`
    ${data.products.length ? html`<section id="shop" aria-labelledby="shop-title" class="section">
      <h2 id="shop-title">${copy.home.shopHeading}</h2>
      <ul class="grid" role="list">${data.products.map(productCard)}</ul>
    </section>` : ''}
    ${data.plans.length ? html`<section id="coffee-club" aria-labelledby="club-title" class="section">
      <h2 id="club-title">${copy.home.clubHeading}</h2>
      <p>${copy.home.clubBody}</p>
      <ul class="grid grid-plans" role="list">${data.plans.map(planCard)}</ul>
    </section>` : ''}`}`;
  return shell(ctx, { pageId: 'sf-home', title: copy.home.heroTitle, main, testid: 'sf-home', state });
}

export function productPage(ctx: PageContext<ProductData>): Html {
  const { item, loadFailed } = ctx.data;
  if (loadFailed) {
    const main = html`${noticeList(ctx)}<section class="state-panel" data-testid="sf-product-error"><h1>${copy.product.errorBody}</h1><a class="button" href="${ctx.path ?? '/'}">${copy.product.tryAgain}</a></section>`;
    return shell(ctx, { pageId: 'sf-product', title: copy.product.errorBody, main, testid: 'sf-product', state: 'error' });
  }
  if (!item) {
    const main = html`${noticeList(ctx)}<section class="state-panel" data-testid="sf-product-not-found"><h1>${copy.product.notFoundTitle}</h1><p>${copy.product.notFoundBody}</p><a class="button" href="/#shop">${copy.product.backToShop}</a></section>`;
    return shell(ctx, { pageId: 'sf-product', title: copy.product.notFoundTitle, main, testid: 'sf-product', state: 'not_found' });
  }
  const variants = item.variants.filter((variant) => variant.available_for_sale !== false);
  const showGroup = item.variants.length > 1;
  const first = variants[0] ?? item.variants[0];
  const sellable = variants.length > 0;
  const main = html`
    ${noticeList(ctx)}
    <nav class="breadcrumb" aria-label="Breadcrumb"><a href="/#shop">${copy.home.shopHeading}</a></nav>
    <div class="product">
      <img class="product-image" src="/images/${item.slug}.svg" alt="${item.product.name}" width="640" height="480">
      <div class="product-info">
        <h1>${item.product.name}</h1>
        <p class="product-price money" data-testid="sf-product-price">${priceLabel(item)}</p>
        ${item.product.description ? html`<p class="product-description">${item.product.description}</p>` : ''}
        ${sellable
          ? html`<form method="post" action="/cart/items" class="stack" data-add-to-cart data-added="${message('added_to_cart')}" data-testid="sf-add-form">
          ${csrfField(ctx)}
          <input type="hidden" name="product_slug" value="${item.slug}">
          ${showGroup
            ? html`<fieldset class="choice-group"><legend>${copy.product.variant}</legend>
              ${item.variants.map((variant) => {
                const slug = slugify(variantLabel(variant));
                const disabled = variant.available_for_sale === false;
                const checked = first && variant.variant_id === first.variant_id;
                return html`<label class="choice"><input type="radio" name="variant_id" value="${variant.variant_id}" ${checked ? raw('checked') : raw('')} ${disabled ? raw('disabled') : raw('')} data-testid="sf-variant-${slug}"><span>${variantLabel(variant)}</span></label>`;
              })}
            </fieldset>`
            : html`<input type="hidden" name="variant_id" value="${first?.variant_id ?? ''}">`}
          <div class="field field-narrow">
            <label for="quantity">${copy.product.quantity}</label>
            <input id="quantity" name="quantity" type="number" min="1" max="20" step="1" value="1" inputmode="numeric" required data-testid="sf-quantity">
          </div>
          <div class="actions">
            <button class="button button-primary" type="submit" data-testid="sf-add-to-cart">${copy.product.addToCart}</button>
            <a class="button-link" href="/cart">${copy.product.inCart}</a>
          </div>
          <p class="add-status" role="status" data-add-status data-testid="sf-add-status"></p>
        </form>`
          : html`<p class="notice notice-warning" role="status">${copy.product.unavailable}</p>`}
      </div>
    </div>`;
  return shell(ctx, { pageId: 'sf-product', title: item.product.name, main, testid: 'sf-product', state: 'loaded' });
}

export function subscribePage(ctx: PageContext<SubscribeData>): Html {
  const { item, loadFailed } = ctx.data;
  if (loadFailed) {
    const main = html`${noticeList(ctx)}<section class="state-panel" data-testid="sf-subscribe-error"><h1>${copy.subscribe.errorBody}</h1><a class="button" href="${ctx.path ?? '/'}">${copy.home.tryAgain}</a></section>`;
    return shell(ctx, { pageId: 'sf-subscribe', title: copy.subscribe.errorBody, main, testid: 'sf-subscribe', state: 'error' });
  }
  if (!item) {
    const main = html`${noticeList(ctx)}<section class="state-panel" data-testid="sf-subscribe-not-found"><h1>${copy.subscribe.notFoundTitle}</h1><p>${copy.subscribe.notFoundBody}</p><a class="button" href="/#coffee-club">${copy.subscribe.backToClub}</a></section>`;
    return shell(ctx, { pageId: 'sf-subscribe', title: copy.subscribe.notFoundTitle, main, testid: 'sf-subscribe', state: 'not_found' });
  }
  const { plan, slug } = item;
  const main = html`
    ${noticeList(ctx)}
    ${pageError(ctx.error, ctx)}
    <section class="narrow stack" aria-labelledby="subscribe-title">
      <h1 id="subscribe-title">${copy.subscribe.title}</h1>
      <p class="lead">${copy.subscribe.confirmLead}</p>
      <dl class="facts">
        <div><dt>${copy.subscribe.plan}</dt><dd data-testid="sf-subscribe-plan">${plan.name}</dd></div>
        <div><dt>${copy.subscribe.billing}</dt><dd data-testid="sf-subscribe-billing">${planBilling(plan)}</dd></div>
        ${plan.trial_period_days ? html`<div><dt>Trial</dt><dd>${fill(copy.home.trialNote, { days: plan.trial_period_days })}</dd></div>` : ''}
      </dl>
      <p>${copy.subscribe.cancelNote}</p>
      <form method="post" action="/subscribe/${slug}" class="actions">
        ${csrfField(ctx)}
        <button class="button button-primary" type="submit" data-testid="sf-subscribe-continue">${copy.subscribe.continue}</button>
        <a class="button-link" href="/#coffee-club">${copy.subscribe.backToClub}</a>
      </form>
    </section>`;
  return shell(ctx, { pageId: 'sf-subscribe', title: copy.subscribe.title, main, testid: 'sf-subscribe', state: 'loaded' });
}
