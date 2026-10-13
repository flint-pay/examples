'use client';

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as logic from '@/shared/checkout-logic.ts';
import { copy, fill, hasMessage, message, parseNotice } from '@/shared/copy.ts';
import { formatMoney, isPositive } from '@/shared/money.ts';
import type { CheckoutState, Money } from '@/shared/types.ts';
import { CheckIcon, ChevronDownIcon, LockIcon } from '../icons.tsx';
import { Field, MoneyText, Notice, Notices, productImage } from '../ui.tsx';
import { CheckoutController, type GiftChallengeBoot, type Snapshot } from './controller.ts';
import { BillingSection, DeliverySection, TipSection } from './DeliverySections.tsx';
import { PaymentSection, SavingsSection } from './PaymentSection.tsx';

type Context = { controller: CheckoutController; snap: Snapshot; storeName: string; emailLocked: boolean; signedInEmail: string | null };
const CheckoutContext = createContext<Context | null>(null);

export function useCheckout(): Context {
  const value = useContext(CheckoutContext);
  if (!value) throw new Error('useCheckout outside the checkout');
  return value;
}

type Props = {
  initial: CheckoutState;
  csrf: string;
  storeName: string;
  contact: { name: string; email: string; phone: string };
  emailLocked: boolean;
  signedInEmail: string | null;
  giftChallenge: GiftChallengeBoot;
};

export function CheckoutClient({ initial, csrf, storeName, contact, emailLocked, signedInEmail, giftChallenge }: Props) {
  const [controller] = useState(() => new CheckoutController({ ref: initial.checkout_ref, csrf, store: storeName, state: initial, giftChallenge, contact }));
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  // Notices from the first render stay until the page changes them; later ones arrive with each answer.
  const [firstNotices] = useState(() => initial.notices ?? []);

  useEffect(() => {
    controller.attach();
    void controller.start();
    return () => controller.detach();
  }, [controller]);

  const state = snap.state;
  const resting = logic.derivePaymentState(state);
  const readOnly = resting === 'recovery' || logic.isExpired(state);
  const delivery = logic.showDelivery(state);
  const billing = logic.taxLocationState(state) !== null;
  const notices = [...new Set([...firstNotices.filter((key) => snap.state === initial), ...(state.notices ?? [])])].filter((raw) => hasMessage(parseNotice(raw).key));
  const title = state.kind === 'subscription' ? copy.checkout.subscriptionTitle : copy.checkout.title;
  const amount = formatMoney(state.approved_outstanding_money ?? logic.outstandingOf(state));

  return (
    <CheckoutContext.Provider value={{ controller, snap, storeName, emailLocked, signedInEmail }}>
      <div data-checkout data-ref={state.checkout_ref} data-kind={state.kind} data-testid="sf-checkout" data-state={snap.paymentState} data-js="ready" data-resolving={snap.locked ? 'true' : undefined}>
        <div id="live-region" className="visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-testid="sf-live">{snap.announcement}</div>
        <div className="checkout-shell">
          <div>
            <div className="checkout-title"><h1>{title}</h1></div>
            <Notices keys={notices} params={{ amount, store: storeName }} />
            <div className="checkout-sections">
              {snap.locked ? <div className="locked-note"><Notice tone="info" testid="sf-locked-note"><p>{message('sections_locked')}</p></Notice></div> : null}
              {readOnly ? null : (
                <>
                  <ContactSection step={1} />
                  {delivery ? <DeliverySection step={2} /> : billing ? <BillingSection step={2} /> : null}
                  <TipSection />
                  {state.kind === 'order' ? <SavingsSection /> : null}
                </>
              )}
              <PaymentSection step={readOnly ? undefined : delivery || billing ? 3 : 2} />
            </div>
          </div>
          <OrderSummary />
        </div>
      </div>
    </CheckoutContext.Provider>
  );
}

