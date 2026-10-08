import { html } from 'hono/html';
import { common, errorPages, fill, identity } from '../../copy.ts';
import {
  button,
  card,
  errorSummary,
  field,
  hiddenInput,
  linkButton,
  pageHeader,
  postForm,
  type Html,
} from '../components.ts';
import { renderDocument } from '../layout.ts';
import type { ErrorPageData, NotFoundData, RenderContext, SignInData, SignUpData, VerifyEmailData } from '../types.ts';

function withNext(path: string, next: string | null): string {
  return next ? `${path}?next=${encodeURIComponent(next)}` : path;
}

export function signIn(ctx: RenderContext<SignInData>): Html {
  const { next, email } = ctx.data;
  const errors = ctx.error?.field_errors;
  const main = html`<div class="auth-card" data-state="idle">
    ${pageHeader(identity.signInTitle, { subtitle: identity.signInIntro, testid: 'ac-sign-in-title' })}
    ${errorSummary(ctx.error, { email: identity.emailLabel, password: identity.passwordLabel })}
    ${postForm(
      { action: '/sign-in', csrf: ctx.csrf, testid: 'ac-sign-in-form' },
      html`${next ? hiddenInput('next', next) : ''}
        ${field({ name: 'email', label: identity.emailLabel, type: 'email', value: email ?? '', autocomplete: 'username', required: true, errors, testid: 'ac-sign-in-email', spellcheck: false, attributes: { autocapitalize: 'none' } })}
        ${field({ name: 'password', label: identity.passwordLabel, type: 'password', autocomplete: 'current-password', required: true, errors, testid: 'ac-sign-in-password' })}
        <div class="form-actions">${button({ label: identity.signInSubmit, type: 'submit', variant: 'primary', testid: 'ac-sign-in-submit', attributes: { 'data-busy-label-keep': 'true' } })}</div>`,
    )}
    <p class="aside">${identity.noAccount} <a href="${withNext('/sign-up', next)}" data-testid="ac-sign-up-link">${identity.createAccountLink}</a></p>
  </div>`;
  return renderDocument(ctx, { pageId: 'sign-in', title: identity.signInTitle, testid: 'sign-in', main, shell: 'auth', mainClass: 'main-auth' });
}

export function signUp(ctx: RenderContext<SignUpData>): Html {
  const { next, name, email } = ctx.data;
  const errors = ctx.error?.field_errors;
  const emailTaken = ctx.error?.code?.toLowerCase() === 'email_taken' || ctx.error?.message_key === 'email_taken';
  const main = html`<div class="auth-card" data-state="idle">
    ${pageHeader(identity.signUpTitle, { subtitle: identity.signUpIntro, testid: 'ac-sign-up-title' })}
    ${errorSummary(ctx.error, { name: identity.nameLabel, email: identity.emailLabel, password: identity.passwordLabel })}
    ${emailTaken ? html`<p class="aside"><a href="${withNext('/sign-in', next)}" data-testid="ac-sign-in-link">${identity.signInLink}</a></p>` : ''}
    ${postForm(
      { action: '/sign-up', csrf: ctx.csrf, testid: 'ac-sign-up-form' },
      html`${next ? hiddenInput('next', next) : ''}
        ${field({ name: 'name', label: identity.nameLabel, value: name ?? '', autocomplete: 'name', required: true, errors, testid: 'ac-sign-up-name' })}
        ${field({ name: 'email', label: identity.emailLabel, type: 'email', value: email ?? '', autocomplete: 'email', required: true, errors, testid: 'ac-sign-up-email', spellcheck: false, attributes: { autocapitalize: 'none' } })}
        ${field({ name: 'password', label: identity.passwordLabel, type: 'password', autocomplete: 'new-password', required: true, minlength: 10, hint: identity.passwordHint, errors, testid: 'ac-sign-up-password' })}
        <div class="form-actions">${button({ label: identity.signUpSubmit, type: 'submit', variant: 'primary', testid: 'ac-sign-up-submit' })}</div>`,
    )}
    <p class="aside">${identity.haveAccount} <a href="${withNext('/sign-in', next)}">${identity.signInLink}</a></p>
  </div>`;
  return renderDocument(ctx, { pageId: 'sign-up', title: identity.signUpTitle, testid: 'sign-up', main, shell: 'auth', mainClass: 'main-auth' });
}

export interface CodeFlowOptions {
  /** Route prefix: /verify-email or /link-purchases. */
  base: string;
  next?: string | null;
  email: string;
  state: 'idle' | 'code_sent';
  sentAt?: number | string;
  csrf: string;
  error?: RenderContext['error'];
  ids: { root: string; code: string; send: string; confirm: string; resend: string };
  idleText: string;
  sentText: string;
  sendLabel: string;
  confirmLabel: string;
  resendLabel: string;
  /** Extra controls after the forms, such as Use a different account. */
  extra?: Html;
}

