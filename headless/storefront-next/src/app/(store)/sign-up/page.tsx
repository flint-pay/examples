import { copy } from '@/shared/copy.ts';
import { viewPath } from '@/server/flint/view-data.ts';
import { pageVisitor } from '@/server/session.ts';
import { SignUpForm } from '@/components/IdentityForms.tsx';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
export const metadata = { title: copy.identity.signUpTitle };

export default async function SignUpPage({ searchParams }: Props) {
  const params = await searchParams;
  await pageVisitor('/sign-up');
  const next = viewPath(params.next);
  return (
    <section className="auth-card" aria-labelledby="sign-up-title" data-testid="sf-sign-up">
      <h1 id="sign-up-title">{copy.identity.signUpTitle}</h1>
      <p className="muted">{copy.identity.signUpLead}</p>
      <SignUpForm next={next === '/' && !params.next ? '' : next} />
    </section>
  );
}
