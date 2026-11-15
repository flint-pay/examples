import { NextResponse } from 'next/server';
import { visitor } from '@/server/session.ts';
import { viewState } from '@/server/checkout-view.ts';
import { hasAffirmAction } from '@/shared/checkout-logic.ts';
import type { CheckoutState } from '@/shared/types.ts';

type Params = { params: Promise<{ ref: string }> };

// Flint sends the buyer back here after a payment step on a Flint-hosted page, such as Affirm. The browser that
// started the checkout continues it; any other browser is told where to go.
export async function GET(request: Request, { params }: Params) {
  const { ref } = await params;
  const found = await visitor({ mutating: false });
  const to = (path: string) => NextResponse.redirect(new URL(path, found?.rt.config.appOrigin ?? request.url), 303);
  if (!found) return to('/return-elsewhere');
  const { rt, session, user } = found;
  try {
    rt.checkouts.owned(ref, session, user);
  } catch {
    return to('/return-elsewhere');
  }
  const read = await rt.checkouts.readForReturn(ref);
  const current = { read, state: await viewState(rt, read) };
  const result = current.read.result;
  const next = rt.payments.next(result);
  const path = `/checkout/${encodeURIComponent(ref)}`;
  if (next === 'done') return to(`${path}/complete`);
  // The return route only reads the payment. An unfinished action is never opened here: the checkout page
  // shows it with Continue and Pay another way, worded for Affirm or for any other Flint-hosted step.
  if (next === 'authenticate') rt.checkouts.notice(current.read.record, hasAffirmAction(current.state as unknown as CheckoutState) ? 'affirm_incomplete' : 'payment_action_incomplete');
  return to(path);
}
