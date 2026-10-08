import { html, raw } from 'hono/html';
import {
  attemptIsOpen,
  buttonKind,
  declineCode,
  deliveryMode,
  deliveryModes,
  deliveryState,
  derivePaymentState,
  guidanceOf,
  isExpired,
  isSettlementOnly,
  collectionKindOf,
  pickupNoneNearby,
  pickupOptions,
  needsProcessor,
  outstandingOf,
  processorMoney,
  serverBlockers,
  showDelivery,
  tipChoice,
  tipVisible,
  TIP_PERCENTS,
} from '../../../public/js/checkout-logic.js';
import { browserMessages, copy, declineMessage, fill, hasMessage, intervalUnit, message, parseNotice } from '../../copy.ts';
import { csrfField, field, money, noticeList, type Html } from '../components.ts';
import { addressLine, formatDay, formatMoney, isPositive, isZero, minorToDecimal } from '../format.ts';
import { shell } from '../layout.ts';
import { scrubForBrowser, jsonForScript } from '../scrub.ts';
import type {
  Address,
  CheckoutData,
  CheckoutState,
  DeliveryOption,
  Money,
  PageContext,
  SavedMethod,
} from '../types.ts';

type Ctx = PageContext<CheckoutData>;

const STRIPE_JS = 'https://js.stripe.com/v3/';

function ref(state: CheckoutState): string {
  return state.checkout_ref;
}

function path(state: CheckoutState, suffix: string): string {
  return `/checkout/${encodeURIComponent(state.checkout_ref)}${suffix}`;
}

function formatOrDash(value: Money | null | undefined): string {
  return value ? formatMoney(value) : '';
}

// ----- Contact -----

function contactValues(state: CheckoutState, user?: { name: string; email: string } | null): { name: string; email: string; phone: string; locked: boolean } {
  const contact = state.order.buyer_contact ?? state.session.buyer_contact ?? null;
  const prefill = state.session.customer_prefill ?? null;
  // A signed-in buyer whose order is bound to a Flint customer checks out with the account email.
  const locked = Boolean(user && state.order.customer_id);
  const email = locked ? user!.email : (contact?.email ?? (contact?.is_email_cleared ? '' : (prefill?.email ?? '')));
  const phone = contact?.phone ?? '';
  const name = state.contact_name ?? state.delivery_selection?.recipient?.name ?? prefill?.shipping_recipient_name ?? (locked ? user!.name : '');
  return { name, email, phone, locked };
}

function verificationForm(state: CheckoutState): Html {
  const v = state.verification;
  if (!v || v.status !== 'code_sent') return html``;
  const sms = v.delivery_channel === 'sms';
  const prompt = sms
    ? message('returning_code_sms', { digits: v.phone_last_digits })
    : message('returning_code_email', { email: v.masked_email });
  return html`<form class="verification" method="post" action="${path(state, '/verification/confirm')}" data-job-form="verification-confirm" novalidate data-testid="sf-returning">
    <p id="returning-prompt">${prompt}</p>
    ${field({ id: 'returning-code', name: 'code', label: copy.checkout.returningCode, required: true, autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: 6, testid: 'sf-returning-code', sensitive: true })}
    <div class="actions">
      <button class="button" type="submit" data-testid="sf-returning-confirm">${copy.checkout.returningConfirm}</button>
      ${sms ? html`<button class="button button-quiet" type="button" data-returning-email data-testid="sf-returning-email">${copy.checkout.returningEmailInstead}</button>` : ''}
      <button class="button button-quiet" type="button" data-returning-skip data-testid="sf-returning-skip">${copy.checkout.returningSkip}</button>
    </div>
  </form>`;
}

function contactSection(ctx: Ctx): Html {
  const state = ctx.data.state;
  const values = contactValues(state, ctx.user);
  const needsPhone = (state.delivery_selection?.input_requirements ?? []).some((item) => item.field_path.includes('phone'));
  return html`<section class="section checkout-section" id="contact" aria-labelledby="contact-title" data-section="contact">
    <h2 id="contact-title">${copy.checkout.contactHeading}</h2>
    <form method="post" action="${path(state, '/contact')}" data-job-form="contact" novalidate class="stack" data-testid="sf-contact">
      ${field({ id: 'contact-name', name: 'name', label: copy.checkout.fullName, value: values.name, required: true, autocomplete: 'name', testid: 'sf-contact-name' })}
      ${values.locked
        ? html`<div class="field"><label for="contact-email">${copy.checkout.email}</label><p class="hint">${fill(message('contact_signed_in_as'), { email: values.email })}</p><input id="contact-email" name="email" type="email" value="${values.email}" readonly autocomplete="email" data-testid="sf-contact-email"></div>`
        : field({ id: 'contact-email', name: 'email', label: copy.checkout.email, type: 'email', value: values.email, required: true, autocomplete: 'email', testid: 'sf-contact-email' })}
      ${field({ id: 'contact-phone', name: 'phone', label: needsPhone ? copy.checkout.phoneDelivery : copy.checkout.phone, type: 'tel', value: values.phone, autocomplete: 'tel', inputmode: 'tel', required: needsPhone, hint: copy.checkout.phoneHint, testid: 'sf-contact-phone' })}
    </form>
    <div data-region="contact-extra" aria-live="polite">${verificationForm(state)}<p class="field-error" role="alert" data-job-error="verification" hidden></p></div>
  </section>`;
}

// ----- Discount -----

