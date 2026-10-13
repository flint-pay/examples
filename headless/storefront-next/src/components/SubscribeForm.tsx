'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { startSubscription, type FormState } from '@/server/actions.ts';
import { copy } from '@/shared/copy.ts';
import { ErrorNotice } from './ui.tsx';

export function SubscribeForm({ slug, storeName }: { slug: string; storeName: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(startSubscription, {});
  return (
    <form action={action} className="stack">
      <input type="hidden" name="plan_slug" value={slug} />
      {state.error ? <ErrorNotice error={state.error} params={{ store: storeName }} /> : null}
      <div className="actions">
        <button className="button button-primary button-large" type="submit" aria-busy={pending} disabled={pending} data-testid="sf-subscribe-continue">{copy.subscribe.continue}</button>
        <Link className="button-link" href="/#coffee-club">{copy.subscribe.backToClub}</Link>
      </div>
    </form>
  );
}
