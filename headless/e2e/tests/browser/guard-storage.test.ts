import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { browserEnvironment } from '../../support/child.ts';
import { BrowserGuard } from '../../support/flint-boundary.ts';
import { CredentialScanner } from '../../support/credential-scan.ts';

const app = 'https://app.example.test';
const secret = 'synthetic-guard-credential';

async function withDocument(browser: Browser, run: (page: Page, context: BrowserContext, guard: BrowserGuard) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    // Fulfill app documents locally and abort everything else. No hosted services are used.
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin === app) await route.fulfill({ contentType: 'text/html', body: '<p>App</p>' });
      else await route.abort();
    });
    const scanner = new CredentialScanner([secret]);
    await run(await context.newPage(), context, new BrowserGuard(scanner, [app]));
  } finally { await context.close(); }
}

test('BrowserGuard scans blank documents without requiring storage from opaque origins', async t => {
  const browser = await chromium.launch({ headless: true, env: browserEnvironment() });
  t.after(() => browser.close());

  await t.test('initial and deliberately blanked app pages reproduce denied Web Storage', async () => {
    await withDocument(browser, async (page, context, guard) => {
      for (const previouslyVisitedApp of [false, true]) {
        if (previouslyVisitedApp) { await page.goto(app); await page.goto('about:blank'); }
        assert.equal(await page.evaluate(() => self.origin), 'null');
        for (const name of ['localStorage', 'sessionStorage'] as const) {
          await assert.rejects(() => page.evaluate(name => window[name], name), /SecurityError/);
        }
        await guard.inspect(context);
      }
    });
  });

  await t.test('sandboxed opaque blank frames remain inspectable', async () => {
    await withDocument(browser, async (page, context, guard) => {
      await page.goto(app);
      await page.evaluate(() => { const frame = document.createElement('iframe'); frame.sandbox.add('allow-scripts'); document.body.append(frame); });
      const frame = page.frames().find(frame => frame !== page.mainFrame())!;
      assert.equal(frame.url(), 'about:blank');
      assert.equal(await frame.evaluate(() => self.origin), 'null');
      await assert.rejects(() => frame.evaluate(() => localStorage), /SecurityError/);
      await guard.inspect(context);
    });
  });

  for (const surface of ['dom', 'sensitive-input'] as const) {
    await t.test(`opaque blank document still fails for leaked ${surface}`, async () => {
      await withDocument(browser, async (page, context, guard) => {
        await page.evaluate(({ secret, surface }) => {
          if (surface === 'dom') document.body.textContent = secret;
          else { const input = document.createElement('input'); input.dataset.sensitive = 'true'; input.value = secret; document.body.append(input); }
        }, { secret, surface });
        await assert.rejects(() => guard.inspect(context), { code: 'CREDENTIAL_LEAK' });
        assert.deepEqual([...guard.scanner.violations], ['CREDENTIAL_DOM']);
      });
    });
  }

  await t.test('inherited blank iframe still fails for leaked DOM', async () => {
    await withDocument(browser, async (page, context, guard) => {
      await page.goto(app);
      await page.evaluate(() => document.body.append(document.createElement('iframe')));
      const frame = page.frames().find(frame => frame !== page.mainFrame())!;
      assert.equal(await frame.evaluate(() => self.origin), app);
      await frame.evaluate(secret => { document.body.textContent = secret; }, secret);
      await assert.rejects(() => guard.inspect(context), { code: 'CREDENTIAL_LEAK' });
      assert.deepEqual([...guard.scanner.violations], ['CREDENTIAL_DOM']);
    });
  });

  for (const inheritedBlank of [false, true]) for (const name of ['localStorage', 'sessionStorage'] as const) {
    await t.test(`${inheritedBlank ? 'inherited blank popup' : 'app document'} still fails for leaked ${name}`, async () => {
      await withDocument(browser, async (page, context, guard) => {
        await page.goto(app);
        let frame = page.mainFrame();
        if (inheritedBlank) {
          const [popup] = await Promise.all([context.waitForEvent('page'), page.evaluate(() => { window.open('about:blank'); })]);
          frame = popup.mainFrame();
          assert.equal(frame.url(), 'about:blank');
          // Remove the opener so its shared storage cannot satisfy the scan assertion.
          await page.close();
        }
        assert.equal(await frame.evaluate(() => self.origin), app);
        await frame.evaluate(({ name, secret }) => window[name].setItem('credential', secret), { name, secret });
        await assert.rejects(() => guard.inspect(context), { code: 'CREDENTIAL_LEAK' });
        assert.deepEqual([...guard.scanner.violations], ['CREDENTIAL_STORAGE']);
      });
    });
  }

  for (const opaque of [false, true]) {
    await t.test(`${opaque ? 'opaque blank' : 'app'} document propagates unexpected storage failures`, async () => {
      await withDocument(browser, async (page, context, guard) => {
        if (!opaque) await page.goto(app);
        await page.evaluate(() => Object.defineProperty(window, 'localStorage', { get() { throw new Error('unexpected-storage-failure'); } }));
        await assert.rejects(() => guard.inspect(context), /unexpected-storage-failure/);
      });
    });
  }

  await t.test('app-origin storage denial remains a failure', async () => {
    await withDocument(browser, async (page, context, guard) => {
      await page.goto(app);
      await page.evaluate(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('app-storage-denied', 'SecurityError'); } }));
      await assert.rejects(() => guard.inspect(context), /SecurityError.*app-storage-denied/);
    });
  });
});
