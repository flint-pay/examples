import { html } from 'hono/html';
import { copy, fill, message } from '../../copy.ts';
import { csrfField, errorSummary, field, noticeList, pageError, type Html } from '../components.ts';
import { shell } from '../layout.ts';
import type { IdentityData, PageContext } from '../types.ts';

const RESEND_AFTER_MS = 30_000;

function nextValue(ctx: PageContext<IdentityData>): string {
  const next = ctx.data.next ?? '';
  return next.startsWith('/') && !next.startsWith('//') ? next : '';
}

function withNext(path: string, next: string): string {
  return next ? `${path}?next=${encodeURIComponent(next)}` : path;
}

function fieldError(ctx: PageContext<IdentityData>, name: string): string | undefined {
  const key = ctx.form?.errors?.[name];
  return key ? message(key) : undefined;
}

const ids = { name: 'name', email: 'email', password: 'password', code: 'code' };

export function signInPage(ctx: PageContext<IdentityData>): Html {
  const next = nextValue(ctx);
  const values = ctx.form?.values ?? {};
  const main = html`
    <section class="narrow stack" aria-labelledby="sign-in-title">
      <h1 id="sign-in-title">${copy.identity.signInTitle}</h1>
      <p class="lead">${copy.identity.signInLead}</p>
      ${noticeList(ctx)}
      ${pageError(ctx.error, ctx)}
      ${errorSummary(ctx.form?.errors, ids)}
      <form method="post" action="/sign-in" class="stack" novalidate data-validate>
        ${csrfField(ctx)}
        <input type="hidden" name="next" value="${next}">
        ${field({ id: 'email', name: 'email', label: copy.identity.email, type: 'email', value: values.email, required: true, autocomplete: 'email', testid: 'sf-sign-in-email', error: fieldError(ctx, 'email') })}
        ${field({ id: 'password', name: 'password', label: copy.identity.password, type: 'password', required: true, autocomplete: 'current-password', testid: 'sf-sign-in-password', sensitive: true, error: fieldError(ctx, 'password') })}
        <div class="actions"><button class="button button-primary" type="submit" data-testid="sf-sign-in-submit">${copy.identity.signInButton}</button></div>
      </form>
      <p>${copy.identity.noAccount} <a href="${withNext('/sign-up', next)}" data-testid="sf-sign-up-link">${copy.identity.createAccountLink}</a></p>
    </section>`;
  return shell(ctx, { pageId: 'sign-in', title: copy.identity.signInTitle, main, testid: 'sf-sign-in' });
}

export function signUpPage(ctx: PageContext<IdentityData>): Html {
  const next = nextValue(ctx);
  const values = ctx.form?.values ?? {};
  const duplicate = ctx.form?.errors?.email === 'email_already_used' || ctx.error?.code === 'EMAIL_ALREADY_REGISTERED';
  const emailError = duplicate ? undefined : fieldError(ctx, 'email');
  const shownError = duplicate ? undefined : ctx.error;
  const main = html`
    <section class="narrow stack" aria-labelledby="sign-up-title">
      <h1 id="sign-up-title">${copy.identity.signUpTitle}</h1>
      <p class="lead">${copy.identity.signUpLead}</p>
      ${noticeList(ctx)}
      ${pageError(shownError, ctx)}
      ${errorSummary(ctx.form?.errors, ids)}
      <form method="post" action="/sign-up" class="stack" novalidate data-validate>
        ${csrfField(ctx)}
        <input type="hidden" name="next" value="${next}">
        ${field({ id: 'name', name: 'name', label: copy.identity.name, value: values.name, required: true, autocomplete: 'name', testid: 'sf-sign-up-name', error: fieldError(ctx, 'name') })}
        ${field({ id: 'email', name: 'email', label: copy.identity.email, type: 'email', value: values.email, required: true, autocomplete: 'email', testid: 'sf-sign-up-email', error: emailError })}
        ${duplicate ? html`<p class="field-error" data-testid="sf-sign-up-email-error">${message('email_already_used').replace(/\s*Sign in instead\.$/, '')} <a href="${withNext('/sign-in', next)}" data-testid="sf-sign-in-instead">Sign in instead.</a></p>` : ''}
        ${field({ id: 'password', name: 'password', label: copy.identity.password, type: 'password', required: true, autocomplete: 'new-password', minlength: 10, hint: copy.identity.passwordHint, testid: 'sf-sign-up-password', sensitive: true, error: fieldError(ctx, 'password') })}
        <div class="actions"><button class="button button-primary" type="submit" data-testid="sf-sign-up-submit">${copy.identity.signUpButton}</button></div>
      </form>
      <p>${copy.identity.haveAccount} <a href="${withNext('/sign-in', next)}">${copy.identity.signInLink}</a></p>
    </section>`;
  return shell(ctx, { pageId: 'sign-up', title: copy.identity.signUpTitle, main, testid: 'sf-sign-up' });
}

