// LOCAL STATE TESTS for gift cards on the invoice and exchange payment pages, and for the
// verification Flint can ask for before it looks a code up. The app and Flint are both stand-ins.
// The fake verification page is served by page.route on the real challenge origin, so message
// origins are genuine, and it posts to its parent the way Flint's page does. The harness answers
// with the app's real security headers. A pass proves what the page does with each answer. It says
// nothing about Flint or the real app. Every identifier, proof, and session ID here is a placeholder.

import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { CHALLENGE_ORIGIN, FAKE_PROOF, challengePageHtml, sessionIdFor } from '../support/challenge.ts';
import { harnessLog, installStripeStub, payUrl, resetHarness, stubCalls } from '../support/helpers.ts';

type Surface = 'invoice' | 'return';
const FRAME = 'iframe.gift-challenge-frame';

test.beforeEach(async ({ request }) => resetHarness(request, { scenario: 'success' }));

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { open, wait };
}

/** Serves the fake verification page for every address on the challenge origin. */
async function serveChallengeHost(page: Page, surface: Surface = 'invoice', options: { hold?: ReturnType<typeof gate>; frames?: string[] } = {}) {
  const hits: string[] = [];
  await page.route(`${CHALLENGE_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    hits.push(url.href);
    await options.hold?.wait;
    // `frames` makes the Nth frame of a check behave as named, whatever the address says.
    const scenario = options.frames?.[hits.length - 1] ?? url.pathname.split('/').pop()!.replace(/^gccf_fake\./, '');
    await route.fulfill({ contentType: 'text/html', body: challengePageHtml(scenario, sessionIdFor(surface), new URL(page.url()).origin) });
  });
  return hits;
}

async function openPay(page: Page, surface: Surface = 'invoice', variant = 'gift') {
  await installStripeStub(page);
  await page.goto(payUrl(surface, variant));
  await expect(page.getByTestId('ac-payment')).toHaveAttribute('data-state', /ready|total_changed/);
}

async function apply(page: Page, code: string) {
  await page.getByTestId('ac-gift-card-code').fill(code);
  await page.getByTestId('ac-gift-card-apply').click();
}

const section = (page: Page) => page.getByTestId('ac-gift-card');
const stateOf = (page: Page) => expect(section(page));
const giftError = (page: Page) => page.getByTestId('ac-gift-card-error');
const messageOf = (page: Page) => page.getByTestId('ac-gift-challenge-message');

async function challengeInfo(request: APIRequestContext): Promise<{ posts: number; gift: string }> {
  return (await request.get('/__harness/challenge')).json();
}

async function applyEntries(request: APIRequestContext) {
  return (await harnessLog(request)).filter((entry) => entry.method === 'POST' && entry.path.endsWith('/pay/gift-card'));
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  expect(found).not.toBeNull();
  return found!;
}

for (const surface of ['invoice', 'return'] as const) {
  test(`B1 completed on the ${surface} page: loading, checking, then applied; the proof is not left anywhere`, async ({ page, request, context }) => {
    const seen: string[] = [];
    page.on('console', (message) => seen.push(message.text()));
    page.on('pageerror', (error) => seen.push(error.message));
    const hold = gate();
    const hits = await serveChallengeHost(page, surface, { hold });
    const proofRelease = gate();
    await page.route('**/pay/gift-card/challenge', async (route) => {
      await proofRelease.wait;
      await route.continue();
    });
    await openPay(page, surface);
    await apply(page, 'CHALLENGE');

    await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
    const panel = page.getByTestId('ac-gift-challenge');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('role', 'group');
    await expect(page.locator('#gift-challenge-intro')).toBeFocused();
    await expect(page.locator('#gift-challenge-intro')).toHaveText('To use this gift card, complete the verification below.');
    await expect(page.getByTestId('ac-gift-card-code')).toHaveAttribute('readonly', '');
    await expect(page.getByTestId('ac-gift-card-code')).toHaveValue('CHALLENGE');
    await expect(page.getByTestId('ac-gift-card-apply')).toBeDisabled();
    await expect(page.getByTestId('ac-gift-challenge-cancel')).toBeVisible();
    await expect(page.getByTestId('ac-gift-challenge-retry')).toBeHidden();
    await expect(page.locator(FRAME)).toHaveCount(1);

    hold.open();
    await stateOf(page).toHaveAttribute('data-challenge-state', 'checking');
    await expect(page.getByTestId('ac-gift-challenge-status')).toHaveText('Applying your gift card.');
    await expect(page.locator(FRAME)).toHaveCount(0);
    await expect(page.getByTestId('ac-gift-challenge-retry')).toBeHidden();
    await expect(page.getByTestId('ac-gift-challenge-cancel')).toBeHidden();
    await expect(page.getByTestId('ac-gift-card-apply')).toHaveAttribute('aria-busy', 'true');

    proofRelease.open();
    // The app answers with a redirect to the same page, which now shows the card and a notice.
    await expect(page.getByTestId('ac-gift-card-applied-1')).toContainText('Gift card ending 4821');
    await expect(page.getByTestId('ac-notice')).toHaveText('Gift card applied.');
    await expect(page.getByTestId('ac-notice')).toBeFocused();
    await expect(page.getByTestId('ac-gift-split')).toHaveText('Gift card: $25.00. Card or other payment: $95.00.');
    await expect(page.getByTestId('ac-pay-button')).toHaveText('Pay $95.00');
    expect(hits).toHaveLength(1);

    const posts = (await harnessLog(request)).filter((entry) => entry.method === 'POST' && entry.path.endsWith('/pay/gift-card/challenge'));
    expect(posts).toHaveLength(1);
    expect(Object.keys(posts[0]!.body as object).sort()).toEqual(['challenge_id', 'gift_card_code', 'proof']);
    const applies = await applyEntries(request);
    expect(applies).toHaveLength(1);
    expect(applies[0]!.actionId).toBeTruthy();

    const storage = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
    const cookies = JSON.stringify(await context.cookies());
    for (const place of [await page.content(), page.url(), storage, cookies, seen.join('\n')]) expect(place).not.toContain(FAKE_PROOF);
    for (const place of [await page.content(), storage, seen.join('\n')]) expect(place).not.toContain('/gift-card-challenge/');
  });
}

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
        const node = document.querySelector('[data-gift-pay]');
        if (!node) return;
        w.__states.push(node.getAttribute('data-challenge-state'));
        new MutationObserver(() => w.__states.push(node.getAttribute('data-challenge-state'))).observe(node, { attributes: true, attributeFilter: ['data-challenge-state'] });
      };
      watch();
    });
  });
  const hits = await serveChallengeHost(page);
  await openPay(page);
  await apply(page, 'CHALLENGEFAIL');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'failed');
  await expect(messageOf(page)).toHaveText("The verification didn't go through. Select Try again.");
  await expect(messageOf(page)).toBeFocused();
  await expect(page.locator(FRAME)).toHaveCount(0);
  await page.getByTestId('ac-gift-challenge-retry').click();
  await expect.poll(() => hits.length).toBe(2);
  await stateOf(page).toHaveAttribute('data-challenge-state', 'failed');
  await expect(page.getByTestId('ac-gift-challenge-retry')).toBeVisible();
  await page.getByTestId('ac-gift-challenge-retry').click();
  await expect.poll(() => hits.length).toBe(3);
  // The third frame fails: no failed panel and no Try again, straight to the unavailable message.
  await stateOf(page).toHaveAttribute('data-challenge-state', 'unavailable');
  await expect(page.getByTestId('ac-gift-challenge')).toBeHidden();
  await expect(page.getByTestId('ac-gift-challenge-retry')).toBeHidden();
  await expect(messageOf(page)).toBeHidden();
  await expect(giftError(page)).toHaveText("We can't check gift card codes right now. Try again later, or pay another way.");
  await expect(page.getByTestId('ac-gift-card-code')).toBeEnabled();
  await expect(page.getByTestId('ac-gift-card-code')).not.toHaveAttribute('readonly', '');
  await expect(page.getByTestId('ac-gift-card-code')).toHaveValue('CHALLENGEFAIL');
  await expect(page.getByTestId('ac-gift-card-code')).toBeFocused();
  await expect(page.getByTestId('ac-gift-card-code')).toHaveAttribute('aria-describedby', 'gift-card-error');
  await expect(page.getByTestId('ac-gift-card-apply')).toBeEnabled();
  expect(hits).toHaveLength(3);
  expect(await page.evaluate(() => (window as any).__frames)).toBe(3);
  const states: string[] = await page.evaluate(() => (window as any).__states);
  expect(states.filter((state) => state === 'failed')).toHaveLength(2);
  expect(states.slice(-2)).toEqual(['loading', 'unavailable']);
  expect((await applyEntries(request)).length).toBe(1);
  expect((await challengeInfo(request)).posts).toBe(0);
});

test('B2 mixed: a slow frame then two failed frames use the same cap of three', async ({ page, request }) => {
  await page.clock.install();
  const hits = await serveChallengeHost(page, 'invoice', { frames: ['silent', 'failed', 'failed'] });
  await openPay(page);
  await apply(page, 'CHALLENGESILENT');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
  await page.clock.fastForward(61_000);
  await stateOf(page).toHaveAttribute('data-challenge-state', 'slow');
  await page.getByTestId('ac-gift-challenge-retry').click();
  await expect.poll(() => hits.length).toBe(2);
  await stateOf(page).toHaveAttribute('data-challenge-state', 'failed');
  await page.getByTestId('ac-gift-challenge-retry').click();
  await expect.poll(() => hits.length).toBe(3);
  await stateOf(page).toHaveAttribute('data-challenge-state', 'unavailable');
  await expect(page.getByTestId('ac-gift-challenge')).toBeHidden();
  await expect(giftError(page)).toHaveText("We can't check gift card codes right now. Try again later, or pay another way.");
  await expect(page.getByTestId('ac-gift-card-code')).toBeFocused();
  expect(hits).toHaveLength(3);
  expect((await applyEntries(request)).length).toBe(1);
  expect((await challengeInfo(request)).posts).toBe(0);
});

test('B2 slow at the cap: Try again from the third slow frame ends in unavailable', async ({ page, request }) => {
  await page.clock.install();
  const hits = await serveChallengeHost(page);
  await openPay(page);
  await apply(page, 'CHALLENGESILENT');
  for (const frames of [1, 2, 3]) {
    await expect.poll(() => hits.length).toBe(frames);
    await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
    await page.clock.fastForward(61_000);
    await stateOf(page).toHaveAttribute('data-challenge-state', 'slow');
    await page.getByTestId('ac-gift-challenge-retry').click();
  }
  await stateOf(page).toHaveAttribute('data-challenge-state', 'unavailable');
  await expect(giftError(page)).toHaveText("We can't check gift card codes right now. Try again later, or pay another way.");
  await expect(page.getByTestId('ac-gift-challenge')).toBeHidden();
  expect(hits).toHaveLength(3);
  expect((await challengeInfo(request)).posts).toBe(0);
});

test('B3 the frame reports unavailable: panel closes and the field is ready again', async ({ page }) => {
  await serveChallengeHost(page);
  await openPay(page);
  await apply(page, 'CHALLENGEGONE');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'unavailable');
  await expect(page.getByTestId('ac-gift-challenge')).toBeHidden();
  await expect(giftError(page)).toHaveText("We can't check gift card codes right now. Try again later, or pay another way.");
  await expect(page.getByTestId('ac-gift-card-code')).toBeEnabled();
  await expect(page.getByTestId('ac-gift-card-code')).not.toHaveAttribute('readonly', '');
  await expect(page.getByTestId('ac-gift-card-code')).toHaveValue('CHALLENGEGONE');
  await expect(page.getByTestId('ac-gift-card-code')).toBeFocused();
  await expect(page.getByTestId('ac-gift-card-code')).toHaveAttribute('aria-describedby', 'gift-card-error');
  await expect(page.getByTestId('ac-gift-card-apply')).toBeEnabled();
});

test('B4 a silent frame shows slow copy and Try again after 60 seconds and keeps the same frame', async ({ page }) => {
  await page.clock.install();
  await serveChallengeHost(page);
  await openPay(page);
  await apply(page, 'CHALLENGESILENT');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
  const frame = await page.locator(FRAME).elementHandle();
  await expect(page.getByTestId('ac-gift-challenge-retry')).toBeHidden();
  await page.clock.fastForward(59_000);
  await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
  await page.clock.fastForward(2_000);
  await stateOf(page).toHaveAttribute('data-challenge-state', 'slow');
  await expect(page.getByTestId('ac-gift-challenge-status')).toHaveText('The verification is taking longer than usual. Select Try again to reload it.');
  await expect(page.getByTestId('ac-gift-challenge-retry')).toBeVisible();
  expect(await frame!.evaluate((node) => node.isConnected)).toBe(true);
  await expect(page.locator(FRAME)).toHaveCount(1);
});

test('the check expires on its own timer and Try again applies the same code again', async ({ page, request }) => {
  await page.clock.install();
  await serveChallengeHost(page);
  await openPay(page);
  await apply(page, 'CHALLENGESHORT');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
  await page.clock.fastForward(121_000);
  await stateOf(page).toHaveAttribute('data-challenge-state', 'expired');
  await expect(messageOf(page)).toHaveText('The verification expired before your gift card was applied. Select Try again.');
  await expect(messageOf(page)).toBeFocused();
  await expect(page.locator(FRAME)).toHaveCount(0);
  expect(await applyEntries(request)).toHaveLength(1);
  await page.getByTestId('ac-gift-challenge-retry').click();
  // No fresh view is held, so this is a new Apply with the same code and a new action ID.
  await expect.poll(async () => (await applyEntries(request)).length).toBe(2);
  const [first, second] = await applyEntries(request);
  expect(second!.actionId).not.toBe(first!.actionId);
  await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
  await expect(page.locator(FRAME)).toHaveCount(1);
});

test.describe('B5 messages that must be ignored', () => {
  const valid = { type: 'flint.gift_card_challenge.completed', checkout_session_id: sessionIdFor('invoice'), proof: FAKE_PROOF, expires_at: '2026-10-08T12:15:00Z' };

  test('a message from the main page', async ({ page, request }) => {
    await serveChallengeHost(page);
    await openPay(page);
    await apply(page, 'CHALLENGESILENT');
    await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
    await page.evaluate((message) => window.postMessage(message, '*'), valid);
    await page.waitForTimeout(400);
    await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
    expect((await challengeInfo(request)).posts).toBe(0);
  });

  test('a message from a second frame on the same challenge origin', async ({ page, request }) => {
    const hits = await serveChallengeHost(page);
    await openPay(page);
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
    expect((await challengeInfo(request)).posts).toBe(0);
  });

  test('a message from the real frame for a different checkout', async ({ page, request }) => {
    const hits = await serveChallengeHost(page);
    await openPay(page);
    await apply(page, 'CHALLENGEWRONG');
    await expect.poll(() => hits.length).toBe(1);
    await page.waitForTimeout(400);
    await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
    await expect(page.locator(FRAME)).toHaveCount(1);
    expect((await challengeInfo(request)).posts).toBe(0);
  });

  test('noise from the real frame before the valid answer: only the valid answer counts', async ({ page, request }) => {
    await serveChallengeHost(page);
    await openPay(page);
    await apply(page, 'CHALLENGESPOOF');
    await expect(page.getByTestId('ac-gift-card-applied-1')).toContainText('Gift card ending 4821');
    expect((await challengeInfo(request)).posts).toBe(1);
  });
});

test('B6 two valid answers send exactly one proof', async ({ page, request }) => {
  await serveChallengeHost(page);
  await openPay(page);
  await apply(page, 'CHALLENGEDOUBLE');
  await expect(page.getByTestId('ac-gift-card-applied-1')).toContainText('Gift card ending 4821');
  await page.waitForTimeout(300);
  expect((await challengeInfo(request)).posts).toBe(1);
});

test('B7 Cancel and Escape leave without any request and return to the field', async ({ page, request }) => {
  await serveChallengeHost(page);
  await openPay(page);
  await apply(page, 'CHALLENGESILENT');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
  await page.getByTestId('ac-gift-challenge-cancel').click();
  await stateOf(page).toHaveAttribute('data-challenge-state', 'none');
  await expect(page.getByTestId('ac-gift-challenge')).toBeHidden();
  await expect(page.locator(FRAME)).toHaveCount(0);
  await expect(page.getByTestId('ac-gift-card-apply')).toBeEnabled();
  await expect(page.getByTestId('ac-gift-card-code')).toBeFocused();
  await expect(page.getByTestId('ac-gift-card-code')).toHaveValue('CHALLENGESILENT');

  await page.getByTestId('ac-gift-card-apply').click();
  await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
  await expect(page.locator('#gift-challenge-intro')).toBeFocused();
  await page.keyboard.press('Escape');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'none');
  await expect(page.getByTestId('ac-gift-card-code')).toBeFocused();
  expect((await challengeInfo(request)).posts).toBe(0);
  expect(await applyEntries(request)).toHaveLength(2);
});

test('B9 Flint rejects the proof: expired copy, then Try again opens the new check without another Apply', async ({ page, request }) => {
  const hits = await serveChallengeHost(page);
  await openPay(page);
  await apply(page, 'CHALLENGEREJECT');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'expired');
  await expect(messageOf(page)).toHaveText('The verification expired before your gift card was applied. Select Try again.');
  await expect(messageOf(page)).toBeFocused();
  expect((await challengeInfo(request)).posts).toBe(1);
  expect(await applyEntries(request)).toHaveLength(1);
  await page.getByTestId('ac-gift-challenge-retry').click();
  await expect(page.getByTestId('ac-gift-card-applied-1')).toContainText('Gift card ending 4821');
  expect(hits).toHaveLength(2);
  expect(await applyEntries(request)).toHaveLength(1);
  expect((await challengeInfo(request)).posts).toBe(2);
});

test('B10 origin required, from the retry and from the first Apply: reload link and the code is kept', async ({ page }) => {
  await serveChallengeHost(page);
  await openPay(page);
  for (const code of ['CHALLENGEORIGIN', 'ORIGINAPPLY']) {
    await apply(page, code);
    await stateOf(page).toHaveAttribute('data-challenge-state', 'origin_required');
    await expect(giftError(page)).toHaveText('Reload this page to verify gift card codes, then apply the code again.');
    const link = page.getByTestId('ac-gift-card-reload');
    await expect(link).toBeVisible();
    await expect(link).toHaveText('Reload this page');
    await expect(link).toHaveAttribute('href', '/invoices/inv_example_001/pay');
    await expect(page.getByTestId('ac-gift-challenge')).toBeHidden();
    await expect(page.getByTestId('ac-gift-card-code')).toHaveValue(code);
    await expect(page.getByTestId('ac-gift-card-code')).toBeEnabled();
    await expect(page.getByTestId('ac-gift-card-code')).toBeFocused();
    await expect(page.getByTestId('ac-gift-card-apply')).toBeEnabled();
  }
});

test('B11 a frame address that is not exactly a Flint challenge page is never loaded', async ({ page, request }) => {
  const requested: string[] = [];
  page.on('request', (seen) => {
    if (/gift-card-challenge|evil\.example\.test/.test(seen.url())) requested.push(seen.url());
  });
  await serveChallengeHost(page);
  await openPay(page);
  for (const code of ['UNTRUSTEDHTTP', 'UNTRUSTEDHOST', 'UNTRUSTEDPATH', 'UNTRUSTEDQUERY']) {
    await apply(page, code);
    await stateOf(page).toHaveAttribute('data-challenge-state', 'unavailable');
    await expect(giftError(page)).toContainText("We can't check gift card codes right now.");
    await expect(page.locator(FRAME)).toHaveCount(0);
    await expect(page.getByTestId('ac-gift-challenge')).toBeHidden();
    await expect(page.getByTestId('ac-gift-card-code')).toBeEnabled();
  }
  expect(requested).toEqual([]);
  expect((await challengeInfo(request)).posts).toBe(0);
});

test('B12 the frame has the specified attributes and size, and the page policy allows it', async ({ page, request }) => {
  await serveChallengeHost(page);
  await openPay(page);
  await apply(page, 'CHALLENGESILENT');
  const frame = page.getByTestId('ac-gift-challenge-frame');
  await expect(frame).toHaveAttribute('src', `${CHALLENGE_ORIGIN}/gift-card-challenge/gccf_fake.silent`);
  await expect(frame).toHaveAttribute('title', 'Gift card verification');
  await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
  for (const name of ['sandbox', 'allow', 'name']) await expect(frame).not.toHaveAttribute(name, /.*/);
  const size = await box(frame);
  expect(size.width).toBeGreaterThanOrEqual(300);
  expect(size.height).toBe(65);
  const policy = (await request.get(payUrl('invoice', 'gift'))).headers()['content-security-policy'] ?? '';
  expect(policy).toContain(`frame-src https://js.stripe.com https://hooks.stripe.com https://*.stripe.com ${CHALLENGE_ORIGIN};`);
  expect(policy).not.toContain('*.withflintpay.com');
  expect(policy).toContain("frame-ancestors 'none'");
});

