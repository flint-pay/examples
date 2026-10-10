import { expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Config, Buyer, Sandbox } from './config.ts';
import type { Fixtures } from './fixtures.ts';
import type { Inbox, Mail } from './inbox.ts';
import { auditEmail, CHECKOUT_ORIGIN } from './email-links.ts';
import type { LinkClassification, LinkRole } from './email-links.ts';
import { CredentialScanner } from './credential-scan.ts';
import { BrowserGuard } from './flint-boundary.ts';
import { Operator } from './operator.ts';
import { equalMoney, money, assertOneCharge } from './money.ts';
import { invariant, HarnessError } from './safe.ts';
import { AuditFeeds,syncAppAudit } from './audit-feed.ts';

export type Checkout = { page: Page; ref: string; origin: string; sandbox: Sandbox; orderId: string; state: any };
export class Driver {
  contexts = new Map<string, BrowserContext>();
  guards = new Map<BrowserContext, BrowserGuard>();
  scanner: CredentialScanner;
  mails: { family: string; mail: Mail; buyer: Buyer; classifications: LinkClassification[] }[] = [];
  auditedRelays = new Map<string, LinkRole>();
  supportUrls = new Map<Sandbox, string | undefined>();
  created = new Map<string, string>();
  visitedAxeStates = new Set<string>();
  auditFeeds = new AuditFeeds();
  appMutations: { app: string; fingerprint: string; operation?: string; targetId?: string; keyHash?:string;authMode?:string;challengeProof?:boolean;timestamp: number; status?: number; resolvedAt?: number }[] = [];
  appResources: { app: string; id: string; type: string; created: boolean; customerId?: string; timestamp: number }[] = [];
  revocations: { app: string; sessionId?: string; customerId?: string }[] = [];
  readonly config: Config; readonly fixtures: Fixtures; readonly browser: Browser; readonly operator: Operator; readonly inbox?: Inbox;
  constructor(config: Config, fixtures: Fixtures, browser: Browser, operator: Operator, inbox?: Inbox) {
    this.config = config; this.fixtures = fixtures; this.browser = browser; this.operator = operator; this.inbox = inbox;
    this.scanner = new CredentialScanner([config.pins.A.key, config.pins.B.key, config.operatorPins.A.key, config.operatorPins.B.key]);
  }
  async page(role = 'guest', sandbox: Sandbox = 'A'): Promise<Page> {
    const key = `${sandbox}:${role}`;
    let context = this.contexts.get(key);
    if (!context) {
      context = await this.browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: false });
      const guard = new BrowserGuard(this.scanner, Object.values(this.config.origins), this.config.origins.accountA, this.auditedRelays);
      await guard.attach(context); this.contexts.set(key, context); this.guards.set(context, guard);
    }
    return context.pages()[0] ?? await context.newPage();
  }
  sf(sandbox: Sandbox = 'A'): string { return sandbox === 'A' ? this.config.origins.storefrontA : this.config.origins.storefrontB; }
  async goto(page: Page, origin: string, path: string): Promise<void> {
    invariant(path.startsWith('/') && !path.startsWith('//'), 'RELATIVE_PATH_REQUIRED');
    await page.goto(new URL(path, origin).href); await page.waitForLoadState('domcontentloaded');
    await this.auditKnownStates(page);
  }
  async csrf(page: Page): Promise<string> {
    // This is the merchant page's anti-CSRF value, never a Flint session credential.
    const value = await page.locator('meta[name="csrf-token"], input[name="_csrf"]').first().evaluate(e => e.getAttribute('content') ?? (e as HTMLInputElement).value);
    invariant(typeof value === 'string' && value.length > 0, 'CSRF_MARKUP_MISSING'); return value;
  }
  async job(page: Page, path: string, body?: any, options: { noCsrf?: boolean; action?: string; method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any }> {
    const origin = new URL(page.url()).origin;
    invariant(Object.values(this.config.origins).includes(origin) && path.startsWith('/') && !path.startsWith('//'), 'BFF_ORIGIN_REQUIRED');
    const token = options.noCsrf ? undefined : await this.csrf(page);
    const response = await page.evaluate(async ({ path, body, token, options }) => {
      const r = await fetch(path, { method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'Accept': 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { 'X-CSRF-Token': token } : {}), ...(options.action ? { 'X-Action-ID': options.action } : {}), ...(options.headers ?? {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await r.text(); let value; try { value = JSON.parse(text); } catch { value = null; }
      return { status: r.status, body: value };
    }, { path, body, token, options });
    const state = response.body?.state;
    if (state?.order?.order_id) await this.trackOrder(origin === this.sf('B') ? 'B' : 'A', state.order.order_id);
    return response;
  }
  async form(page: Page, action: string, values: Record<string, string> = {}): Promise<void> {
    const form = page.locator(`form[action="${action}"]:visible`).first();
    await expect(form).toBeVisible();
    for (const [name, value] of Object.entries(values)) {
      const input = form.locator(`[name="${name}"]`);
      const tag = await input.first().evaluate(e => e.tagName.toLowerCase());
      if (await input.first().getAttribute('type') === 'hidden') await expect(input.first()).toHaveValue(value);
      else if (tag === 'select') await input.selectOption(value); else await input.fill(value);
    }
    const submit = form.locator('button[type="submit"], input[type="submit"], button:not([type])').first();
    if (await form.getAttribute('data-job-form')) {
      await submit.click();
      await page.waitForLoadState('domcontentloaded');
    } else {
      // Arm the document wait before clicking, including a redirect back to the same URL.
      await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), submit.click()]);
    }
  }
  async login(page: Page, buyer: Buyer, at = this.config.origins.accountA): Promise<void> {
    const b = this.fixtures.buyers[buyer]; invariant(b, 'BUYER_CONFIGURATION_REQUIRED');
    await this.goto(page, at, '/sign-in');
    await this.form(page, '/sign-in', { email: b.email, password: b.password });
    invariant(!new URL(page.url()).pathname.startsWith('/sign-in') && !new URL(page.url()).pathname.startsWith('/verify-email'), 'BUYER_NOT_VERIFIED');
  }
  async signup(page: Page, buyer: Buyer, at = this.config.origins.accountA, next = '/'): Promise<void> {
    const b = this.fixtures.buyers[buyer];
    await this.goto(page, at, `/sign-up?next=${encodeURIComponent(next)}`);
    await this.form(page, '/sign-up', { name: 'Acceptance buyer', email: b.email, password: b.password });
    const after = new Date();
    await this.form(page, '/verify-email/send');
    const mail = await this.email(buyer, after, 'verification');
    invariant(mail.codes.length === 1, 'EMAIL_CODE_AMBIGUOUS');
    await this.form(page, '/verify-email/confirm', { code: mail.codes[0] });
    if (at === this.config.origins.accountA) await expect(page.getByTestId(next.startsWith('/orders/') ? 'ac-order' : 'ac-home')).toBeVisible();
    const sandbox = buyer === 'b1b' ? 'B' : 'A';
    const customers = await this.operator.clients.clients[sandbox].customers.list({ email: b.email });
    invariant(customers.data.length === 1, 'CUSTOMER_BINDING_AMBIGUOUS'); b.customerId = customers.data[0].customer_id; b.verified = true;
    await this.track(sandbox, 'customer', b.customerId, 'review');
  }
  async email(buyer: Buyer, after: Date, family: string): Promise<Mail> {
    invariant(this.inbox, 'INBOX_PREREQUISITE');
    const mail = await this.inbox.waitForEmail({ to: this.fixtures.buyers[buyer].email, after, subjectIncludes: this.fixtures.values.emailSubjects?.[family] });
    const sandbox = buyer === 'b1b' ? 'B' : 'A';
    if (!this.supportUrls.has(sandbox)) this.supportUrls.set(sandbox, (await this.operator.clients.clients[sandbox].merchants.get()).support_url);
    const classifications = auditEmail(mail, family, { appOrigins: Object.values(this.config.origins), apiOrigin: this.config.apiOrigin, checkoutOrigin: CHECKOUT_ORIGIN, merchantSupportUrl: this.supportUrls.get(sandbox) });
    for (let i = 0; i < mail.links.length; i++) if (['flint_account_link_relay', 'flint_email_preferences_relay'].includes(classifications[i].role)) this.auditedRelays.set(mail.links[i].href, classifications[i].role);
    this.mails.push({ family, mail, buyer, classifications }); return mail;
  }
  emailLink(mail: Mail, role: LinkRole): string {
    const entry = this.mails.find(m => m.mail === mail); invariant(entry, 'EMAIL_NOT_AUDITED');
    const index = entry.classifications.findIndex(c => c.role === role && c.verdict !== 'fail'); invariant(index >= 0 && mail.links[index], 'EMAIL_REQUIRED_LINK_MISSING'); return mail.links[index].href;
  }
  async track(sandbox: Sandbox, type: string, id: string, cleanup: string, reviewAt?: string, creationRequestId?: string): Promise<void> {
    if (this.operator.ledger.state.resources.some(r => r.sandbox === sandbox && r.resource === id && r.type === type)) return;
    const pin = this.config.pins[sandbox];
    await this.operator.ledger.record({ resource: id, type, mode: 'test', sandbox, merchant: pin.merchantId, sandboxId: pin.sandboxId, createdBy: this.config.run, purpose: 'acceptance', cleanup, creationRequestId, owner: 'headless e2e', reviewAt: reviewAt ?? new Date(Date.now() + 30 * 86400_000).toISOString(), owned: true });
  }
  requireOwned(sandbox: Sandbox, id: string): void { invariant(this.operator.ledger.state.resources.some(r => r.sandbox === sandbox && r.resource === id && r.owned), 'RUN_RESOURCE_AUTHORITY_REQUIRED'); }
  async observeResource(sandbox: Sandbox, type: string, id: string, cleanup: string, reviewAt: string, creationRequestId: string | undefined, created: boolean): Promise<void> {
    if (this.operator.ledger.state.resources.some(r => r.sandbox === sandbox && r.resource === id && r.type === type)) return;
    const pin = this.config.pins[sandbox];
    await this.operator.ledger.record({ resource: id, type, mode: 'test', sandbox, merchant: pin.merchantId, sandboxId: pin.sandboxId, createdBy: created ? this.config.run : 'preexisting-reference', purpose: created ? 'app-creation' : 'app-reference', cleanup, creationRequestId, owner: created ? 'headless e2e' : 'parent existing fixture owner', reviewAt, owned: created });
  }
  async trackOrder(sandbox: Sandbox, id: string): Promise<any> {
    const order = await this.operator.clients.clients[sandbox].orders.get(id);
    await this.track(sandbox, 'order', id, 'review');
    for (const session of order.checkout_session_ids ?? []) await this.track(sandbox, 'checkout_session', session, 'checkout_session');
    for (const fulfillment of order.fulfillments ?? []) await this.track(sandbox, 'fulfillment', fulfillment.fulfillment_id, 'review');
    for (const line of order.line_items) await this.track(sandbox, 'order_line_item', line.order_line_item_id, 'review');
    if (order.active_payment_attempt?.order_payment_attempt_id) await this.track(sandbox, 'payment_attempt', order.active_payment_attempt.order_payment_attempt_id, 'review');
    for (const intent of order.payment_intent_ids ?? []) await this.track(sandbox, 'payment_intent', intent, 'review');
    if (order.subscription_id) await this.track(sandbox, 'subscription', order.subscription_id, 'subscription');
    if (order.customer_id) {
      const customer = await this.operator.clients.clients[sandbox].customers.get(order.customer_id);
      const role = Object.entries(this.fixtures.buyers).find(([, b]) => b.email === customer.email)?.[0] as Buyer | undefined;
      if (role) { this.fixtures.buyers[role].customerId = order.customer_id; await this.track(sandbox, 'customer', order.customer_id, 'review'); }
    }
    return order;
  }
  async cart(page: Page, slug = 'house-blend', sandbox: Sandbox = 'A', quantity = '1'): Promise<void> {
    await this.goto(page, this.sf(sandbox), `/products/${slug}`);
    await expect(page.getByTestId('sf-product')).toBeVisible();
    await page.getByTestId('sf-quantity').fill(quantity);
    const variants = page.locator('[data-testid^="sf-variant-"]');
    if (await variants.count()) await variants.first().check();
    await page.getByTestId('sf-add-to-cart').click();
    await expect(page.getByTestId('sf-add-status')).toHaveText('Added to cart');
    await this.goto(page, this.sf(sandbox), '/cart');
    await expect(page.getByTestId('sf-cart')).toBeVisible();
  }
  async checkout(page: Page, slug = 'house-blend', sandbox: Sandbox = 'A', buyer: Buyer = 'b1'): Promise<Checkout> {
    await this.cart(page, slug, sandbox);
    await page.getByTestId('sf-checkout-start').click();
    await page.waitForURL(/\/checkout\/[^/]+$/);
    const ref = new URL(page.url()).pathname.split('/')[2];
    const c: Checkout = { page, ref, sandbox, origin: this.sf(sandbox), orderId: '', state: null };
    await this.state(c);
    await page.getByTestId('sf-contact-name').fill('Acceptance buyer');
    const email = page.getByTestId('sf-contact-email');
    if (await email.isEditable()) { await email.fill(this.fixtures.buyers[buyer].email); await email.blur(); }
    return c;
  }
  async state(c: Checkout): Promise<any> {
    const response = await this.job(c.page, `/checkout/${c.ref}/state`);
    invariant(response.status === 200 && response.body?.state?.order?.order_id, 'CHECKOUT_STATE_INVALID');
    c.state = response.body.state; c.orderId = c.state.order.order_id; return c.state;
  }
  async registerGiftChallenge(page:Page,orderId:string,origin:string):Promise<string>{
    await syncAppAudit(this);const url=await this.operator.challengeUrlFor(orderId,origin);
    const guard=this.guards.get(page.context());invariant(guard,'BROWSER_GUARD_REQUIRED');guard.allowGiftChallenge(url);return url;
  }
  async applyGift(c:Checkout,giftCardCode:string):Promise<void>{
    await this.registerGiftChallenge(c.page,c.orderId,c.origin);
    const before=c.state.order.gift_cards?.length??0;
    await c.page.getByTestId('sf-gift-card-code').fill(giftCardCode);await c.page.getByTestId('sf-gift-card-apply').click();
    await expect.poll(async()=>{const state=await this.state(c);return state.order.gift_cards?.length??0;},{timeout:60000}).toBeGreaterThan(before);
    const panel=c.page.locator('[data-challenge-state]');if(await panel.count())await expect(panel.first()).toHaveAttribute('data-challenge-state','none',{timeout:60000});
  }
  async delivery(c: Checkout, pickup = false): Promise<void> {
    if (!c.state.session.delivery_selection_required && !await c.page.getByTestId('sf-delivery').isVisible()) return;
    if (pickup) {
      await c.page.getByTestId('sf-delivery-mode-pickup').check();
      const form = c.page.locator(`form[action="/checkout/${c.ref}/pickup-locations"]`);
      await form.locator('[name="postal_code"]').fill(process.env.E2E_PICKUP_POSTAL_CODE ?? '78701');
      await c.page.getByTestId('sf-pickup-search').click();
    } else {
      // Mode radios render only for multiple delivery modes; a ship-only checkout has none.
      const shipMode = c.page.getByTestId('sf-delivery-mode-ship');
      if (await shipMode.count() && await shipMode.isVisible()) await shipMode.check();
      else await expect(c.page.getByTestId('sf-delivery')).toHaveAttribute('data-mode', 'ship');
      // A ready quote (e.g. the automatic requote after session replacement) already shows its options; only request one when absent.
      const ready = c.page.getByTestId('sf-delivery-options');
      const hasReady = await ready.isVisible() && await ready.locator('[data-testid^="sf-delivery-option-"]').count() > 0;
      if (!hasReady) {
        const address = this.fixtures.values.shippingAddress;
        invariant(address, 'DELIVERY_FIXTURE_REQUIRED');
        const form = c.page.locator(`form[action="/checkout/${c.ref}/delivery/quote"]`);
        for (const [name, value] of Object.entries(address)) {
          const input = form.locator(`[name="${name}"]`);
          if (!await input.count()) continue;
          if (await input.first().getAttribute('type') === 'hidden') await expect(input.first()).toHaveValue(String(value));
          else await input.first().fill(String(value));
        }
        await c.page.getByTestId('sf-delivery-quote').click();
      }
    }
    const option = c.page.locator(pickup ? '[data-testid^="sf-pickup-location-"]' : '[data-testid^="sf-delivery-option-"]').first();
    await expect(option).toBeVisible({ timeout: 30_000 });
    if (pickup) {
      await option.check();
      // Pickup is data-no-autosubmit and needs its explicit select.
      await c.page.getByTestId('sf-pickup-select').click();
    } else {
      // checkout.js autosubmits only a single-group shipping selection; multiple groups need a choice in each, then an explicit submit.
      const form = c.page.getByTestId('sf-delivery-options');
      const groups = form.locator('fieldset[data-group-id]');
      const count = await groups.count();
      invariant(count > 0, 'DELIVERY_GROUPS_REQUIRED');
      for (let i = 0; i < count; i++) {
        const first = groups.nth(i).locator('input[type="radio"]').first();
        invariant(await first.count() > 0, 'DELIVERY_GROUP_OPTIONS_REQUIRED');
        await first.check();
      }
      if (count > 1) await c.page.getByTestId('sf-delivery-choose').click();
    }
    await expect(c.page.getByTestId('sf-delivery-selected')).toBeVisible({ timeout: 30_000 });
    await this.state(c);
    await this.auditKnownStates(c.page);
  }
  async card(page: Page, number = '4242424242424242'): Promise<void> {
    let frame;
    for (let i = 0; i < 100 && !frame; i++) {
      for (const f of page.frames()) if (await f.locator('#payment-numberInput').count()) { frame = f; break; }
      if (!frame) await page.waitForTimeout(100);
    }
    invariant(frame, 'STRIPE_CARD_FRAME_MISSING');
    for (const [selector, value] of [['#payment-numberInput', number], ['#payment-expiryInput', '1230'], ['#payment-cvcInput', '123']]) {
      const input = frame.locator(selector); await input.fill(''); await input.pressSequentially(value, { delay: 15 });
    }
    const postal = frame.locator('#payment-postalCodeInput'); if (await postal.count()) await postal.fill('78701');
  }
  async challenge(page: Page, outcome: 'success' | 'fail'): Promise<void> {
    for (let i = 0; i < 300; i++) {
      for (const frame of page.frames()) {
        let url: URL; try { url = new URL(frame.url()); } catch { continue; }
        if (url.protocol !== 'https:' || url.username || url.password || url.port || !(url.hostname === 'stripe.com' || url.hostname.endsWith('.stripe.com'))) continue;
        const button = frame.getByRole('button', { name: outcome === 'success' ? /^(?:Complete authentication|Complete)$/i : /^(?:Fail authentication|Fail)$/i });
        if (await button.isVisible()) { await this.auditKnownStates(page); await button.click(); return; }
      }
      await page.waitForTimeout(100);
    }
    throw new HarnessError('PROVIDER_CHALLENGE_CONTROL_MISSING');
  }
  async pay(c: Checkout, number = '4242424242424242'): Promise<void> {
    await this.card(c.page, number); await expect(c.page.getByTestId('sf-pay-button')).toBeEnabled(); await c.page.getByTestId('sf-pay-button').click();
  }
  async settled(c: Checkout, attemptCount?: number): Promise<any> {
    await expect(c.page.getByTestId('sf-complete')).toHaveAttribute('data-state', 'paid', { timeout: 60_000 });
    const order = await this.trackOrder(c.sandbox, c.orderId);
    const attempts = await this.operator.clients.clients[c.sandbox].orders.listPaymentAttempts(c.orderId);
    assertOneCharge(order as any, attempts.data as any[]);
    const ids = new Set(attempts.data.flatMap(a => a.payment_intents ?? []).filter(p => p.status === 'succeeded').map(p => p.payment_intent_id));
    for (const id of ids) {
      const payment = await this.operator.clients.clients[c.sandbox].paymentIntents.get(id);
      invariant(payment.status === 'succeeded', 'AUTHORITATIVE_CHARGE_NOT_SUCCEEDED');
      const expected = c.state.order.gift_card_estimate?.processor_money ?? c.state.order.settlement_amounts.outstanding_money;
      equalMoney(payment.captured_money, expected);
    }
    if (attemptCount !== undefined) invariant(attempts.data.length === attemptCount, 'ATTEMPT_COUNT_MISMATCH');
    return order;
  }
  async summary(c: Checkout): Promise<void> {
    const order = await this.operator.clients.clients[c.sandbox].orders.get(c.orderId);
    for (const [hook, value] of [['sf-summary-total', order.pricing_amounts.total_money], ['sf-summary-tax', order.pricing_amounts.tax_money], ['sf-summary-outstanding', order.settlement_amounts.outstanding_money]] as const) {
      const locator = c.page.getByTestId(hook), m = money(value);
      await expect(locator).toHaveAttribute('data-amount-minor', m.amount); await expect(locator).toHaveAttribute('data-currency', m.currency);
    }
  }
  async axe(page: Page, state: string): Promise<void> {
    for (const width of [390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      const results = await new AxeBuilder({ page }).analyze();
      invariant(!results.violations.some(v => ['serious', 'critical'].includes(v.impact ?? '')), 'AXE_SERIOUS_OR_CRITICAL');
    }
    this.visitedAxeStates.add(state);
  }
  async auditKnownStates(page: Page): Promise<void> {
    const ordinary: Record<string, string> = { 'sf-home': 'sf-home', 'sf-product': 'sf-product', 'ac-home': 'ac-home', 'ac-orders': 'ac-orders', 'ac-order': 'ac-order', 'ac-return': 'ac-return', 'ac-subscription': 'ac-subscription', 'ac-payment-methods': 'ac-payment-methods', 'ac-profile-email': 'ac-profile-email', 'sign-in': 'sign-in', 'sign-up': 'sign-up', 'verify-email': 'verify-email' };
    for (const [hook, state] of Object.entries(ordinary)) if (!this.visitedAxeStates.has(state) && await page.getByTestId(hook).isVisible()) await this.axe(page, state);
    const components: Record<string, Record<string, string>> = {
      'sf-cart': { filled: 'sf-cart-filled', empty: 'sf-cart-empty' },
      'sf-payment': { ready: 'sf-checkout-ready', declined: 'sf-checkout-declined', authenticating: 'sf-checkout-requires-action', bank_processing: 'sf-checkout-bank-processing', total_changed: 'sf-checkout-total-changed' },
      'sf-complete': { paid: 'sf-complete-paid', bank_processing: 'sf-complete-processing' },
      'ac-payment': { ready: 'ac-invoice-pay-ready', declined: 'ac-invoice-pay-declined' },
      'ac-email-preferences': { 'token-confirm': 'ac-email-preferences-token' },
    };
    for (const [hook, states] of Object.entries(components)) {
      const target = page.getByTestId(hook); if (!await target.isVisible()) continue;
      const label = states[await target.getAttribute('data-state') ?? ''];
      if (label && !this.visitedAxeStates.has(label)) await this.axe(page, label);
    }
  }
  async guardCheck(): Promise<void> { for (const [context, guard] of this.guards) { for (const page of context.pages()) await this.auditKnownStates(page); await guard.inspect(context); } }
  async close(): Promise<void> { for (const [context, guard] of this.guards) { guard.close(); await context.close(); } }
}
