import Link from 'next/link';
import { copy } from '@/shared/copy.ts';
import { SiteHeader } from '@/components/SiteHeader.tsx';

export default function NotFound() {
  return (
    <>
      <SiteHeader storeName={process.env.STORE_NAME || 'Cedar & Stone'} user={null} cartCount={0} accountOrigin={process.env.ACCOUNT_APP_ORIGIN || null} />
      <main id="main" tabIndex={-1} className="wrap">
        <section className="state-panel" aria-labelledby="nf-title" data-testid="sf-not-found">
          <h1 id="nf-title">{copy.errors.notFoundTitle}</h1>
          <p>{copy.errors.notFound}</p>
          <div className="actions"><Link className="button button-primary" href="/">{copy.errors.notFoundLink}</Link><Link className="button-link" href="/cart">{copy.errors.cartLink}</Link></div>
        </section>
      </main>
    </>
  );
}