for (const viewport of [
  { width: 360, height: 800, frame: 302 },
  { width: 768, height: 1000, frame: 0 },
  { width: 1440, height: 1000, frame: 0 },
]) {
  test(`B13 layout at ${viewport.width} px: frame, buttons, and panel stay inside the gift card`, async ({ page }) => {
    await page.clock.install();
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await serveChallengeHost(page);
    await openPay(page);
    await apply(page, 'CHALLENGESILENT');
    await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
    const check = async () => {
      const gift = await box(section(page));
      const panel = await box(page.getByTestId('ac-gift-challenge'));
      expect(panel.x).toBeGreaterThanOrEqual(gift.x - 0.5);
      expect(panel.x + panel.width).toBeLessThanOrEqual(gift.x + gift.width + 0.5);
      expect(panel.y).toBeGreaterThanOrEqual(gift.y - 0.5);
      expect(panel.y + panel.height).toBeLessThanOrEqual(gift.y + gift.height + 0.5);
      const summary = await box(page.locator('aside.pay-summary'));
      const overlaps = panel.x < summary.x + summary.width && panel.x + panel.width > summary.x && panel.y < summary.y + summary.height && panel.y + panel.height > summary.y;
      expect(overlaps).toBe(false);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      for (const id of ['ac-gift-challenge-retry', 'ac-gift-challenge-cancel']) {
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
    await expect(page.getByTestId('ac-gift-challenge-retry')).toBeVisible();
    await check();
  });
}

test('B14 keyboard only: Tab reaches the frame, then Try again, then Cancel; Enter and Space activate', async ({ page }) => {
  await page.clock.install();
  const hits = await serveChallengeHost(page);
  await openPay(page);
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
  await expect(page.getByTestId('ac-gift-challenge-retry')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('ac-gift-challenge-cancel')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await expect.poll(() => hits.length).toBe(2);
  await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
  await expect(page.locator('#gift-challenge-intro')).toBeFocused();
  await expect(page.frameLocator(FRAME).locator('p')).toHaveText('Fake verification');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('ac-gift-challenge-cancel')).toBeFocused();
  await page.keyboard.press('Space');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'none');
  await expect(page.getByTestId('ac-gift-card-code')).toBeFocused();
});

test('B15 axe finds no serious or critical problems while loading, after a failure, and for a settlement', async ({ page }) => {
  await serveChallengeHost(page);
  await openPay(page);
  const scan = async (label: string) => {
    const results = await new AxeBuilder({ page }).exclude(FRAME).analyze();
    const bad = results.violations.filter((violation: any) => ['serious', 'critical'].includes(violation.impact));
    expect(bad.map((violation: any) => `${label}: ${violation.id}`)).toEqual([]);
  };
  await apply(page, 'CHALLENGESILENT');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
  await scan('loading');
  await page.getByTestId('ac-gift-challenge-cancel').click();
  await apply(page, 'CHALLENGEFAIL');
  await stateOf(page).toHaveAttribute('data-challenge-state', 'failed');
  await scan('failed');
  await page.goto(payUrl('invoice', 'gift_settlement'));
  await expect(page.getByTestId('ac-settlement-explanation')).toBeVisible();
  await scan('settlement');
});

test('B16 neither the page nor its embedded data holds a frame address before a check starts', async ({ page, request }) => {
  const html = await (await request.get(payUrl('invoice', 'gift'))).text();
  expect(html).not.toContain('/gift-card-challenge/');
  expect(html).not.toContain('gccf_');
  expect(html).not.toContain(sessionIdFor('invoice'));
  expect(html).not.toMatch(/<iframe/);
  await serveChallengeHost(page);
  await openPay(page);
  const boot = JSON.parse((await page.locator('#gift-pay-boot').textContent()) ?? '{}');
  expect(boot.challenge).toEqual({ origin: CHALLENGE_ORIGIN, slow_after_ms: 60000, max_mounts: 3 });
  expect(boot.endpoints).toEqual({
    apply: '/invoices/inv_example_001/pay/gift-card',
    challenge: '/invoices/inv_example_001/pay/gift-card/challenge',
    page: '/invoices/inv_example_001/pay',
  });
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.getByTestId('ac-gift-challenge')).toBeHidden();
  await expect(page.getByTestId('ac-gift-challenge-host')).toBeEmpty();
});

