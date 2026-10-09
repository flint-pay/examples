// LOCAL STATE TESTS for the gift card verification on the checkout page. The app and Flint are both
// stand-ins here. The fake verification page is served by page.route on the real challenge origin,
// so message origins are genuine, and it posts to its parent the way Flint's page does. A pass
// proves what the page does with each answer. It says nothing about Flint or about the real app.
// Every identifier, proof, and session ID in these tests is a made-up placeholder.

import { expect, test, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHash } from 'node:crypto';
import { CHALLENGE_ORIGIN, FAKE_PROOF, challengePageHtml, sessionIdFor } from '../support/fake-backend.ts';
import { chooseShipping, fillContact, fixtureLog, openCheckout, resetFixtures, typeCard, waitForPayment } from '../support/helpers.ts';

test.beforeEach(async ({ request }) => resetFixtures(request));

const REF = 'chk_card';
const FRAME = 'iframe.gift-challenge-frame';

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { open, wait };
}

/** Serves the fake verification page for every address on the challenge origin. */
async function serveChallengeHost(page: Page, options: { hold?: ReturnType<typeof gate>; frames?: string[] } = {}) {
  const hits: string[] = [];
  await page.route(`${CHALLENGE_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    hits.push(url.href);
    await options.hold?.wait;
    // `frames` makes the Nth frame of a check behave as named, whatever the address says.
    const scenario = options.frames?.[hits.length - 1] ?? url.pathname.split('/').pop()!.replace(/^gccf_fake\./, '');
    await route.fulfill({ contentType: 'text/html', body: challengePageHtml(scenario, sessionIdFor(REF), new URL(page.url()).origin) });
  });
  return hits;
}

async function openOrder(page: Page) {
  await openCheckout(page, 'card');
  await waitForPayment(page, 'ready');
}

async function apply(page: Page, code: string) {
  await page.getByTestId('sf-gift-card-code').fill(code);
  await page.getByTestId('sf-gift-card-apply').click();
}

const section = (page: Page) => page.locator('[data-region="gift-cards"]');
const stateOf = (page: Page) => expect(section(page));
const giftError = (page: Page) => page.locator('[data-job-error="gift-card"]');
const messageOf = (page: Page) => page.getByTestId('sf-gift-challenge-message');

async function challengePosts(request: Parameters<typeof fixtureLog>[0]) {
  return (await fixtureLog(request, REF)).challengePosts;
}

async function applyPosts(request: Parameters<typeof fixtureLog>[0]) {
  return (await fixtureLog(request, REF)).log.filter((entry) => entry.method === 'POST' && entry.path === 'gift-card').length;
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  expect(found).not.toBeNull();
  return found!;
}

test('B1 completed: loading, checking, then applied; the proof is not left anywhere', async ({ page, request, context }) => {
  const seen: string[] = [];
  page.on('console', (message) => seen.push(message.text()));
  page.on('pageerror', (error) => seen.push(error.message));
  const hold = gate();
  const hits = await serveChallengeHost(page, { hold });
  const proofRelease = gate();
  await page.route('**/checkout/chk_card/gift-card/challenge', async (route) => {
    await proofRelease.wait;
    await route.continue();
  });
  await openOrder(page);
  await apply(page, 'CHALLENGE');

  await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
  const panel = page.getByTestId('sf-gift-challenge');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('role', 'group');
  await expect(page.locator('#gift-challenge-intro')).toBeFocused();
  await expect(page.locator('#gift-challenge-intro')).toHaveText('To use this gift card, complete the verification below.');
  await expect(page.getByTestId('sf-gift-card-code')).toHaveAttribute('readonly', '');
  await expect(page.getByTestId('sf-gift-card-code')).toHaveValue('CHALLENGE');
  await expect(page.getByTestId('sf-gift-card-apply')).toBeDisabled();
  await expect(page.getByTestId('sf-gift-challenge-cancel')).toBeVisible();
  await expect(page.getByTestId('sf-gift-challenge-retry')).toBeHidden();
  await expect(page.locator(FRAME)).toHaveCount(1);

  hold.open();
  await stateOf(page).toHaveAttribute('data-challenge-state', 'checking');
  await expect(page.getByTestId('sf-gift-challenge-status')).toHaveText('Applying your gift card.');
  await expect(page.locator(FRAME)).toHaveCount(0);
  await expect(page.getByTestId('sf-gift-challenge-retry')).toBeHidden();
  await expect(page.getByTestId('sf-gift-challenge-cancel')).toBeHidden();
  await expect(page.getByTestId('sf-gift-card-apply')).toHaveAttribute('aria-busy', 'true');

  proofRelease.open();
  await stateOf(page).toHaveAttribute('data-challenge-state', 'none');
  await expect(page.getByTestId('sf-gift-card-applied-0')).toContainText('Gift card ending 4821');
  await expect(panel).toBeHidden();
  await expect(page.locator('#gift-title')).toBeFocused();
  await expect(page.getByTestId('sf-live')).toContainText('Gift card applied.');
  expect(hits).toHaveLength(1);

  const posts = (await fixtureLog(request, REF)).log.filter((entry) => entry.path === 'gift-card/challenge');
  expect(posts).toHaveLength(1);
  expect(Object.keys(posts[0]!.body).sort()).toEqual(['challenge_id', 'gift_card_code', 'proof']);

  const storage = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
  const cookies = JSON.stringify(await context.cookies());
  for (const place of [await page.content(), page.url(), storage, cookies, seen.join('\n')]) expect(place).not.toContain(FAKE_PROOF);
  for (const place of [await page.content(), storage, seen.join('\n')]) expect(place).not.toContain('/gift-card-challenge/');
});

test('B2 verification_failed: the third frame ends in unavailable at once, with no extra click', async ({ page, request }) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.__frames = 0;
    w.__states = [];
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if (node instanceof HTMLIFrameElement) w.__frames += 1;
    }).observe(document, { childList: true, subtree: true });
    // Every value the check's state attribute takes, so a state that flashes by is still seen.
    document.addEventListener('DOMContentLoaded', () => {
      const watch = () => {
        const node = document.querySelector('[data-region="gift-cards"]');
        if (!node) return;
        w.__states.push(node.getAttribute('data-challenge-state'));
        new MutationObserver(() => w.__states.push(node.getAttribute('data-challenge-state'))).observe(node, { attributes: true, attributeFilter: ['data-challenge-state'] });
      };
      watch();
    });
  });
  const hits = await serveChallengeHost(page);
  await openOrder(page);
  await apply(page, 'CHALLENGEFAIL');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'failed');
  await expect(messageOf(page)).toHaveText("The verification didn't go through. Select Try again.");
  await expect(messageOf(page)).toBeFocused();
  await expect(page.locator(FRAME)).toHaveCount(0);
  await page.getByTestId('sf-gift-challenge-retry').click();
  await expect.poll(() => hits.length).toBe(2);
  await stateOf(page).toHaveAttribute('data-challenge-state', 'failed');
  await expect(page.getByTestId('sf-gift-challenge-retry')).toBeVisible();
  await page.getByTestId('sf-gift-challenge-retry').click();
  await expect.poll(() => hits.length).toBe(3);
  // The third frame fails: no failed panel and no Try again, straight to the unavailable message.
  await stateOf(page).toHaveAttribute('data-challenge-state', 'unavailable');
  await expect(page.getByTestId('sf-gift-challenge')).toBeHidden();
  await expect(page.getByTestId('sf-gift-challenge-retry')).toBeHidden();
  await expect(messageOf(page)).toBeHidden();
  await expect(giftError(page)).toHaveText("We can't check gift card codes right now. Try again later, or pay another way.");
  await expect(page.getByTestId('sf-gift-card-code')).toBeEnabled();
  await expect(page.getByTestId('sf-gift-card-code')).not.toHaveAttribute('readonly', '');
  await expect(page.getByTestId('sf-gift-card-code')).toHaveValue('CHALLENGEFAIL');
  await expect(page.getByTestId('sf-gift-card-code')).toBeFocused();
  await expect(page.getByTestId('sf-gift-card-code')).toHaveAttribute('aria-describedby', 'gift-card-error');
  await expect(page.getByTestId('sf-gift-card-apply')).toBeEnabled();
  expect(hits).toHaveLength(3);
  expect(await page.evaluate(() => (window as any).__frames)).toBe(3);
  const states: string[] = await page.evaluate(() => (window as any).__states);
  expect(states.filter((state) => state === 'failed')).toHaveLength(2);
  expect(states.slice(-2)).toEqual(['loading', 'unavailable']);
  expect((await applyPosts(request))).toBe(1);
  expect((await challengePosts(request))).toBe(0);
});

test('B2 mixed: a slow frame then two failed frames use the same cap of three', async ({ page, request }) => {
  await page.clock.install();
  const hits = await serveChallengeHost(page, { frames: ['silent', 'failed', 'failed'] });
  await openOrder(page);
  await apply(page, 'CHALLENGESILENT');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
  await page.clock.fastForward(61_000);
  await stateOf(page).toHaveAttribute('data-challenge-state', 'slow');
  await page.getByTestId('sf-gift-challenge-retry').click();
  await expect.poll(() => hits.length).toBe(2);
  await stateOf(page).toHaveAttribute('data-challenge-state', 'failed');
  await page.getByTestId('sf-gift-challenge-retry').click();
  await expect.poll(() => hits.length).toBe(3);
  await stateOf(page).toHaveAttribute('data-challenge-state', 'unavailable');
  await expect(page.getByTestId('sf-gift-challenge')).toBeHidden();
  await expect(giftError(page)).toHaveText("We can't check gift card codes right now. Try again later, or pay another way.");
  await expect(page.getByTestId('sf-gift-card-code')).toBeFocused();
  expect(hits).toHaveLength(3);
  expect((await applyPosts(request))).toBe(1);
  expect((await challengePosts(request))).toBe(0);
});

test('B2 slow at the cap: Try again from the third slow frame ends in unavailable', async ({ page, request }) => {
  await page.clock.install();
  const hits = await serveChallengeHost(page);
  await openOrder(page);
  await apply(page, 'CHALLENGESILENT');
  for (const frames of [1, 2, 3]) {
    await expect.poll(() => hits.length).toBe(frames);
    await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
    await page.clock.fastForward(61_000);
    await stateOf(page).toHaveAttribute('data-challenge-state', 'slow');
    await page.getByTestId('sf-gift-challenge-retry').click();
  }
  await stateOf(page).toHaveAttribute('data-challenge-state', 'unavailable');
  await expect(giftError(page)).toHaveText("We can't check gift card codes right now. Try again later, or pay another way.");
  await expect(page.getByTestId('sf-gift-challenge')).toBeHidden();
  expect(hits).toHaveLength(3);
  expect((await challengePosts(request))).toBe(0);
});

test('B3 the frame reports unavailable: panel closes and the field is ready again', async ({ page }) => {
  await serveChallengeHost(page);
  await openOrder(page);
  await apply(page, 'CHALLENGEGONE');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'unavailable');
  await expect(page.getByTestId('sf-gift-challenge')).toBeHidden();
  await expect(giftError(page)).toContainText("We can't check gift card codes right now. Try again later, or pay another way.");
  await expect(page.getByTestId('sf-gift-card-code')).toBeEnabled();
  await expect(page.getByTestId('sf-gift-card-code')).not.toHaveAttribute('readonly', '');
  await expect(page.getByTestId('sf-gift-card-code')).toHaveValue('CHALLENGEGONE');
  await expect(page.getByTestId('sf-gift-card-code')).toBeFocused();
  await expect(page.getByTestId('sf-gift-card-code')).toHaveAttribute('aria-describedby', 'gift-card-error');
  await expect(page.getByTestId('sf-gift-card-apply')).toBeEnabled();
});

test('B4 a silent frame shows slow copy and Try again after 60 seconds and keeps the same frame', async ({ page }) => {
  await page.clock.install();
  await serveChallengeHost(page);
  await openOrder(page);
  await apply(page, 'CHALLENGESILENT');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
  const frame = await page.locator(FRAME).elementHandle();
  await expect(page.getByTestId('sf-gift-challenge-retry')).toBeHidden();
  await page.clock.fastForward(59_000);
  await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
  await page.clock.fastForward(2_000);
  await stateOf(page).toHaveAttribute('data-challenge-state', 'slow');
  await expect(page.getByTestId('sf-gift-challenge-status')).toHaveText('The verification is taking longer than usual. Select Try again to reload it.');
  await expect(page.getByTestId('sf-gift-challenge-retry')).toBeVisible();
  expect(await frame!.evaluate((node) => node.isConnected)).toBe(true);
  await expect(page.locator(FRAME)).toHaveCount(1);
});

test('the check expires on its own timer and Try again applies the same code again', async ({ page, request }) => {
  await page.clock.install();
  await serveChallengeHost(page);
  await openOrder(page);
  await apply(page, 'CHALLENGESHORT');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
  await page.clock.fastForward(121_000);
  await stateOf(page).toHaveAttribute('data-challenge-state', 'expired');
  await expect(messageOf(page)).toHaveText('The verification expired before your gift card was applied. Select Try again.');
  await expect(messageOf(page)).toBeFocused();
  await expect(page.locator(FRAME)).toHaveCount(0);
  expect(await applyPosts(request)).toBe(1);
  await page.getByTestId('sf-gift-challenge-retry').click();
  // No fresh view is held, so this is a new Apply with the same code, which starts a new check.
  await expect.poll(() => applyPosts(request)).toBe(2);
  await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
  await expect(page.locator(FRAME)).toHaveCount(1);
});

test.describe('B5 messages that must be ignored', () => {
  const valid = { type: 'flint.gift_card_challenge.completed', checkout_session_id: sessionIdFor(REF), proof: FAKE_PROOF, expires_at: '2026-10-08T12:15:00Z' };

  test('a message from the main page', async ({ page, request }) => {
    await serveChallengeHost(page);
    await openOrder(page);
    await apply(page, 'CHALLENGESILENT');
    await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
    await page.evaluate((message) => window.postMessage(message, '*'), valid);
    await page.waitForTimeout(400);
    await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
    expect(await challengePosts(request)).toBe(0);
  });

  test('a message from a second frame on the same challenge origin', async ({ page, request }) => {
    const hits = await serveChallengeHost(page);
    await openOrder(page);
    await apply(page, 'CHALLENGESILENT');
    await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
    await page.evaluate((origin) => {
      const other = document.createElement('iframe');
      other.src = `${origin}/gift-card-challenge/gccf_fake.completed`;
      other.setAttribute('data-testid', 'injected-frame');
      document.body.append(other);
    }, CHALLENGE_ORIGIN);
    await expect.poll(() => hits.some((hit) => hit.endsWith('gccf_fake.completed'))).toBe(true);
    await page.waitForTimeout(400);
    await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
    expect(await challengePosts(request)).toBe(0);
  });

  test('a message from the real frame for a different checkout', async ({ page, request }) => {
    const hits = await serveChallengeHost(page);
    await openOrder(page);
    await apply(page, 'CHALLENGEWRONG');
    await expect.poll(() => hits.length).toBe(1);
    await page.waitForTimeout(400);
    await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
    await expect(page.locator(FRAME)).toHaveCount(1);
    expect(await challengePosts(request)).toBe(0);
  });

  test('noise from the real frame before the valid answer: only the valid answer counts', async ({ page, request }) => {
    await serveChallengeHost(page);
    await openOrder(page);
    await apply(page, 'CHALLENGESPOOF');
    await expect(page.getByTestId('sf-gift-card-applied-0')).toContainText('Gift card ending 4821');
    expect(await challengePosts(request)).toBe(1);
  });
});

test('B6 two valid answers send exactly one proof', async ({ page, request }) => {
  await serveChallengeHost(page);
  await openOrder(page);
  await apply(page, 'CHALLENGEDOUBLE');
  await expect(page.getByTestId('sf-gift-card-applied-0')).toContainText('Gift card ending 4821');
  await page.waitForTimeout(300);
  expect(await challengePosts(request)).toBe(1);
});

test('B7 Cancel and Escape leave without any request and return to the field', async ({ page, request }) => {
  await serveChallengeHost(page);
  await openOrder(page);
  await apply(page, 'CHALLENGESILENT');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
  await page.getByTestId('sf-gift-challenge-cancel').click();
  await stateOf(page).toHaveAttribute('data-challenge-state', 'none');
  await expect(page.getByTestId('sf-gift-challenge')).toBeHidden();
  await expect(page.locator(FRAME)).toHaveCount(0);
  await expect(page.getByTestId('sf-gift-card-apply')).toBeEnabled();
  await expect(page.getByTestId('sf-gift-card-code')).toBeFocused();
  await expect(page.getByTestId('sf-gift-card-code')).toHaveValue('CHALLENGESILENT');

  await page.getByTestId('sf-gift-card-apply').click();
  await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
  await expect(page.locator('#gift-challenge-intro')).toBeFocused();
  await page.keyboard.press('Escape');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'none');
  await expect(page.getByTestId('sf-gift-card-code')).toBeFocused();
  expect(await challengePosts(request)).toBe(0);
  expect(await applyPosts(request)).toBe(2);
});

test('B8 a job saved during the check does not replace the gift card region, and the code survives the sync', async ({ page }) => {
  await serveChallengeHost(page);
  await openOrder(page);
  await apply(page, 'CHALLENGESILENT');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
  const frame = await page.locator(FRAME).elementHandle();
  await page.getByTestId('sf-discount-code').fill('WELCOME10');
  await page.getByTestId('sf-discount-apply').click();
  await expect(page.getByTestId('sf-discount-applied-0')).toBeVisible();
  expect(await frame!.evaluate((node) => node.isConnected)).toBe(true);
  await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
  await page.getByTestId('sf-gift-challenge-cancel').click();
  await stateOf(page).toHaveAttribute('data-challenge-state', 'none');
  await expect(page.getByTestId('sf-gift-card-code')).toHaveValue('CHALLENGESILENT');
  await expect(page.getByTestId('sf-gift-card-code')).toBeFocused();
});

test('B9 Flint rejects the proof: expired copy, then Try again opens the new check without another Apply', async ({ page, request }) => {
  const hits = await serveChallengeHost(page);
  await openOrder(page);
  await apply(page, 'CHALLENGEREJECT');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'expired');
  await expect(messageOf(page)).toHaveText('The verification expired before your gift card was applied. Select Try again.');
  await expect(messageOf(page)).toBeFocused();
  expect(await challengePosts(request)).toBe(1);
  expect(await applyPosts(request)).toBe(1);
  await page.getByTestId('sf-gift-challenge-retry').click();
  await expect(page.getByTestId('sf-gift-card-applied-0')).toContainText('Gift card ending 4821');
  expect(hits).toHaveLength(2);
  expect(await applyPosts(request)).toBe(1);
  expect(await challengePosts(request)).toBe(2);
});

test('B10 origin required, from the retry and from the first Apply: the checkout is refreshed and the code is kept', async ({ page }) => {
  await serveChallengeHost(page);
  await openOrder(page);
  for (const code of ['CHALLENGEORIGIN', 'ORIGINAPPLY']) {
    await apply(page, code);
    await stateOf(page).toHaveAttribute('data-challenge-state', 'origin_required');
    await expect(giftError(page)).toHaveText('We refreshed your checkout so we can verify gift card codes. Select Apply to try this code again.');
    await expect(page.getByTestId('sf-notice-checkout_refreshed')).toBeVisible();
    await expect(page.getByTestId('sf-gift-challenge')).toBeHidden();
    await expect(page.getByTestId('sf-gift-card-code')).toHaveValue(code);
    await expect(page.getByTestId('sf-gift-card-code')).toBeEnabled();
    await expect(page.getByTestId('sf-gift-card-code')).toBeFocused();
    await expect(page.getByTestId('sf-gift-card-apply')).toBeEnabled();
  }
});

test('B11 a frame address that is not exactly a Flint challenge page is never loaded', async ({ page, request }) => {
  const requested: string[] = [];
  page.on('request', (seen) => {
    if (/gift-card-challenge|evil\.example\.test/.test(seen.url())) requested.push(seen.url());
  });
  await serveChallengeHost(page);
  await openOrder(page);
  for (const code of ['UNTRUSTEDHTTP', 'UNTRUSTEDHOST', 'UNTRUSTEDPATH', 'UNTRUSTEDQUERY']) {
    await apply(page, code);
    await stateOf(page).toHaveAttribute('data-challenge-state', 'unavailable');
    await expect(giftError(page)).toContainText("We can't check gift card codes right now.");
    await expect(page.locator(FRAME)).toHaveCount(0);
    await expect(page.getByTestId('sf-gift-challenge')).toBeHidden();
    await expect(page.getByTestId('sf-gift-card-code')).toBeEnabled();
  }
  expect(requested).toEqual([]);
  expect(await challengePosts(request)).toBe(0);
});

test('B12 the frame has the specified attributes and size', async ({ page }) => {
  await serveChallengeHost(page);
  await openOrder(page);
  await apply(page, 'CHALLENGESILENT');
  const frame = page.getByTestId('sf-gift-challenge-frame');
  await expect(frame).toHaveAttribute('src', `${CHALLENGE_ORIGIN}/gift-card-challenge/gccf_fake.silent`);
  await expect(frame).toHaveAttribute('title', 'Gift card verification');
  await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
  for (const name of ['sandbox', 'allow', 'name']) await expect(frame).not.toHaveAttribute(name, /.*/);
  const size = await box(frame);
  expect(size.width).toBeGreaterThanOrEqual(300);
  expect(size.height).toBe(65);
});

for (const viewport of [
  { width: 360, height: 800, frame: 328 },
  { width: 768, height: 1000, frame: 0 },
  { width: 1440, height: 1000, frame: 0 },
]) {
  test(`B13 layout at ${viewport.width} px: frame, buttons, and panel stay inside the gift card section`, async ({ page }) => {
    await page.clock.install();
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await serveChallengeHost(page);
    await openOrder(page);
    await apply(page, 'CHALLENGESILENT');
    await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
    const check = async () => {
      const gift = await box(section(page));
      const panel = await box(page.getByTestId('sf-gift-challenge'));
      expect(panel.x).toBeGreaterThanOrEqual(gift.x - 0.5);
      expect(panel.x + panel.width).toBeLessThanOrEqual(gift.x + gift.width + 0.5);
      expect(panel.y).toBeGreaterThanOrEqual(gift.y - 0.5);
      expect(panel.y + panel.height).toBeLessThanOrEqual(gift.y + gift.height + 0.5);
      const summary = await box(page.getByTestId('sf-summary'));
      const overlaps = panel.x < summary.x + summary.width && panel.x + panel.width > summary.x && panel.y < summary.y + summary.height && panel.y + panel.height > summary.y;
      expect(overlaps).toBe(false);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      for (const id of ['sf-gift-challenge-retry', 'sf-gift-challenge-cancel']) {
        const button = page.getByTestId(id);
        if (!(await button.isVisible())) continue;
        const size = await box(button);
        expect(size.width).toBeGreaterThanOrEqual(44);
        expect(size.height).toBeGreaterThanOrEqual(44);
      }
    };
    const frame = await box(page.locator(FRAME));
    expect(frame.width).toBeGreaterThanOrEqual(300);
    expect(frame.height).toBe(65);
    if (viewport.frame) expect(Math.round(frame.width)).toBe(viewport.frame);
    await check();
    await page.clock.fastForward(61_000);
    await stateOf(page).toHaveAttribute('data-challenge-state', 'slow');
    await expect(page.getByTestId('sf-gift-challenge-retry')).toBeVisible();
    await check();
  });
}

test('B14 keyboard only: Tab reaches the frame, then Try again, then Cancel; Enter and Space activate', async ({ page }) => {
  await page.clock.install();
  const hits = await serveChallengeHost(page);
  await openOrder(page);
  await apply(page, 'CHALLENGESILENT');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
  await page.clock.fastForward(61_000);
  await stateOf(page).toHaveAttribute('data-challenge-state', 'slow');
  await expect(page.locator('#gift-challenge-intro')).toBeFocused();
  // Tab moves through the frame's document, so let it finish loading first.
  await expect(page.frameLocator(FRAME).locator('p')).toHaveText('Fake verification');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('sf-gift-challenge-retry')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('sf-gift-challenge-cancel')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await expect.poll(() => hits.length).toBe(2);
  await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
  await expect(page.locator('#gift-challenge-intro')).toBeFocused();
  await expect(page.frameLocator(FRAME).locator('p')).toHaveText('Fake verification');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('sf-gift-challenge-cancel')).toBeFocused();
  await page.keyboard.press('Space');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'none');
  await expect(page.getByTestId('sf-gift-card-code')).toBeFocused();
});

test('B15 axe finds no serious or critical problems while loading and after a failure', async ({ page }) => {
  await serveChallengeHost(page);
  await openOrder(page);
  const scan = async (label: string) => {
    const results = await new AxeBuilder({ page }).exclude(FRAME).analyze();
    const bad = results.violations.filter((violation: any) => ['serious', 'critical'].includes(violation.impact));
    expect(bad.map((violation: any) => `${label}: ${violation.id}`)).toEqual([]);
  };
  await apply(page, 'CHALLENGESILENT');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
  await scan('loading');
  await page.getByTestId('sf-gift-challenge-cancel').click();
  await apply(page, 'CHALLENGEFAIL');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'failed');
  await scan('failed');
});

test('B16 neither the page nor its embedded state holds a frame address before a check starts', async ({ page, request }) => {
  const html = await (await request.get(`/checkout/${REF}`)).text();
  expect(html).not.toContain('/gift-card-challenge/');
  expect(html).not.toContain('gccf_');
  expect(html).not.toContain(sessionIdFor(REF));
  expect(html).not.toMatch(/<iframe/);
  await serveChallengeHost(page);
  await openOrder(page);
  const boot = JSON.parse((await page.locator('#checkout-bootstrap').textContent()) ?? '{}');
  expect(boot.gift_challenge).toEqual({ origin: CHALLENGE_ORIGIN, slow_after_ms: 60000, max_mounts: 3 });
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.getByTestId('sf-gift-challenge')).toBeHidden();
  await expect(page.getByTestId('sf-gift-challenge-host')).toBeEmpty();
});

test('the session tag the page checks is the one the server computes for the pinned vector', async () => {
  const tag = createHash('sha256').update('flint-examples.gift-challenge.v1\ngch_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\ncs_PLACEHOLDER_PINNED_VECTOR').digest('base64url');
  expect(tag).toBe('CGZN0PgNBeNrKsatRzXixdZjmjeaolCFm462W42PkeU');
});

test('the browser module computes the pinned session tag vector', async ({ page }) => {
  await page.goto('/__health');
  const tag = await page.evaluate(async () => {
    const path = '/js/gift-challenge.js';
    const module = await import(path);
    return module.sessionTagFor('gch_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'cs_PLACEHOLDER_PINNED_VECTOR');
  });
  expect(tag).toBe('CGZN0PgNBeNrKsatRzXixdZjmjeaolCFm462W42PkeU');
});

test.describe('outcomes of the retry', () => {
  test('an unconfirmed result keeps the code and never sends the proof again', async ({ page, request }) => {
    await serveChallengeHost(page);
    await openOrder(page);
    await apply(page, 'CHALLENGEUNKNOWN');
    await stateOf(page).toHaveAttribute('data-challenge-state', 'unconfirmed');
    await expect(giftError(page)).toHaveText("We couldn't confirm whether your gift card was applied. Select Apply to check.");
    await expect(page.getByTestId('sf-gift-card-code')).toHaveValue('CHALLENGEUNKNOWN');
    await expect(page.getByTestId('sf-gift-card-code')).toBeFocused();
    await expect(page.getByTestId('sf-gift-card-apply')).toBeEnabled();
    expect(await challengePosts(request)).toBe(1);
  });

  test('the server says the check is gone: expired copy, no held view', async ({ page, request }) => {
    await serveChallengeHost(page);
    await openOrder(page);
    await apply(page, 'CHALLENGEEXPIRED');
    await stateOf(page).toHaveAttribute('data-challenge-state', 'expired');
    await expect(messageOf(page)).toBeFocused();
    await page.getByTestId('sf-gift-challenge-retry').click();
    await expect.poll(() => applyPosts(request)).toBe(2);
  });

  test('Flint cannot run the check after the proof: unavailable copy', async ({ page }) => {
    await serveChallengeHost(page);
    await openOrder(page);
    await apply(page, 'CHALLENGEUNAVAIL');
    await stateOf(page).toHaveAttribute('data-challenge-state', 'unavailable');
    await expect(giftError(page)).toContainText("We can't check gift card codes right now.");
    await expect(page.getByTestId('sf-gift-card-code')).toBeFocused();
  });

  test('the order changed during the check: apply again, code kept', async ({ page }) => {
    await serveChallengeHost(page);
    await openOrder(page);
    await apply(page, 'CHALLENGESTALE');
    await stateOf(page).toHaveAttribute('data-challenge-state', 'none');
    await expect(giftError(page)).toHaveText('Your order changed. Apply the gift card again.');
    await expect(page.getByTestId('sf-gift-card-code')).toHaveValue('CHALLENGESTALE');
    await expect(page.getByTestId('sf-gift-card-code')).toBeFocused();
  });

  test('a code Flint refuses after the check shows the usual field error', async ({ page }) => {
    await serveChallengeHost(page);
    await openOrder(page);
    await apply(page, 'CHALLENGEREFUSED');
    await expect(giftError(page)).toContainText("That gift card code isn't valid for this order.");
    await stateOf(page).toHaveAttribute('data-challenge-state', 'none');
    await expect(page.getByTestId('sf-gift-card-code')).toHaveValue('CHALLENGEREFUSED');
    await expect(page.getByTestId('sf-gift-card-code')).toBeEnabled();
  });
});

test('finishing a payment closes an open check without a message of its own', async ({ page }) => {
  await serveChallengeHost(page);
  await openOrder(page);
  await fillContact(page);
  await chooseShipping(page);
  await expect(page.getByTestId('sf-delivery')).toHaveAttribute('data-state', 'options');
  await page.getByTestId('sf-delivery-option-0').check();
  await expect(page.getByTestId('sf-delivery')).toHaveAttribute('data-state', 'selected');
  await apply(page, 'CHALLENGESILENT');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
  await typeCard(page, 'slow');
  await page.getByTestId('sf-pay-button').click();
  await waitForPayment(page, 'waiting');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'none');
  await expect(page.getByTestId('sf-gift-challenge')).toBeHidden();
  await expect(page.locator(FRAME)).toHaveCount(0);
  await expect(page.getByTestId('sf-locked-note')).toBeVisible();
});

// A proxy answers with its own page instead of the app's JSON. The page cannot know whether the change
// happened, so it says so, never sends the proof again, and leaves the settling to a same-code Apply.
test.describe('a proxy error page instead of the app answer', () => {
  for (const status of [502, 503]) {
    test(`proof request answered ${status}: unconfirmed copy, one proof, and a same-code Apply finds it applied`, async ({ page, request }) => {
      await serveChallengeHost(page);
      await openOrder(page);
      await apply(page, `PROXYPROOF${status}`);
      await stateOf(page).toHaveAttribute('data-challenge-state', 'unconfirmed');
      await expect(giftError(page)).toHaveText("We couldn't confirm whether your gift card was applied. Select Apply to check.");
      await expect(page.getByTestId('sf-gift-card-code')).toHaveValue(`PROXYPROOF${status}`);
      await expect(page.getByTestId('sf-gift-card-code')).toBeFocused();
      await expect(page.getByTestId('sf-gift-challenge')).toBeHidden();
      expect(await challengePosts(request)).toBe(1);
      await page.getByTestId('sf-gift-card-apply').click();
      await expect(page.getByTestId('sf-gift-card-applied-0')).toContainText('Gift card ending 4821');
      expect(await challengePosts(request)).toBe(1);
    });

    test(`apply answered ${status}: the page says it is still checking and the same code then applies`, async ({ page }) => {
      await openOrder(page);
      await apply(page, `PROXYAPPLY${status}`);
      await expect(giftError(page)).toHaveText("We're still checking what happened. Don't pay again yet. Check again in a moment.");
      await expect(page.getByTestId('sf-gift-card-code')).toHaveValue(`PROXYAPPLY${status}`);
      await page.getByTestId('sf-gift-card-apply').click();
      await expect(page.getByTestId('sf-gift-card-applied-0')).toContainText('Gift card ending 4821');
    });
  }
});

test('an Apply queued behind a discount keeps its code through the region swap and completes the check', async ({ page, request }) => {
  await serveChallengeHost(page);
  const discountRelease = gate();
  await page.route('**/checkout/chk_card/discount', async (route) => {
    await discountRelease.wait;
    await route.continue();
  });
  await openOrder(page);
  const discountSent = page.waitForRequest('**/checkout/chk_card/discount');
  await page.getByTestId('sf-discount-code').fill('WELCOME10');
  await page.getByTestId('sf-discount-apply').click();
  await discountSent;
  await apply(page, 'CHALLENGE');
  await expect(page.getByTestId('sf-gift-card-apply')).toHaveAttribute('aria-busy', 'true');
  discountRelease.open();
  // The discount's swap renders a fresh, empty gift card field before the queued Apply runs.
  await expect(page.getByTestId('sf-discount-applied-0')).toContainText('WELCOME10');
  await expect(page.getByTestId('sf-gift-card-applied-0')).toContainText('Gift card ending 4821');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'none');
  await expect(giftError(page)).toBeHidden();
  await expect(page.getByTestId('sf-gift-card-code')).toHaveValue('');
  expect(await challengePosts(request)).toBe(1);
  expect(await applyPosts(request)).toBe(1);
  expect(JSON.stringify((await fixtureLog(request, REF)).log)).not.toContain('CHALLENGE');
});