function discountSection(ctx: Ctx): Html {
  const state = ctx.data.state;
  if (state.session.promotion_config?.codes_enabled === false) return html`<div data-region="discount"></div>`;
  const applied = state.order.applied_discounts ?? [];
  return html`<section class="section checkout-section" id="discount" data-region="discount" aria-labelledby="discount-title" data-section="discount">
    <h2 id="discount-title">${copy.checkout.discountHeading}</h2>
    <form method="post" action="${path(state, '/discount')}" data-job-form="discount" novalidate class="inline-field" data-testid="sf-discount">
      ${field({ id: 'discount-code', name: 'promotion_code', label: copy.checkout.discountCode, autocomplete: 'off', testid: 'sf-discount-code' })}
      <button class="button" type="submit" data-testid="sf-discount-apply">${copy.checkout.discountApply}</button>
    </form>
    <p class="field-error" role="alert" data-job-error="discount" hidden></p>
    ${applied.length
      ? html`<ul class="applied-list" role="list" aria-label="${copy.checkout.discountApplied}">${applied.map((discount, index) => {
          const label = discount.customer_facing_name ?? discount.promotion_code ?? copy.checkout.discountHeading;
          return html`<li data-testid="sf-discount-applied-${index}">
            <span class="applied-name">${label}${discount.promotion_code && discount.customer_facing_name ? html` <span class="code">${discount.promotion_code}</span>` : ''}</span>
            <span class="applied-amount">${money(discount.applied_money, `-${formatOrDash(discount.applied_money)}`)}</span>
            ${discount.promotion_code
              ? html`<form method="post" action="${path(state, '/discount/remove')}" data-job-form="discount-remove" class="inline-form"><input type="hidden" name="order_discount_id" value="${discount.order_discount_id}"><button class="button button-quiet button-small" type="submit" aria-label="${fill(copy.checkout.discountRemoveLabel, { name: label })}">${copy.checkout.discountRemove}</button></form>`
              : ''}
          </li>`;
        })}</ul>`
      : ''}
  </section>`;
}

// ----- Delivery -----

function optionLabel(option: DeliveryOption): { title: string; detail: Html | string; price: Html } {
  const price = option.amount_money && isZero(option.amount_money) ? copy.checkout.free : formatOrDash(option.amount_money);
  if (option.type === 'pickup') {
    const location = option.pickup?.location;
    const address = addressLine(location?.address);
    return {
      title: location?.name ?? option.name,
      detail: html`${address}${location?.instructions ? html`<span class="option-note">${location.instructions}</span>` : ''}`,
      price: money(option.amount_money, price),
    };
  }
  const estimate = option.arrival_estimate;
  const arrives = estimate
    ? estimate.earliest_date === estimate.latest_date
      ? fill(copy.checkout.arrivesOn, { date: formatDay(estimate.earliest_date) })
      : fill(copy.checkout.arrives, { earliest: formatDay(estimate.earliest_date), latest: formatDay(estimate.latest_date) })
    : '';
  return { title: option.name, detail: arrives, price: money(option.amount_money, price) };
}

type ListGroup = { id: string; names: string[]; options: DeliveryOption[] };

function listGroups(state: CheckoutState, type: 'ship' | 'pickup'): ListGroup[] {
  const quoteGroups = state.delivery_quote?.choice_groups ?? [];
  const names = (id: string) => (quoteGroups.find((group) => group.delivery_choice_group_id === id)?.line_items ?? []).map((item) => item.name).filter((name): name is string => Boolean(name));
  if (type === 'pickup') {
    const grouped = new Map<string, DeliveryOption[]>();
    for (const item of pickupOptions(state)) grouped.set(item.delivery_choice_group_id, [...(grouped.get(item.delivery_choice_group_id) ?? []), item]);
    return [...grouped].map(([id, options]) => ({ id, names: names(id), options }));
  }
  return quoteGroups
    .map((group) => ({ id: group.delivery_choice_group_id, names: names(group.delivery_choice_group_id), options: group.options.filter((option) => option.type !== 'pickup') }))
    .filter((group) => group.options.length > 0);
}

/** Radios are numbered from 0 in display order across all groups. */
function optionsList(state: CheckoutState, type: 'ship' | 'pickup'): { html: Html; count: number; groups: number } {
  const groups = listGroups(state, type);
  let index = 0;
  const testid = type === 'pickup' ? 'sf-pickup-location' : 'sf-delivery-option';
  const body = groups.map((group) => {
    const legend =
      groups.length > 1
        ? group.names.length ? fill(copy.checkout.groupLegendItems, { items: group.names.join(', ') }) : copy.checkout.groupLegend
        : type === 'pickup' ? copy.checkout.pickupLegend : copy.checkout.optionsLegend;
    return html`<fieldset class="choice-group" data-group-id="${group.id}">
      <legend>${legend}</legend>
      ${group.options.map((option) => {
        const position = index;
        index += 1;
        const label = optionLabel(option);
        const id = `opt-${type}-${position}`;
        const optionId = option.delivery_option_id ?? option.delivery_method_id;
        return html`<label class="choice choice-option" for="${id}">
          <input id="${id}" type="radio" name="group-${group.id}" value="${optionId}" data-group-id="${group.id}" data-testid="${testid}-${position}">
          <span class="choice-text"><span class="choice-title">${label.title}</span>${label.detail ? html`<span class="choice-detail">${label.detail}</span>` : ''}</span>
          <span class="choice-price">${label.price}</span>
        </label>`;
      })}
    </fieldset>`;
  });
  return { html: html`${body}`, count: index, groups: groups.length };
}

