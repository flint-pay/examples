import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium, expect } from '@playwright/test';
import { Driver } from '../../support/driver.ts';
import { browserEnvironment } from '../../support/child.ts';

test('form waits for the submitted document and preserves enhanced checkout jobs', async t => {
  let sameUrl = false, submitted = false;
  const server = createServer(async (request, response) => {
    request.resume();
    if (request.url === '/favicon.ico') { response.writeHead(204).end(); return; }
    if (request.method === 'POST' && request.url === '/verification/confirm') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}'); return;
    }
    if (request.method === 'POST') {
      submitted = true;
      await new Promise(resolve => setTimeout(resolve, 150));
      response.writeHead(303, { location: sameUrl ? '/sign-in' : '/account' }).end(); return;
    }
    response.setHeader('content-type', 'text/html');
    if (request.url === '/checkout') {
      response.end(`<form method="post" action="/verification/confirm" data-job-form="verification-confirm"><input name="code"><button type="submit">Confirm</button></form><p data-testid="job-completed" hidden>Confirmed</p><script>document.querySelector('form').addEventListener('submit', async event => { event.preventDefault(); await fetch('/verification/confirm', { method: 'POST' }); document.querySelector('[data-testid="job-completed"]').hidden = false; });</script>`);
    } else if (submitted) {
      await new Promise(resolve => setTimeout(resolve, 150));
      response.end('<p data-testid="submitted-document">Signed in</p>');
    } else {
      // Delay native submission beyond the click's own navigation wait.
      response.end(`<form method="post" action="/sign-in"><input name="email"><input name="password" type="password"><button type="submit">Sign in</button></form><script>document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget; setTimeout(() => HTMLFormElement.prototype.submit.call(form), 100); });</script>`);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, env: browserEnvironment() });
    for (const same of [false, true]) {
      await t.test(same ? 'same-URL POST redirect replaces the document' : 'delayed sign-in reaches the destination document', async () => {
        sameUrl = same; submitted = false;
        const context = await browser!.newContext({ serviceWorkers: 'block' });
        try {
          const page = await context.newPage();
          page.setDefaultNavigationTimeout(3000);
          await page.goto(`${origin}/sign-in`);
          await Driver.prototype.form.call({} as Driver, page, '/sign-in', { email: 'buyer@example.invalid', password: 'local-test-password' });
          // Immediate reads expose a premature return; retrying assertions would conceal it.
          assert.equal(new URL(page.url()).pathname, same ? '/sign-in' : '/account');
          assert.equal(await page.getByTestId('submitted-document').count(), 1);
        } finally { await context.close(); }
      });
    }
    await t.test('enhanced verification uses fetch without document navigation', async () => {
      const context = await browser!.newContext({ serviceWorkers: 'block' });
      try {
        const page = await context.newPage();
        page.setDefaultNavigationTimeout(3000);
        await page.goto(`${origin}/checkout`);
        await Driver.prototype.form.call({} as Driver, page, '/verification/confirm', { code: '123456' });
        await expect(page.getByTestId('job-completed')).toBeVisible();
        assert.equal(new URL(page.url()).pathname, '/checkout');
      } finally { await context.close(); }
    });
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