export function StepHeading({ id, step, done, title, children }: { id: string; step?: number; done?: boolean; title: string; children?: React.ReactNode }) {
  return (
    <div className="step-head">
      {step ? <span className="step-badge" aria-hidden="true">{done ? <CheckIcon /> : step}</span> : null}
      <h2 id={id} tabIndex={-1}>{title}</h2>
      {children}
    </div>
  );
}

// ----- Contact -----

function ContactSection({ step }: { step: number }) {
  const { controller, snap, emailLocked, signedInEmail } = useCheckout();
  const { contact, state } = snap;
  const needsPhone = (state.delivery_selection?.input_requirements ?? []).some((item) => item.field_path.includes('phone'));
  const done = logic.looksLikeEmail(contact.email) && Boolean(contact.name.trim());
  const verification = state.verification;
  const verificationKey = verification ? `${verification.purpose}:${verification.delivery_channel}:${verification.masked_email ?? verification.phone_last_digits ?? ''}` : '';
  const showVerification = verification?.status === 'code_sent' && verification.purpose === 'use_saved_payment_methods' && snap.verificationSkipped !== verificationKey;
  return (
    <section className="step" id="contact" aria-labelledby="contact-title" data-section="contact" data-done={done}>
      <StepHeading id="contact-title" step={step} done={done} title={copy.checkout.contactHeading}>
        {signedInEmail ? null : <a className="small" href={`/sign-in?next=${encodeURIComponent(`/checkout/${state.checkout_ref}`)}`}>{copy.checkout.haveAccount}</a>}
      </StepHeading>
      <fieldset disabled={snap.locked} className="stack" data-testid="sf-contact">
        {emailLocked ? (
          <div className="field">
            <label htmlFor="contact-email">{copy.checkout.email}</label>
            <input id="contact-email" name="email" type="email" value={contact.email} readOnly autoComplete="email" data-testid="sf-contact-email" aria-describedby="contact-email-hint" />
            <p className="hint" id="contact-email-hint">{fill(message('contact_signed_in_as'), { email: contact.email })}</p>
          </div>
        ) : (
          <Field id="contact-email" name="email" type="email" label={copy.checkout.email} value={contact.email} required autoComplete="email" testid="sf-contact-email"
            hint={copy.checkout.emailHint} error={snap.emailInvalid ? message('contact_email_invalid') : undefined}
            onChange={(event) => controller.setContact('email', event.target.value)} onBlur={() => controller.blurContact('email')} />
        )}
        <div className="field-row field-row-2">
          <Field id="contact-name" name="name" label={copy.checkout.fullName} value={contact.name} required autoComplete="name" testid="sf-contact-name"
            onChange={(event) => controller.setContact('name', event.target.value)} onBlur={() => controller.blurContact('name')} />
          <Field id="contact-phone" name="phone" type="tel" label={needsPhone ? copy.checkout.phoneDelivery : copy.checkout.phoneLabel} optional={!needsPhone} value={contact.phone} autoComplete="tel" inputMode="tel" required={needsPhone}
            hint={copy.checkout.phoneHint} testid="sf-contact-phone"
            onChange={(event) => controller.setContact('phone', event.target.value)} onBlur={() => controller.blurContact('phone')} />
        </div>
      </fieldset>
      <div aria-live="polite">
        {showVerification ? <VerificationForm /> : null}
        <p className="field-error" role="alert" data-job-error="verification" hidden={!snap.jobErrors.verification}>{snap.jobErrors.verification}</p>
      </div>
    </section>
  );
}

