import { notFound, redirect } from 'next/navigation';
import { copy } from '@/shared/copy.ts';
import { appError } from '@/server/flint/errors.ts';
import { pageVisitor } from '@/server/session.ts';
import { projectState } from '@/server/checkout-view.ts';
import { CheckoutClient } from '@/components/checkout/CheckoutClient.tsx';
import { ErrorNotice } from '@/components/ui.tsx';
import type { CheckoutState } from '@/shared/types.ts';

type Props = { params: Promise<{ ref: string }> };

export const metadata = { title: copy.checkout.title };

/** The contact fields the page starts with: what the buyer gave this checkout, then their saved details. */
function contactValues(state: CheckoutState, user: { name: string; email: string } | null) {
  const contact = state.order.buyer_contact ?? state.session.buyer_contact ?? null;
  const prefill = state.session.customer_prefill ?? null;
  // A signed-in buyer whose order is bound to a customer checks out with the account email.
  const locked = Boolean(user && state.order.customer_id);
  const email = locked ? user!.email : (contact?.email ?? (contact?.is_email_cleared ? '' : (prefill?.email ?? '')));
  const name = state.contact_name ?? state.delivery_selection?.recipient?.name ?? prefill?.shipping_recipient_name ?? (locked ? user!.name : '');
  return { contact: { name, email, phone: contact?.phone ?? '' }, emailLocked: locked };
}

export default async function CheckoutPage({ params }: Props) {
  const { ref } = await params;
  const { rt, session, user } = await pageVisitor(`/checkout/${encodeURIComponent(ref)}`);
  try {
    rt.checkouts.owned(ref, session, user);
  } catch {
    notFound();
  }
  let state: CheckoutState;
  try {
    state = (await projectState(rt, ref, user)).state;
  } catch (error) {
    const mapped = appError(error);
    if (mapped.kind === 'bug' || mapped.kind === 'unavailable' || mapped.kind === 'unknown_outcome') console.error(error);
    return (
      <section className="state-panel" data-testid="sf-checkout" data-state="error">
        <h1>{copy.errors.serverTitle}</h1>
        <ErrorNotice error={mapped} params={{ store: rt.config.storeName }} />
        <div className="actions"><a className="button" href="/cart">{copy.errors.cartLink}</a></div>
      </section>
    );
  }
  if (['paid', 'partially_paid'].includes(state.session.status ?? '')) redirect(`/checkout/${encodeURIComponent(ref)}/complete`);
  const signedIn = user ? { name: user.name, email: user.email } : null;
  const { contact, emailLocked } = contactValues(state, signedIn);
  return (
    <CheckoutClient
      initial={state}
      csrf={session.csrf_token}
      storeName={rt.config.storeName}
      contact={contact}
      emailLocked={emailLocked}
      signedInEmail={signedIn?.email ?? null}
      giftChallenge={{ origin: rt.config.giftChallengeOrigin, slow_after_ms: 60000, max_mounts: 3 }}
    />
  );
}
