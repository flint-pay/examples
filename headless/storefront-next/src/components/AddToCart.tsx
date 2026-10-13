'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState } from 'react';
import { addToCart, type FormState } from '@/server/actions.ts';
import { copy, errorKey, fill, message } from '@/shared/copy.ts';
import { formatMoney, multiplyMoney, type Money } from '@/shared/money.ts';
import { slugify } from '@/shared/format.ts';
import { CheckIcon } from './icons.tsx';
import { ErrorNotice } from './ui.tsx';
import { QuantityStepper } from './QuantityStepper.tsx';
import { CheckoutButton } from './CheckoutButton.tsx';

export type VariantChoice = { variant_id: string; label: string; available: boolean; price: Money | null };

export function AddToCart({ slug, name, image, variants, showVariants, storeName }: { slug: string; name: string; image: string; variants: VariantChoice[]; showVariants: boolean; storeName: string }) {
  const firstAvailable = variants.find((variant) => variant.available) ?? variants[0];
  const [variantId, setVariantId] = useState(firstAvailable?.variant_id ?? '');
  const [quantity, setQuantity] = useState(1);
  const [state, action, pending] = useActionState<FormState, FormData>(addToCart, {});
  const added = useRef<HTMLDivElement>(null);
  const variant = variants.find((item) => item.variant_id === variantId);
  const lineTotal = variant?.price ? multiplyMoney(variant.price, quantity) : null;

  useEffect(() => {
    if (state.notice === 'added_to_cart') added.current?.focus();
  }, [state.at, state.notice]);

  return (
    <div className="stack">
      <form action={action} className="buy-box" data-testid="sf-add-form">
        <input type="hidden" name="product_slug" value={slug} />
        {showVariants ? (
          <fieldset>
            <legend className="choice-legend">{copy.product.variant}</legend>
            <div className="pills">
              {variants.map((item) => (
                <label className="pill" key={item.variant_id}>
                  <input type="radio" name="variant_id" value={item.variant_id} checked={variantId === item.variant_id} disabled={!item.available} onChange={() => setVariantId(item.variant_id)} data-testid={`sf-variant-${slugify(item.label)}`} />
                  <span>{item.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <input type="hidden" name="variant_id" value={variantId} />
        )}
        <div className="buy-row">
          <QuantityStepper id="quantity" name="quantity" value={quantity} onChange={setQuantity} itemName={name} testid="sf-quantity" />
          <button className="button button-primary button-large" type="submit" aria-busy={pending} disabled={pending} data-testid="sf-add-to-cart">
            {copy.product.addToCart}{lineTotal ? <span className="money"> · {formatMoney(lineTotal)}</span> : null}
          </button>
        </div>
        <p className="visually-hidden" role="status" data-testid="sf-add-status" data-state={state.notice === 'added_to_cart' ? 'added' : undefined}>
          {state.notice === 'added_to_cart' ? message('added_to_cart') : ''}
        </p>
      </form>
      {state.error ? <ErrorNotice error={state.error} params={{ store: storeName }} /> : null}
      {state.notice === 'added_to_cart' ? (
        <div className="added" ref={added} tabIndex={-1} key={state.at} aria-labelledby="added-title">
          <img src={image} alt="" width={64} height={48} />
          <div className="added-body">
            <p className="added-title" id="added-title"><CheckIcon className="inline-icon" /> {fill(copy.product.addedTitle, { name })}</p>
            <p className="small muted flush">{fill(state.cartCount === 1 ? copy.product.addedCountOne : copy.product.addedCount, { count: state.cartCount ?? 0 })}</p>
          </div>
          <div className="row">
            <Link className="button button-small" href="/cart">{copy.product.inCart}</Link>
            <CheckoutButton storeName={storeName} className="button button-small button-dark" testid="sf-added-checkout" />
          </div>
        </div>
      ) : null}
      {state.error && errorKey(state.error) === 'cart_locked_payment' ? <Link className="button-link" href="/cart">{copy.product.inCart}</Link> : null}
    </div>
  );
}
