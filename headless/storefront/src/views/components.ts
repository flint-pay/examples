import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { copy, errorKey, fill, hasMessage, message, parseNotice, toneFor, type Params } from '../copy.ts';
import type { FieldErrors, PageContext, PageError } from './types.ts';

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export function noticeList(ctx: PageContext, params: Params = {}, region = true): Html {
  // Unknown keys are skipped so a raw internal key never reaches a buyer.
  const items = ctx.notices.map(parseNotice).filter(({ key }) => hasMessage(key));
  return html`<div class="notices" ${region ? raw('data-region="notices"') : raw('')} data-testid="sf-notices">${items.map(({ key, param }) => {
    const text = message(key, { store: ctx.storeName, n: param, amount: param, email: param, ...params });
    const tone = toneFor(key);
    return html`<p class="notice notice-${tone}" role="${tone === 'error' ? 'alert' : 'status'}" data-notice="${key}" data-testid="sf-notice-${key}"><span class="notice-label">${toneLabel(tone)}</span> ${text}</p>`;
  })}</div>`;
}

function toneLabel(tone: string): string {
  return tone === 'error' ? 'Problem:' : tone === 'warning' ? 'Notice:' : tone === 'success' ? 'Done:' : 'Note:';
}

export function pageError(error: PageError | undefined, ctx: PageContext): Html | '' {
  if (!error) return '';
  const text = message(errorKey(error), { store: ctx.storeName });
  return html`<div class="notice notice-error" role="alert" data-testid="sf-error-message" tabindex="-1" id="page-error"><p>${text}</p>${error.request_id ? html`<p class="reference">${fill(message('reference_id'), { id: error.request_id })}</p>` : ''}</div>`;
}

export type FieldOptions = {
  id: string;
  name: string;
  label: string;
  type?: string;
  value?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  autocomplete?: string;
  inputmode?: string;
  maxlength?: number;
  testid?: string;
  sensitive?: boolean;
  readonly?: boolean;
  minlength?: number;
  pattern?: string;
  placeholder?: string;
  disabled?: boolean;
};

export function field(o: FieldOptions): Html {
  const describedBy = [o.hint ? `${o.id}-hint` : '', o.error ? `${o.id}-error` : ''].filter(Boolean).join(' ');
  return html`<div class="field${o.error ? ' has-error' : ''}">
    <label for="${o.id}">${o.label}</label>
    ${o.hint ? html`<p class="hint" id="${o.id}-hint">${o.hint}</p>` : ''}
    <input id="${o.id}" name="${o.name}" type="${o.type ?? 'text'}" value="${o.value ?? ''}"
      ${o.required ? raw('required') : raw('')}
      ${o.readonly ? raw('readonly') : raw('')}
      ${o.disabled ? raw('disabled') : raw('')}
      ${o.autocomplete ? raw(`autocomplete="${o.autocomplete}"`) : raw('')}
      ${o.inputmode ? raw(`inputmode="${o.inputmode}"`) : raw('')}
      ${o.maxlength ? raw(`maxlength="${o.maxlength}"`) : raw('')}
      ${o.minlength ? raw(`minlength="${o.minlength}"`) : raw('')}
      ${o.pattern ? raw(`pattern="${o.pattern}"`) : raw('')}
      ${o.placeholder ? html`placeholder="${o.placeholder}"` : raw('')}
      ${o.testid ? html`data-testid="${o.testid}"` : raw('')}
      ${o.sensitive ? raw('data-sensitive="true"') : raw('')}
      ${o.error ? raw('aria-invalid="true"') : raw('')}
      ${describedBy ? html`aria-describedby="${describedBy}"` : raw('')}>
    ${o.error ? html`<p class="field-error" id="${o.id}-error" data-testid="${o.testid ?? o.id}-error">${o.error}</p>` : ''}
  </div>`;
}

export function errorSummary(errors: FieldErrors | undefined, ids: Record<string, string>, title: string = copy.identity.errorSummary): Html | '' {
  const entries = Object.entries(errors ?? {}).filter(([name]) => name !== '_form');
  const formError = errors?._form;
  if (!entries.length && !formError) return '';
  return html`<div class="error-summary" role="alert" tabindex="-1" id="error-summary" data-testid="sf-error-summary">
    <p class="error-summary-title">${formError ? message(formError) : title}</p>
    ${entries.length ? html`<ul>${entries.map(([name, key]) => html`<li><a href="#${ids[name] ?? name}">${message(key)}</a></li>`)}</ul>` : ''}
  </div>`;
}

export function csrfField(ctx: PageContext): Html {
  return html`<input type="hidden" name="_csrf" value="${ctx.csrf}">`;
}

export function money(value: { amount: string; currency: string } | null | undefined, text: string, testid?: string): Html {
  const id = testid ? html`data-testid="${testid}"` : raw('');
  if (!value) return html`<span class="money" ${id}>${text}</span>`;
  return html`<span class="money" data-amount-minor="${value.amount}" data-currency="${value.currency}" ${id}>${text}</span>`;
}
