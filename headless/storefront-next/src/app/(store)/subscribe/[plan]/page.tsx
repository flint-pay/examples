import Link from 'next/link';
import { copy, fill } from '@/shared/copy.ts';
import { planBilling, plain } from '@/shared/catalog.ts';
import type { PlanItem } from '@/shared/types.ts';
import { LocalError } from '@/server/flint/errors.ts';
import { pageVisitor } from '@/server/session.ts';
import { SubscribeForm } from '@/components/SubscribeForm.tsx';
import { CheckIcon } from '@/components/icons.tsx';

type Props = { params: Promise<{ plan: string }> };

export const metadata = { title: copy.subscribe.title };

export default async function SubscribePage({ params }: Props) {
  const { plan: slug } = await params;
  const { rt } = await pageVisitor(`/subscribe/${encodeURIComponent(slug)}`);
  let item: PlanItem | null = null;
  let failed = false;
  try {
    item = plain<PlanItem>(await rt.catalog.plan(slug));
  } catch (error) {
    if (!(error instanceof LocalError && error.code === 'NOT_FOUND')) { console.error(error); failed = true; }
  }
  if (failed) {
    return (
      <section className="state-panel" data-testid="sf-subscribe" data-state="error">
        <h1>{copy.subscribe.errorBody}</h1>
        <Link className="button" href={`/subscribe/${encodeURIComponent(slug)}`}>{copy.home.tryAgain}</Link>
      </section>
    );
  }
  if (!item) {
    return (
      <section className="state-panel" data-testid="sf-subscribe" data-state="not_found">
        <h1>{copy.subscribe.notFoundTitle}</h1>
        <p>{copy.subscribe.notFoundBody}</p>
        <Link className="button" href="/#coffee-club">{copy.subscribe.backToClub}</Link>
      </section>
    );
  }
  const { plan } = item;
  return (
    <div data-testid="sf-subscribe" data-state="loaded" className="auth-card" style={{ maxWidth: 560 }}>
      <p className="eyebrow">{copy.home.clubEyebrow}</p>
      <h1 id="subscribe-title">{copy.subscribe.title}</h1>
      <p className="lead">{copy.subscribe.confirmLead}</p>
      <dl className="facts">
        <div><dt>{copy.subscribe.plan}</dt><dd data-testid="sf-subscribe-plan">{plan.name}</dd></div>
        <div><dt>{copy.subscribe.billing}</dt><dd data-testid="sf-subscribe-billing">{planBilling(plan)}</dd></div>
        {plan.trial_period_days ? <div><dt>{copy.subscribe.trial}</dt><dd>{fill(copy.home.trialNote, { days: plan.trial_period_days })}</dd></div> : null}
      </dl>
      <ul className="perks">
        <li><CheckIcon />{copy.subscribe.cancelNote}</li>
        {plan.trial_period_days ? <li><CheckIcon />{copy.subscribe.trialNoCharge}</li> : null}
      </ul>
      <SubscribeForm slug={item.slug} storeName={rt.config.storeName} />
    </div>
  );
}
