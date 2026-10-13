'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { copy, fill, message } from '@/shared/copy.ts';
import type { CheckoutState } from '@/shared/types.ts';
import { checkoutRequest, type JobError } from './api.ts';
import { Field } from '../ui.tsx';

/** Re-renders the confirmation every 2 seconds for up to a minute while the payment is still being confirmed. */
export function CompletePoller() {
  const router = useRouter();
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started >= 60_000) {
        window.clearInterval(timer);
        setStalled(true);
        return;
      }
      router.refresh();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [router]);
  return <p className="visually-hidden" role="status">{stalled ? message('still_confirming') : ''}</p>;
}

export function ReceiptButton({ checkoutRef, email, csrf }: { checkoutRef: string; email: string; csrf: string }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; state: 'sent' | 'error' } | null>(null);
  async function send() {
    setBusy(true);
    const result = await checkoutRequest(checkoutRef, csrf, 'POST', '/receipt', {});
    if (result.ok) setStatus({ text: email ? fill(message('receipt_sent'), { email }) : copy.complete.receiptSentGeneric, state: 'sent' });
    else {
      const error = result.error;
      const key = [error?.message_key, error?.code?.toLowerCase()].find((candidate) => candidate && ['receipt_recently_sent', 'receipt_just_sent', 'order_receipt_recipient_limit_reached', 'network_error'].includes(candidate));
      setStatus({ text: key ? message(key) : error?.kind === 'rate_limited' ? message('receipt_recently_sent') : message('generic_error'), state: 'error' });
    }
    setBusy(false);
  }
  return (
    <div className="stack">
      <p className="hint flush">{copy.complete.receiptHint}</p>
      <div className="actions"><button className="button" type="button" onClick={() => void send()} aria-busy={busy} disabled={busy} data-testid="sf-send-receipt">{copy.complete.emailReceipt}</button></div>
      <p className="status-line" role={status?.state === 'error' ? 'alert' : 'status'} data-state={status?.state} data-testid="sf-receipt-status">{status?.text ?? ''}</p>
    </div>
  );
}

/**
 * Confirms a card the buyer chose to save at checkout. It stays pending until a code sent after payment
 * is entered here. Only a card saved with a phone number reaches this state.
 */