function selectedSummary(state: CheckoutState): Html {
  const selection = state.delivery_selection;
  if (!selection) return html``;
  const choice = selection.choices[0];
  if (!choice) return html``;
  const price = selection.amount_money && isZero(selection.amount_money) ? copy.checkout.free : formatOrDash(selection.amount_money);
  const where = choice.type === 'pickup'
    ? fill(copy.checkout.pickupAt, { name: choice.pickup?.location?.name ?? choice.name })
    : fill(copy.checkout.shipTo, { name: selection.recipient?.name ?? '', address: addressLine(selection.destination_address) }).replace(/^Ship to ,\s*/, 'Ship to ');
  const estimate = choice.arrival_estimate
    ? fill(copy.checkout.arrives, { earliest: formatDay(choice.arrival_estimate.earliest_date), latest: formatDay(choice.arrival_estimate.latest_date) })
    : '';
  return html`<div class="selected-summary" data-testid="sf-delivery-selected" data-selection-id="${selection.delivery_selection_id}">
    <div>
      <p class="selected-title">${choice.name} ${money(selection.amount_money, price)}</p>
      <p class="selected-detail">${where}</p>
      ${estimate ? html`<p class="selected-detail">${estimate}</p>` : ''}
    </div>
    <button class="button button-quiet button-small" type="button" data-delivery-change aria-expanded="false" aria-controls="delivery-edit">${copy.checkout.change}</button>
  </div>`;
}

function deliverySection(ctx: Ctx): Html {
  const state = ctx.data.state;
  if (!showDelivery(state)) return html`<div data-region="delivery"></div>`;
  let stateName = deliveryState(state) ?? 'idle';
  const mode = deliveryMode(state);
  const modes = deliveryModes(state);
  const quote = state.delivery_quote;
  const prefill: Address = state.delivery_selection?.destination_address ?? quote?.destination_address ?? state.session.customer_prefill?.shipping_address ?? {};
  const recipient = state.delivery_selection?.recipient?.name ?? contactValues(state, ctx.user).name;
  const postal = quote?.buyer_location?.address?.postal_code ?? '';
  const ship = optionsList(state, 'ship');
  const pickup = optionsList(state, 'pickup');
  if (stateName === 'options' && ((mode === 'ship' && ship.count === 0) || (mode === 'pickup' && pickup.count === 0))) stateName = 'unavailable';
  if (stateName === 'unavailable' && mode === 'pickup' && pickupNoneNearby(state)) stateName = 'none_nearby';
  const selected = stateName === 'selected' || (stateName === 'needs_input' && state.delivery_selection !== null && state.delivery_selection !== undefined);
  const reasons = quote?.buyer_reasons ?? [];
  const retarget = stateName === 'stale';
  return html`<section class="section checkout-section" id="delivery" data-region="delivery" aria-labelledby="delivery-title" data-testid="sf-delivery" data-state="${stateName}" data-mode="${mode}" data-section="delivery"${retarget ? raw(' data-auto-requote="true"') : raw('')}>
    <h2 id="delivery-title" tabindex="-1">${copy.checkout.deliveryHeading}</h2>
    ${selected ? selectedSummary(state) : ''}
    ${stateName === 'needs_input' ? html`<p class="notice notice-warning" role="status" data-testid="sf-delivery-needs-input"><a href="#contact-phone" data-focus-phone>${message('delivery_phone_needed')}</a></p>` : ''}
    ${stateName === 'stale' ? html`<p class="notice notice-warning" role="status" data-testid="sf-delivery-stale">${message('delivery_prices_changed')}</p>` : ''}
    ${stateName === 'none_nearby' ? html`<p class="notice notice-warning" role="status" data-testid="sf-pickup-none">${fill(message('pickup_none_nearby'), { postal_code: postal })}</p>` : ''}
    ${stateName === 'unavailable' ? html`<div class="notice notice-warning" role="status" data-testid="sf-delivery-unavailable"><p>${message('delivery_unavailable')}</p>${reasons.length ? html`<ul>${reasons.map((reason) => html`<li>${reason}</li>`)}</ul>` : ''}</div>` : ''}
    <div id="delivery-edit" class="delivery-edit"${selected ? raw(' hidden') : raw('')}>
      ${modes.length > 1
        ? html`<fieldset class="choice-group" data-delivery-modes><legend>${copy.checkout.deliveryModeLegend}</legend>
        ${modes.includes('ship') ? html`<label class="choice"><input type="radio" name="delivery-mode" value="ship" ${mode === 'ship' ? raw('checked') : raw('')} data-testid="sf-delivery-mode-ship"><span>${copy.checkout.modeShip}</span></label>` : ''}
        ${modes.includes('pickup') ? html`<label class="choice"><input type="radio" name="delivery-mode" value="pickup" ${mode === 'pickup' ? raw('checked') : raw('')} data-testid="sf-delivery-mode-pickup"><span>${copy.checkout.modePickup}</span></label>` : ''}
      </fieldset>`
        : ''}
      ${modes.includes('ship')
        ? html`<div data-delivery-panel="ship"${mode === 'ship' ? raw('') : raw(' hidden')}>
        <form method="post" action="${path(state, '/delivery/quote')}" data-job-form="delivery-quote" novalidate class="stack address-form" data-testid="sf-delivery-address">
          ${field({ id: 'ship-name', name: 'recipient_name', label: copy.checkout.recipientName, value: recipient, required: true, autocomplete: 'shipping name', testid: 'sf-ship-name' })}
          ${field({ id: 'ship-line1', name: 'line1', label: copy.checkout.line1, value: prefill.line1 ?? '', required: true, autocomplete: 'shipping address-line1', testid: 'sf-ship-line1' })}
          ${field({ id: 'ship-line2', name: 'line2', label: copy.checkout.line2, value: prefill.line2 ?? '', autocomplete: 'shipping address-line2', testid: 'sf-ship-line2' })}
          <div class="field-row">
            ${field({ id: 'ship-city', name: 'city', label: copy.checkout.city, value: prefill.city ?? '', required: true, autocomplete: 'shipping address-level2', testid: 'sf-ship-city' })}
            ${field({ id: 'ship-state', name: 'state', label: copy.checkout.state, value: prefill.state ?? '', required: true, autocomplete: 'shipping address-level1', maxlength: 2, testid: 'sf-ship-state' })}
            ${field({ id: 'ship-postal', name: 'postal_code', label: copy.checkout.postalCode, value: prefill.postal_code ?? '', required: true, autocomplete: 'shipping postal-code', inputmode: 'numeric', testid: 'sf-ship-postal' })}
          </div>
          <p class="hint">${copy.checkout.country}: ${copy.checkout.countryUs}</p>
          <input type="hidden" name="country" value="US">
          <div class="actions"><button class="button" type="submit" data-testid="sf-delivery-quote">${copy.checkout.showDeliveryOptions}</button></div>
        </form>
        <div class="options-area" data-options-area="ship" aria-live="polite">
          ${ship.count
            ? html`<form method="post" action="${path(state, '/delivery/select')}" data-job-form="delivery-select" novalidate class="stack" data-testid="sf-delivery-options">${ship.html}<div class="actions"><button class="button button-primary" type="submit" data-testid="sf-delivery-choose">${copy.checkout.choose}</button></div></form>`
            : ''}
        </div>
      </div>`
        : ''}
      ${modes.includes('pickup')
        ? html`<div data-delivery-panel="pickup"${mode === 'pickup' ? raw('') : raw(' hidden')}>
        <form method="post" action="${path(state, '/pickup-locations')}" data-job-form="pickup-locations" novalidate class="stack" data-testid="sf-pickup-form">
          ${field({ id: 'pickup-postal', name: 'postal_code', label: copy.checkout.pickupPostal, value: postal, required: true, autocomplete: 'postal-code', inputmode: 'numeric', testid: 'sf-pickup-postal' })}
          <div class="actions"><button class="button" type="submit" data-testid="sf-pickup-search">${copy.checkout.findPickup}</button></div>
        </form>
        <div class="options-area" data-options-area="pickup" aria-live="polite">
          ${pickup.count
            ? html`<form method="post" action="${path(state, '/delivery/select')}" data-job-form="delivery-select" novalidate class="stack" data-no-autosubmit data-testid="sf-pickup-options">${pickup.html}<div class="actions"><button class="button button-primary" type="submit" data-testid="sf-pickup-select">${copy.checkout.pickupSelect}</button></div></form>`
            : ''}
        </div>
      </div>`
        : ''}
    </div>
    <p class="field-error" role="alert" data-job-error="delivery" hidden></p>
  </section>`;
}

