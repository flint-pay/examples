import { copy } from '@/shared/copy.ts';
import { viewPath } from '@/server/flint/view-data.ts';
import { pageVisitor } from '@/server/session.ts';
import { noticesFrom } from '@/server/page-notices.ts';
import { Notices } from '@/components/ui.tsx';
import { SignInForm } from '@/components/IdentityForms.tsx';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
export const metadata = { title: copy.identity.signInTitle };

export default async function SignInPage({ searchParams }: Props) {
  const params = await searchParams;
  await pageVisitor('/sign-in');
  const next = viewPath(params.next);
  return (
    <section className="auth-card" aria-labelledby="sign-in-title" data-testid="sf-sign-in">
      <h1 id="sign-in-title">{copy.identity.signInTitle}</h1>
      <p className="muted">{copy.identity.signInLead}</p>
      <Notices keys={noticesFrom(params, ['signed_out'])} />
      <SignInForm next={next === '/' && !params.next ? '' : next} />
    </section>
  );
}
