import { html, raw } from 'hono/html';
import { common, errorPages, nav, noticeText, testModeBanner, fill } from '../copy.ts';
import { attrs, cls, csrfInput, supportContact, type Html } from './components.ts';
import type { RenderContext } from './types.ts';

export type NavKey =
  | 'overview'
  | 'orders'
  | 'subscriptions'
  | 'invoices'
  | 'returns'
  | 'payment-methods'
  | 'addresses'
  | 'gift-cards'
  | 'profile'
  | 'email-preferences'
  | 'privacy';

const NAV_ITEMS: Array<{ key: NavKey; href: string; label: string }> = [
  { key: 'overview', href: '/', label: nav.overview },
  { key: 'orders', href: '/orders', label: nav.orders },
  { key: 'subscriptions', href: '/subscriptions', label: nav.subscriptions },
  { key: 'invoices', href: '/invoices', label: nav.invoices },
  { key: 'returns', href: '/returns', label: nav.returns },
  { key: 'payment-methods', href: '/payment-methods', label: nav.paymentMethods },
  { key: 'addresses', href: '/addresses', label: nav.addresses },
  { key: 'gift-cards', href: '/gift-cards', label: nav.giftCards },
  { key: 'profile', href: '/profile', label: nav.profile },
  { key: 'email-preferences', href: '/email-preferences', label: nav.emailPreferences },
  { key: 'privacy', href: '/privacy', label: nav.privacy },
];

/** account: header, navigation, footer. auth: header and footer only. bare: no chrome (receipts). */
export type Shell = 'account' | 'auth' | 'bare';

export interface DocumentOptions {
  pageId: string;
  title: string;
  testid: string;
  main: Html;
  nav?: NavKey;
  shell?: Shell;
  /** Browser modules to load after app.js, as paths under /js/. */
  scripts?: string[];
  /** Loads Stripe.js from the provider. Only payment and card pages set this. */
  stripe?: boolean;
  /** Extra class on <main>. */
  mainClass?: string;
  /** Hides the page notices (the page prints them itself). */
  hideNotices?: boolean;
}

const WARNING_NOTICES = new Set(['wrong_environment', 'not_in_account', 'session_ended']);

export function renderNotices(ctx: RenderContext): Html {
  const items = ctx.notices
    .map((notice) => {
      const key = typeof notice === 'string' ? notice : notice.key;
      const text = noticeText(notice);
      return text ? { key, text } : null;
    })
    .filter((item): item is { key: string; text: string } => item !== null);
  if (!items.length) return html``;
  return html`<div class="notices" data-testid="ac-notice-region">${items.map(
    (item) => html`<div class="${cls('notice', WARNING_NOTICES.has(item.key) ? 'notice-warn' : 'notice-info')}" role="status" data-testid="ac-notice" data-notice="${item.key}"><p>${item.text}</p></div>`,
  )}</div>`;
}

function navList(active: NavKey | undefined, suffix: string): Html {
  return html`<ul class="nav-list">${NAV_ITEMS.map(
    (item) => html`<li><a href="${item.href}"${attrs({
      'aria-current': item.key === active ? 'page' : undefined,
      'data-testid': `ac-nav-${item.key}${suffix}`,
    })}>${item.label}</a></li>`,
  )}</ul>`;
}

function header(ctx: RenderContext, shell: Shell): Html {
  return html`<header class="site-header">
    <div class="site-header-inner">
      <a class="brand" href="/" data-testid="ac-brand">${ctx.storeName}</a>
      <div class="header-links">
        ${ctx.storefrontOrigin ? html`<a class="header-link" href="${ctx.storefrontOrigin}" data-testid="ac-shop-link">${common.shop}</a>` : ''}
        ${
          ctx.user && shell === 'account'
            ? html`<span class="header-email" data-testid="ac-user-email">${ctx.user.email}</span>
              <form method="post" action="/sign-out" class="inline-form">${csrfInput(ctx.csrf)}<button type="submit" class="btn btn-secondary btn-small" data-testid="ac-sign-out">${common.signOut}</button></form>`
            : ''
        }
      </div>
    </div>
  </header>`;
}

function footer(ctx: RenderContext): Html {
  const hasSupport = Boolean(ctx.support && (ctx.support.email || ctx.support.phone || ctx.support.url));
  return html`<footer class="site-footer">
    <div class="site-footer-inner">
      <p>${hasSupport ? fill(common.footerSupport, { store: ctx.storeName }) : common.footerNoContact}</p>
      ${supportContact(ctx.support, 'ac-support')}
    </div>
  </footer>`;
}

export function renderDocument(ctx: RenderContext, options: DocumentOptions): Html {
  const shell = options.shell ?? 'account';
  const withNav = shell === 'account' && Boolean(ctx.user);
  const scripts = options.scripts ?? [];
  const body = shell === 'bare'
    ? html`<main id="main" class="${cls('main', 'main-bare', options.mainClass)}" tabindex="-1" data-testid="${options.testid}" data-page="${options.pageId}">${options.main}</main>`
    : html`<a class="skip-link" href="#main">${common.skipToContent}</a>
      <div class="test-banner" data-testid="ac-test-banner"><p>${testModeBanner}</p></div>
      ${header(ctx, shell)}
      <div class="${cls('shell', withNav && 'shell-with-nav')}">
        ${
          withNav
            ? html`<nav class="sidebar" aria-label="${common.accountNavigation}" data-testid="ac-sidebar">${navList(options.nav, '')}</nav>
              <details class="account-menu" data-testid="ac-account-menu">
                <summary>${common.accountMenu}</summary>
                <nav aria-label="${common.accountMenu}">${navList(options.nav, '-menu')}</nav>
              </details>`
            : ''
        }
        <main id="main" class="${cls('main', options.mainClass)}" tabindex="-1" data-testid="${options.testid}" data-page="${options.pageId}">
          ${options.hideNotices ? '' : renderNotices(ctx)}
          ${options.main}
        </main>
      </div>
      ${footer(ctx)}`;
  return html`<!doctype html>
<html lang="en" class="no-js">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="robots" content="noindex">
  <meta name="csrf-token" content="${ctx.csrf}">
  <title>${options.title} | ${ctx.storeName}</title>
  <link rel="icon" href="/assets/images/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/assets/styles.css">
  <script src="/js/js-flag.js"></script>
  ${options.stripe ? html`<script src="https://js.stripe.com/v3/" async data-stripe-script></script>` : ''}
</head>
<body data-page="${options.pageId}">
  ${body}
  <div class="live-region sr-only" role="status" aria-live="polite" aria-atomic="true" id="live-region" data-testid="ac-live-region"></div>
  <script type="module" src="/js/app.js"></script>
  ${scripts.map((src) => html`<script type="module" src="${src}"></script>`)}
</body>
</html>`;
}

/** Wraps a document string so callers get a plain string. */
export function toHtmlString(value: Html | string): string {
  return typeof value === 'string' ? value : String(value);
}

export { errorPages, raw };