// ----- Gift cards -----

function giftCardSection(ctx: Ctx): Html {
  const state = ctx.data.state;
  if (state.kind !== 'order' || state.order.gift_card_tender_enabled === false) return html`<div data-region="gift-cards"></div>`;
  const cards = state.order.gift_cards ?? [];
  const allocations = new Map((state.order.gift_card_estimate?.gift_cards ?? []).map((card) => [card.gift_card_id, card.amount_money]));
  return html`<section class="section checkout-section" id="gift-cards" data-region="gift-cards" aria-labelledby="gift-title" data-section="gift-cards">
    <h2 id="gift-title">${copy.checkout.giftCardHeading}</h2>
    <form method="post" action="${path(state, '/gift-card')}" data-job-form="gift-card" novalidate class="inline-field" data-testid="sf-gift-card">
      ${field({ id: 'gift-card-code', name: 'gift_card_code', label: copy.checkout.giftCardCode, autocomplete: 'off', testid: 'sf-gift-card-code', sensitive: true })}
      <button class="button" type="submit" data-testid="sf-gift-card-apply">${copy.checkout.giftCardApply}</button>
    </form>
    <p class="field-error" role="alert" data-job-error="gift-card" hidden></p>
    ${cards.length
      ? html`<ul class="applied-list" role="list" aria-label="${copy.checkout.giftCardApplied}">${cards.map((card, index) => {
          const amount = allocations.get(card.gift_card_id) ?? null;
          return html`<li data-testid="sf-gift-card-applied-${index}">
            <span class="applied-name">${fill(copy.checkout.giftCardEnding, { last: card.last_characters })}</span>
            <span class="applied-amount">${amount ? money(amount, fill(copy.checkout.giftCardAmount, { amount: formatMoney(amount) })) : ''}</span>
            <form method="post" action="${path(state, `/gift-card/${encodeURIComponent(card.gift_card_id)}/remove`)}" data-job-form="gift-card-remove" class="inline-form"><button class="button button-quiet button-small" type="submit" aria-label="${fill(copy.checkout.giftCardRemoveLabel, { last: card.last_characters })}">${copy.checkout.giftCardRemove}</button></form>
          </li>`;
        })}</ul>`
      : ''}
  </section>`;
}

