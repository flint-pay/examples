// The rendering boundary. The backend builds a RenderContext and calls renderPage.
//
//   import { renderPage } from './views/index.ts';
//   return c.html(renderPage('ac-orders', context));
//
// renderPage is synchronous and returns a complete HTML document as a string. Every interpolated
// value is escaped by hono/html. Nothing in this folder calls Flint.

import { addressFormPage, addressesPage } from './pages/addresses.ts';
import { giftCardAddPage, giftCardPage, giftCardsPage } from './pages/gift-cards.ts';
import { homePage } from './pages/home.ts';
import { errorPage, notFound, signIn, signUp, verifyEmail } from './pages/identity.ts';
import { invoicePage, invoicesPage } from './pages/invoices.ts';
import { orderPage, orderReceiptPage, ordersPage, returnStartPage } from './pages/orders.ts';
import { invoicePayPage, returnPayPage } from './pages/payment.ts';
import { paymentMethodNewPage, paymentMethodReturnPage, paymentMethodsPage } from './pages/payment-methods.ts';
import { emailPreferencesPage, linkPurchasesPage, privacyPage } from './pages/preferences.ts';
import { profileEmailPage, profilePage, profilePasswordPage } from './pages/profile.ts';
import { returnPage, returnsPage } from './pages/returns.ts';
import { subscriptionPage, subscriptionsPage } from './pages/subscriptions.ts';
import { PAGE_IDS, type PageDataMap, type PageId, type RenderContext } from './types.ts';
import type { Html } from './components.ts';

type Renderers = { [K in PageId]: (context: RenderContext<PageDataMap[K]>) => Html };

const renderers: Renderers = {
  'sign-in': signIn,
  'sign-up': signUp,
  'verify-email': verifyEmail,
  'not-found': notFound,
  error: errorPage,
  'ac-home': homePage,
  'ac-orders': ordersPage,
  'ac-order': orderPage,
  'ac-order-receipt': orderReceiptPage,
  'ac-return-start': returnStartPage,
  'ac-returns': returnsPage,
  'ac-return': returnPage,
  'ac-return-pay': returnPayPage,
  'ac-invoices': invoicesPage,
  'ac-invoice': invoicePage,
  'ac-invoice-pay': invoicePayPage,
  'ac-subscriptions': subscriptionsPage,
  'ac-subscription': subscriptionPage,
  'ac-payment-methods': paymentMethodsPage,
  'ac-payment-method-new': paymentMethodNewPage,
  'ac-payment-method-return': paymentMethodReturnPage,
  'ac-profile': profilePage,
  'ac-profile-email': profileEmailPage,
  'ac-profile-password': profilePasswordPage,
  'ac-addresses': addressesPage,
  'ac-address-form': addressFormPage,
  'ac-gift-cards': giftCardsPage,
  'ac-gift-card-add': giftCardAddPage,
  'ac-gift-card': giftCardPage,
  'ac-email-preferences': emailPreferencesPage,
  'ac-privacy': privacyPage,
  'ac-link-purchases': linkPurchasesPage,
};

export function isPageId(value: string): value is PageId {
  return (PAGE_IDS as readonly string[]).includes(value);
}

export function renderPage<K extends PageId>(pageId: K, context: RenderContext<PageDataMap[K]>): string {
  const render = renderers[pageId] as ((context: RenderContext<PageDataMap[K]>) => Html) | undefined;
  if (!render) throw new Error(`Unknown page id: ${String(pageId)}`);
  if (context === undefined || context === null || typeof context !== 'object') {
    throw new Error(`renderPage(${pageId}) needs a context object`);
  }
  if (context.data === undefined || context.data === null) {
    throw new Error(`renderPage(${pageId}) needs context.data`);
  }
  const output = render(context);
  if (output instanceof Promise) throw new Error(`Page ${pageId} rendered asynchronously, which views must not do`);
  return String(output);
}

export * from './types.ts';
