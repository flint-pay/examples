import { cartPage } from './pages/cart.ts';
import { homePage, productPage, subscribePage } from './pages/catalog.ts';
import { checkoutPage } from './pages/checkout.ts';
import { completePage } from './pages/complete.ts';
import { signInPage, signUpPage, verifyEmailPage } from './pages/identity.ts';
import { errorPage, notFoundPage, returnElsewherePage } from './pages/misc.ts';
import type {
  CartData,
  CheckoutData,
  CompleteData,
  HomeData,
  IdentityData,
  PageContext,
  PageId,
  ProductData,
  SubscribeData,
} from './types.ts';

export type { PageContext, PageId } from './types.ts';
export type * from './types.ts';
export { scrubForBrowser } from './scrub.ts';

/**
 * Renders one buyer-facing page to an HTML document string. All dynamic values
 * are escaped by hono/html. The app calls `c.html(await renderPage(id, ctx))`.
 */
export async function renderPage(pageId: PageId, context: PageContext<any>): Promise<string> {
  const rendered = (() => {
    switch (pageId) {
      case 'sf-home':
        return homePage(context as PageContext<HomeData>);
      case 'sf-product':
        return productPage(context as PageContext<ProductData>);
      case 'sf-cart':
        return cartPage(context as PageContext<CartData>);
      case 'sf-subscribe':
        return subscribePage(context as PageContext<SubscribeData>);
      case 'sf-checkout':
        return checkoutPage(context as PageContext<CheckoutData>);
      case 'sf-complete':
        return completePage(context as PageContext<CompleteData>);
      case 'sign-in':
        return signInPage(context as PageContext<IdentityData>);
      case 'sign-up':
        return signUpPage(context as PageContext<IdentityData>);
      case 'verify-email':
        return verifyEmailPage(context as PageContext<IdentityData>);
      case 'return-elsewhere':
        return returnElsewherePage(context);
      case 'not-found':
        return notFoundPage(context);
      case 'error':
        return errorPage(context);
      default: {
        const unknown: never = pageId;
        throw new Error(`Unknown page id: ${String(unknown)}`);
      }
    }
  })();
  return String(await rendered);
}