test('the browser module computes the pinned session tag vector', async ({ page }) => {
  await page.goto(payUrl('invoice', 'gift'));
  const tag = await page.evaluate(async () => {
    const path = '/js/gift-challenge.js';
    const module = await import(path);
    return module.sessionTagFor('gch_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'cs_PLACEHOLDER_PINNED_VECTOR');
  });
  expect(tag).toBe('CGZN0PgNBeNrKsatRzXixdZjmjeaolCFm462W42PkeU');
});

test.describe('B17 settlement and split', () => {
  for (const surface of ['invoice', 'return'] as const) {
    test(`gift cards cover the ${surface} balance: no payment form, explanation, Confirm payment, no credential`, async ({ page, request }) => {
      const requested: string[] = [];
      page.on('request', (seen) => requested.push(seen.url()));
      await openPay(page, surface, 'gift_settlement');
      await expect(page.getByTestId('ac-payment')).toHaveAttribute('data-state', 'ready');
      await expect(page.getByTestId('ac-payment-element')).toBeHidden();
      await expect(page.getByTestId('ac-wallets')).toBeHidden();
      await expect(page.locator('[data-saved-methods]')).toBeHidden();
      await expect(page.getByTestId('ac-settlement-explanation')).toHaveText(
        surface === 'invoice'
          ? 'Your gift card covers this invoice. $120.00 will come off your gift card balance.'
          : 'Your gift card covers this balance. $120.00 will come off your gift card balance.',
      );
      const pay = page.getByTestId('ac-pay-button');
      await expect(pay).toHaveText('Confirm payment');
      await expect(pay).toBeEnabled();
      await expect(page.getByTestId('ac-pay-blocker')).toHaveText('');
      await expect(page.getByTestId('ac-gift-card-applied-1')).toContainText('Applied $120.00');
      expect(requested.filter((url) => url.startsWith('https://js.stripe.com'))).toEqual([]);
      expect(await page.evaluate(() => Boolean((window as any).__stripeStub))).toBe(false);

      await pay.click();
      await expect(page.getByTestId('harness-complete')).toBeVisible();
      const submits = (await harnessLog(request)).filter((entry) => entry.method === 'POST' && entry.path.endsWith('/pay/submit'));
      expect(submits).toHaveLength(1);
      expect(submits[0]!.body).toEqual({
        approved_outstanding_money: { amount: '12000', currency: 'USD' },
        approved_collection_kind: 'settlement',
        approved_order_revision: 'rev_example_3',
        approved_gift_card_money: { amount: '12000', currency: 'USD' },
      });
    });
  }

  test('a gift card that covers part: Elements collects the rest, both amounts show, and the approvals are sent', async ({ page, request }) => {
    await openPay(page, 'invoice', 'gift_split');
    const calls = await stubCalls(page);
    expect(calls.elements[0]).toMatchObject({ mode: 'payment', amount: 9500, currency: 'usd' });
    await expect(page.getByTestId('ac-gift-split')).toHaveText('Gift card: $25.00. Card or other payment: $95.00.');
    await expect(page.getByTestId('ac-gift-card-applied-1')).toContainText('Gift card ending 4821');
    await expect(page.getByTestId('ac-gift-card-applied-1')).toContainText('Applied $25.00');
    await expect(page.getByTestId('ac-settlement-explanation')).toBeHidden();
    const pay = page.getByTestId('ac-pay-button');
    await expect(pay).toHaveText('Pay $95.00');
    await page.getByTestId('stub-card').fill('4242');
    await expect(pay).toBeEnabled();
    await pay.click();
    await expect(page.getByTestId('harness-complete')).toBeVisible();
    const submits = (await harnessLog(request)).filter((entry) => entry.method === 'POST' && entry.path.endsWith('/pay/submit'));
    expect(submits[0]!.body).toEqual({
      credential: { kind: 'confirmation_token', value: 'ctoken_stub_1' },
      approved_outstanding_money: { amount: '12000', currency: 'USD' },
      approved_collection_kind: 'processor',
      approved_order_revision: 'rev_example_3',
      approved_gift_card_money: { amount: '2500', currency: 'USD' },
    });
  });

  test('a changed gift card balance asks to check the amounts, in its own words', async ({ page }) => {
    await openPay(page, 'invoice', 'gift_changed');
    await expect(page.getByTestId('ac-payment-banner')).toHaveText('Your gift card balance changed. Check the amounts, then confirm.');
  });
});

test.describe('the gift card section', () => {
  test('is absent when the order takes no gift cards', async ({ page }) => {
    await installStripeStub(page);
    await page.goto(payUrl('invoice', 'default'));
    await expect(page.getByTestId('ac-payment')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByTestId('ac-gift-card')).toHaveCount(0);
    await expect(page.locator('#gift-pay-boot')).toHaveCount(0);
  });

  test('shows applied cards without edit controls when cards can no longer change', async ({ page }) => {
    await openPay(page, 'invoice', 'gift_locked');
    await expect(page.getByTestId('ac-gift-card-applied-1')).toContainText('Gift card ending 4821');
    await expect(page.getByTestId('ac-gift-card-form')).toHaveCount(0);
    await expect(page.getByTestId('ac-gift-card-remove-1')).toHaveCount(0);
  });

  test('Remove is a plain form with the page token and an action ID, and returns with a notice', async ({ page }) => {
    await openPay(page, 'invoice', 'gift_split');
    const remove = page.getByTestId('ac-gift-card-remove-1');
    await expect(remove).toHaveAttribute('method', 'post');
    await expect(remove).toHaveAttribute('action', '/invoices/inv_example_001/pay/gift-card/gc_example_001/remove');
    await expect(remove.locator('input[name="_csrf"]')).toHaveValue('csrf-example-token');
    await expect(remove.locator('input[name="_action_id"]')).not.toHaveValue('');
    await expect(remove.getByRole('button', { name: 'Remove gift card ending 4821' })).toBeVisible();
    await remove.getByRole('button').click();
    await expect(page.getByTestId('ac-notice')).toHaveText('Gift card removed.');
    await expect(page.getByTestId('ac-gift-card-applied-1')).toHaveCount(0);
  });

  test('an empty code asks for the code without any request', async ({ page, request }) => {
    await openPay(page);
    await page.getByTestId('ac-gift-card-apply').click();
    await expect(giftError(page)).toHaveText('Enter the gift card code.');
    await expect(page.getByTestId('ac-gift-card-code')).toBeFocused();
    expect(await applyEntries(request)).toHaveLength(0);
  });

  test('a code the app refuses shows the payment wording and keeps the code', async ({ page }) => {
    await openPay(page);
    await apply(page, 'BADCARD');
    await expect(giftError(page)).toHaveText("That gift card code isn't valid for this payment. Check the code and try again.");
    await expect(page.getByTestId('ac-gift-card-code')).toHaveValue('BADCARD');
    await expect(page.getByTestId('ac-gift-card-code')).toBeFocused();
  });

  test('a plain apply reloads the page with the card and a notice', async ({ page }) => {
    await openPay(page);
    await apply(page, 'GOODCARD');
    await expect(page.getByTestId('ac-gift-card-applied-1')).toContainText('Gift card ending 4821');
    await expect(page.getByTestId('ac-notice')).toBeFocused();
  });

  test('payment controls lock the gift card section and end an open check silently', async ({ page, request }) => {
    await resetHarness(request, { scenario: 'stuck_waiting' });
    await serveChallengeHost(page);
    await openPay(page);
    await apply(page, 'CHALLENGESILENT');
    await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
    await page.getByTestId('stub-card').fill('4242');
    await page.getByTestId('ac-pay-button').click();
    await expect(page.getByTestId('ac-payment')).toHaveAttribute('data-state', /waiting|submitting/);
    await stateOf(page).toHaveAttribute('data-challenge-state', 'none');
    await expect(page.getByTestId('ac-gift-challenge')).toBeHidden();
    await expect(page.locator(FRAME)).toHaveCount(0);
    await expect(page.getByTestId('ac-gift-card-apply')).toBeDisabled();
  });
});

test.describe('outcomes of the retry', () => {
  test('an unconfirmed result keeps the code, never sends the proof again, and the next Apply reuses its action ID', async ({ page, request }) => {
    await serveChallengeHost(page);
    await openPay(page);
    await apply(page, 'CHALLENGEUNKNOWN');
    await stateOf(page).toHaveAttribute('data-challenge-state', 'unconfirmed');
    await expect(giftError(page)).toHaveText("We couldn't confirm whether your gift card was applied. Select Apply to check.");
    await expect(page.getByTestId('ac-gift-card-code')).toHaveValue('CHALLENGEUNKNOWN');
    await expect(page.getByTestId('ac-gift-card-code')).toBeFocused();
    await expect(page.getByTestId('ac-gift-card-apply')).toBeEnabled();
    expect((await challengeInfo(request)).posts).toBe(1);
    await page.getByTestId('ac-gift-card-apply').click();
    await expect.poll(async () => (await applyEntries(request)).length).toBe(2);
    const [first, second] = await applyEntries(request);
    expect(second!.actionId).toBe(first!.actionId);
    // That Apply started a new check, which ends unconfirmed again. A different code is a different action.
    await expect.poll(async () => (await challengeInfo(request)).posts).toBe(2);
    await stateOf(page).toHaveAttribute('data-challenge-state', 'unconfirmed');
    await apply(page, 'GOODCARD');
    await expect(page.getByTestId('ac-gift-card-applied-1')).toBeVisible();
    const all = await applyEntries(request);
    expect(all[2]!.actionId).not.toBe(first!.actionId);
  });

  test('an Apply with an unknown outcome keeps its action ID through an empty field and another code, while the app holds the change', async ({ page, request }) => {
    await openPay(page);
    await apply(page, 'UNKNOWNAPPLY');
    await stateOf(page).toHaveAttribute('data-challenge-state', 'unconfirmed');
    await expect(giftError(page)).toHaveText("We couldn't confirm whether your gift card was applied. Select Apply to check.");
    await expect(page.getByTestId('ac-gift-card-code')).toHaveValue('UNKNOWNAPPLY');
    // An empty field and a different code leave the record alone. The app refuses the other code.
    await page.getByTestId('ac-gift-card-code').fill('');
    await page.getByTestId('ac-gift-card-apply').click();
    await expect(giftError(page)).toHaveText('Enter the gift card code.');
    await apply(page, 'GOODCARD');
    await expect(giftError(page)).toHaveText("We're still checking your last gift card change. Finish it first, then try again.");
    await apply(page, 'UNKNOWNAPPLY');
    await expect(page.getByTestId('ac-gift-card-applied-1')).toContainText('Gift card ending 4821');
    const applies = await applyEntries(request);
    expect(applies.map((entry) => (entry.body as { gift_card_code: string }).gift_card_code)).toEqual(['UNKNOWNAPPLY', 'GOODCARD', 'UNKNOWNAPPLY']);
    expect(applies[1]!.actionId).not.toBe(applies[0]!.actionId);
    expect(applies[2]!.actionId).toBe(applies[0]!.actionId);
  });

  test('a definite answer ends the reuse: the next Apply of that code gets a new action ID', async ({ page, request }) => {
    // The first check completes and its proof request is lost. The replay is answered with a new check.
    await serveChallengeHost(page, 'invoice', { frames: ['completed', 'silent', 'silent'] });
    await openPay(page);
    await apply(page, 'CHALLENGEUNKNOWN');
    await stateOf(page).toHaveAttribute('data-challenge-state', 'unconfirmed');
    await page.getByTestId('ac-gift-card-apply').click();
    await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
    await page.getByTestId('ac-gift-challenge-cancel').click();
    await page.getByTestId('ac-gift-card-apply').click();
    await stateOf(page).toHaveAttribute('data-challenge-state', 'loading');
    const ids = (await applyEntries(request)).map((entry) => entry.actionId);
    expect(ids).toHaveLength(3);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  test('the server says the check is gone: expired copy, no held view', async ({ page }) => {
    await serveChallengeHost(page);
    await openPay(page);
    await apply(page, 'CHALLENGEEXPIRED');
    await stateOf(page).toHaveAttribute('data-challenge-state', 'expired');
    await expect(messageOf(page)).toBeFocused();
  });

  test('Flint cannot run the check after the proof: unavailable copy', async ({ page }) => {
    await serveChallengeHost(page);
    await openPay(page);
    await apply(page, 'CHALLENGEUNAVAIL');
    await stateOf(page).toHaveAttribute('data-challenge-state', 'unavailable');
    await expect(giftError(page)).toContainText("We can't check gift card codes right now.");
    await expect(page.getByTestId('ac-gift-card-code')).toBeFocused();
  });

  test('the payment changed during the check: apply again, code kept', async ({ page }) => {
    await serveChallengeHost(page);
    await openPay(page);
    await apply(page, 'CHALLENGESTALE');
    await stateOf(page).toHaveAttribute('data-challenge-state', 'none');
    await expect(giftError(page)).toHaveText('This payment changed. Apply the gift card again.');
    await expect(page.getByTestId('ac-gift-card-code')).toHaveValue('CHALLENGESTALE');
    await expect(page.getByTestId('ac-gift-card-code')).toBeFocused();
  });

  test('a code Flint refuses after the check shows the payment wording', async ({ page }) => {
    await serveChallengeHost(page);
    await openPay(page);
    await apply(page, 'CHALLENGEREFUSED');
    await expect(giftError(page)).toHaveText("That gift card code isn't valid for this payment. Check the code and try again.");
    await stateOf(page).toHaveAttribute('data-challenge-state', 'none');
    await expect(page.getByTestId('ac-gift-card-code')).toHaveValue('CHALLENGEREFUSED');
  });

  test('no check is possible: the app says so and the field stays usable', async ({ page }) => {
    await serveChallengeHost(page);
    await openPay(page);
    await apply(page, 'NOCHECK');
    await stateOf(page).toHaveAttribute('data-challenge-state', 'unavailable');
    await expect(giftError(page)).toHaveText("We can't check gift card codes right now. Try again later, or pay another way.");
    await expect(page.getByTestId('ac-gift-card-apply')).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// Recovery after an apply or a remove whose outcome is unknown, including after a reload.
// The fake app holds the change the way the real one does: matched by code or card, never by action ID.
// ---------------------------------------------------------------------------

const PAY_PAGE = '/invoices/inv_example_001/pay';
const UNCONFIRMED_APPLY = "We couldn't confirm whether your last gift card was applied. Enter the same code and select Apply to check. If you don't have the code, come back in 10 minutes.";
const UNCONFIRMED_REMOVE = "We couldn't confirm whether the gift card ending 4821 was removed. Select Check again.";
const notice = (page: Page) => page.getByTestId('ac-gift-unconfirmed');

/** Leaves an apply with an unknown outcome and reloads the page, as a buyer who closed the tab would. */
async function reloadAfterUnknownApply(page: Page, code = 'UNKNOWNAPPLY') {
  await openPay(page);
  await apply(page, code);
  await stateOf(page).toHaveAttribute('data-challenge-state', 'unconfirmed');
  await page.goto(PAY_PAGE);
  await expect(notice(page)).toBeVisible();
}

test.describe('GU recovery', () => {
  test('GU1 apply unknown, then reload: the note, an empty enabled field, no remove forms', async ({ page }) => {
    await reloadAfterUnknownApply(page);
    await expect(notice(page)).toHaveText(UNCONFIRMED_APPLY);
    await expect(notice(page)).toBeFocused();
    await expect(notice(page)).toHaveAttribute('tabindex', '-1');
    await expect(notice(page)).not.toHaveAttribute('role', /.*/);
    await expect(page.getByTestId('ac-gift-card')).toBeVisible();
    await expect(page.getByTestId('ac-gift-card-code')).toHaveValue('');
    await expect(page.getByTestId('ac-gift-card-code')).toBeEnabled();
    await expect(page.getByTestId('ac-gift-card-code')).toHaveAttribute('aria-describedby', 'gift-unconfirmed gift-card-error');
    await expect(page.getByTestId('ac-gift-card-apply')).toBeEnabled();
    await expect(page.getByTestId('ac-gift-card-recheck')).toHaveCount(0);
    await expect(page.locator('[data-testid^="ac-gift-card-remove-"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="ac-gift-card-applied-"]')).toHaveCount(0);
    await stateOf(page).toHaveAttribute('data-challenge-state', 'none');
  });

  test('GU2 the same code settles it: the page reloads with the notice and no recovery note', async ({ page }) => {
    await reloadAfterUnknownApply(page);
    await apply(page, 'UNKNOWNAPPLY');
    await expect(page.getByTestId('ac-notice')).toHaveText('Gift card applied.');
    await expect(page.getByTestId('ac-notice')).toBeFocused();
    await expect(notice(page)).toHaveCount(0);
    await expect(page.getByTestId('ac-gift-card-applied-1')).toContainText('Gift card ending 4821');
  });

  test('GU3 a different code is refused in the field, and the note stays', async ({ page }) => {
    await reloadAfterUnknownApply(page);
    await apply(page, 'GOODCARD');
    await expect(giftError(page)).toHaveText("We're still checking your last gift card change. Finish it first, then try again.");
    await expect(page.getByTestId('ac-gift-card-code')).toHaveValue('GOODCARD');
    await expect(page.getByTestId('ac-gift-card-code')).toBeFocused();
    await expect(page.getByTestId('ac-gift-card-code')).toHaveAttribute('aria-describedby', 'gift-unconfirmed gift-card-error');
    await expect(notice(page)).toHaveText(UNCONFIRMED_APPLY);
    await stateOf(page).toHaveAttribute('data-challenge-state', 'none');
    await expect(page.getByTestId('ac-gift-challenge')).toBeHidden();
  });

  test('GU4 the same code is challenged: the check runs and ends applied', async ({ page }) => {
    await serveChallengeHost(page);
    await reloadAfterUnknownApply(page, 'UNKNOWNCHALLENGE');
    await apply(page, 'UNKNOWNCHALLENGE');
    await expect(page.getByTestId('ac-gift-card-applied-1')).toContainText('Gift card ending 4821');
    await expect(page.getByTestId('ac-notice')).toHaveText('Gift card applied.');
    await expect(notice(page)).toHaveCount(0);
  });

  test('GU5 remove unknown: the note names the card and Check again ends with the removed notice', async ({ page, request }) => {
    await resetHarness(request, { scenario: 'success', removeUnknown: true });
    await openPay(page, 'invoice', 'gift_split');
    await page.getByTestId('ac-gift-card-remove-1').getByRole('button').click();
    // The page returns without an error message of its own: the note says what is unresolved.
    await expect(notice(page)).toHaveText(UNCONFIRMED_REMOVE);
    await expect(page.getByTestId('ac-notice')).toHaveCount(0);
    await expect(page.locator('[role="alert"]:visible')).toHaveCount(0);
    await expect(notice(page)).toBeFocused();
    const again = page.getByTestId('ac-gift-card-recheck');
    await expect(again).toBeVisible();
    await expect(again).toHaveText('Check again');
    await expect(again).toHaveAttribute('aria-label', 'Check again whether the gift card ending 4821 was removed');
    await expect(page.getByTestId('ac-gift-card-recheck-form')).toHaveAttribute('action', '/invoices/inv_example_001/pay/gift-card/gc_example_001/remove');
    await expect(page.getByTestId('ac-gift-card-recheck-form').locator('input[name="_csrf"]')).toHaveValue('csrf-example-token');
    await expect(page.getByTestId('ac-gift-card-recheck-form').locator('input[name="_action_id"]')).not.toHaveValue('');
    await expect(page.getByTestId('ac-gift-card-applied-1')).toContainText('Gift card ending 4821');
    await expect(page.locator('[data-testid^="ac-gift-card-remove-"]')).toHaveCount(0);
    await expect(page.getByTestId('ac-gift-card-form')).toHaveCount(0);
    await again.click();
    await expect(page.getByTestId('ac-notice')).toHaveText('Gift card removed.');
    await expect(page.getByTestId('ac-notice')).toBeFocused();
    await expect(notice(page)).toHaveCount(0);
    await expect(page.getByTestId('ac-gift-card-applied-1')).toHaveCount(0);
  });

  test('GU5 a second activation of Check again sends nothing more', async ({ page, request }) => {
    await resetHarness(request, { scenario: 'success', removeUnknown: true });
    await openPay(page, 'invoice', 'gift_split');
    await page.getByTestId('ac-gift-card-remove-1').getByRole('button').click();
    await expect(notice(page)).toBeVisible();
    // The page's own handler runs first, so the document sees whether the second activation was stopped.
    const stopped = await page.getByTestId('ac-gift-card-recheck-form').evaluate((form) => {
      const f = form as HTMLFormElement;
      const seen: boolean[] = [];
      document.addEventListener('submit', (event) => seen.push(event.defaultPrevented));
      f.requestSubmit();
      const button = f.querySelector('button')!;
      const disabled = button.disabled && button.getAttribute('aria-disabled') === 'true';
      f.requestSubmit();
      return { seen, disabled };
    });
    expect(stopped).toEqual({ seen: [false, true], disabled: true });
    await expect(page.getByTestId('ac-notice')).toHaveText('Gift card removed.');
    const removes = (await harnessLog(request)).filter((entry) => entry.method === 'POST' && entry.path.endsWith('/gift-card/gc_example_001/remove'));
    expect(removes).toHaveLength(2);
  });

  test('GU5 without a card name the button and its name say Check again', async ({ page }) => {
    await installStripeStub(page);
    await page.goto(payUrl('invoice', 'gift_unconfirmed_remove_any'));
    await expect(notice(page)).toHaveText("We couldn't confirm whether your gift card was removed. Select Check again.");
    await expect(page.getByTestId('ac-gift-card-recheck')).toHaveAttribute('aria-label', 'Check again');
  });

  test.describe('without JavaScript', () => {
    test.use({ javaScriptEnabled: false });
    test('GU5 Check again is a plain form and still ends with the removed notice', async ({ page, request }) => {
      await resetHarness(request, { scenario: 'success', removeUnknown: true });
      await installStripeStub(page);
      await page.goto(payUrl('invoice', 'gift_split'));
      await page.getByTestId('ac-gift-card-remove-1').getByRole('button').click();
      await expect(notice(page)).toHaveText(UNCONFIRMED_REMOVE);
      await expect(page.getByTestId('ac-gift-card-recheck')).toBeVisible();
      await page.getByTestId('ac-gift-card-recheck').click();
      await expect(page.getByTestId('ac-notice')).toHaveText('Gift card removed.');
      await expect(notice(page)).toHaveCount(0);
    });
  });

  test('GU6 when the change cannot be checked yet: the wait text, no form, no Check again', async ({ page }) => {
    await installStripeStub(page);
    await page.goto(payUrl('invoice', 'gift_unconfirmed_wait'));
    await expect(notice(page)).toHaveText("We're still checking your last gift card change. Come back in 10 minutes.");
    await expect(page.getByTestId('ac-gift-card')).toBeVisible();
    await expect(page.getByTestId('ac-gift-card-form')).toHaveCount(0);
    await expect(page.getByTestId('ac-gift-card-recheck')).toHaveCount(0);
  });

  test('GU7 Pay while a change is unresolved shows the app wording in the payment message and stays', async ({ page }) => {
    await reloadAfterUnknownApply(page);
    await expect(page.getByTestId('ac-payment')).toHaveAttribute('data-state', 'ready');
    await page.getByTestId('stub-card').fill('4242');
    await page.getByTestId('ac-pay-button').click();
    await expect(page.getByTestId('ac-payment-message')).toHaveText("We're still checking your last gift card change. Finish it first, then try again.");
    await expect(page).toHaveURL(new RegExp(`${PAY_PAGE}$`));
    await expect(page.getByTestId('ac-payment')).toHaveAttribute('data-state', 'ready');
    await expect(notice(page)).toBeVisible();
  });

  for (const width of [320, 375, 768, 1280]) {
    for (const variant of ['gift_unconfirmed_apply', 'gift_unconfirmed_remove']) {
      test(`GU8 ${variant} at ${width} px: no overflow, the note wraps, Check again is whole and below it`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await installStripeStub(page);
        await page.goto(payUrl('invoice', variant));
        await expect(notice(page)).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        const gift = await box(section(page));
        const note = await box(notice(page));
        expect(note.x).toBeGreaterThanOrEqual(gift.x);
        expect(note.x + note.width).toBeLessThanOrEqual(gift.x + gift.width + 0.5);
        expect(note.height).toBeGreaterThan(24);
        if (variant === 'gift_unconfirmed_remove') {
          const button = page.getByTestId('ac-gift-card-recheck');
          const size = await box(button);
          expect(size.y).toBeGreaterThanOrEqual(note.y + note.height - 0.5);
          expect(size.x).toBeGreaterThanOrEqual(gift.x);
          expect(size.x + size.width).toBeLessThanOrEqual(width);
          expect(size.width).toBeGreaterThanOrEqual(44);
          expect(size.height).toBeGreaterThanOrEqual(44);
          expect(await button.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        }
        if (width < 400) {
          const padding = await section(page).evaluate((node) => getComputedStyle(node).paddingLeft);
          expect(padding).toBe('12px');
        }
      });
    }
  }

  test('GU9 keyboard: Tab from the note reaches Check again or the code field; Enter and Space activate', async ({ page, request }) => {
    await installStripeStub(page);
    for (const key of ['Enter', 'Space']) {
      await resetHarness(request, { scenario: 'success', removeUnknown: true });
      await page.goto(payUrl('invoice', 'gift_split'));
      await page.getByTestId('ac-gift-card-remove-1').getByRole('button').click();
      await expect(notice(page)).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('ac-gift-card-recheck')).toBeFocused();
      await page.keyboard.press(key);
      await expect(page.getByTestId('ac-notice')).toHaveText('Gift card removed.');
    }
    await resetHarness(request, { scenario: 'success' });
    await page.goto(payUrl('invoice', 'gift_unconfirmed_apply'));
    await expect(notice(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('ac-gift-card-code')).toBeFocused();
    await page.keyboard.type('GOODCARD');
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('ac-gift-card-apply')).toBeFocused();
  });

  test('GU9 axe finds no serious or critical problems in the apply and remove recovery states', async ({ page }) => {
    await installStripeStub(page);
    for (const variant of ['gift_unconfirmed_apply', 'gift_unconfirmed_remove', 'gift_unconfirmed_wait']) {
      await page.goto(payUrl('invoice', variant));
      await expect(notice(page)).toBeVisible();
      const results = await new AxeBuilder({ page }).analyze();
      const bad = results.violations.filter((violation: any) => ['serious', 'critical'].includes(violation.impact));
      expect(bad.map((violation: any) => `${variant}: ${violation.id}`)).toEqual([]);
    }
  });

  test('GU10 after a reload nothing holds the code, a hash, a key, or the stored revision', async ({ page, request, context }) => {
    const seen: string[] = [];
    page.on('console', (message) => seen.push(message.text()));
    page.on('pageerror', (error) => seen.push(error.message));
    await reloadAfterUnknownApply(page);
    const keys = (await applyEntries(request)).map((entry) => entry.actionId ?? '');
    expect(keys[0]).toBeTruthy();
    const storage = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
    const cookies = JSON.stringify(await context.cookies());
    const html = await page.content();
    for (const place of [html, page.url(), storage, cookies, seen.join('\n')]) {
      for (const secret of ['UNKNOWNAPPLY', 'code_hash', 'idempotency_key', 'rev_stored', ...keys]) expect(place).not.toContain(secret);
    }
    expect(await page.getByTestId('ac-gift-card-code').inputValue()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// A proxy answers with its own page (not the app's JSON). requestJson returns a null body for it, so
// the page cannot know whether the change happened. It must say so, keep the action ID, and leave the
// settling to the app, which holds the change and matches the same code again.
// ---------------------------------------------------------------------------

const COULD_NOT_CONFIRM = "We couldn't confirm whether your gift card was applied. Select Apply to check.";

test.describe('a proxy error page instead of the app answer', () => {
  for (const status of [502, 503]) {
    test(`apply answered ${status}: unconfirmed copy, same action ID on the next Apply, and the app settles it`, async ({ page, request }) => {
      await openPay(page);
      await apply(page, `PROXYAPPLY${status}`);
      await stateOf(page).toHaveAttribute('data-challenge-state', 'unconfirmed');
      await expect(giftError(page)).toHaveText(COULD_NOT_CONFIRM);
      await expect(page.getByTestId('ac-gift-card-code')).toHaveValue(`PROXYAPPLY${status}`);
      await expect(page.getByTestId('ac-gift-card-code')).toBeFocused();
      await expect(page.getByTestId('ac-gift-card-apply')).toBeEnabled();
      await expect(page.getByTestId('ac-gift-challenge')).toBeHidden();
      await page.getByTestId('ac-gift-card-apply').click();
      await expect(page.getByTestId('ac-gift-card-applied-1')).toContainText('Gift card ending 4821');
      const ids = (await applyEntries(request)).map((entry) => entry.actionId);
      expect(ids).toHaveLength(2);
      expect(ids[1]).toBe(ids[0]);
    });

    test(`apply answered ${status}, then a reload: the app's recovery note settles it with the same code`, async ({ page, request }) => {
      await openPay(page);
      await apply(page, `PROXYAPPLY${status}`);
      await stateOf(page).toHaveAttribute('data-challenge-state', 'unconfirmed');
      await page.goto(PAY_PAGE);
      await expect(notice(page)).toHaveText(UNCONFIRMED_APPLY);
      await apply(page, `PROXYAPPLY${status}`);
      await expect(page.getByTestId('ac-notice')).toHaveText('Gift card applied.');
      await expect(notice(page)).toHaveCount(0);
      const ids = (await applyEntries(request)).map((entry) => entry.actionId);
      // The page lost its in-memory ID with the reload. The app ignores the ID and matches the code.
      expect(ids).toHaveLength(2);
      expect(ids[1]).not.toBe(ids[0]);
    });

    test(`proof request answered ${status}: unconfirmed copy, the proof is not sent again, and the same action ID settles it`, async ({ page, request }) => {
      await serveChallengeHost(page);
      await openPay(page);
      await apply(page, `PROXYPROOF${status}`);
      await stateOf(page).toHaveAttribute('data-challenge-state', 'unconfirmed');
      await expect(giftError(page)).toHaveText(COULD_NOT_CONFIRM);
      await expect(page.getByTestId('ac-gift-card-code')).toHaveValue(`PROXYPROOF${status}`);
      await expect(page.getByTestId('ac-gift-card-code')).toBeFocused();
      await expect(page.getByTestId('ac-gift-challenge')).toBeHidden();
      await expect(page.locator(FRAME)).toHaveCount(0);
      expect((await challengeInfo(request)).posts).toBe(1);
      await page.getByTestId('ac-gift-card-apply').click();
      await expect(page.getByTestId('ac-gift-card-applied-1')).toContainText('Gift card ending 4821');
      const ids = (await applyEntries(request)).map((entry) => entry.actionId);
      expect(ids).toHaveLength(2);
      expect(ids[1]).toBe(ids[0]);
      expect((await challengeInfo(request)).posts).toBe(1);
    });
  }

  test('a non-JSON 4xx is not treated as unknown', async ({ page }) => {
    await openPay(page);
    await page.route('**/pay/gift-card', (route) => route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Not found</h1>' }));
    await apply(page, 'GOODCARD');
    await expect(giftError(page)).toHaveText('Something went wrong on our side. Try again.');
    await stateOf(page).toHaveAttribute('data-challenge-state', 'none');
  });
});
