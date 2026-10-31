'use client';

import { useEffect, useRef, useState } from 'react';
import * as logic from '@/shared/checkout-logic.ts';
import { copy, fill, intervalUnit, message } from '@/shared/copy.ts';
import { titleCase } from '@/shared/format.ts';
import { formatMoney } from '@/shared/money.ts';
import type { CheckoutState } from '@/shared/types.ts';
import { BankIcon, LockIcon } from '../icons.tsx';
import { Field, MoneyText } from '../ui.tsx';
import { CheckoutButton } from '../CheckoutButton.tsx';
import { StepHeading, useCheckout } from './CheckoutClient.tsx';

// ----- Discounts and gift cards -----

export function SavingsSection() {
  const { snap } = useCheckout();
  const state = snap.state;
  const codes = state.session.promotion_config?.codes_enabled !== false;
  const gifts = state.order.gift_card_tender_enabled !== false;
  if (!codes && !gifts) return null;
  return (
    <section className="step" aria-labelledby="savings-title" data-section="savings">
      <StepHeading id="savings-title" title={codes && gifts ? copy.checkout.savingsHeading : codes ? copy.checkout.discountHeading : copy.checkout.giftCardHeading} />
      <div className="stack">
        {codes ? <DiscountBlock /> : null}
        {gifts ? <GiftCardBlock /> : null}
      </div>
    </section>
  );
}