// ----- Tip -----

function tipSection(ctx: Ctx): Html {
  const state = ctx.data.state;
  if (!tipVisible(state)) return html`<div data-region="tip"></div>`;
  const choice = tipChoice(state);
  const custom = state.order.requested_tip?.amount_money;
  const customValue = custom ? minorToDecimal(custom.amount, custom.currency) : '';
  const options: { value: string; label: string }[] = [
    { value: 'none', label: copy.checkout.tipNone },
    ...TIP_PERCENTS.map((percent) => ({ value: String(percent), label: `${percent}%` })),
    { value: 'custom', label: copy.checkout.tipCustom },
  ];
  return html`<section class="section checkout-section" id="tip" data-region="tip" aria-labelledby="tip-title" data-section="tip">
    <h2 id="tip-title">${copy.checkout.tipHeading}</h2>
    <form method="post" action="${path(state, '/tip')}" data-job-form="tip" novalidate class="stack" data-testid="sf-tip">
      <fieldset class="choice-group choice-inline"><legend>${copy.checkout.tipLegend}</legend>
        ${options.map((option) => html`<label class="choice"><input type="radio" name="tip" value="${option.value}" ${choice === option.value ? raw('checked') : raw('')} data-testid="sf-tip-${option.value}"><span>${option.label}</span></label>`)}
      </fieldset>
      <div data-tip-custom${choice === 'custom' ? raw('') : raw(' hidden')}>
        ${field({ id: 'tip-custom', name: 'amount', label: copy.checkout.tipCustomLabel, value: customValue, inputmode: 'decimal', autocomplete: 'off', testid: 'sf-tip-custom-amount' })}
      </div>
      <div class="actions"><button class="button" type="submit" data-testid="sf-tip-apply">${copy.checkout.tipApply}</button></div>
    </form>
    <p class="field-error" role="alert" data-job-error="tip" hidden></p>
  </section>`;
}

// ----- Summary -----

