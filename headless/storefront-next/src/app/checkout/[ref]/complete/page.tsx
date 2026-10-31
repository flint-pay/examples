import { notFound, redirect } from 'next/navigation';
import { copy, fill } from '@/shared/copy.ts';
import { deriveCompleteState, trialSetupNotStarted } from '@/shared/complete.ts';
import { addressLine, formatDay, titleCase } from '@/shared/format.ts';
import { formatMoney, isPositive } from '@/shared/money.ts';
import type { CheckoutState, CheckoutSubscription } from '@/shared/types.ts';
import { appError, condition } from '@/server/flint/errors.ts';
import { buyerSafe } from '@/server/flint/projection.ts';
import { pageVisitor } from '@/server/session.ts';
import { projectState } from '@/server/checkout-view.ts';
import { AmountRows, SummaryLines } from '@/components/checkout/CheckoutClient.tsx';
import { CompletePoller, ReceiptButton, SaveCardPanel } from '@/components/checkout/CompleteClient.tsx';
import { ErrorNotice, MoneyText, Notices } from '@/components/ui.tsx';
import { BankIcon, CheckIcon, ClockIcon } from '@/components/icons.tsx';

type Props = { params: Promise<{ ref: string }> };

export const metadata = { title: copy.complete.paidTitle };