function DiscountBlock() {
  const { controller, snap } = useCheckout();
  const applied = (snap.state.order.discounts ?? []).filter((discount) => discount.status !== 'canceled');
  const [code, setCode] = useState('');
  const error = snap.jobErrors.discount;
  const queued = controller.isQueued('discount') || controller.isQueued('discount-remove');
  return (
    <div id="discount" data-region="discount" data-section="discount">
      <h3 id="discount-title" tabIndex={-1} className="visually-hidden">{copy.checkout.discountHeading}</h3>
      {applied.length ? (
        <ul className="applied-list" role="list" aria-label={copy.checkout.discountApplied}>
          {applied.map((discount, index) => {
            const label = discount.customer_facing_name ?? discount.promotion_code ?? copy.checkout.discountHeading;
            return (
              <li key={discount.order_discount_id} data-testid={`sf-discount-applied-${index}`}>
                <span className="applied-name">{label}{discount.promotion_code && discount.customer_facing_name ? <> <span className="code">{discount.promotion_code}</span></> : null}</span>
                <span className="applied-amount"><MoneyText value={discount.applied_money} text={`-${formatMoney(discount.applied_money)}`} /></span>
                {discount.promotion_code ? (
                  <button className="button button-quiet button-small" type="button" disabled={snap.locked || queued} aria-label={fill(copy.checkout.discountRemoveLabel, { name: label })}
                    onClick={() => void controller.job('discount-remove', { order_discount_ids: [discount.order_discount_id] })}>{copy.checkout.discountRemove}</button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="stack">
          <form noValidate className="inline-field" data-testid="sf-discount" onSubmit={(event) => {
            event.preventDefault();
            if (!code.trim()) { controller.showJobError('discount', message('discount_required')); document.getElementById('discount-code')?.focus(); return; }
            void controller.job('discount', { promotion_code: code.trim() }, { onDone: () => setCode('') });
          }}>
            <Field id="discount-code" name="promotion_code" label={copy.checkout.discountCode} value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" testid="sf-discount-code" disabled={snap.locked} aria-invalid={error ? true : undefined} />
            <button className="button button-dark" type="submit" aria-busy={controller.isQueued('discount')} disabled={snap.locked || queued} data-testid="sf-discount-apply">{copy.checkout.discountApply}</button>
          </form>
          <p className="field-error" role="alert" data-job-error="discount" data-testid="sf-discount-error" hidden={!error}>{error}</p>
      </div>
    </div>
  );
}

function GiftCardBlock() {
  const { controller, snap } = useCheckout();
  const order = snap.state.order;
  const cards = order.gift_cards ?? [];
  const allocations = new Map((order.gift_card_estimate?.gift_cards ?? []).map((card) => [card.gift_card_id, card.amount_money]));
  const [code, setCode] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const gift = snap.gift;
  const active = controller.giftActive();
  const error = snap.jobErrors['gift-card'];
  useEffect(() => { if (snap.giftCodeReset) setCode(''); }, [snap.giftCodeReset]);
  // The field shows the code being checked, as Apply sent it.
  useEffect(() => { if (active && gift.code) setCode(gift.code); }, [active, gift.code]);

  function apply(event?: React.FormEvent) {
    event?.preventDefault();
    if (active) return;
    if (!code.trim()) { controller.showJobError('gift-card', message('gift_card_required')); document.getElementById('gift-card-code')?.focus(); return; }
    void controller.job('gift-card', { gift_card_code: code.trim() });
  }

  const status = gift.state === 'slow' ? message('gift_challenge_slow') : gift.state === 'checking' ? message('gift_challenge_checking') : '';
  const alert = gift.state === 'failed' ? message('gift_challenge_failed') : gift.state === 'expired' ? message('gift_challenge_expired') : '';
  return (
    <div id="gift-cards" data-region="gift-cards" data-section="gift-cards" data-challenge-state={gift.state}>
      <h3 id="gift-title" tabIndex={-1} className="visually-hidden">{copy.checkout.giftCardHeading}</h3>
      {cards.length ? (
        <ul className="applied-list" role="list" aria-label={copy.checkout.giftCardApplied}>
          {cards.map((card, index) => {
            const amount = allocations.get(card.gift_card_id) ?? null;
            return (
              <li key={card.gift_card_id} data-testid={`sf-gift-card-applied-${index}`}>
                <span className="applied-name">{fill(copy.checkout.giftCardEnding, { last: card.last4 })}</span>
                <span className="applied-amount">{amount ? <MoneyText value={amount} text={fill(copy.checkout.giftCardAmount, { amount: formatMoney(amount) })} /> : null}</span>
                <button className="button button-quiet button-small" type="button" disabled={snap.locked || controller.isQueued('gift-card-remove')} aria-label={fill(copy.checkout.giftCardRemoveLabel, { last: card.last4 })}
                  onClick={() => void controller.job('gift-card-remove', {}, { path: `/gift-card/${encodeURIComponent(card.gift_card_id)}/remove` })}>{copy.checkout.giftCardRemove}</button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="stack">
          <form ref={form} noValidate className="inline-field" data-testid="sf-gift-card" onSubmit={apply}>
            <Field id="gift-card-code" name="gift_card_code" label={copy.checkout.giftCardCode} value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" testid="sf-gift-card-code" data-sensitive="true"
              readOnly={active} aria-readonly={active || undefined} disabled={snap.locked} aria-describedby={error ? 'gift-card-error' : undefined} />
            <button className="button button-dark" type="submit" aria-busy={gift.state === 'checking' || controller.isQueued('gift-card')} disabled={snap.locked || active || controller.isQueued('gift-card')} data-testid="sf-gift-card-apply">{copy.checkout.giftCardApply}</button>
          </form>
          <p className="field-error" id="gift-card-error" role="alert" data-job-error="gift-card" data-testid="sf-gift-card-error" hidden={!error}>{error}</p>
          <div className="gift-challenge" role="group" aria-labelledby="gift-challenge-intro" data-testid="sf-gift-challenge" data-state={active ? gift.state : 'none'} hidden={!active}
            onKeyDown={(event) => { if (event.key === 'Escape' && active && gift.state !== 'checking') { event.preventDefault(); controller.cancelGiftChallenge(); } }}>
            <p id="gift-challenge-intro" className="flush" tabIndex={-1}>{message('gift_challenge_intro')}</p>
            <div id="gift-challenge-host" data-testid="sf-gift-challenge-host" hidden={gift.state !== 'loading' && gift.state !== 'slow'} />
            <p className="hint flush" role="status" data-testid="sf-gift-challenge-status">{status}</p>
            <p className="field-error" id="gift-challenge-message" role="alert" tabIndex={-1} data-testid="sf-gift-challenge-message" hidden={!alert}>{alert}</p>
            <div className="actions">
              <button type="button" className="button" hidden={!['slow', 'failed', 'expired'].includes(gift.state)} onClick={() => controller.retryGiftChallenge(() => form.current?.requestSubmit())} data-testid="sf-gift-challenge-retry">{copy.checkout.giftChallengeRetry}</button>
              <button type="button" className="button button-quiet" hidden={!active || gift.state === 'checking'} onClick={() => controller.cancelGiftChallenge()} aria-label={copy.checkout.giftChallengeCancelLabel} data-testid="sf-gift-challenge-cancel">{copy.checkout.giftChallengeCancel}</button>
            </div>
          </div>
      </div>
    </div>
  );
}

// ----- Payment -----

function payLabel(state: CheckoutState): string {
  const outstanding = formatMoney(logic.processorMoney(state));
  switch (logic.buttonKind(state)) {
    case 'subscription_trial': return copy.checkout.payTrial;
    case 'subscription_paid': return fill(copy.checkout.paySubscription, { amount: outstanding });
    case 'confirm_order': return copy.checkout.payConfirmOrder;
    default: return fill(copy.checkout.payOrder, { amount: outstanding });
  }
}

function SubscriptionTerms({ state }: { state: CheckoutState }) {
  const terms = state.session.subscription_terms;
  if (state.kind !== 'subscription' || !terms) return null;
  const count = Number(terms.billing_interval_count);
  const unit = intervalUnit(terms.billing_interval, count);
  const total = formatMoney(terms.recurring_total_money);
  const parts = [
    count === 1 ? fill(copy.checkout.subscriptionTermsOne, { total, unit }) : fill(copy.checkout.subscriptionTerms, { total, unit, count }),
    terms.trial_period_days ? fill(copy.checkout.trialTerms, { days: terms.trial_period_days }) : '',
    copy.checkout.cancelNote,
    terms.contract_term_months ? fill(copy.checkout.contractTerm, { months: terms.contract_term_months }) : '',
    terms.early_termination_fee_money ? fill(copy.checkout.earlyTerminationFee, { fee: formatMoney(terms.early_termination_fee_money) }) : '',
  ].filter(Boolean);
  return <div className="terms" data-testid="sf-subscription-terms"><p>{parts.join(' ')}</p></div>;
}

export function PaymentSection({ step }: { step?: number }) {
  const { controller, snap, storeName } = useCheckout();
  const state = snap.state;
  const resting = logic.derivePaymentState(state);
  const showForm = !['expired', 'unavailable', 'recovery', 'needs_billing'].includes(resting);
  const paymentState = snap.paymentState;
  const support = state.session.merchant_support;
  const dialog = useRef<HTMLDialogElement>(null);
  const another = useRef<HTMLButtonElement>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  return (
    <section className="step" id="payment" aria-labelledby="payment-title" data-testid="sf-payment" data-state={paymentState} data-collection={logic.collectionKindOf(state)} data-section="payment" data-kind={state.kind} data-active="true">
      <StepHeading id="payment-title" step={step} title={copy.checkout.paymentHeading}>
        <span className="secure-note"><LockIcon />{copy.checkout.encrypted}</span>
      </StepHeading>
      {resting === 'expired' ? (
        <div className="panel" data-testid="sf-expired">
          <p role="alert">{message('checkout_expired')}</p>
          {state.kind === 'order' ? <CheckoutButton storeName={storeName} label={copy.checkout.startAgain} className="button button-primary" testid="sf-start-again" /> : <a className="button button-primary" href="/#coffee-club">{copy.checkout.startAgain}</a>}
        </div>
      ) : null}
      {resting === 'unavailable' ? (
        <div className="panel" data-testid="sf-unavailable">
          <p role="alert" data-testid="sf-payment-message">{state.next === 'capture' ? message('bug_checkout', { store: storeName }) : message('payments_unavailable', { store: storeName })}</p>
          {support?.email ? <p><a href={`mailto:${support.email}`}>{support.email}</a></p> : null}
        </div>
      ) : null}
      {resting === 'needs_billing' ? <div className="panel" data-testid="sf-payment-needs-billing"><p role="status">{message('billing_address_needed')}</p></div> : null}
      {resting === 'recovery' ? <div className="panel" data-testid="sf-recovery"><div className="progress-line"><span className="spinner" aria-hidden="true" /><p role="status" data-testid="sf-payment-message">{message('finishing_payment')}</p></div></div> : null}
      {showForm ? <PaymentForm onPayAnotherWay={() => dialog.current?.showModal()} anotherRef={another} /> : null}
      <dialog ref={dialog} aria-labelledby="affirm-dialog-title" data-testid="sf-affirm-dialog" onClose={() => {
        if (dialog.current?.returnValue === 'confirm') { setConfirmingCancel(true); void controller.payAnotherWay().finally(() => setConfirmingCancel(false)); }
        else another.current?.focus();
      }}>
        <form method="dialog" className="stack">
          <h3 id="affirm-dialog-title">{copy.checkout.dialogTitle}</h3>
          <p>{copy.checkout.dialogBody}</p>
          <div className="actions">
            <button className="button button-primary" type="submit" value="confirm" data-testid="sf-affirm-dialog-confirm" aria-busy={confirmingCancel}>{copy.checkout.dialogConfirm}</button>
            <button className="button" type="submit" value="cancel">{copy.checkout.dialogCancel}</button>
          </div>
        </form>
      </dialog>
    </section>
  );
}

function PaymentForm({ onPayAnotherWay, anotherRef }: { onPayAnotherWay: () => void; anotherRef: React.RefObject<HTMLButtonElement | null> }) {
  const { controller, snap, storeName } = useCheckout();
  const state = snap.state;
  const paymentState = snap.paymentState;
  const processor = controller.needsProcessor();
  const savedVisible = state.kind === 'order' && processor && snap.savedMethods.length > 0;
  const fieldsHidden = !processor || snap.savedChoice !== null;
  const saveOffered = controller.saveOffered();
  const phoneOffered = saveOffered && state.session.can_save_payment_method_with_phone === true;
  const guidance = logic.guidanceOf(state)?.stripe;
  const messaging = (guidance?.elements?.payment_method_types ?? []).includes('affirm');
  const settlement = logic.isSettlementOnly(state);
  const giftMoney = (state.order.gift_cards?.length ?? 0) > 0 ? state.order.gift_card_estimate?.gift_card_money : null;
  const estimate = state.order.gift_card_estimate;
  const split = logic.collectionKindOf(state) === 'processor' && (state.order.gift_cards?.length ?? 0) > 0 && estimate?.can_pay;
  const blockers = controller.blockers();
  const busy = paymentState === 'submitting';
  const first = blockers[0] ?? '';
  const message_ = snap.message;
  const panel = paymentState === 'affirm_incomplete' ? 'affirm' : ['waiting', 'resuming', 'authenticating'].includes(paymentState) ? 'waiting' : paymentState === 'bank_processing' ? 'bank' : '';
  const ach = (guidance?.elements?.payment_method_types ?? []).includes('us_bank_account');

  useEffect(() => {
    controller.onPaymentFormMounted();
    return () => controller.onPaymentFormUnmounted();
  }, [controller]);

  return (
    <form id="pay-form" noValidate data-testid="sf-pay-form" data-needs-processor={processor ? 'true' : 'false'} data-locked={snap.locked ? '' : undefined} className="payment-wrap"
      onSubmit={(event) => { event.preventDefault(); void controller.pay(); }}>
      {savedVisible ? (
        <fieldset data-region="saved-methods" data-saved-methods disabled={snap.locked}>
          <legend className="choice-legend">{copy.checkout.savedLegend}</legend>
          <div className="choices">
            {snap.savedMethods.map((method, index) => {
              const card = method.card!;
              return (
                <label className="choice-card" key={method.payment_method_id}>
                  <input type="radio" name="payment-source" value={method.payment_method_id} checked={snap.savedChoice === method.payment_method_id} onChange={() => controller.setSavedChoice(method.payment_method_id)} data-testid={`sf-saved-method-${index}`} />
                  <span className="choice-body"><span className="choice-title">{fill(copy.checkout.savedCardTitle, { brand: titleCase(card.brand), last4: card.last4 })}</span><span className="choice-detail">{fill(copy.checkout.savedCardExpires, { month: String(card.exp_month).padStart(2, '0'), year: String(card.exp_year).slice(-2) })}</span></span>
                </label>
              );
            })}
            <label className="choice-card">
              <input type="radio" name="payment-source" value="new" checked={snap.savedChoice === null} onChange={() => controller.setSavedChoice('new')} data-testid="sf-use-new-method" />
              <span className="choice-body"><span className="choice-title">{copy.checkout.useNewMethod}</span></span>
            </label>
          </div>
        </fieldset>
      ) : <div data-region="saved-methods" />}

      <div className="payment-wrap" hidden={fieldsHidden} data-payment-fields>
        <div className="wallets" data-testid="sf-wallets" hidden={!snap.walletsAvailable}>
          <div id="express-checkout" aria-label={copy.checkout.walletsLabel} />
          <p className="divider" aria-hidden="true">{copy.checkout.orPayWithCard}</p>
        </div>
        <div className="element-wrap">
          {!snap.elementsReady ? <div className="skeleton" aria-hidden="true"><span /><span /></div> : null}
          <div id="payment-element" role="group" aria-label={copy.checkout.paymentElementLabel} />
        </div>
        <div id="affirm-messaging" data-testid="sf-affirm-messaging" hidden={!messaging} />
        {messaging ? (
          <>
            <div className="field" hidden={!controller.affirmCountryShown()}>
              <label htmlFor="affirm-country">{copy.checkout.billingCountry}</label>
              <select id="affirm-country" name="billing_country" required disabled={!controller.affirmActive() || snap.locked} aria-describedby="affirm-country-hint" data-testid="sf-affirm-country" value={snap.affirmCountry} onChange={(event) => controller.setAffirmCountry(event.target.value)}>
                <option value="">{copy.checkout.billingCountryChoose}</option>
                <option value="US">{copy.checkout.countryUs}</option>
                <option value="other">{copy.checkout.countryOther}</option>
              </select>
              <p className="hint" id="affirm-country-hint">{copy.checkout.affirmCountryHint}</p>
            </div>
            <div hidden={!controller.affirmPostalShown()}>
              <Field id="affirm-postal" name="billing_postal_code" label={copy.checkout.billingPostalCode} inputMode="numeric" autoComplete="billing postal-code" maxLength={12} required disabled={!controller.affirmPostalShown() || snap.locked} testid="sf-affirm-postal"
                value={snap.affirmPostal} onChange={(event) => controller.setAffirmPostal(event.target.value)}
                error={snap.affirmPostal.trim() && !logic.US_POSTAL_CODE.test(snap.affirmPostal.trim()) ? message('billing_postal_code_required') : undefined} />
            </div>
          </>
        ) : null}
        {ach ? <p className="hint flush"><BankIcon className="inline-icon" /> {copy.checkout.achNote}</p> : null}
        {saveOffered ? (
          <div className="save-block" hidden={snap.savedChoice !== null}>
            <label className="check">
              <input type="checkbox" id="save-card" name="save_payment_method" checked={snap.saveCard} disabled={!controller.saveAllowed() || snap.locked} onChange={(event) => void controller.setSaveCard(event.target.checked)} data-testid="sf-save-card" aria-describedby="save-consent" />
              <span>{fill(copy.checkout.saveCard, { store: storeName })}</span>
            </label>
            <p className="hint flush" id="save-consent">{copy.checkout.saveCardConsent}</p>
            {phoneOffered && snap.saveCard ? (
              <Field id="save-phone" name="save_payment_method_phone" type="tel" label={copy.checkout.savePhone} autoComplete="tel" inputMode="tel" hint={copy.checkout.savePhoneHint} testid="sf-save-phone" value={snap.savePhone} onChange={(event) => controller.setSavePhone(event.target.value)} disabled={snap.locked} />
            ) : null}
          </div>
        ) : null}
      </div>

      {settlement ? (
        <p className="notice notice-info" role="status" data-testid="sf-settlement-explanation">
          {giftMoney ? fill(message('settlement_gift_card'), { gift_card_money: formatMoney(giftMoney) }) : message('settlement_discount')}
        </p>
      ) : null}
      {split && estimate ? <p className="hint flush" data-testid="sf-gift-card-split">{fill(message('gift_card_split'), { gift_card_money: formatMoney(estimate.gift_card_money), processor_money: formatMoney(estimate.processor_money) })}</p> : null}
      <SubscriptionTerms state={state} />

      {panel === 'affirm' ? (
        <div className="panel">
          <p>{message('affirm_incomplete')}</p>
          <div className="actions">
            <button className="button button-primary" type="button" onClick={() => void controller.continueAffirm()} data-testid="sf-affirm-continue">{copy.checkout.continueAffirm}</button>
            <button className="button" type="button" ref={anotherRef} onClick={onPayAnotherWay} data-testid="sf-pay-another-way">{copy.checkout.payAnotherWay}</button>
          </div>
        </div>
      ) : null}
      {panel === 'waiting' ? (
        <div className="panel">
          <div className="progress-line"><span className="spinner" aria-hidden="true" /><p role="status">{paymentState === 'resuming' ? copy.checkout.stateResuming : paymentState === 'authenticating' ? copy.checkout.stateAuthenticating : copy.checkout.stateWaiting}</p></div>
          {snap.checkAgain ? <button className="button" type="button" onClick={() => void controller.checkAgain()} data-testid="sf-check-again">{copy.checkout.checkAgain}</button> : null}
        </div>
      ) : null}
      {panel === 'bank' ? (
        <div className="panel">
          <p role="status">{copy.checkout.stateBankProcessing}</p>
          <a className="button button-primary" href={`/checkout/${encodeURIComponent(state.checkout_ref)}/complete`}>{copy.checkout.viewConfirmation}</a>
        </div>
      ) : null}

      {message_ ? (
        <div id="payment-message" className="payment-message" role="alert" tabIndex={-1} data-tone={message_.tone} data-testid="sf-payment-message" data-code={message_.code}>{message_.text}</div>
      ) : <div id="payment-message" hidden data-testid="sf-payment-message" />}
      {paymentState === 'pay_remaining' && state.attempt ? (
        <div className="panel" data-testid="sf-pay-remaining" role="status"><p>{fill(message('pay_remaining'), { paid: formatMoney(state.order.settlement_amounts?.paid_money), remaining: formatMoney(logic.outstandingOf(state)) })}</p></div>
      ) : null}

      <div className="pay-row">
        <button id="pay-button" className="button button-primary button-block pay-button" type="submit" aria-busy={busy} aria-describedby="pay-blocker" disabled={blockers.length > 0 || busy} data-testid="sf-pay-button">
          <LockIcon className="inline-icon" /> {payLabel(state)}
        </button>
        <p id="pay-blocker" className="pay-blocker" data-testid="sf-pay-blocker" data-blocker={first}>{busy || paymentState === 'loading' ? '' : first ? controller.blockerText(first) : ''}</p>
      </div>
    </form>
  );
}
