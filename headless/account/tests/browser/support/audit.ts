import type { Page } from '@playwright/test';

export interface AuditOptions {
  /** The page has no site chrome (the printable receipt). */
  bare?: boolean;
}

/** Structural checks that apply to every page. Returns a list of problems, empty when clean. */
export async function auditPage(page: Page, options: AuditOptions = {}): Promise<string[]> {
  return page.evaluate((opts) => {
    const problems: string[] = [];
    const doc = document;
    if (doc.documentElement.lang !== 'en') problems.push('html lang is not en');
    if (!doc.title.trim()) problems.push('empty title');
    const h1s = doc.querySelectorAll('h1');
    if (h1s.length !== 1) problems.push(`expected one h1, found ${h1s.length}`);

    const main = doc.querySelectorAll('main');
    if (main.length !== 1) problems.push(`expected one main, found ${main.length}`);
    else if (!main[0]?.getAttribute('data-testid')) problems.push('main has no data-testid');
    if (!opts.bare) {
      if (!doc.querySelector('header')) problems.push('no header landmark');
      if (!doc.querySelector('footer')) problems.push('no footer landmark');
      const skip = doc.querySelector('a.skip-link');
      if (!skip || skip.getAttribute('href') !== '#main') problems.push('skip link missing');
      if (!doc.querySelector('[data-testid="ac-test-banner"]')) problems.push('test mode banner missing');
    }
    if (!doc.getElementById('live-region')) problems.push('live region missing');

    const ids = new Map<string, number>();
    for (const el of doc.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
    for (const [id, count] of ids) if (count > 1) problems.push(`duplicate id ${id}`);

    // A repeated data-testid is fine when each copy sits inside its own, different container id
    // (a row per card, per address, per request). Tests scope to that container.
    const byTestid = new Map<string, Element[]>();
    for (const el of doc.querySelectorAll('[data-testid]')) {
      const id = el.getAttribute('data-testid') ?? '';
      byTestid.set(id, [...(byTestid.get(id) ?? []), el]);
    }
    for (const [id, elements] of byTestid) {
      if (elements.length < 2) continue;
      const scopes = elements.map((el) => el.parentElement?.closest('[data-testid]')?.getAttribute('data-testid') ?? '');
      const scoped = scopes.every((scope) => scope !== '') && new Set(scopes).size === scopes.length;
      if (!scoped) problems.push(`duplicate data-testid ${id}`);
    }

    for (const el of doc.querySelectorAll('[aria-describedby],[aria-labelledby],[aria-controls]')) {
      for (const attr of ['aria-describedby', 'aria-labelledby', 'aria-controls']) {
        const value = el.getAttribute(attr);
        if (!value) continue;
        for (const ref of value.split(/\s+/)) if (!doc.getElementById(ref)) problems.push(`${attr} points at missing id ${ref}`);
      }
    }
    for (const label of doc.querySelectorAll('label[for]')) {
      if (!doc.getElementById(label.getAttribute('for') ?? '')) problems.push(`label for missing id ${label.getAttribute('for')}`);
    }

    for (const control of doc.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea')) {
      const id = control.id;
      const labelled =
        (id && doc.querySelector(`label[for="${CSS.escape(id)}"]`)) ||
        control.closest('label') ||
        control.getAttribute('aria-label') ||
        control.getAttribute('aria-labelledby');
      if (!labelled) problems.push(`unlabelled control ${control.tagName.toLowerCase()}#${id || control.getAttribute('name') || '?'}`);
    }
    for (const button of doc.querySelectorAll('button')) {
      if (!(button.textContent ?? '').trim() && !button.getAttribute('aria-label')) problems.push('button without a name');
    }
    for (const form of doc.querySelectorAll('form')) {
      if (form.method.toLowerCase() !== 'post') problems.push(`form ${form.getAttribute('action')} is not POST`);
      if (!form.querySelector('input[name="_csrf"]')) problems.push(`form ${form.getAttribute('action')} has no _csrf`);
      const action = form.getAttribute('action') ?? '';
      if (!action.startsWith('/') || action.startsWith('//')) problems.push(`form action is not a local path: ${action}`);
    }
    for (const link of doc.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href') ?? '';
      if (href === '#' || href.toLowerCase().startsWith('javascript:')) problems.push(`inert link ${href}`);
      if (/withflintpay\.com/i.test(href)) problems.push(`link to a Flint host ${href}`);
      if (link.getAttribute('target') === '_blank' && !/noopener/.test(link.getAttribute('rel') ?? '')) problems.push(`target=_blank without noopener ${href}`);
      if (!(link.textContent ?? '').trim() && !link.getAttribute('aria-label')) problems.push(`link without a name ${href}`);
    }
    for (const el of doc.querySelectorAll('*')) {
      for (const attr of el.getAttributeNames()) if (attr.startsWith('on')) problems.push(`inline handler ${attr}`);
    }
    for (const script of doc.querySelectorAll('script:not([src])')) {
      if (script.getAttribute('type') !== 'application/json') problems.push('inline executable script');
    }
    const html = doc.documentElement.outerHTML;
    if (/flint_(test|live|cses|cref)_|\bckat_|\bcklt_|whsec_/.test(html)) problems.push('credential-like text in page');
    for (const img of doc.querySelectorAll('img')) if (!img.hasAttribute('alt')) problems.push('img without alt');
    return problems;
  }, options);
}

/** True when the document is wider than the viewport. */
export async function overflowsHorizontally(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}