export default async function CompletePage({ params }: Props) {
  const { ref } = await params;
  const path = `/checkout/${encodeURIComponent(ref)}`;
  const { rt, session, user } = await pageVisitor(`${path}/complete`);
  try {
    rt.checkouts.owned(ref, session, user);
  } catch {
    notFound();
  }
  let state: CheckoutState;
  let paidSignal = false;
  try {
    const current = await projectState(rt, ref, user);
    state = current.state;
    if (trialSetupNotStarted(state)) {
      if (!state.attempt) rt.checkouts.notice(current.read.record, 'trial_not_started');
      redirect(path);
    }
    let subscription: unknown;
    try {
      subscription = await rt.checkouts.subscription(current.read);
    } catch (error) {
      if (condition(error) !== 'CHECKOUT_SESSION_PAYMENT_REQUIRED') throw error;
    }
    state = { ...state, subscription: buyerSafe(subscription) as CheckoutSubscription | undefined };
    const order = current.read.order;
    if (current.read.record.cart_id && ['paid', 'bank_processing'].includes(rt.checkouts.record(ref).status)) rt.carts.complete(current.read.record.checkout_ref, order);
    paidSignal = Boolean(rt.store.get('SELECT * FROM order_signals WHERE order_id=?', order.order_id));
  } catch (error) {
    if (error && typeof error === 'object' && 'digest' in error) throw error;
    console.error(error);
    return (
      <section className="state-panel" data-testid="sf-complete" data-state="error">
        <h1>{copy.errors.serverTitle}</h1>
        <ErrorNotice error={appError(error)} params={{ store: rt.config.storeName }} />
      </section>
    );
  }
  const view = deriveCompleteState(state);
  const order = state.order;
  const paid = order.settlement_amounts?.paid_money ?? null;
  const outstanding = order.settlement_amounts?.outstanding_money ?? null;
  const accountOrigin = rt.config.accountOrigin ?? null;
  const accountUrl = accountOrigin ? (user ? `${accountOrigin}/orders/${encodeURIComponent(order.order_id)}` : `${accountOrigin}/sign-up?next=${encodeURIComponent(`/orders/${order.order_id}`)}`) : null;
  const email = order.buyer_contact?.email ?? '';
  const heading =
    view === 'paid' ? copy.complete.paidTitle
    : view === 'bank_processing' ? copy.complete.bankTitle
    : view === 'subscription_active' ? copy.complete.activeTitle
    : view === 'subscription_trialing' ? copy.complete.trialTitle
    : view === 'partially_paid' ? copy.complete.partialTitle
    : copy.complete.confirmingTitle;
  const Icon = view === 'confirming' || view === 'partially_paid' ? ClockIcon : view === 'bank_processing' ? BankIcon : CheckIcon;
  const lead = view === 'paid' ? (email ? fill(copy.complete.paidLead, { email }) : copy.complete.paidLeadNoEmail) : view === 'bank_processing' ? copy.complete.bankBody : view === 'confirming' ? (state.kind === 'subscription' ? copy.complete.subscriptionPending : copy.complete.confirmingBody) : '';
  const accountLink = accountUrl ? <a className="button" href={accountUrl} data-testid="sf-account-link">{user ? copy.complete.trackOrder : copy.complete.createAccount}</a> : null;
  return (
    <div data-testid="sf-complete" data-state={view}>
      <Notices keys={state.notices ?? []} params={{ store: rt.config.storeName }} />
      <section className="complete-hero" aria-labelledby="complete-title">
        <div className="state-icon"><Icon /></div>
        <h1 id="complete-title" tabIndex={-1} data-testid="sf-complete-status" data-status={view}>{heading}</h1>
        {lead ? <p>{lead}</p> : null}
        {order.order_number && view !== 'confirming' && state.kind === 'order' ? <p className="order-number">{copy.complete.orderNumber} <strong data-testid="sf-complete-order-number">{order.order_number}</strong></p> : null}
      </section>

      {view === 'confirming' ? (
        <div className="state-panel" data-region="complete">
          <div className="progress-line progress-center"><span className="spinner" aria-hidden="true" /><span>{copy.complete.updatesOnItsOwn}</span></div>
          <CompletePoller />
          <a className="button" href={`${path}/complete`} data-testid="sf-check-again">{copy.complete.checkAgain}</a>
        </div>
      ) : view === 'partially_paid' ? (
        <div className="state-panel" data-region="complete">
          <p>{fill(copy.complete.partialBody, { paid: formatMoney(paid), remaining: formatMoney(outstanding) })}</p>
          <p>{fill(copy.complete.partialSupport, { store: rt.config.storeName })}</p>
          {state.session.merchant_support?.email ? <p><a href={`mailto:${state.session.merchant_support.email}`}>{state.session.merchant_support.email}</a> {state.session.merchant_support.phone ?? ''}</p> : null}
        </div>
      ) : view === 'subscription_active' || view === 'subscription_trialing' ? (
        <div className="panel-card wrap-narrow centered" data-region="complete">
          <SubscriptionFacts state={state} trialing={view === 'subscription_trialing'} />
          {accountOrigin && state.subscription ? <p className="spaced"><a className="button" href={`${accountOrigin}/subscriptions/${encodeURIComponent(state.subscription.subscription_id)}`} data-testid="sf-account-link">{copy.complete.manage}</a></p> : null}
        </div>
      ) : (
        <div className="complete-grid" data-region="complete">
          <div className="panel-card stack">
            <h2>{copy.complete.items}</h2>
            <SummaryLines state={state} />
            <Destination state={state} />
          </div>
          <div className="panel-card stack">
            <h2>{copy.complete.amounts}</h2>
            {view === 'paid' ? <AmountRows state={state} /> : null}
            {view === 'paid' ? <PaymentLine state={state} /> : null}
            {paid && isPositive(paid) ? <p className="summary-row summary-strong"><span>{copy.complete.paidAmount}</span> <MoneyText value={paid} text={formatMoney(paid)} /></p> : null}
            {paidSignal ? <p className="hint flush" data-testid="sf-paid-signal"><CheckIcon className="inline-icon" /> {copy.complete.paidSignal}</p> : null}
            {view === 'paid' ? <SaveCardPanel state={state} csrf={session.csrf_token} /> : null}
            {view === 'paid' ? <ReceiptButton checkoutRef={state.checkout_ref} email={email} csrf={session.csrf_token} /> : null}
            <div className="actions">{accountLink}<a className="button-link" href="/">{copy.complete.continueShopping}</a></div>
          </div>
        </div>
      )}
    </div>
  );
}

