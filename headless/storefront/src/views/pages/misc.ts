import { html } from 'hono/html';
import { copy, errorKey, fill, message } from '../../copy.ts';
import { noticeList, type Html } from '../components.ts';
import { shell } from '../layout.ts';
import type { PageContext } from '../types.ts';

export function notFoundPage(ctx: PageContext): Html {
  const main = html`${noticeList(ctx)}<section class="state-panel" aria-labelledby="nf-title"><h1 id="nf-title">${copy.errors.notFoundTitle}</h1><p>${copy.errors.notFound}</p><a class="button" href="/">${copy.errors.notFoundLink}</a></section>`;
  return shell(ctx, { pageId: 'not-found', title: copy.errors.notFoundTitle, main, testid: 'sf-not-found' });
}

export function errorPage(ctx: PageContext): Html {
  const key = ctx.error ? errorKey(ctx.error) : 'generic_error';
  const text = key === 'generic_error' ? copy.errors.server : message(key, { store: ctx.storeName });
  const main = html`${noticeList(ctx)}<section class="state-panel" aria-labelledby="err-title"><h1 id="err-title">${copy.errors.serverTitle}</h1><p role="alert" data-testid="sf-error-message">${text}</p>${ctx.error?.request_id ? html`<p class="reference" data-testid="sf-error-reference">${fill(message('reference_id'), { id: ctx.error.request_id })}</p>` : ''}<div class="actions"><a class="button" href="/">${copy.errors.serverLink}</a><a class="button-link" href="/cart">${copy.errors.cartLink}</a></div></section>`;
  return shell(ctx, { pageId: 'error', title: copy.errors.serverTitle, main, testid: 'sf-error' });
}

export function returnElsewherePage(ctx: PageContext): Html {
  const main = html`<section class="state-panel narrow" aria-labelledby="re-title"><h1 id="re-title">${copy.returnElsewhere.title}</h1><p data-testid="sf-return-elsewhere">${copy.returnElsewhere.body}</p><a class="button" href="/">${copy.returnElsewhere.home}</a></section>`;
  return shell(ctx, { pageId: 'return-elsewhere', title: copy.returnElsewhere.title, main, testid: 'sf-return' });
}
