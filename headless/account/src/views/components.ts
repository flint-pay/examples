import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { common, errorMessage, fieldMessage, fill, type CopyParams } from '../copy.ts';
import { formatDate, formatDateTime, formatMoney, isoString, safeJson } from './format.ts';
import type { MoneyValue, PageError, RenderContext } from './types.ts';

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

type AttrValue = string | number | boolean | null | undefined;

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Renders a map of attributes with escaped values. Names must come from code, never from data. */
export function attrs(map: Record<string, AttrValue>): Html {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(map)) {
    if (value === false || value === null || value === undefined) continue;
    parts.push(value === true ? name : `${name}="${escapeAttr(String(value))}"`);
  }
  return raw(parts.length ? ` ${parts.join(' ')}` : '');
}

export function cls(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Formatting bound to the request context
// ---------------------------------------------------------------------------

export interface Fmt {
  date(value: string | undefined | null): string;
  dateTime(value: string | undefined | null): string;
  money(value: MoneyValue | undefined | null): string;
}

export function fmtFor(ctx: Pick<RenderContext, 'timeZone'>): Fmt {
  const timeZone = ctx.timeZone || 'UTC';
  return {
    date: (value) => formatDate(value, timeZone),
    dateTime: (value) => formatDateTime(value, timeZone),
    money: (value) => formatMoney(value),
  };
}

/** A money amount with the data hooks tests read. */
export function money(value: MoneyValue | undefined | null, options: { testid?: string; className?: string } = {}): Html {
  if (!value) return html``;
  return html`<span class="${cls('money', options.className)}"${attrs({
    'data-testid': options.testid,
    'data-amount-minor': value.amount,
    'data-currency': value.currency,
  })}>${formatMoney(value)}</span>`;
}

export function timeEl(value: string | undefined | null, ctx: Pick<RenderContext, 'timeZone'>, withTime = false): Html {
  const fmt = fmtFor(ctx);
  const text = withTime ? fmt.dateTime(value) : fmt.date(value);
  if (!text) return html``;
  return html`<time datetime="${isoString(value)}">${text}</time>`;
}

// ---------------------------------------------------------------------------
// Basic elements
// ---------------------------------------------------------------------------

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';

export function badge(text: string, tone: Tone = 'neutral', extra: Record<string, AttrValue> = {}): Html {
  return html`<span class="${cls('badge', `badge-${tone}`)}"${attrs(extra)}>${text}</span>`;
}

export function csrfInput(csrf: string): Html {
  return html`<input type="hidden" name="_csrf" value="${csrf}">`;
}

export function hiddenInput(name: string, value: string | number | undefined | null): Html {
  return html`<input type="hidden" name="${name}" value="${value === undefined || value === null ? '' : String(value)}">`;
}

export interface FormOptions {
  action: string;
  csrf: string;
  className?: string;
  id?: string;
  testid?: string;
  noValidate?: boolean;
  attributes?: Record<string, AttrValue>;
}

export function postForm(options: FormOptions, children: Html | Html[]): Html {
  return html`<form method="post" action="${options.action}"${attrs({
    id: options.id,
    class: options.className,
    'data-testid': options.testid,
    novalidate: options.noValidate,
    ...options.attributes,
  })}>${csrfInput(options.csrf)}${children}</form>`;
}

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'link';

export interface ButtonOptions {
  label: string;
  type?: 'button' | 'submit';
  variant?: ButtonVariant;
  testid?: string;
  disabled?: boolean;
  className?: string;
  attributes?: Record<string, AttrValue>;
}

export function button(options: ButtonOptions): Html {
  return html`<button type="${options.type ?? 'button'}"${attrs({
    class: cls('btn', `btn-${options.variant ?? 'secondary'}`, options.className),
    'data-testid': options.testid,
    disabled: options.disabled,
    ...options.attributes,
  })}>${options.label}</button>`;
}

export function linkButton(href: string, label: string, options: { variant?: ButtonVariant; testid?: string; className?: string; attributes?: Record<string, AttrValue> } = {}): Html {
  return html`<a href="${href}"${attrs({
    class: cls('btn', `btn-${options.variant ?? 'secondary'}`, options.className),
    'data-testid': options.testid,
    ...options.attributes,
  })}>${label}</a>`;
}

/** A link to a page outside this app (carrier, label). Opens in a new tab and says so. */
export function externalLink(href: string, label: string, options: { testid?: string; className?: string } = {}): Html {
  return html`<a href="${href}" target="_blank" rel="noopener noreferrer"${attrs({
    class: options.className,
    'data-testid': options.testid,
  })}>${label}<span class="sr-only"> (${common.opensInNewTab})</span></a>`;
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

export function fieldId(name: string): string {
  return `f-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

export interface FieldOptions {
  name: string;
  label: string;
  type?: string;
  value?: string | number | null;
  hint?: string;
  required?: boolean;
  autocomplete?: string;
  inputmode?: string;
  maxlength?: number;
  minlength?: number;
  pattern?: string;
  spellcheck?: boolean;
  testid?: string;
  sensitive?: boolean;
  disabled?: boolean;
  errors?: Record<string, string>;
  errorParams?: CopyParams;
  className?: string;
  readonly?: boolean;
  autofocus?: boolean;
  attributes?: Record<string, AttrValue>;
}

export function fieldError(id: string, errors: Record<string, string> | undefined, name: string, params?: CopyParams): Html {
  const key = errors?.[name];
  if (!key) return html``;
  return html`<p class="field-error" id="${id}-error" data-testid="field-error-${name}">${fieldMessage(key, params)}</p>`;
}

export function field(options: FieldOptions): Html {
  const id = fieldId(options.name);
  const hasError = Boolean(options.errors?.[options.name]);
  const describedBy = [options.hint ? `${id}-hint` : '', hasError ? `${id}-error` : ''].filter(Boolean).join(' ');
  return html`<div class="${cls('field', hasError && 'field-invalid', options.className)}">
    <label for="${id}">${options.label}${options.required ? '' : ''}</label>
    ${options.hint ? html`<p class="hint" id="${id}-hint">${options.hint}</p>` : ''}
    <input id="${id}" name="${options.name}" type="${options.type ?? 'text'}"${attrs({
      value: options.value === undefined || options.value === null ? undefined : String(options.value),
      required: options.required,
      autocomplete: options.autocomplete,
      inputmode: options.inputmode,
      maxlength: options.maxlength,
      minlength: options.minlength,
      pattern: options.pattern,
      spellcheck: options.spellcheck === false ? 'false' : undefined,
      disabled: options.disabled,
      readonly: options.readonly,
      autofocus: options.autofocus,
      'aria-invalid': hasError ? 'true' : undefined,
      'aria-describedby': describedBy || undefined,
      'data-testid': options.testid,
      'data-sensitive': options.sensitive ? 'true' : undefined,
      ...options.attributes,
    })}>
    ${fieldError(id, options.errors, options.name, options.errorParams)}
  </div>`;
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  attributes?: Record<string, AttrValue>;
}

export function selectField(options: {
  name: string;
  label: string;
  options: SelectOption[];
  value?: string | null;
  placeholder?: string;
  required?: boolean;
  hint?: string;
  testid?: string;
  errors?: Record<string, string>;
  className?: string;
  attributes?: Record<string, AttrValue>;
}): Html {
  const id = fieldId(options.name);
  const hasError = Boolean(options.errors?.[options.name]);
  const describedBy = [options.hint ? `${id}-hint` : '', hasError ? `${id}-error` : ''].filter(Boolean).join(' ');
  return html`<div class="${cls('field', hasError && 'field-invalid', options.className)}">
    <label for="${id}">${options.label}</label>
    ${options.hint ? html`<p class="hint" id="${id}-hint">${options.hint}</p>` : ''}
    <select id="${id}" name="${options.name}"${attrs({
      required: options.required,
      'aria-invalid': hasError ? 'true' : undefined,
      'aria-describedby': describedBy || undefined,
      'data-testid': options.testid,
      ...options.attributes,
    })}>
      ${options.placeholder !== undefined ? html`<option value="">${options.placeholder}</option>` : ''}
      ${options.options.map(
        (option) => html`<option value="${option.value}"${attrs({
          selected: options.value === option.value,
          disabled: option.disabled,
          ...option.attributes,
        })}>${option.label}</option>`,
      )}
    </select>
    ${fieldError(id, options.errors, options.name)}
  </div>`;
}

export function textareaField(options: {
  name: string;
  label: string;
  value?: string | null;
  rows?: number;
  maxlength?: number;
  hint?: string;
  testid?: string;
  errors?: Record<string, string>;
  required?: boolean;
  className?: string;
}): Html {
  const id = fieldId(options.name);
  const hasError = Boolean(options.errors?.[options.name]);
  const describedBy = [options.hint ? `${id}-hint` : '', hasError ? `${id}-error` : ''].filter(Boolean).join(' ');
  return html`<div class="${cls('field', hasError && 'field-invalid', options.className)}">
    <label for="${id}">${options.label}</label>
    ${options.hint ? html`<p class="hint" id="${id}-hint">${options.hint}</p>` : ''}
    <textarea id="${id}" name="${options.name}" rows="${options.rows ?? 3}"${attrs({
      maxlength: options.maxlength,
      required: options.required,
      'aria-invalid': hasError ? 'true' : undefined,
      'aria-describedby': describedBy || undefined,
      'data-testid': options.testid,
    })}>${options.value ?? ''}</textarea>
    ${fieldError(id, options.errors, options.name)}
  </div>`;
}

export function checkboxField(options: {
  name: string;
  label: string;
  checked?: boolean;
  value?: string;
  hint?: string;
  testid?: string;
  disabled?: boolean;
  attributes?: Record<string, AttrValue>;
}): Html {
  const id = fieldId(options.name);
  return html`<div class="field field-check">
    <input id="${id}" type="checkbox" name="${options.name}" value="${options.value ?? 'on'}"${attrs({
      checked: options.checked,
      disabled: options.disabled,
      'aria-describedby': options.hint ? `${id}-hint` : undefined,
      'data-testid': options.testid,
      ...options.attributes,
    })}>
    <label for="${id}">${options.label}</label>
    ${options.hint ? html`<p class="hint" id="${id}-hint">${options.hint}</p>` : ''}
  </div>`;
}

// ---------------------------------------------------------------------------
// Errors and states
// ---------------------------------------------------------------------------

/**
 * The form-level error summary. Receives focus on load (the app script focuses [data-autofocus]).
 * `labels` maps field names to labels so each message links to its field.
 */
export function errorSummary(error: PageError | undefined, labels: Record<string, string> = {}, params: CopyParams = {}): Html {
  if (!error) return html``;
  const fields = Object.entries(error.field_errors ?? {});
  const message = errorMessage(error, params);
  return html`<div class="alert alert-error" role="alert" tabindex="-1" id="error-summary" data-autofocus data-testid="ac-error" data-error-kind="${error.kind}"${attrs({ 'data-error-code': error.code })}>
    <p class="alert-title">${message}</p>
    ${
      fields.length
        ? html`<ul class="alert-list">${fields.map(
            ([name, key]) => html`<li><a href="#${fieldId(name)}">${labels[name] ? html`${labels[name]}: ` : ''}${fieldMessage(key, params)}</a></li>`,
          )}</ul>`
        : ''
    }
    ${error.request_id ? html`<p class="alert-ref">${fill(common.referenceId, { id: error.request_id })}</p>` : ''}
  </div>`;
}

/** A section that failed to load. The retry is a real link that reloads the page. */
export function sectionError(section: string, error: PageError | undefined, retryHref: string, testid?: string): Html {
  return html`<div class="alert alert-error section-error" role="alert"${attrs({ 'data-testid': testid ?? 'ac-section-error', 'data-state': 'error' })}>
    <p class="alert-title">${fill(common.sectionLoadError, { section })}</p>
    ${error?.request_id ? html`<p class="alert-ref">${fill(common.referenceId, { id: error.request_id })}</p>` : ''}
    <p><a href="${retryHref}" class="btn btn-secondary">${common.retry}</a></p>
  </div>`;
}

export function emptyState(text: string, action?: Html, testid?: string): Html {
  return html`<div class="empty"${attrs({ 'data-testid': testid, 'data-state': 'empty' })}>
    <p>${text}</p>
    ${action ? html`<p>${action}</p>` : ''}
  </div>`;
}

export function pageHeader(title: string, options: { subtitle?: string; actions?: Html; testid?: string } = {}): Html {
  return html`<div class="page-header">
    <div>
      <h1 id="page-title" tabindex="-1"${attrs({ 'data-testid': options.testid })}>${title}</h1>
      ${options.subtitle ? html`<p class="lede">${options.subtitle}</p>` : ''}
    </div>
    ${options.actions ? html`<div class="page-actions">${options.actions}</div>` : ''}
  </div>`;
}

export function card(children: Html | Html[], options: { className?: string; testid?: string; labelledBy?: string } = {}): Html {
  return html`<section class="${cls('card', options.className)}"${attrs({ 'data-testid': options.testid, 'aria-labelledby': options.labelledBy })}>${children}</section>`;
}

export function definitionList(items: Array<{ term: string; description: Html | string; testid?: string }>): Html {
  return html`<dl class="facts">${items.map(
    (item) => html`<div class="fact"><dt>${item.term}</dt><dd${attrs({ 'data-testid': item.testid })}>${item.description}</dd></div>`,
  )}</dl>`;
}

export function jsonBlock(id: string, data: unknown): Html {
  return html`<script type="application/json" id="${id}">${raw(safeJson(data))}</script>`;
}

export function paginationLinks(options: {
  basePath: string;
  pageToken?: string | null;
  nextPageToken?: string | null;
  /** Prefix for data-testid: {testid}-older and {testid}-newest. */
  testid: string;
  newerLabel?: string;
  olderLabel?: string;
}): Html {
  const hasNewer = Boolean(options.pageToken);
  const hasOlder = Boolean(options.nextPageToken);
  if (!hasNewer && !hasOlder) return html``;
  return html`<nav class="pager" aria-label="Pages">
    ${hasNewer ? html`<a class="btn btn-secondary" href="${options.basePath}" data-testid="${options.testid}-newest">${options.newerLabel ?? common.newerOrders}</a>` : ''}
    ${hasOlder ? html`<a class="btn btn-secondary" href="${options.basePath}?page=${encodeURIComponent(options.nextPageToken ?? '')}" data-testid="${options.testid}-older">${options.olderLabel ?? common.olderOrders}</a>` : ''}
  </nav>`;
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

/** The button that opens a dialog. Hidden without JavaScript, where the dialog shows inline. */
export function dialogTrigger(dialogId: string, label: string, options: { variant?: ButtonVariant; testid?: string; className?: string } = {}): Html {
  return html`<button type="button"${attrs({
    class: cls('btn', `btn-${options.variant ?? 'secondary'}`, 'js-only', options.className),
    'data-dialog-open': dialogId,
    'data-testid': options.testid,
    'aria-haspopup': 'dialog',
  })}>${label}</button>`;
}

export function dialog(options: {
  id: string;
  title: string;
  children: Html | Html[];
  testid?: string;
  openOnLoad?: boolean;
}): Html {
  return html`<dialog id="${options.id}" class="dialog" aria-labelledby="${options.id}-title"${attrs({
    'data-testid': options.testid,
    'data-open-on-load': options.openOnLoad ? 'true' : undefined,
  })}>
    <div class="dialog-body">
      <h2 id="${options.id}-title">${options.title}</h2>
      ${options.children}
    </div>
  </dialog>`;
}

/** A confirmation dialog with one POST form. */
export function confirmDialog(options: {
  id: string;
  title: string;
  body: string;
  action: string;
  csrf: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  testid?: string;
  confirmTestid?: string;
  hidden?: Array<[string, string]>;
}): Html {
  return dialog({
    id: options.id,
    title: options.title,
    testid: options.testid,
    children: postForm(
      { action: options.action, csrf: options.csrf },
      html`<p>${options.body}</p>
        ${(options.hidden ?? []).map(([name, value]) => hiddenInput(name, value))}
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-dialog-close>${options.cancelLabel}</button>
          ${button({ label: options.confirmLabel, type: 'submit', variant: options.danger ? 'danger' : 'primary', testid: options.confirmTestid })}
        </div>`,
    ),
  });
}

/** Support contact lines. */
export function supportContact(support: RenderContext['support'], testid = 'ac-support-inline'): Html {
  if (!support || (!support.email && !support.phone && !support.url)) return html``;
  const url = support.url && /^https?:\/\//i.test(support.url) ? support.url : null;
  return html`<ul class="contact-list" data-testid="${testid}">
    ${support.email ? html`<li><a href="mailto:${support.email}">${fill(common.contactEmail, { email: support.email })}</a></li>` : ''}
    ${support.phone ? html`<li><a href="tel:${support.phone.replace(/[^\d+]/g, '')}">${fill(common.contactPhone, { phone: support.phone })}</a></li>` : ''}
    ${url ? html`<li><a href="${url}" target="_blank" rel="noopener noreferrer">${fill(common.contactSite, { site: new URL(url).host })}<span class="sr-only"> (${common.opensInNewTab})</span></a></li>` : ''}
  </ul>`;
}
