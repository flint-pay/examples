import Link from 'next/link';
import { copy } from '@/shared/copy.ts';

export const metadata = { title: copy.returnElsewhere.title };

export default function ReturnElsewherePage() {
  return (
    <section className="state-panel" aria-labelledby="re-title" data-testid="sf-return">
      <h1 id="re-title">{copy.returnElsewhere.title}</h1>
      <p data-testid="sf-return-elsewhere">{copy.returnElsewhere.body}</p>
      <Link className="button" href="/">{copy.returnElsewhere.home}</Link>
    </section>
  );
}
