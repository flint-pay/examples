import { html } from 'hono/html';
import { common, fill, profile as copy } from '../../copy.ts';
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
import type { ProfileData, ProfileEmailData, ProfilePasswordData, RenderContext } from '../types.ts';

export function profilePage(ctx: RenderContext<ProfileData>): Html {
  const { customer, values = {} } = ctx.data;
  const errors = ctx.error?.field_errors;
  const main = html`${pageHeader(copy.title, { subtitle: copy.intro, testid: 'ac-profile-title' })}
    ${errorSummary(ctx.error, { name: copy.nameLabel, phone: copy.phoneLabel })}
    ${card(
      html`${postForm(
        { action: '/profile', csrf: ctx.csrf, testid: 'ac-profile-form' },
        html`${field({ name: 'name', label: copy.nameLabel, value: values.name ?? customer.name ?? '', autocomplete: 'name', errors, testid: 'ac-profile-name' })}
          ${field({ name: 'phone', label: copy.phoneLabel, type: 'tel', value: values.phone ?? customer.phone ?? '', autocomplete: 'tel', hint: copy.phoneHint, errors, testid: 'ac-profile-phone' })}
          <div class="form-actions">${button({ label: copy.save, type: 'submit', variant: 'primary', testid: 'ac-profile-save' })}</div>`,
      )}
      <div class="readonly-field">
        <p class="label">${copy.emailLabel}</p>
        <p data-testid="ac-profile-email-value">${customer.email}</p>
        <p class="hint">${copy.emailNote}</p>
        <p class="actions-row">${linkButton('/profile/email', copy.changeEmail, { testid: 'ac-profile-change-email' })}${linkButton('/profile/password', copy.changePassword, { testid: 'ac-profile-change-password' })}</p>
      </div>`,
      { testid: 'ac-profile-card' },
    )}`;
  return renderDocument(ctx, { pageId: 'ac-profile', title: copy.title, testid: 'ac-profile', main, nav: 'profile' });
}

export function profileEmailPage(ctx: RenderContext<ProfileEmailData>): Html {
  const { current_email, request, new_email } = ctx.data;
  const errors = ctx.error?.field_errors;
  const sent = Boolean(request && !request.confirmed);
  const needCurrent = Boolean(request?.current_email_confirmation_required);
  const target = request?.new_email ?? new_email ?? '';
  const body = sent
    ? html`<p role="status" data-testid="ac-email-codes-sent">${needCurrent ? fill(copy.codesSent, { current: current_email, new: target }) : fill(copy.codesSentNew, { new: target })}</p>
        ${postForm(
          { action: '/profile/email/confirm', csrf: ctx.csrf, testid: 'ac-email-confirm-form' },
          html`${needCurrent ? field({ name: 'current_email_code', label: fill(copy.currentCodeLabel, { email: current_email }), autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: 6, pattern: '[0-9]{6}', required: true, errors, testid: 'ac-email-code-current', sensitive: true }) : ''}
            ${field({ name: 'new_email_code', label: fill(copy.newCodeLabel, { email: target }), autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: 6, pattern: '[0-9]{6}', required: true, errors, testid: 'ac-email-code-new', sensitive: true })}
            <div class="form-actions">${button({ label: copy.confirmEmail, type: 'submit', variant: 'primary', testid: 'ac-email-confirm' })}</div>`,
        )}
        ${postForm({ action: '/profile/email', csrf: ctx.csrf, className: 'resend-form' }, html`${hiddenInput('new_email', target)}<div class="form-actions">${button({ label: copy.sendNewCodes, type: 'submit', variant: 'secondary', testid: 'ac-email-resend' })}</div>`)}`
    : postForm(
        { action: '/profile/email', csrf: ctx.csrf, testid: 'ac-email-start-form' },
        html`<p class="muted">${copy.currentEmail}: ${current_email}</p>
          ${field({ name: 'new_email', label: copy.newEmailLabel, type: 'email', value: new_email ?? '', autocomplete: 'email', required: true, errors, testid: 'ac-email-new', attributes: { autocapitalize: 'none' }, spellcheck: false })}
          <div class="form-actions">${button({ label: copy.sendCodes, type: 'submit', variant: 'primary', testid: 'ac-email-send' })}</div>`,
      );
  const main = html`${pageHeader(copy.emailTitle, { subtitle: sent ? undefined : copy.emailIntro, testid: 'ac-profile-email-title' })}
    ${errorSummary(ctx.error, { new_email: copy.newEmailLabel, current_email_code: copy.currentCodeLabel.replace('{email}', 'your current email'), new_email_code: copy.newCodeLabel.replace('{email}', 'your new email') })}
    <section class="card" data-testid="ac-email-change" data-state="${sent ? 'codes_sent' : 'idle'}">${body}</section>
    <p class="back-link"><a href="/profile">${common.back}</a></p>`;
  return renderDocument(ctx, { pageId: 'ac-profile-email', title: copy.emailTitle, testid: 'ac-profile-email', main, nav: 'profile' });
}

export function profilePasswordPage(ctx: RenderContext<ProfilePasswordData>): Html {
  const errors = ctx.error?.field_errors;
  const main = html`${pageHeader(copy.passwordTitle, { subtitle: copy.passwordIntro, testid: 'ac-password-title' })}
    ${errorSummary(ctx.error, { current_password: copy.currentPasswordLabel, new_password: copy.newPasswordLabel })}
    ${card(
      postForm(
        { action: '/profile/password', csrf: ctx.csrf, testid: 'ac-password-form' },
        html`${field({ name: 'current_password', label: copy.currentPasswordLabel, type: 'password', autocomplete: 'current-password', required: true, errors, testid: 'ac-password-current' })}
          ${field({ name: 'new_password', label: copy.newPasswordLabel, type: 'password', autocomplete: 'new-password', required: true, minlength: 10, hint: 'Use at least 10 characters.', errors, testid: 'ac-password-new' })}
          <div class="form-actions">${button({ label: copy.passwordSubmit, type: 'submit', variant: 'primary', testid: 'ac-password-submit' })}</div>`,
      ),
      { testid: 'ac-password-card' },
    )}
    <p class="back-link"><a href="/profile">${common.back}</a></p>`;
  return renderDocument(ctx, { pageId: 'ac-profile-password', title: copy.passwordTitle, testid: 'ac-password', main, nav: 'profile' });
}
