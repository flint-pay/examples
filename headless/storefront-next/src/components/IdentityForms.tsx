'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState } from 'react';
import { confirmEmailCode, sendEmailCode, signIn, signUp, type FormState } from '@/server/actions.ts';
import { copy, fill, message } from '@/shared/copy.ts';
import { ErrorNotice, Field } from './ui.tsx';

function withNext(path: string, next: string) {
  return next ? `${path}?next=${encodeURIComponent(next)}` : path;
}

/** Focuses the first problem after a failed submit, so keyboard and screen reader users land on it. */
function useFocusProblem(state: FormState) {
  useEffect(() => {
    if (!state.at) return;
    const target = document.getElementById('error-summary') ?? document.querySelector<HTMLElement>('[aria-invalid="true"]');
    target?.focus();
  }, [state.at]);
}

function ErrorSummary({ errors, ids }: { errors?: Record<string, string>; ids: Record<string, string> }) {
  const entries = Object.entries(errors ?? {});
  if (!entries.length) return null;
  return (
    <div className="error-summary" role="alert" tabIndex={-1} id="error-summary" data-testid="sf-error-summary">
      <p>{copy.identity.errorSummary}</p>
      <ul>{entries.map(([name, key]) => <li key={name}><a href={`#${ids[name] ?? name}`}>{message(key)}</a></li>)}</ul>
    </div>
  );
}

const ids = { name: 'name', email: 'email', password: 'password', code: 'code' };

export function SignInForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(signIn, {});
  useFocusProblem(state);
  return (
    <>
      <ErrorNotice error={state.error} id="page-error" />
      <ErrorSummary errors={state.fieldErrors} ids={ids} />
      <form action={action} noValidate>
        <input type="hidden" name="next" value={next} />
        <Field id="email" name="email" type="email" label={copy.identity.email} defaultValue={state.values?.email} required autoComplete="email" testid="sf-sign-in-email" error={state.fieldErrors?.email ? message(state.fieldErrors.email) : undefined} />
        <Field id="password" name="password" type="password" label={copy.identity.password} required autoComplete="current-password" testid="sf-sign-in-password" data-sensitive="true" error={state.fieldErrors?.password ? message(state.fieldErrors.password) : undefined} />
        <button className="button button-primary button-block button-large" type="submit" aria-busy={pending} disabled={pending} data-testid="sf-sign-in-submit">{copy.identity.signInButton}</button>
      </form>
      <p className="auth-foot">{copy.identity.noAccount} <Link href={withNext('/sign-up', next)} data-testid="sf-sign-up-link">{copy.identity.createAccountLink}</Link></p>
    </>
  );
}

export function SignUpForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(signUp, {});
  useFocusProblem(state);
  const duplicate = state.fieldErrors?.email === 'email_already_used';
  return (
    <>
      <ErrorNotice error={state.error} id="page-error" />
      <ErrorSummary errors={duplicate ? undefined : state.fieldErrors} ids={ids} />
      <form action={action} noValidate>
        <input type="hidden" name="next" value={next} />
        <Field id="name" name="name" label={copy.identity.name} defaultValue={state.values?.name} required autoComplete="name" testid="sf-sign-up-name" />
        <Field id="email" name="email" type="email" label={copy.identity.email} defaultValue={state.values?.email} required autoComplete="email" testid="sf-sign-up-email" error={!duplicate && state.fieldErrors?.email ? message(state.fieldErrors.email) : undefined} aria-invalid={duplicate || undefined} />
        {duplicate ? <p className="field-error" data-testid="sf-sign-up-email-error">{message('email_already_used').replace(/\s*Sign in instead\.$/, '')} <Link href={withNext('/sign-in', next)} data-testid="sf-sign-in-instead">{copy.identity.signInInstead}</Link></p> : null}
        <Field id="password" name="password" type="password" label={copy.identity.password} required autoComplete="new-password" minLength={10} hint={copy.identity.passwordHint} testid="sf-sign-up-password" data-sensitive="true" error={state.fieldErrors?.password ? message(state.fieldErrors.password) : undefined} />
        <button className="button button-primary button-block button-large" type="submit" aria-busy={pending} disabled={pending} data-testid="sf-sign-up-submit">{copy.identity.signUpButton}</button>
      </form>
      <p className="auth-foot">{copy.identity.haveAccount} <Link href={withNext('/sign-in', next)}>{copy.identity.signInLink}</Link></p>
    </>
  );
}

const RESEND_AFTER_MS = 30_000;

export function VerifyEmailForms({ next, email, sentAt }: { next: string; email: string; sentAt: number | null }) {
  const [sendState, send, sending] = useActionState<FormState, FormData>(sendEmailCode, {});
  const [confirmState, confirm, confirming] = useActionState<FormState, FormData>(confirmEmailCode, {});
  const [now, setNow] = useState(() => Date.now());
  const code = useRef<HTMLInputElement>(null);
  const enableAt = sentAt ? sentAt + RESEND_AFTER_MS : 0;
  const left = Math.max(0, Math.ceil((enableAt - now) / 1000));
  useEffect(() => {
    if (!left) return;
    const timer = window.setTimeout(() => setNow(Date.now()), 1000);
    return () => window.clearTimeout(timer);
  }, [left, now]);
  useEffect(() => { if (sentAt) code.current?.focus(); }, [sentAt]);
  useFocusProblem(confirmState);
  if (!sentAt) {
    return (
      <>
        <p data-testid="sf-verify-idle">{fill(copy.identity.verifyIdle, { email })}</p>
        <ErrorNotice error={sendState.error} id="page-error" />
        <form action={send}>
          <input type="hidden" name="next" value={next} />
          <button className="button button-primary button-block button-large" type="submit" aria-busy={sending} disabled={sending} data-testid="sf-verify-send">{copy.identity.sendCode}</button>
        </form>
      </>
    );
  }
  return (
    <>
      <p data-testid="sf-verify-sent">{fill(copy.identity.verifyCodeSent, { email })}</p>
      <ErrorNotice error={confirmState.fieldErrors?.code ? undefined : confirmState.error} id="page-error" />
      <ErrorNotice error={sendState.error} />
      <form action={confirm} noValidate>
        <input type="hidden" name="next" value={next} />
        <Field ref={code} id="code" name="code" label={copy.identity.code} required autoComplete="one-time-code" inputMode="numeric" maxLength={6} pattern="[0-9]{6}" className="code-field" testid="sf-verify-code" data-sensitive="true" error={confirmState.fieldErrors?.code ? message(confirmState.fieldErrors.code) : undefined} />
        <button className="button button-primary button-block button-large" type="submit" aria-busy={confirming} disabled={confirming} data-testid="sf-verify-confirm">{copy.identity.confirm}</button>
      </form>
      <form action={send} className="row">
        <input type="hidden" name="next" value={next} />
        <button className="button button-quiet" type="submit" disabled={left > 0 || sending} aria-busy={sending} aria-describedby={left ? 'resend-reason' : undefined} data-testid="sf-verify-resend">{copy.identity.sendNewCode}</button>
        {left ? <span className="hint flush" id="resend-reason">{fill(copy.identity.resendWait, { seconds: left })}</span> : null}
      </form>
    </>
  );
}
