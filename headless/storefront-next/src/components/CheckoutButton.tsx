'use client';

import { useActionState } from 'react';
import { startCheckout, type FormState } from '@/server/actions.ts';
import { copy } from '@/shared/copy.ts';
import { ErrorNotice } from './ui.tsx';

/** Starts checkout for the current cart. A server action, so it also works as a plain form post. */
export function CheckoutButton({ storeName, className = 'button button-primary button-block button-large', label = copy.cart.checkOut, testid = 'sf-checkout-start' }: { storeName: string; className?: string; label?: string; testid?: string }) {
  const [state, action, pending] = useActionState<FormState>(startCheckout, {});
  return (
    <form action={action} className="stack">
      <button className={className} type="submit" aria-busy={pending} disabled={pending} data-testid={testid}>{label}</button>
      {state.error ? <ErrorNotice error={state.error} params={{ store: storeName }} /> : null}
    </form>
  );
}
