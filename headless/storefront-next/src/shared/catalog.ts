import { copy, fill, intervalUnit } from './copy.ts';
import { formatMoney, multiplyMoney, sumMoney, type Money } from './money.ts';
import type { CatalogItem, ProductVariant, SubscriptionPlan } from './types.ts';

export function priceLabel(item: CatalogItem): string {
  const range = item.product.price_range;
  const min = range?.min_unit_price_money ?? item.variants[0]?.unit_price_money ?? null;
  const max = range?.max_unit_price_money ?? min;
  if (!min) return '';
  if (max && max.amount !== min.amount) return fill(copy.home.from, { price: formatMoney(min) });
  return formatMoney(min);
}

export function variantLabel(variant: ProductVariant): string {
  return variant.name ?? variant.selected_options?.map((option) => option.value).join(', ') ?? '';
}

/** Recurring price of a plan: the sum of its line items. Display only; Flint prices the order. */
export function planRecurring(plan: SubscriptionPlan): Money | null {
  const lines = plan.line_items ?? [];
  if (!lines.length) return null;
  return sumMoney(lines.map((line) => (line.unit_price_money ? multiplyMoney(line.unit_price_money, Number(line.quantity)) : null)));
}

export function planBilling(plan: SubscriptionPlan): string {
  const price = formatMoney(planRecurring(plan));
  const count = Number(plan.billing_interval_count);
  const unit = intervalUnit(plan.billing_interval, count);
  if (!price) return '';
  const every = count === 1 ? { price, unit } : { price, unit, count };
  if (plan.trial_period_days) return fill(count === 1 ? copy.home.afterTrial : copy.home.afterTrialMany, { ...every, days: plan.trial_period_days });
  return fill(count === 1 ? copy.home.perIntervalOne : copy.home.perInterval, every);
}

/** A short line under each product name. The sample catalog has no categories, so it is inferred from the slug. */
export function productKicker(item: CatalogItem): string {
  if (item.product.product_type === 'service') return copy.home.kickerClass;
  return /blend|bean|coffee/.test(item.slug) ? copy.home.kickerCoffee : copy.home.kickerGear;
}

/** SDK models are class instances. Pages hand only plain JSON to client components. */
export function plain<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
