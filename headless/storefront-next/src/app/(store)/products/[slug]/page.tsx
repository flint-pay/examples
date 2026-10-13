import Link from 'next/link';
import type { Metadata } from 'next';
import { copy } from '@/shared/copy.ts';
import { plain, priceLabel, productKicker, variantLabel } from '@/shared/catalog.ts';
import type { CatalogItem } from '@/shared/types.ts';
import { LocalError } from '@/server/flint/errors.ts';
import { pageVisitor } from '@/server/session.ts';
import { runtime } from '@/server/runtime.ts';
import { AddToCart } from '@/components/AddToCart.tsx';
import { Notice, productImage } from '@/components/ui.tsx';
import { CheckIcon, LeafIcon, ReturnIcon, TruckIcon } from '@/components/icons.tsx';

type Props = { params: Promise<{ slug: string }> };

async function load(slug: string): Promise<{ item: CatalogItem | null; failed: boolean }> {
  try {
    return { item: plain<CatalogItem>(await (await runtime()).catalog.product(slug)), failed: false };
  } catch (error) {
    if (error instanceof LocalError && error.code === 'NOT_FOUND') return { item: null, failed: false };
    console.error(error);
    return { item: null, failed: true };
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { item } = await load((await params).slug);
  return { title: item?.product.name ?? copy.product.notFoundTitle };
}

export default async function ProductPage({ params }: Props) {
  const { slug } = await params;
  const { rt } = await pageVisitor(`/products/${encodeURIComponent(slug)}`);
  const { item, failed } = await load(slug);
  if (failed) {
    return (
      <section className="state-panel" data-testid="sf-product" data-state="error">
        <h1>{copy.product.errorBody}</h1>
        <Link className="button" href={`/products/${encodeURIComponent(slug)}`}>{copy.product.tryAgain}</Link>
      </section>
    );
  }
  if (!item) {
    return (
      <section className="state-panel" data-testid="sf-product" data-state="not_found">
        <h1>{copy.product.notFoundTitle}</h1>
        <p>{copy.product.notFoundBody}</p>
        <Link className="button" href="/#shop">{copy.product.backToShop}</Link>
      </section>
    );
  }
  const variants = item.variants.map((variant) => ({ variant_id: variant.variant_id, label: variantLabel(variant), available: variant.available_for_sale !== false, price: variant.unit_price_money }));
  const sellable = variants.some((variant) => variant.available);
  const physical = item.product.product_type !== 'service';
  return (
    <div data-testid="sf-product" data-state="loaded">
      <nav className="breadcrumb" aria-label="Breadcrumb"><Link href="/#shop">{copy.home.shopHeading}</Link> / <span aria-current="page">{item.product.name}</span></nav>
      <div className="product">
        <div className="product-image"><img src={productImage(item.slug)} alt={item.product.name} width={640} height={480} /></div>
        <div className="product-info">
          <p className="eyebrow">{productKicker(item)}</p>
          <h1>{item.product.name}</h1>
          <p className="product-price money" data-testid="sf-product-price">{priceLabel(item)}</p>
          {item.product.description ? <p className="product-description">{item.product.description}</p> : <p className="product-description">{physical ? copy.product.defaultDescription : copy.product.defaultClassDescription}</p>}
          {sellable ? (
            <AddToCart slug={item.slug} name={item.product.name} image={productImage(item.slug)} variants={variants} showVariants={item.variants.length > 1} storeName={rt.config.storeName} />
          ) : (
            <Notice tone="warning"><p>{copy.product.unavailable}</p></Notice>
          )}
          <ul className="perks">
            {physical ? <li><TruckIcon />{copy.product.perkShipping}</li> : <li><CheckIcon />{copy.product.perkClass}</li>}
            {physical ? <li><LeafIcon />{copy.product.perkPickup}</li> : null}
            <li><ReturnIcon />{copy.product.perkReturns}</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
