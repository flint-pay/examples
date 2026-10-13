import { postGiftCardRemove } from '@/server/checkout-routes.ts';

type Params = { params: Promise<{ ref: string; giftCardId: string }> };

export function POST(request: Request, context: Params) {
  return postGiftCardRemove(async () => (await context.params).giftCardId)(request, context);
}
