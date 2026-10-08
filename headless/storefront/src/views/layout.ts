import { html, raw } from 'hono/html';
import { copy, fill } from '../copy.ts';
import { csrfField, type Html } from './components.ts';
import type { PageContext, PageId } from './types.ts';

export type ShellOptions = {
  pageId: PageId;
  title: string;
  main: Html;
  /** data-testid for the main landmark. */
  testid: string;
  state?: string;
  /** Extra tags for the head, for example the Stripe.js script on checkout. */
  head?: Html;
  /** Extra module scripts, in addition to site.js. */
  scripts?: string[];
  wide?: boolean;
};

export function cartName(count: number): string {
  return count === 1 ? copy.nav.cartNameOne : fill(copy.nav.cartName, { count });
}

function accountNav(ctx: PageContext): Html {
  const next = encodeURIComponent(ctx.path && ctx.path.startsWith('/') ? ctx.path : '/');
  return html`${ctx.accountOrigin ? html`<li><a class="nav-link" href="${ctx.accountOrigin}" data-testid="sf-nav-account">${copy.nav.account}</a></li>` : ''}
    ${ctx.user
      ? html`<li><form method="post" action="/sign-out" class="inline-form">${csrfField(ctx)}<button class="nav-link nav-button" type="submit" data-testid="sf-nav-sign-out">${copy.nav.signOut}</button></form></li>`
      : ctx.accountOrigin
        ? ''
        : html`<li><a class="nav-link" href="/sign-in?next=${next}" data-testid="sf-nav-sign-in">${copy.nav.signIn}</a></li>`}`;
}

export function shell(ctx: PageContext, o: ShellOptions): Html {
  const current = (id: PageId) => (o.pageId === id ? raw('aria-current="page"') : raw(''));
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${o.title} | ${ctx.storeName}</title>
<meta name="csrf-token" content="${ctx.csrf}">
<meta name="color-scheme" content="light">
<link rel="icon" href="/images/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
${o.head ?? ''}
</head>
<body data-page="${o.pageId}">
<a class="skip-link" href="#main">${copy.skipLink}</a>
<div class="test-banner" data-testid="sf-test-banner">${copy.testBanner}</div>
<header class="site-header">
  <div class="wrap header-row">
    <a class="brand" href="/" data-testid="sf-brand">${ctx.storeName}</a>
    <nav aria-label="${copy.nav.label}">
      <ul class="nav-list">
        <li><a class="nav-link" href="/#shop" ${current('sf-home')}>${copy.nav.shop}</a></li>
        <li><a class="nav-link" href="/#coffee-club">${copy.nav.club}</a></li>
        <li><a class="nav-link nav-cart" href="/cart" aria-label="${cartName(ctx.cartCount)}" data-label-one="${copy.nav.cartNameOne}" data-label-many="${copy.nav.cartName}" ${current('sf-cart')} data-testid="sf-nav-cart"><span aria-hidden="true">Cart</span> <span class="cart-count" data-testid="sf-cart-count" data-count="${ctx.cartCount}" aria-hidden="true">${ctx.cartCount}</span></a></li>
        ${accountNav(ctx)}
      </ul>
    </nav>
  </div>
</header>
<div id="live-region" class="visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-testid="sf-live"></div>
<main id="main" tabindex="-1" class="${o.wide ? 'wrap wrap-wide' : 'wrap'}" data-testid="${o.testid}"${o.state ? html` data-state="${o.state}"` : ''}>
${o.main}
</main>
<footer class="site-footer">
  <div class="wrap">
    <p>${copy.footer.note}</p>
    <p>${copy.footer.emailNote}</p>
  </div>
</footer>
<script type="module" src="/js/site.js"></script>
${(o.scripts ?? []).map((src) => html`<script type="module" src="${src}"></script>`)}
</body>
</html>`;
}
