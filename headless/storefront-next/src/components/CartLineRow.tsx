'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import { updateCartLine, type FormState } from '@/server/actions.ts';
import { copy, fill } from '@/shared/copy.ts';
import { formatMoney, type Money } from '@/shared/money.ts';
import { ErrorNotice } from './ui.tsx';
import { QuantityStepper } from './QuantityStepper.tsx';

type Props = { lineId: string; slug: string; image: string; name: string; variantName: string; unit: Money | null; quantity: number; total: Money | null; locked: boolean; storeName: string };

/** One cart line. Quantity changes save on their own after a short pause; the server re-renders the totals. */
export function CartLineRow({ lineId, slug, image, name, variantName, unit, quantity, total, locked, storeName }: Props) {
  const [state, action] = useActionState<FormState, FormData>(updateCartLine, {});
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState(quantity);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => setDraft(quantity), [quantity, state.at]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function send(intent: 'update' | 'remove', value = draft) {
    const form = new FormData();
    form.set('line_id', lineId);
    form.set('intent', intent);
    form.set('quantity', String(value));
    startTransition(() => action(form));
  }

  // A step saves after a short pause, so several taps send one request. Typed quantities wait for Update or Enter.
  function step(value: number) {
    setDraft(value);
    window.clearTimeout(timer.current);
    if (value >= 1 && value !== quantity) timer.current = window.setTimeout(() => send('update', value), 450);
  }
  const dirty = draft !== quantity;

  return (
    <li className="cart-line" data-testid={`sf-cart-line-${lineId}`} data-pending={pending}>
      <Link className="cart-thumb" href={`/products/${slug}`} tabIndex={-1} aria-hidden="true"><img src={image} alt="" width={96} height={72} loading="lazy" /></Link>
      <div className="cart-name">
        <Link className="cart-title" href={`/products/${slug}`}>{name}</Link>
        {variantName ? <span className="cart-variant">{variantName}</span> : null}
        <span className="cart-unit"><span className="money" data-amount-minor={unit?.amount} data-currency={unit?.currency}>{formatMoney(unit)}</span> {copy.cart.eachSuffix}</span>
        {locked ? (
          <p className="cart-unit flush">{copy.cart.quantity} <strong data-testid={`sf-cart-quantity-${lineId}`}>{quantity}</strong></p>
        ) : (
          <div className="cart-controls">
            <form className="row" onSubmit={(event) => { event.preventDefault(); window.clearTimeout(timer.current); if (draft >= 1) send('update'); }}>
              <QuantityStepper id={`qty-${lineId}`} name="quantity" value={draft} onChange={step} onType={(value) => { window.clearTimeout(timer.current); setDraft(value); }} itemName={name} testid={`sf-cart-quantity-${lineId}`} small />
              {dirty ? <button className="button button-small" type="submit" disabled={pending || draft < 1} aria-label={fill(copy.cart.updateLabel, { name })}>{copy.cart.update}</button> : null}
            </form>
            <button className="button button-quiet button-small" type="button" onClick={() => send('remove')} disabled={pending} aria-label={fill(copy.cart.removeLabel, { name })} data-testid={`sf-cart-remove-${lineId}`}>{copy.cart.remove}</button>
          </div>
        )}
        {state.error ? <ErrorNotice error={state.error} params={{ store: storeName }} /> : null}
      </div>
      <p className="cart-total flush"><span className="money" data-amount-minor={total?.amount}>{formatMoney(total)}</span></p>
    </li>
  );
}