function supportBlock(state: CheckoutState): Html {
  const support = state.session.merchant_support;
  if (!support || (!support.email && !support.phone && !support.url)) return html``;
  const safeUrl = support.url && /^https?:\/\//i.test(support.url) ? support.url : null;
  return html`<div class="support" data-testid="sf-support">
    <h3>${copy.checkout.supportHeading}</h3>
    <ul role="list">
      ${support.email ? html`<li><a href="mailto:${support.email}">${fill(copy.checkout.supportEmail, { email: support.email })}</a></li>` : ''}
      ${support.phone ? html`<li><a href="tel:${support.phone.replace(/[^+\d]/g, '')}">${fill(copy.checkout.supportPhone, { phone: support.phone })}</a></li>` : ''}
      ${safeUrl ? html`<li><a href="${safeUrl}" rel="noopener noreferrer">${fill(copy.checkout.supportWebsite, { url: safeUrl.replace(/^https?:\/\//i, '') })}</a></li>` : ''}
    </ul>
  </div>`;
}

function row(label: string, value: Money | null | undefined, text: string, rowKey: string, testid?: string, strong = false): Html {
  return html`<div class="summary-row${strong ? ' summary-strong' : ''}" data-row="${rowKey}"><dt>${label}</dt><dd>${money(value ?? null, text, testid)}</dd></div>`;
}

export function amountRows(state: CheckoutState): Html {
  const order = state.order;
  const pricing = order.pricing_amounts;
  const outstanding = processorMoney(state);
  const total = pricing?.total_money ?? null;
  const taxPending = order.tax?.status === 'requires_location';
  const estimate = order.gift_card_estimate;
  const giftMoney = (order.gift_cards?.length ?? 0) > 0 ? estimate?.gift_card_money ?? null : null;
  const charges = (order.charges ?? []).filter((charge) => isPositive(charge.applied_money));
  return html`<dl class="summary-rows">
    ${row(copy.checkout.subtotal, pricing?.subtotal_money, formatOrDash(pricing?.subtotal_money), 'subtotal', 'sf-summary-subtotal')}
    ${pricing && isPositive(pricing.discount_money) ? row(copy.checkout.discounts, pricing.discount_money, `-${formatOrDash(pricing.discount_money)}`, 'discounts', 'sf-summary-discounts') : ''}
    ${charges.length
      ? charges.map((charge) => row(charge.name, charge.applied_money, formatOrDash(charge.applied_money), 'charge'))
      : pricing && isPositive(pricing.charge_money)
        ? row(copy.checkout.delivery, pricing.charge_money, formatOrDash(pricing.charge_money), 'charges')
        : ''}
    ${pricing && isPositive(pricing.requested_tip_money) ? row(copy.checkout.tip, pricing.requested_tip_money, formatOrDash(pricing.requested_tip_money), 'tip', 'sf-summary-tip') : ''}
    ${taxPending
      ? html`<div class="summary-row" data-row="tax"><dt>${copy.checkout.tax}</dt><dd><span class="money" data-testid="sf-summary-tax" data-state="requires_location">${copy.checkout.taxPending}</span></dd></div>`
      : pricing?.tax_money
        ? row(copy.checkout.tax, pricing.tax_money, formatOrDash(pricing.tax_money), 'tax', 'sf-summary-tax')
        : ''}
    ${row(copy.checkout.total, total, formatOrDash(total), 'total', 'sf-summary-total', true)}
    ${giftMoney && isPositive(giftMoney) ? row(copy.checkout.giftCards, giftMoney, `-${formatOrDash(giftMoney)}`, 'gift-cards', 'sf-summary-gift-cards') : ''}
    ${row(copy.checkout.amountDue, outstanding, formatOrDash(outstanding), 'outstanding', 'sf-summary-outstanding', true)}
  </dl>`;
}

function summaryRegion(ctx: Ctx): Html {
  const state = ctx.data.state;
  const order = state.order;
  const pricing = order.pricing_amounts;
  const outstanding = outstandingOf(state);
  const total = pricing?.total_money ?? null;
  const trial = state.kind === 'subscription' ? state.session.subscription_terms?.trial_period_days : undefined;
  return html`<aside class="order-summary" data-region="summary" data-testid="sf-summary" aria-labelledby="summary-title">
    <details class="summary-panel" data-summary open>
      <summary><span id="summary-title" class="summary-title">${copy.checkout.orderSummary}</span> <span class="summary-total-inline">${fill(copy.checkout.orderTotal, { amount: formatOrDash(total ?? outstanding) })}</span></summary>
      <ul class="summary-lines" role="list" aria-label="${copy.checkout.summaryLines}">
        ${order.line_items.map((line) => {
          const option = line.selected_options?.map((entry) => entry.value).join(', ');
          return html`<li class="summary-line">
            ${line.slug ? html`<img src="/images/${line.slug}.svg" alt="" width="56" height="42">` : ''}
            <span class="summary-line-name">${line.name}${option ? html` <span class="muted">${option}</span>` : ''}<span class="muted">${fill(copy.checkout.quantity, { n: line.quantity })}</span></span>
            <span>${money(line.total_money, formatOrDash(line.total_money))}</span>
          </li>`;
        })}
      </ul>
      ${amountRows(state)}
      ${trial ? html`<p class="hint">${fill(copy.checkout.freeTrialLine, { days: trial })}</p>` : ''}
    </details>
    ${supportBlock(state)}
  </aside>`;
}

// ----- Payment -----

function savedMethodsRegion(state: CheckoutState): Html {
  const methods: SavedMethod[] = state.kind === 'order' ? (state.saved_methods ?? []).filter((method) => method.card) : [];
  if (!methods.length) return html`<div data-region="saved-methods"></div>`;
  return html`<div data-region="saved-methods"><fieldset class="choice-group" data-saved-methods><legend>${copy.checkout.savedLegend}</legend>
    ${methods.map((method, index) => {
      const card = method.card!;
      return html`<label class="choice"><input type="radio" name="payment-source" value="${method.payment_method_id}" ${index === 0 ? raw('checked') : raw('')} data-testid="sf-saved-method-${index}"><span>${fill(copy.checkout.savedMethod, { brand: card.brand.charAt(0).toUpperCase() + card.brand.slice(1), last4: card.last4, month: String(card.exp_month).padStart(2, '0'), year: String(card.exp_year).slice(-2) })}</span></label>`;
    })}
    <label class="choice"><input type="radio" name="payment-source" value="new" data-testid="sf-use-new-method"><span>${copy.checkout.useNewMethod}</span></label>
  </fieldset></div>`;
}

function termsBlock(state: CheckoutState): Html {
  const terms = state.session.subscription_terms;
  if (state.kind !== 'subscription' || !terms) return html``;
  const count = terms.billing_interval_count;
  const unit = intervalUnit(terms.billing_interval, count);
  const total = formatOrDash(terms.recurring_total_money);
  return html`<div class="terms" data-testid="sf-subscription-terms">
    <p>${count === 1 ? fill(copy.checkout.subscriptionTermsOne, { total, unit }) : fill(copy.checkout.subscriptionTerms, { total, unit, count })}
    ${terms.trial_period_days ? ' ' + fill(copy.checkout.trialTerms, { days: terms.trial_period_days }) : ''}
    ${' ' + copy.checkout.cancelNote}
    ${terms.contract_term_months ? ' ' + fill(copy.checkout.contractTerm, { months: terms.contract_term_months }) : ''}
    ${terms.early_termination_fee_money ? ' ' + fill(copy.checkout.earlyTerminationFee, { fee: formatMoney(terms.early_termination_fee_money) }) : ''}</p>
  </div>`;
}

export function payLabel(state: CheckoutState): string {
  const kind = buttonKind(state);
  const outstanding = formatOrDash(processorMoney(state));
  switch (kind) {
    case 'subscription_trial':
      return copy.checkout.payTrial;
    case 'subscription_paid':
      return fill(copy.checkout.paySubscription, { amount: outstanding });
    case 'confirm_order':
      return copy.checkout.payConfirmOrder;
    default:
      return fill(copy.checkout.payOrder, { amount: outstanding });
  }
}

/** What the Confirm order button does when no processor is needed. */
export function settlementText(state: CheckoutState): string {
  const gift = (state.order.gift_cards?.length ?? 0) > 0 ? state.order.gift_card_estimate?.gift_card_money : null;
  return gift ? fill(message('settlement_gift_card'), { gift_card_money: formatMoney(gift) }) : message('settlement_discount');
}

/** The gift card and card split when both pay for one order. */
export function splitText(state: CheckoutState): string {
  const estimate = state.order.gift_card_estimate;
  if (collectionKindOf(state) !== 'processor' || (state.order.gift_cards?.length ?? 0) === 0 || !estimate?.can_pay) return '';
  return fill(message('gift_card_split'), { gift_card_money: formatMoney(estimate.gift_card_money), processor_money: formatMoney(estimate.processor_money) });
}

function supportLine(ctx: Ctx): Html {
  const support = ctx.data.state.session.merchant_support;
  return html`${support?.email ? html` <a href="mailto:${support.email}">${support.email}</a>` : ''}`;
}

function paymentSection(ctx: Ctx): Html {
  const state = ctx.data.state;
  const resting = derivePaymentState(state);
  const processor = needsProcessor(state);
  const blockers = serverBlockers(state);
  const showForm = resting !== 'expired' && resting !== 'unavailable' && resting !== 'recovery';
  const initial = resting === 'ready' || resting === 'declined' || resting === 'pay_remaining' ? (processor ? 'loading' : resting) : resting;
  const code = declineCode(state);
  const saveOffered = state.kind === 'order' && state.session.save_payment_method_offered === true && processor;
  const phoneOffered = saveOffered && state.session.save_payment_method_phone_offered === true;
  const settlementOnly = isSettlementOnly(state);
  const stripeGuidance = guidanceOf(state)?.stripe;
  const messaging = (stripeGuidance?.elements?.payment_method_types ?? []).includes('affirm');
  const initialMessage =
    resting === 'declined'
      ? declineMessage(code)
      : resting === 'unavailable'
        ? state.next === 'capture'
          ? message('bug_checkout', { store: ctx.storeName })
          : message('payments_unavailable', { store: ctx.storeName })
        : '';
  const attempt = state.attempt;
  const firstBlocker = blockers[0];
  const open = attemptIsOpen(resting as never);
  return html`<section class="section checkout-section payment-section" id="payment" aria-labelledby="payment-title" data-testid="sf-payment" data-state="${initial}" data-collection="${collectionKindOf(state)}" data-section="payment" data-kind="${state.kind}">
    <h2 id="payment-title" tabindex="-1">${copy.checkout.paymentHeading}</h2>
    ${resting === 'expired'
      ? html`<div class="state-panel" data-testid="sf-expired"><p role="alert">${message('checkout_expired')}</p>${state.kind === 'order' ? html`<form method="post" action="/checkout"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="button button-primary" type="submit">${copy.checkout.startAgain}</button></form>` : html`<a class="button button-primary" href="/#coffee-club">${copy.checkout.startAgain}</a>`}</div>`
      : ''}
    ${resting === 'unavailable'
      ? html`<div class="state-panel" data-testid="sf-unavailable"><p role="alert" data-testid="sf-payment-message">${initialMessage}</p>${supportLine(ctx)}</div>`
      : ''}
    ${resting === 'recovery'
      ? html`<div class="state-panel" data-testid="sf-recovery"><p role="status" data-testid="sf-payment-message">${message('finishing_payment')}</p></div>`
      : ''}
    ${showForm
      ? html`<form id="pay-form" method="post" action="${path(state, '/pay')}" novalidate data-testid="sf-pay-form" ${processor ? raw('data-needs-processor="true"') : raw('data-needs-processor="false"')}>
      ${savedMethodsRegion(state)}
      <div class="payment-fields"${processor ? raw('') : raw(' hidden')} data-payment-fields>
        <div id="wallets" class="wallets" data-testid="sf-wallets" hidden>
          <p class="wallets-label" id="wallets-label">${copy.checkout.walletsLabel}</p>
          <div id="express-checkout" aria-labelledby="wallets-label"></div>
          <p class="wallets-or" aria-hidden="true">${copy.checkout.orPayWithCard}</p>
        </div>
        <div class="payment-element-wrap" data-payment-wrap>
          <div class="skeleton" data-skeleton aria-hidden="true"></div>
          <div id="payment-element" role="group" aria-label="${copy.checkout.paymentElementLabel}"></div>
        </div>
        <div id="affirm-messaging" class="messaging" data-testid="sf-affirm-messaging"${messaging ? raw('') : raw(' hidden')}></div>
        ${saveOffered
          ? html`<div class="save-block" data-save-block>
          <label class="check"><input type="checkbox" id="save-card" name="save_payment_method" data-testid="sf-save-card"><span>${fill(copy.checkout.saveCard, { store: ctx.storeName })}</span></label>
          <p class="hint" id="save-consent">${copy.checkout.saveCardConsent}</p>
          ${phoneOffered ? html`<div data-save-phone hidden>${field({ id: 'save-phone', name: 'save_payment_method_phone', label: copy.checkout.savePhone, type: 'tel', autocomplete: 'tel', inputmode: 'tel', hint: copy.checkout.savePhoneHint, testid: 'sf-save-phone' })}</div>` : ''}
        </div>`
          : ''}
      </div>
      <p class="notice notice-info" role="status" data-settlement-note data-testid="sf-settlement-explanation"${settlementOnly ? raw('') : raw(' hidden')}>${settlementText(state)}</p>
      <p class="hint" data-gift-split data-testid="sf-gift-card-split"${splitText(state) ? raw('') : raw(' hidden')}>${splitText(state)}</p>
      ${termsBlock(state)}
      <div data-panel="affirm" hidden class="panel">
        <p>${message('affirm_incomplete')}</p>
        <div class="actions">
          <button class="button button-primary" type="button" data-affirm-continue data-testid="sf-affirm-continue">${copy.checkout.continueAffirm}</button>
          <button class="button" type="button" data-pay-another-way data-testid="sf-pay-another-way">${copy.checkout.payAnotherWay}</button>
        </div>
      </div>
      <div data-panel="waiting" hidden class="panel">
        <p data-waiting-text role="status">${copy.checkout.stateWaiting}</p>
        <button class="button" type="button" data-check-again data-testid="sf-check-again" hidden>${copy.checkout.checkAgain}</button>
      </div>
      <div data-panel="bank" hidden class="panel">
        <p role="status">${copy.checkout.stateBankProcessing}</p>
        <a class="button button-primary" href="${path(state, '/complete')}">${copy.checkout.viewConfirmation}</a>
      </div>
      <div class="pay-row">
        <button id="pay-button" class="button button-primary button-block" type="submit" aria-busy="false" aria-describedby="pay-blocker" data-testid="sf-pay-button"${blockers.length || open || initial === 'loading' ? raw(' disabled') : raw('')}>${payLabel(state)}</button>
        <p id="pay-blocker" class="pay-blocker" data-testid="sf-pay-blocker" data-blocker="${firstBlocker ?? ''}">${firstBlocker ? message(firstBlocker === 'session_not_open' ? 'session_not_open' : firstBlocker) : ''}</p>
      </div>
      <div id="payment-message" class="payment-message" role="alert" tabindex="-1" data-testid="sf-payment-message"${initialMessage && resting === 'declined' ? raw('') : raw(' hidden')}${code ? html` data-code="${code}"` : ''}>${resting === 'declined' ? initialMessage : ''}</div>
      ${resting === 'pay_remaining' && attempt
        ? html`<div class="panel" data-testid="sf-pay-remaining" role="status"><p>${fill(message('pay_remaining'), { paid: formatOrDash(state.order.settlement_amounts?.paid_money), remaining: formatOrDash(outstandingOf(state)) })}</p></div>`
        : ''}
    </form>
    <dialog id="affirm-dialog" aria-labelledby="affirm-dialog-title" data-testid="sf-affirm-dialog">
      <form method="dialog" class="stack">
        <h3 id="affirm-dialog-title">${copy.checkout.dialogTitle}</h3>
        <p>${copy.checkout.dialogBody}</p>
        <div class="actions">
          <button class="button button-primary" type="submit" value="confirm" data-testid="sf-affirm-dialog-confirm">${copy.checkout.dialogConfirm}</button>
          <button class="button" type="submit" value="cancel">${copy.checkout.dialogCancel}</button>
        </div>
      </form>
    </dialog>`
      : ''}
  </section>`;
}

// ----- Page -----

function bootstrapJson(ctx: Ctx): Html {
  const state = ctx.data.state;
  const payload = {
    ref: ref(state),
    store: ctx.storeName,
    state: scrubForBrowser(state),
    messages: browserMessages,
    labels: {
      savedLegend: copy.checkout.savedLegend,
      settlementDiscount: message('settlement_discount'),
      settlementGiftCard: message('settlement_gift_card'),
      giftCardSplit: message('gift_card_split'),
      useNewMethod: copy.checkout.useNewMethod,
      payOrder: copy.checkout.payOrder,
      paySubscription: copy.checkout.paySubscription,
      payTrial: copy.checkout.payTrial,
      payConfirmOrder: copy.checkout.payConfirmOrder,
      savedMethod: copy.checkout.savedMethod,
      stateWaiting: copy.checkout.stateWaiting,
      stateResuming: copy.checkout.stateResuming,
      stateAuthenticating: copy.checkout.stateAuthenticating,
      amountDue: copy.checkout.amountDue,
    },
  };
  return html`<script type="application/json" id="checkout-bootstrap">${raw(jsonForScript(payload))}</script>`;
}

export function checkoutPage(input: Ctx): Html {
  const state = input.data.state;
  // Only keys with buyer copy are kept, in the page and in the embedded state.
  const known = (keys: string[]) => keys.filter((raw) => hasMessage(parseNotice(raw).key));
  const notices = [...new Set([...known(input.notices), ...known(state.notices ?? [])])];
  const ctx: Ctx = { ...input, notices, data: { ...input.data, state: { ...state, notices } } };
  const resting = derivePaymentState(state);
  const recovery = resting === 'recovery';
  const expired = isExpired(state);
  const params = { amount: formatOrDash(state.approved_outstanding_money ?? outstandingOf(state)), store: ctx.storeName };
  const title = state.kind === 'subscription' ? copy.checkout.subscriptionTitle : copy.checkout.title;
  const readOnly = recovery || expired;
  const main = html`
    <h1>${title}</h1>
    ${noticeList(ctx, params)}
    <noscript><p class="notice notice-error" role="alert">${copy.checkout.noscript}</p></noscript>
    <div class="checkout-layout" data-checkout data-ref="${ref(state)}" data-kind="${state.kind}">
      ${summaryRegion(ctx)}
      <div class="checkout-sections">
        <p class="notice notice-info locked-note" role="status" data-locked-note data-testid="sf-locked-note"${attemptIsOpen(resting) ? raw('') : raw(' hidden')}>${message('sections_locked')}</p>
        ${readOnly ? '' : html`${contactSection(ctx)}${state.kind === 'order' ? discountSection(ctx) : ''}${deliverySection(ctx)}${giftCardSection(ctx)}${tipSection(ctx)}`}
        ${paymentSection(ctx)}
      </div>
    </div>
    ${bootstrapJson(ctx)}`;
  return shell(ctx, {
    pageId: 'sf-checkout',
    title,
    main,
    testid: 'sf-checkout',
    wide: true,
    head: html`<script src="${STRIPE_JS}" async></script>`,
    scripts: ['/js/checkout.js'],
  });
}
