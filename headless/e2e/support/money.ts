import { invariant } from './safe.ts';

export type Money = { amount: string; currency: string };
export function money(value: unknown): Money {
  const m = value as Money;
  invariant(typeof m?.amount === 'string' && /^(0|[1-9]\d*)$/.test(m.amount) && typeof m.currency === 'string' && /^[A-Z]{3}$/.test(m.currency), 'EXACT_MONEY_REQUIRED');
  return { amount: m.amount, currency: m.currency };
}
export function equalMoney(actual: unknown, expected: unknown): void {
  const a = money(actual), b = money(expected);
  invariant(a.amount === b.amount && a.currency === b.currency, 'MONEY_MISMATCH');
}
export function giftAllocation(order: Record<string, any>): Record<string, unknown> {
  invariant(typeof order.order_revision === 'string' && /^[1-9]\d*$/.test(order.order_revision), 'EXPECTED_REVISION_REQUIRED');
  const e = order.gift_card_estimate;
  invariant(e && Array.isArray(e.gift_cards) && e.gift_cards.length > 0, 'GIFT_ESTIMATE_REQUIRED');
  const cards = e.gift_cards.map((c: any) => ({ gift_card_id: c.gift_card_id, amount_money: money(c.amount_money) }));
  const total = money(e.gift_card_money), processor = money(e.processor_money);
  invariant(cards.every((c: any) => typeof c.gift_card_id === 'string' && c.amount_money.currency === total.currency), 'GIFT_ALLOCATION_INVALID');
  invariant(cards.reduce((sum: bigint, c: any) => sum + BigInt(c.amount_money.amount), 0n).toString() === total.amount, 'GIFT_ALLOCATION_SUM');
  invariant(processor.currency === total.currency && total.currency === money(order.settlement_amounts.outstanding_money).currency && BigInt(total.amount) + BigInt(processor.amount) === BigInt(money(order.settlement_amounts.outstanding_money).amount), 'GIFT_ALLOCATION_TOTAL');
  invariant(e.order_revision === order.order_revision, 'GIFT_ESTIMATE_REVISION_MISMATCH');
  return { order_revision: order.order_revision, gift_cards: cards, gift_card_money: total, processor_money: processor };
}
export function settlementRequest(order: Record<string, any>, source?: Record<string, unknown>): Record<string, unknown> {
  const expected = money(order.settlement_amounts.outstanding_money);
  const allocation = order.gift_cards?.length ? giftAllocation(order) : undefined;
  const processor = allocation ? money(allocation.processor_money) : expected;
  invariant(processor.amount === '0' ? !source : !!source, 'PROCESSOR_SOURCE_REQUIREMENT');
  return { action: 'pay', expected_outstanding_money: expected, ...(allocation ? { accepted_gift_card_allocation: allocation } : {}), ...(source ? { payment_source: source } : {}) };
}
export function assertOneCharge(order: Record<string, any>, attempts: Record<string, any>[], count = 1): void {
  invariant(attempts.filter(a => a.status === 'succeeded').length === 1, 'SUCCEEDED_ATTEMPT_COUNT');
  const payments = attempts.flatMap(a => a.payment_intents ?? []).filter(p => p.status === 'succeeded');
  const ids = payments.map(p => p.payment_intent_id);
  invariant(ids.every(id => typeof id === 'string') && new Set(ids).size === count, 'SETTLED_PAYMENT_COUNT');
  invariant(order.payment_status === 'paid' && money(order.settlement_amounts.outstanding_money).amount === '0', 'ORDER_NOT_SETTLED');
}