/** The email code flow shared by verify-email and link-purchases. */
export function codeFlow(options: CodeFlowOptions): Html {
  const errors = options.error?.field_errors;
  const sentAtMs = options.sentAt === undefined ? undefined : Number(options.sentAt);
  const hiddenNext = options.next ? hiddenInput('next', options.next) : '';
  return html`<div class="auth-card" data-state="${options.state}" data-testid="${options.ids.root}" data-code-flow>
    ${
      options.state === 'idle'
        ? html`<p data-testid="${options.ids.root}-intro">${fill(options.idleText, { email: options.email })}</p>
          ${postForm(
            { action: `${options.base}/send`, csrf: options.csrf },
            html`${hiddenNext}<div class="form-actions">${button({ label: options.sendLabel, type: 'submit', variant: 'primary', testid: options.ids.send })}</div>`,
          )}`
        : html`<p role="status" data-testid="${options.ids.root}-sent">${fill(options.sentText, { email: options.email })}</p>
          ${postForm(
            { action: `${options.base}/confirm`, csrf: options.csrf, attributes: { 'data-busy-form': 'true' } },
            html`${hiddenNext}
              ${field({ name: 'code', label: identity.codeLabel, autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: 6, pattern: '[0-9]{6}', required: true, errors, testid: options.ids.code, sensitive: true, autofocus: !options.error })}
              <div class="form-actions">${button({ label: options.confirmLabel, type: 'submit', variant: 'primary', testid: options.ids.confirm })}</div>`,
          )}
          ${postForm(
            { action: `${options.base}/send`, csrf: options.csrf, className: 'resend-form', attributes: { 'data-resend-form': 'true', 'data-sent-at': sentAtMs && Number.isFinite(sentAtMs) ? String(sentAtMs) : undefined, 'data-resend-wait': '30', 'data-resend-label': options.resendLabel, 'data-resend-wait-label': identity.verifyResendIn } },
            html`${hiddenNext}<div class="form-actions">${button({ label: options.resendLabel, type: 'submit', variant: 'secondary', testid: options.ids.resend, attributes: { 'data-resend-button': 'true' } })}<span class="hint" data-resend-note aria-live="off"></span></div>`,
          )}`
    }
    ${options.extra ?? ''}
  </div>`;
}

export function verifyEmail(ctx: RenderContext<VerifyEmailData>): Html {
  const { next, email, verification } = ctx.data;
  const state = verification?.status === 'code_sent' ? 'code_sent' : 'idle';
  const main = html`${pageHeader(identity.verifyTitle, { testid: 'ac-verify-title' })}
    ${errorSummary(ctx.error, { code: identity.codeLabel })}
    ${codeFlow({
      base: '/verify-email',
      next,
      email,
      state,
      sentAt: verification?.sentAt,
      csrf: ctx.csrf,
      error: ctx.error,
      ids: { root: 'ac-verify-email', code: 'ac-verify-code', send: 'ac-verify-send', confirm: 'ac-verify-confirm', resend: 'ac-verify-resend' },
      idleText: identity.verifyIdle,
      sentText: identity.verifySent,
      sendLabel: identity.verifySend,
      confirmLabel: identity.verifyConfirm,
      resendLabel: identity.verifyResend,
      extra: html`<div class="aside">${postForm({ action: '/sign-out', csrf: ctx.csrf, className: 'inline-form' }, button({ label: identity.verifyDifferent, type: 'submit', variant: 'link', testid: 'ac-verify-different' }))}</div>`,
    })}`;
  return renderDocument(ctx, { pageId: 'verify-email', title: identity.verifyTitle, testid: 'verify-email', main, shell: 'auth', mainClass: 'main-auth', scripts: ['/js/verify-email.js'] });
}

export function notFound(ctx: RenderContext<NotFoundData>): Html {
  const main = card(
    html`<h1 id="page-title" tabindex="-1" data-testid="ac-error-title">${errorPages.notFoundTitle}</h1>
      <p>${errorPages.notFoundBody}</p>
      <p class="form-actions">${linkButton(ctx.user ? '/' : '/sign-in', ctx.user ? errorPages.home : common.signIn, { variant: 'primary' })}${ctx.storefrontOrigin ? linkButton(ctx.storefrontOrigin, errorPages.shop) : ''}</p>`,
    { className: 'error-card', testid: 'ac-errors-404' },
  );
  return renderDocument(ctx, { pageId: 'not-found', title: errorPages.notFoundTitle, testid: 'ac-errors', main, shell: ctx.user ? 'account' : 'auth', mainClass: 'main-auth' });
}

export function errorPage(ctx: RenderContext<ErrorPageData>): Html {
  const main = card(
    html`<h1 id="page-title" tabindex="-1" data-testid="ac-error-title">${errorPages.errorTitle}</h1>
      <p>${errorPages.errorBody}</p>
      ${ctx.error?.request_id ? html`<p class="alert-ref" data-testid="ac-error-reference">${fill(common.referenceId, { id: ctx.error.request_id })}</p>` : ''}
      <p class="form-actions">${linkButton(ctx.user ? '/' : '/sign-in', ctx.user ? errorPages.home : common.signIn, { variant: 'primary' })}</p>`,
    { className: 'error-card', testid: 'ac-errors-500' },
  );
  return renderDocument(ctx, { pageId: 'error', title: errorPages.errorTitle, testid: 'ac-errors', main, shell: ctx.user ? 'account' : 'auth', mainClass: 'main-auth' });
}
