import Link from 'next/link';
import { copy, message } from '@/shared/copy.ts';
import { plain, variantLabel } from '@/shared/catalog.ts';
import { formatMoney, multiplyMoney } from '@/shared/money.ts';
import type { CartData } from '@/shared/types.ts';
import { pageVisitor } from '@/server/session.ts';
import { noticesFrom } from '@/server/page-notices.ts';
import { CartLineRow } from '@/components/CartLineRow.tsx';
import { CheckoutButton } from '@/components/CheckoutButton.tsx';
import { Notice, Notices, productImage } from '@/components/ui.tsx';
import { BagIcon, LockIcon, TruckIcon } from '@/components/icons.tsx';

export const metadata = { title: copy.cart.title };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function CartPage({ searchParams }: Props) {
  const { rt, session, user } = await pageVisitor('/cart');
  const notices = noticesFrom(await searchParams, ['email_confirmed', 'email_confirmed_linked']);
  const cart = rt.carts.current(session, user);
  let data: CartData | null = null;
  try {
    const locked = await rt.checkouts.cartLock(cart, session, user);
    data = { cart: plain(await rt.carts.view(cart)), locked: !!locked, checkoutRef: locked?.checkout_ref ?? null };
  } catch (error) {
    console.error(error);
  }
  if (!data) {
    return (
      <div data-testid="sf-cart" data-state="error">
        <h1>{copy.cart.title}</h1>
        <section className="state-panel">
          <p role="alert">{copy.cart.loadFailed}</p>
          <Link className="button button-primary" href="/cart">{copy.home.tryAgain}</Link>
        </section>
      </div>
    );
  }
  const { lines, subtotal_money } = data.cart;
  const empty = lines.length === 0;
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  return (
    <div data-testid="sf-cart" data-state={empty ? 'empty' : data.locked ? 'locked' : 'filled'}>
      <Notices keys={notices} />
      <div className="section-head">
        <h1>{copy.cart.title}</h1>
        {!empty ? <p className="muted">{count === 1 ? copy.cart.itemCountOne : copy.cart.itemCount.replace('{count}', String(count))}</p> : null}
      </div>
      {empty ? (
        <section className="state-panel" data-testid="sf-cart-empty">
          <div className="state-icon"><BagIcon /></div>
          <p>{copy.cart.emptyBody}</p>
          <Link className="button button-primary" href="/#shop">{copy.cart.shop}</Link>
        </section>
      ) : (
        <>
          {data.locked ? <Notice tone="warning" testid="sf-cart-locked"><p>{message('cart_locked_payment')}</p></Notice> : null}
          <div className="cart-layout">
            <ul className="cart-lines" role="list">
              {lines.map((line) => {
                const unit = line.variant.unit_price_money;
                return (
                  <CartLineRow
                    key={line.line_id}
                    lineId={line.line_id}
                    slug={line.item.slug}
                    image={productImage(line.item.slug)}
                    name={line.item.product.name}
                    variantName={line.item.variants.length > 1 ? variantLabel(line.variant) : ''}
                    unit={unit}
                    quantity={line.quantity}
                    total={unit ? multiplyMoney(unit, line.quantity) : null}
                    locked={data.locked === true}
                    storeName={rt.config.storeName}
                  />
                );
              })}
            </ul>
            <aside className="cart-summary panel-card" aria-labelledby="cart-summary-title">
              <h2 id="cart-summary-title">{copy.cart.summary}</h2>
              <dl className="summary-rows">
                <div className="summary-row summary-strong"><dt>{copy.cart.subtotalShort}</dt><dd><span className="money" data-testid="sf-cart-subtotal" data-amount-minor={subtotal_money?.amount}>{formatMoney(subtotal_money)}</span></dd></div>
              </dl>
              <p className="hint flush">{copy.cart.subtotalHint}</p>
              {data.locked && data.checkoutRef ? (
                <>
                  <Link className="button button-primary button-block button-large" href={`/checkout/${data.checkoutRef}`} data-testid="sf-checkout-start">{copy.cart.returnToPayment}</Link>
                  <p className="hint flush">{copy.cart.lockedBody}</p>
                </>
              ) : (
                <CheckoutButton storeName={rt.config.storeName} />
              )}
              <ul className="perks">
                <li><LockIcon />{copy.cart.perkSecure}</li>
                <li><TruckIcon />{copy.cart.perkDelivery}</li>
              </ul>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