export function SaveCardPanel({ state, csrf }: { state: CheckoutState; csrf: string }) {
  const router = useRouter();
  const save = state.session.payment_method_save;
  const ref = state.checkout_ref;
  const v = state.verification;
  const sent = v?.status === 'code_sent' && v.purpose === 'confirm_saved_payment_method';
  const emailOnly = Boolean(save?.email_confirmation_required);
  const [status, setStatus] = useState<{ text: string; kind: 'info' | 'error' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [codeInvalid, setCodeInvalid] = useState(false);
  const [textHidden, setTextHidden] = useState(false);
  const [emailHidden, setEmailHidden] = useState(false);
  const autoSent = useRef(false);

  /** Shows what went wrong. Returns true when the page should re-render instead. */
  function explain(error: JobError | undefined, quiet: boolean): boolean {
    const code = String(error?.code ?? '');
    if (code === 'PAYMENT_METHOD_SAVE_NOT_PENDING') return true;
    if (code === 'CUSTOMER_VERIFICATION_TEXT_UNAVAILABLE') {
      setTextHidden(true);
      setStatus({ text: message('customer_verification_text_unavailable'), kind: 'info' });
    } else if (code === 'PAYMENT_METHOD_SAVE_EMAIL_UNAVAILABLE') {
      setEmailHidden(true);
      setStatus({ text: message('payment_method_save_email_unavailable'), kind: quiet ? 'info' : 'error' });
    } else if (code === 'CUSTOMER_VERIFICATION_CODE_INVALID') {
      setStatus({ text: message('save_card_code_invalid'), kind: 'error' });
      setCodeInvalid(true);
      document.getElementById('save-card-code')?.focus();
    } else if (code === 'PAYMENT_METHOD_SAVE_CODE_LIMIT_REACHED' || error?.kind === 'rate_limited') {
      setStatus({ text: message('customer_verification_rate_limited'), kind: 'error' });
    } else if (code === 'PAYMENT_METHOD_SAVE_NOT_READY') {
      setStatus({ text: message('payment_method_save_not_ready'), kind: 'info' });
    } else {
      setStatus({ text: message(error?.code === 'NETWORK_ERROR' ? 'network_error' : 'generic_error'), kind: quiet ? 'info' : 'error' });
    }
    return false;
  }

  async function send(channel: 'sms' | 'email', quiet: boolean) {
    setBusy(true);
    const result = await checkoutRequest(ref, csrf, 'POST', '/verification', { purpose: 'confirm_saved_payment_method', channel });
    setBusy(false);
    if (result.ok || explain(result.error, quiet)) {
      router.refresh();
      window.setTimeout(() => document.getElementById('save-card-code')?.focus(), 300);
    }
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setCodeInvalid(false);
    if (!/^\d{6}$/.test(code.trim())) {
      explain({ code: 'CUSTOMER_VERIFICATION_CODE_INVALID' }, false);
      return;
    }
    setBusy(true);
    const result = await checkoutRequest(ref, csrf, 'POST', '/verification/confirm', { code: code.trim() });
    setBusy(false);
    if (result.ok || explain(result.error, false)) router.refresh();
  }

  // The first text is sent once per checkout, without a press, then the buttons take over.
  useEffect(() => {
    if (!save || save.status !== 'pending' || sent || emailOnly || autoSent.current) return;
    const key = `save-card-auto:${ref}`;
    try {
      if (window.sessionStorage.getItem(key) === '1') return;
      window.sessionStorage.setItem(key, '1');
    } catch {
      // Private browsing can refuse storage. The buttons still work.
    }
    autoSent.current = true;
    void send('sms', true);
    // Runs once for the pending state this page rendered.
  }, [save?.status, sent, emailOnly, ref]);

  if (!save) return null;
  const heading = <h3 id="save-card-title">{copy.complete.saveCardHeading}</h3>;
  const statusLine = <p className="status-line" role={status?.kind === 'error' ? 'alert' : 'status'} data-state={status?.kind} data-testid="sf-save-confirm-status">{status?.text ?? ''}</p>;
  if (save.status === 'saved') {
    return <section className="panel" aria-labelledby="save-card-title" data-status="saved" data-testid="sf-save-confirm">{heading}<p role="status" data-testid="sf-save-confirm-saved">{save.saved_with === 'email' ? copy.complete.saveCardSavedEmail : copy.complete.saveCardSavedText}</p></section>;
  }
  if (save.status === 'expired') {
    return <section className="panel" aria-labelledby="save-card-title" data-status="expired" data-testid="sf-save-confirm">{heading}<p data-testid="sf-save-confirm-expired">{copy.complete.saveCardExpired}</p></section>;
  }
  if (save.status !== 'pending') return null;
  if (!sent) {
    return (
      <section className="panel" aria-labelledby="save-card-title" data-status="pending" data-testid="sf-save-confirm">
        {heading}
        <p className="hint flush">{emailOnly ? copy.complete.saveCardEmailStep : copy.complete.saveCardIntro}</p>
        <div className="actions">
          {emailOnly ? (
            <button className="button" type="button" disabled={busy} hidden={emailHidden} onClick={() => void send('email', false)} data-testid="sf-save-confirm-email">{copy.complete.saveCardSendEmail}</button>
          ) : (
            <>
              <button className="button" type="button" disabled={busy} hidden={textHidden} onClick={() => void send('sms', false)} data-testid="sf-save-confirm-text">{copy.complete.saveCardSendText}</button>
              <button className={textHidden ? 'button' : 'button button-quiet'} type="button" disabled={busy} hidden={emailHidden} onClick={() => void send('email', false)} data-testid="sf-save-confirm-email">{copy.complete.saveCardEmailInstead}</button>
            </>
          )}
        </div>
        {statusLine}
      </section>
    );
  }
  const bySms = v!.delivery_channel === 'sms';
  const prompt = bySms ? message('returning_code_sms', { digits: v!.phone_last_digits ?? save.phone_last_digits }) : message('returning_code_email', { email: v!.masked_email });
  return (
    <section className="panel" aria-labelledby="save-card-title" data-status="code_sent" data-testid="sf-save-confirm">
      {heading}
      <form noValidate className="stack" onSubmit={(event) => void confirm(event)} data-testid="sf-save-confirm-form">
        <p id="save-card-prompt" className="flush">{prompt}</p>
        <Field id="save-card-code" name="code" label={copy.complete.saveCardCode} value={code} onChange={(event) => setCode(event.target.value)} required autoComplete="one-time-code" inputMode="numeric" maxLength={6} testid="sf-save-confirm-code" data-sensitive="true" aria-invalid={codeInvalid || undefined} />
        <div className="actions">
          <button className="button button-primary" type="submit" disabled={busy} aria-busy={busy} data-testid="sf-save-confirm-confirm">{copy.complete.saveCardConfirm}</button>
          <button className="button button-quiet" type="button" disabled={busy} onClick={() => void send(bySms ? 'sms' : 'email', false)} data-testid="sf-save-confirm-resend">{copy.complete.saveCardResend}</button>
          {bySms && !emailOnly ? <button className="button button-quiet" type="button" disabled={busy} hidden={emailHidden} onClick={() => void send('email', false)} data-testid="sf-save-confirm-email">{copy.complete.saveCardEmailInstead}</button> : null}
        </div>
      </form>
      {statusLine}
    </section>
  );
}
