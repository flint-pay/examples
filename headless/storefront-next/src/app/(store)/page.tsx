import Link from 'next/link';
import { copy, fill } from '@/shared/copy.ts';
import { planBilling, plain, priceLabel, productKicker } from '@/shared/catalog.ts';
import type { CatalogItem, PlanItem } from '@/shared/types.ts';
import { pageVisitor } from '@/server/session.ts';
import { noticesFrom } from '@/server/page-notices.ts';
import { Notice, Notices, productImage } from '@/components/ui.tsx';
import { CheckIcon, ClockIcon, LeafIcon, TruckIcon } from '@/components/icons.tsx';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function HomePage({ searchParams }: Props) {
  const { rt } = await pageVisitor('/');
  const notices = noticesFrom(await searchParams, ['signed_out', 'email_confirmed', 'email_confirmed_linked']);
  let products: CatalogItem[] = [];
  let plans: PlanItem[] = [];
  let failed = false;
  try {
    const loaded = await rt.catalog.read();
    products = plain(loaded.products);
    plans = plain(loaded.plans);
  } catch (error) {
    console.error(error);
    failed = true;
  }
  const empty = !failed && products.length === 0 && plans.length === 0;
  const state = failed ? 'error' : empty ? 'empty_setup_needed' : 'loaded';
  const featured = products.find((item) => item.slug === 'house-blend') ?? products[0];
  return (
    <div data-testid="sf-home" data-state={state}>
      <Notices keys={notices} params={{ store: rt.config.storeName }} />
      {rt.preflight.cards !== 'ready' ? <Notice tone="warning" testid="sf-cards-not-ready"><p>{copy.home.cardsNotReady}</p></Notice> : null}
      <section className="hero" aria-labelledby="hero-title">
        <div>
          <p className="eyebrow">{copy.home.eyebrow}</p>
          <h1 id="hero-title">{copy.home.heroTitle}</h1>
          <p className="lead">{copy.home.heroBody}</p>
          <div className="actions">
            <Link className="button button-primary button-large" href="#shop">{copy.home.shopNow}</Link>
            {plans.length ? <Link className="button button-large" href="#coffee-club">{copy.home.joinClub}</Link> : null}
          </div>
          <ul className="hero-points">
            <li><LeafIcon />{copy.home.pointRoasted}</li>
            <li><TruckIcon />{copy.home.pointShipping}</li>
            <li><ClockIcon />{copy.home.pointPickup}</li>
          </ul>
        </div>
        <div className="hero-art"><img src={productImage(featured?.slug)} alt="" width={640} height={480} /></div>
      </section>

      {failed ? (
        <section className="state-panel" data-testid="sf-home-error" aria-labelledby="home-error-title">
          <h2 id="home-error-title">{copy.home.shopHeading}</h2>
          <p role="alert">{copy.home.errorBody}</p>
          <Link className="button" href="/">{copy.home.tryAgain}</Link>
        </section>
      ) : empty ? (
        <section className="state-panel" data-testid="sf-setup-needed" aria-labelledby="setup-title">
          <h2 id="setup-title">{copy.home.setupNeededTitle}</h2>
          <p>{copy.home.setupNeededBody}</p>
        </section>
      ) : (
        <>
          {products.length ? (
            <section id="shop" aria-labelledby="shop-title" className="section">
              <div className="section-head">
                <h2 id="shop-title">{copy.home.shopHeading}</h2>
                <p className="muted small">{fill(copy.home.productCount, { count: products.length })}</p>
              </div>
              <ul className="grid" role="list">
                {products.map((item) => (
                  <li className="card" key={item.slug} data-testid={`sf-product-card-${item.slug}`}>
                    <Link className="card-link" href={`/products/${item.slug}`} aria-label={fill(copy.home.viewProduct, { name: item.product.name })}>
                      <span className="card-image"><img src={productImage(item.slug)} alt="" width={640} height={480} loading="lazy" /></span>
                      <span className="card-body">
                        <span className="card-kicker">{productKicker(item)}</span>
                        <span className="card-title">{item.product.name}</span>
                        <span className="card-price money">{priceLabel(item)}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {plans.length ? (
            <section id="coffee-club" aria-labelledby="club-title" className="section">
              <div className="club">
                <div>
                  <p className="eyebrow">{copy.home.clubEyebrow}</p>
                  <h2 id="club-title">{copy.home.clubHeading}</h2>
                  <p>{copy.home.clubBody}</p>
                  <ul className="hero-points" style={{ color: '#d8e6dc' }}>
                    <li><CheckIcon />{copy.home.clubPointSkip}</li>
                    <li><CheckIcon />{copy.home.clubPointCancel}</li>
                  </ul>
                </div>
                <ul className="plans" role="list">
                  {plans.map(({ plan, slug }) => (
                    <li className="plan-card" key={slug} data-testid={`sf-plan-card-${slug}`}>
                      {plan.trial_period_days ? <span className="plan-badge">{fill(copy.home.trialNote, { days: plan.trial_period_days })}</span> : null}
                      <h3>{plan.name}</h3>
                      <p className="plan-price">{planBilling(plan)}</p>
                      <Link className="button button-primary" href={`/subscribe/${slug}`} aria-label={`${copy.home.subscribe}: ${plan.name}`}>{copy.home.subscribe}</Link>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