function VerificationForm() {
  const { controller, snap } = useCheckout();
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState('');
  const v = snap.state.verification!;
  const sms = v.delivery_channel === 'sms';
  const prompt = sms ? message('returning_code_sms', { digits: v.phone_last_digits }) : message('returning_code_email', { email: v.masked_email });
  const queued = controller.isQueued('verification-confirm');
  return (
    <form className="panel" noValidate data-testid="sf-returning" onSubmit={(event) => {
      event.preventDefault();
      if (!/^\d{6}$/.test(code.trim())) { setProblem(message('code_required')); return; }
      setProblem('');
      void controller.job('verification-confirm', { code: code.trim() });
    }}>
      <p className="choice-title">{copy.checkout.returningHeading}</p>
      <p id="returning-prompt" className="small">{prompt}</p>
      <Field id="returning-code" name="code" label={copy.checkout.returningCode} value={code} onChange={(event) => setCode(event.target.value)} required autoComplete="one-time-code" inputMode="numeric" maxLength={6} className="code-field" testid="sf-returning-code" data-sensitive="true" error={problem || undefined} />
      <div className="actions">
        <button className="button button-primary" type="submit" aria-busy={queued} disabled={queued || snap.locked} data-testid="sf-returning-confirm">{copy.checkout.returningConfirm}</button>
        {sms ? <button className="button button-quiet" type="button" onClick={() => void controller.emailCodeInstead()} data-testid="sf-returning-email">{copy.checkout.returningEmailInstead}</button> : null}
        <button className="button button-quiet" type="button" onClick={() => controller.skipVerification()} data-testid="sf-returning-skip">{copy.checkout.returningSkip}</button>
      </div>
    </form>
  );
}

// ----- Summary -----

function Row({ label, value, text, row, testid, strong, className }: { label: string; value: Money | null | undefined; text: string; row: string; testid?: string; strong?: boolean; className?: string }) {
  return (
    <div className={`summary-row${strong ? ' summary-strong' : ''}${className ? ` ${className}` : ''}`} data-row={row}>
      <dt>{label}</dt>
      <dd><MoneyText value={value} text={text} testid={testid} /></dd>
    </div>
  );
}

export function AmountRows({ state }: { state: CheckoutState }) {
  const order = state.order;
  const pricing = order.pricing_amounts;
  const outstanding = logic.processorMoney(state);
  const total = pricing?.total_money ?? null;
  const taxPending = order.tax?.status === 'requires_location';
  const estimate = order.gift_card_estimate;
  const giftMoney = (order.gift_cards?.length ?? 0) > 0 ? estimate?.gift_card_money ?? null : null;
  const charges = (order.charges ?? []).filter((charge) => isPositive(charge.applied_money));
  const deliveryPending = logic.showDelivery(state) && !state.delivery_selection && !charges.length && !isPositive(pricing?.charge_money);
  return (
    <dl className="summary-rows">
      <Row label={copy.checkout.subtotal} value={pricing?.subtotal_money} text={formatMoney(pricing?.subtotal_money)} row="subtotal" testid="sf-summary-subtotal" />
      {pricing && isPositive(pricing.discount_money) ? <Row label={copy.checkout.discounts} value={pricing.discount_money} text={`-${formatMoney(pricing.discount_money)}`} row="discounts" testid="sf-summary-discounts" /> : null}
      {charges.length
        ? charges.map((charge, index) => <Row key={index} label={charge.name} value={charge.applied_money} text={formatMoney(charge.applied_money)} row="charge" />)
        : pricing && isPositive(pricing.charge_money)
          ? <Row label={copy.checkout.delivery} value={pricing.charge_money} text={formatMoney(pricing.charge_money)} row="charges" />
          : deliveryPending ? <div className="summary-row" data-row="delivery-pending"><dt>{copy.checkout.deliveryShort}</dt><dd><span className="pending-value">{copy.checkout.deliveryPending}</span></dd></div> : null}
      {pricing && isPositive(pricing.requested_tip_money) ? <Row label={copy.checkout.tip} value={pricing.requested_tip_money} text={formatMoney(pricing.requested_tip_money)} row="tip" testid="sf-summary-tip" /> : null}
      {taxPending ? (
        <div className="summary-row" data-row="tax"><dt>{copy.checkout.tax}</dt><dd><span className="money pending-value" data-testid="sf-summary-tax" data-state="requires_location">{logic.taxLocationState(state) === 'needed' ? copy.checkout.taxPendingBilling : copy.checkout.taxPending}</span></dd></div>
      ) : pricing?.tax_money ? <Row label={copy.checkout.tax} value={pricing.tax_money} text={formatMoney(pricing.tax_money)} row="tax" testid="sf-summary-tax" /> : null}
      <Row label={copy.checkout.total} value={total} text={formatMoney(total)} row="total" testid="sf-summary-total" strong />
      {giftMoney && isPositive(giftMoney) ? <Row label={copy.checkout.giftCards} value={giftMoney} text={`-${formatMoney(giftMoney)}`} row="gift-cards" testid="sf-summary-gift-cards" /> : null}
      <Row label={copy.checkout.amountDue} value={outstanding} text={formatMoney(outstanding)} row="outstanding" testid="sf-summary-outstanding" strong className="summary-due" />
    </dl>
  );
}