function Destination({ state }: { state: CheckoutState }) {
  const dest = state.order.delivery_destination;
  const choice = state.delivery_selection?.choices?.[0];
  if (choice?.type === 'pickup') {
    const location = choice.pickup?.location;
    return <div data-testid="sf-complete-delivery"><h3>{copy.complete.pickupAt}</h3><p className="flush">{location?.name ?? choice.name}</p>{location?.address ? <p className="muted flush">{addressLine(location.address)}</p> : null}{location?.instructions ? <p className="muted flush">{location.instructions}</p> : null}</div>;
  }
  if (!dest?.address) return null;
  return (
    <div data-testid="sf-complete-delivery">
      <h3>{copy.complete.deliveryTo}</h3>
      {dest.recipient?.name ? <p className="flush">{dest.recipient.name}</p> : null}
      <p className="muted flush">{addressLine(dest.address)}</p>
      {choice?.arrival_estimate ? <p className="muted flush">{fill(copy.checkout.arrives, { earliest: formatDay(choice.arrival_estimate.earliest_date), latest: formatDay(choice.arrival_estimate.latest_date) })}</p> : null}
    </div>
  );
}

/** Says when no card paid: gift cards or discounts covered the order. */
function PaymentLine({ state }: { state: CheckoutState }) {
  const total = state.order.pricing_amounts?.total_money ?? null;
  const gift = (state.order.gift_card_settlements ?? []).reduce((sum, item) => sum + BigInt(item.amount_money?.amount ?? '0'), 0n);
  const totalMinor = total ? BigInt(total.amount) : null;
  const text = gift > 0n && totalMinor !== null && gift >= totalMinor ? copy.complete.paidWithGiftCard : totalMinor === 0n ? copy.complete.coveredByDiscounts : '';
  return text ? <p className="summary-row" data-testid="sf-complete-payment-method"><span>{text}</span></p> : null;
}

function SubscriptionFacts({ state, trialing }: { state: CheckoutState; trialing: boolean }) {
  const sub = state.subscription!;
  const plan = sub.subscription_plan?.name ?? state.session.subscription_terms?.plan_name ?? state.order.subscription_plan?.name ?? '';
  const card = sub.payment_method?.card;
  const next = sub.next_billing_at ?? sub.trial_end_at;
  const statusText = sub.status === 'trialing' ? copy.complete.statusTrialing : sub.status === 'active' ? copy.complete.statusActive : fill(copy.complete.statusOther, { status: sub.status.replace(/_/g, ' ') });
  const amount = <MoneyText value={sub.recurring_subtotal_money ?? null} text={formatMoney(sub.recurring_subtotal_money)} />;
  return (
    <dl className="facts">
      <div><dt>{copy.complete.plan}</dt><dd>{plan}</dd></div>
      <div><dt>{copy.complete.status}</dt><dd data-testid="sf-subscription-status" data-status={sub.status}>{statusText}</dd></div>
      {trialing ? (
        <>
          <div><dt>{copy.complete.trialEnds}</dt><dd>{formatDay(sub.trial_end_at, true)}</dd></div>
          <div><dt>{copy.complete.firstCharge}</dt><dd>{amount}{sub.next_billing_at ? ` on ${formatDay(sub.next_billing_at, true)}` : ''}</dd></div>
        </>
      ) : (
        <div><dt>{copy.complete.nextCharge}</dt><dd>{next ? <>{amount} on {formatDay(next, true)}</> : ''}</dd></div>
      )}
      {card ? <div><dt>{copy.complete.paymentMethod}</dt><dd>{fill(copy.complete.cardEnding, { brand: titleCase(card.brand), last4: card.last4 })}</dd></div> : null}
    </dl>
  );
}
