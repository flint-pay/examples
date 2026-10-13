import Link from 'next/link';
import { copy, fill } from '@/shared/copy.ts';
import { signOut } from '@/server/actions.ts';
import { BagIcon, BrandMark, LockIcon } from './icons.tsx';
import { CartBadge } from './CartBadge.tsx';

export function cartName(count: number): string {
  return count === 1 ? copy.nav.cartNameOne : fill(copy.nav.cartName, { count });
}

type HeaderProps = { storeName: string; user: { name: string; email: string } | null; cartCount: number; accountOrigin: string | null };

export function SiteHeader({ storeName, user, cartCount, accountOrigin }: HeaderProps) {
  return (
    <header className="site-header">
      <div className="wrap header-row">
        <Link className="brand" href="/" data-testid="sf-brand">
          <BrandMark className="brand-mark" />
          {storeName}
        </Link>
        <nav aria-label={copy.nav.label}>
          <ul className="nav-list">
            <li className="nav-secondary"><Link className="nav-link" href="/#shop">{copy.nav.shop}</Link></li>
            <li className="nav-secondary"><Link className="nav-link" href="/#coffee-club">{copy.nav.club}</Link></li>
            {accountOrigin ? <li><a className="nav-link" href={accountOrigin} data-testid="sf-nav-account">{copy.nav.account}</a></li> : null}
            {user ? (
              <li>
                <form action={signOut}>
                  <button className="nav-link" type="submit" data-testid="sf-nav-sign-out">{copy.nav.signOut}</button>
                </form>
              </li>
            ) : accountOrigin ? null : (
              <li><Link className="nav-link" href="/sign-in" data-testid="sf-nav-sign-in">{copy.nav.signIn}</Link></li>
            )}
            <li>
              <Link className="nav-link nav-cart" href="/cart" aria-label={cartName(cartCount)} data-testid="sf-nav-cart">
                <BagIcon />
                <span aria-hidden="true">{copy.nav.cart}</span>
                <CartBadge count={cartCount} />
              </Link>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}

export function CheckoutHeader({ storeName, backHref }: { storeName: string; backHref: string }) {
  return (
    <header className="site-header checkout-header">
      <div className="wrap header-row">
        <Link className="brand" href="/" data-testid="sf-brand">
          <BrandMark className="brand-mark" />
          {storeName}
        </Link>
        <div className="row">
          <span className="secure-note"><LockIcon /><span className="secure-note-text">{copy.checkout.secureCheckout}</span></span>
          <Link className="nav-link" href={backHref}>{copy.checkout.backToCart}</Link>
        </div>
      </div>
    </header>
  );
}