export function SummaryLines({ state }: { state: CheckoutState }) {
  return (
    <ul className="summary-lines" role="list" aria-label={copy.checkout.summaryLines}>
      {state.order.line_items.map((line, index) => {
        // Flint's line name can already include the variant, so the option shows only when it adds something.
        const values = line.selected_options?.map((entry) => entry.value).join(', ');
        const option = values && !line.name.includes(values) ? values : '';
        return (
          <li className="summary-line" key={line.order_line_item_id ?? index}>
            <span className="summary-thumb">
              <img src={productImage(line.slug)} alt="" width={64} height={48} />
              <span className="summary-qty" aria-hidden="true">{line.quantity}</span>
            </span>
            <span className="summary-line-name">
              {line.name}
              {option ? <span className="muted">{option}</span> : null}
              <span className="visually-hidden">{fill(copy.checkout.quantity, { n: line.quantity })}</span>
            </span>
            <MoneyText value={line.total_money} text={formatMoney(line.total_money)} />
          </li>
        );
      })}
    </ul>
  );
}

function OrderSummary() {
  const { snap } = useCheckout();
  const state = snap.state;
  const [open, setOpen] = useState(false);
  const outstanding = logic.outstandingOf(state);
  const total = state.order.pricing_amounts?.total_money ?? null;
  const trial = state.kind === 'subscription' ? state.session.subscription_terms?.trial_period_days : undefined;
  const support = state.session.merchant_support;
  const safeUrl = support?.url && /^https?:\/\//i.test(support.url) ? support.url : null;
  const panel = useRef<HTMLDivElement>(null);
  return (
    <aside className="order-summary" data-region="summary" data-testid="sf-summary" aria-labelledby="summary-title">
      <div className="summary-card">
        <button type="button" className="summary-toggle" aria-expanded={open} aria-controls="summary-content" onClick={() => setOpen(!open)}>
          <span className="toggle-label">{open ? copy.checkout.hideSummary : copy.checkout.showSummary}<ChevronDownIcon /></span>
          <span className="money">{formatMoney(total ?? outstanding)}</span>
        </button>
        <div className="summary-content" id="summary-content" ref={panel} hidden={!open}>
          <h2 className="summary-heading" id="summary-title">{copy.checkout.orderSummary}</h2>
          <SummaryLines state={state} />
          <AmountRows state={state} />
          {trial ? <p className="hint flush">{fill(copy.checkout.freeTrialLine, { days: trial })}</p> : null}
        </div>
      </div>
      <p className="powered"><LockIcon />{copy.checkout.securedBy} <strong>Flint</strong></p>
      {support && (support.email || support.phone || safeUrl) ? (
        <div className="support" data-testid="sf-support">
          <h3>{copy.checkout.supportHeading}</h3>
          <ul role="list">
            {support.email ? <li><a href={`mailto:${support.email}`}>{fill(copy.checkout.supportEmail, { email: support.email })}</a></li> : null}
            {support.phone ? <li><a href={`tel:${support.phone.replace(/[^+\d]/g, '')}`}>{fill(copy.checkout.supportPhone, { phone: support.phone })}</a></li> : null}
            {safeUrl ? <li><a href={safeUrl} rel="noopener noreferrer">{fill(copy.checkout.supportWebsite, { url: safeUrl.replace(/^https?:\/\//i, '') })}</a></li> : null}
          </ul>
        </div>
      ) : null}
    </aside>
  );
}
