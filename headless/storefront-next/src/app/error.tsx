'use client';

import Link from 'next/link';
import { copy } from '@/shared/copy.ts';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main" tabIndex={-1} className="wrap">
      <section className="state-panel" aria-labelledby="err-title" data-testid="sf-error">
        <h1 id="err-title">{copy.errors.serverTitle}</h1>
        <p role="alert" data-testid="sf-error-message">{copy.errors.server}</p>
        {error.digest ? <p className="reference" data-testid="sf-error-reference">{copy.errors.reference} {error.digest}</p> : null}
        <div className="actions">
          <button className="button button-primary" type="button" onClick={() => reset()}>{copy.errors.retry}</button>
          <Link className="button" href="/">{copy.errors.serverLink}</Link>
          <Link className="button-link" href="/cart">{copy.errors.cartLink}</Link>
        </div>
      </section>
    </main>
  );
}
