import { html } from 'hono/html';
import { addresses as copy, common, fill } from '../../copy.ts';
import {
  badge,
  button,
  card,
  checkboxField,
  confirmDialog,
  dialogTrigger,
  emptyState,
  errorSummary,
  field,
  hiddenInput,
  linkButton,
  pageHeader,
  postForm,
  sectionError,
  type Html,
} from '../components.ts';
import { path } from '../format.ts';
import { renderDocument } from '../layout.ts';
import type { AddressesData, AddressFormData, RenderContext } from '../types.ts';
import { addressBlock } from './shared.ts';

export function addressesPage(ctx: RenderContext<AddressesData>): Html {
  const { addresses } = ctx.data;
  let body: Html;
  if (addresses.status === 'error') {
    body = sectionError('your addresses', addresses.error, '/addresses', 'ac-addresses-error');
  } else if (!addresses.value.items.length) {
    body = emptyState(copy.empty, linkButton('/addresses/new', copy.add, { variant: 'primary', testid: 'ac-address-new' }), 'ac-addresses-empty');
  } else {
    body = html`<ul class="rows cards" data-state="loaded">${addresses.value.items.map((address) => {
      const id = address.customer_address_id;
      const base = path('/addresses', id);
      const dialogId = `delete-${id}`;
      const deleteDialog = confirmDialog({
          id: dialogId,
          title: copy.deleteTitle,
          body: copy.deleteConfirm,
          action: `${base}/delete`,
          csrf: ctx.csrf,
          confirmLabel: copy.deleteYes,
          cancelLabel: copy.deleteNo,
          danger: true,
          confirmTestid: 'ac-address-delete-confirm',
        });
      return html`<li class="row row-card" data-testid="ac-address-${id}">
        <div class="row-main">
          ${address.label ? html`<span class="row-title">${address.label}</span>` : ''}
          ${addressBlock(address.address, address.recipient_name)}
          ${address.phone ? html`<span class="row-meta">${address.phone}</span>` : ''}
        </div>
        <div class="row-badges">
          ${address.is_default_shipping ? badge(copy.defaultShipping, 'good', { 'data-testid': 'ac-address-default-shipping' }) : ''}
          ${address.is_default_billing ? badge(copy.defaultBilling, 'good', { 'data-testid': 'ac-address-default-billing' }) : ''}
        </div>
        <div class="row-actions">
          ${linkButton(`${base}/edit`, common.edit, { testid: 'ac-address-edit' })}
          ${!address.is_default_shipping ? postForm({ action: `${base}/default`, csrf: ctx.csrf, className: 'inline-form' }, html`${hiddenInput('kind', 'shipping')}${button({ label: copy.setShipping, type: 'submit', testid: 'ac-address-set-shipping' })}`) : ''}
          ${!address.is_default_billing ? postForm({ action: `${base}/default`, csrf: ctx.csrf, className: 'inline-form' }, html`${hiddenInput('kind', 'billing')}${button({ label: copy.setBilling, type: 'submit', testid: 'ac-address-set-billing' })}`) : ''}
          ${dialogTrigger(dialogId, common.delete, { variant: 'danger', testid: 'ac-address-delete' })}
        </div>
        ${deleteDialog}
      </li>`;
    })}</ul>
    <p>${linkButton('/addresses/new', copy.add, { variant: 'primary', testid: 'ac-address-new' })}</p>`;
  }
  const main = html`${pageHeader(copy.title, { testid: 'ac-addresses-title' })}${card(body, { testid: 'ac-addresses-list' })}`;
  return renderDocument(ctx, { pageId: 'ac-addresses', title: copy.title, testid: 'ac-addresses', main, nav: 'addresses' });
}

export function addressFormPage(ctx: RenderContext<AddressFormData>): Html {
  const { mode, address, values = {}, is_first } = ctx.data;
  const errors = ctx.error?.field_errors;
  const edit = mode === 'edit' && address;
  const title = edit ? copy.editTitle : copy.newTitle;
  const v = (name: string, fallback: string | undefined): string => values[name] ?? fallback ?? '';
  const action = edit ? path('/addresses', address.customer_address_id) : '/addresses';
  const labels: Record<string, string> = { recipient_name: copy.recipient, line1: copy.line1, city: copy.city, state: copy.state, postal_code: copy.postalCode };
  const main = html`${pageHeader(title, { testid: 'ac-address-form-title' })}
    ${errorSummary(ctx.error, labels)}
    ${card(
      postForm(
        { action, csrf: ctx.csrf, testid: 'ac-address-form' },
        html`${field({ name: 'recipient_name', label: copy.recipient, value: v('recipient_name', address?.recipient_name), autocomplete: 'name', required: true, errors, testid: 'ac-address-recipient' })}
          ${field({ name: 'label', label: copy.label, value: v('label', address?.label), hint: copy.labelHint, errors, testid: 'ac-address-label' })}
          ${field({ name: 'line1', label: copy.line1, value: v('line1', address?.address.line1), autocomplete: 'address-line1', required: true, errors, testid: 'ac-address-line1' })}
          ${field({ name: 'line2', label: copy.line2, value: v('line2', address?.address.line2), autocomplete: 'address-line2', errors, testid: 'ac-address-line2' })}
          <div class="field-row">
            ${field({ name: 'city', label: copy.city, value: v('city', address?.address.city), autocomplete: 'address-level2', required: true, errors, testid: 'ac-address-city' })}
            ${field({ name: 'state', label: copy.state, value: v('state', address?.address.state), autocomplete: 'address-level1', required: true, maxlength: 2, pattern: '[A-Za-z]{2}', errors, testid: 'ac-address-state', className: 'field-narrow' })}
            ${field({ name: 'postal_code', label: copy.postalCode, value: v('postal_code', address?.address.postal_code), autocomplete: 'postal-code', required: true, inputmode: 'numeric', errors, testid: 'ac-address-postal', className: 'field-narrow' })}
          </div>
          <div class="readonly-field"><p class="label">${copy.country}</p><p>${copy.countryValue}</p>${hiddenInput('country', 'US')}</div>
          ${field({ name: 'phone', label: copy.phone, type: 'tel', value: v('phone', address?.phone), autocomplete: 'tel', errors, testid: 'ac-address-phone' })}
          ${
            is_first && !edit
              ? html`<p class="hint" data-testid="ac-address-first-note">${copy.firstNote}</p>`
              : html`${checkboxField({ name: 'is_default_shipping', label: copy.defaultShippingLabel, checked: values.is_default_shipping ? values.is_default_shipping === 'on' : address?.is_default_shipping, testid: 'ac-address-default-shipping-input' })}
                ${checkboxField({ name: 'is_default_billing', label: copy.defaultBillingLabel, checked: values.is_default_billing ? values.is_default_billing === 'on' : address?.is_default_billing, testid: 'ac-address-default-billing-input' })}`
          }
          <div class="form-actions">${button({ label: copy.save, type: 'submit', variant: 'primary', testid: 'ac-address-save' })}${linkButton('/addresses', common.cancel)}</div>`,
      ),
      { testid: 'ac-address-form-card' },
    )}`;
  void fill;
  return renderDocument(ctx, { pageId: 'ac-address-form', title, testid: 'ac-address-form-page', main, nav: 'addresses' });
}
