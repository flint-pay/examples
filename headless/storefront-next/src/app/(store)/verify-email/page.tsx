import { redirect } from 'next/navigation';
import { copy } from '@/shared/copy.ts';
import { returnPath } from '@/server/security/paths.ts';
import { pageVisitor } from '@/server/session.ts';
import { signOut } from '@/server/actions.ts';
import { VerifyEmailForms } from '@/components/IdentityForms.tsx';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
export const metadata = { title: copy.identity.verifyTitle };

export default async function VerifyEmailPage({ searchParams }: Props) {
  const params = await searchParams;
  const next = returnPath(typeof params.next === 'string' ? params.next : undefined);
  const { rt, session, user } = await pageVisitor(`/verify-email?next=${encodeURIComponent(next)}`);
  if (!user || user.status === 'closed') redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  const pending = rt.identity.pending(session);
  return (
    <section className="auth-card" aria-labelledby="verify-title" data-testid="sf-verify-email" data-state={pending ? 'code_sent' : 'idle'}>
      <h1 id="verify-title">{copy.identity.verifyTitle}</h1>
      <VerifyEmailForms next={next} email={user.email} sentAt={pending?.created_at ?? null} />
      <form action={signOut} className="auth-foot">
        <button className="link-button" type="submit" data-testid="sf-verify-different">{copy.identity.useDifferentAccount}</button>
      </form>
    </section>
  );
}
