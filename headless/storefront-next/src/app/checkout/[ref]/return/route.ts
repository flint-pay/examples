import { NextResponse } from 'next/server';
import { visitor } from '@/server/session.ts';
import { projectState } from '@/server/checkout-view.ts';

type Params = { params: Promise<{ ref: string }> };

// Stripe sends the buyer back here after a redirect payment method, such as Affirm. The browser that
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
  const current = await projectState(rt, ref, user);
  const attempt = current.read.result.attempt;
  const result = attempt?.status === 'requires_action' && attempt.is_resumable ? await rt.payments.resume(ref, true) : current.read.result;
  const next = rt.payments.next(result);
  const path = `/checkout/${encodeURIComponent(ref)}`;
  if (next === 'done') return to(`${path}/complete`);
  if (next === 'authenticate') rt.checkouts.notice(current.read.record, 'affirm_incomplete');
  return to(path);
}