export function verifyEmailPage(ctx: PageContext<IdentityData>): Html {
  const next = nextValue(ctx);
  const email = ctx.data.email ?? ctx.user?.email ?? '';
  const verification = ctx.data.verification ?? null;
  const sent = verification?.status === 'code_sent';
  const sentAt = verification?.sentAt === undefined ? NaN : new Date(verification.sentAt).getTime();
  const enableAt = Number.isFinite(sentAt) ? sentAt + RESEND_AFTER_MS : 0;
  const canResendNow = !Number.isFinite(sentAt) || Date.now() >= enableAt;
  const main = html`
    <section class="narrow stack" aria-labelledby="verify-title">
      <h1 id="verify-title">${copy.identity.verifyTitle}</h1>
      ${noticeList(ctx)}
      ${pageError(ctx.error, ctx)}
      ${errorSummary(ctx.form?.errors, ids)}
      ${sent
        ? html`
      <p data-testid="sf-verify-sent">${fill(copy.identity.verifyCodeSent, { email })}</p>
      <form method="post" action="/verify-email/confirm" class="stack" novalidate data-validate data-busy-on-submit>
        ${csrfField(ctx)}
        <input type="hidden" name="next" value="${next}">
        ${field({ id: 'code', name: 'code', label: copy.identity.code, value: '', required: true, autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: 6, pattern: '[0-9]{6}', testid: 'sf-verify-code', sensitive: true, error: fieldError(ctx, 'code') })}
        <div class="actions"><button class="button button-primary" type="submit" data-testid="sf-verify-confirm">${copy.identity.confirm}</button></div>
      </form>
      <form method="post" action="/verify-email/send" class="stack" data-resend data-ready-text="${copy.identity.resendReady}" data-wait-text="${copy.identity.resendWait}" ${canResendNow ? '' : html`data-enable-at="${new Date(enableAt).toISOString()}"`}>
        ${csrfField(ctx)}
        <input type="hidden" name="next" value="${next}">
        <div class="actions">
          <button class="button" type="submit" data-testid="sf-verify-resend" ${canResendNow ? '' : html`disabled aria-describedby="resend-reason"`}>${copy.identity.sendNewCode}</button>
        </div>
        ${canResendNow ? '' : html`<p class="hint" id="resend-reason" data-resend-reason>${fill(copy.identity.resendWait, { seconds: 30 })}</p>`}
      </form>`
        : html`
      <p data-testid="sf-verify-idle">${fill(copy.identity.verifyIdle, { email })}</p>
      <form method="post" action="/verify-email/send" class="stack" data-busy-on-submit>
        ${csrfField(ctx)}
        <input type="hidden" name="next" value="${next}">
        <div class="actions"><button class="button button-primary" type="submit" data-testid="sf-verify-send">${copy.identity.sendCode}</button></div>
      </form>`}
      <form method="post" action="/sign-out" class="inline-form">
        ${csrfField(ctx)}
        <button class="button-link" type="submit" data-testid="sf-verify-different">${copy.identity.useDifferentAccount}</button>
      </form>
    </section>`;
  return shell(ctx, { pageId: 'verify-email', title: copy.identity.verifyTitle, main, testid: 'sf-verify-email', state: sent ? 'code_sent' : 'idle' });
}
