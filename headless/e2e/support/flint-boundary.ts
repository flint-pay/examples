import type { BrowserContext, Page, Request } from '@playwright/test';
import { relayOrigin, relayPath, stripeOrigins } from './boundary-allowlist.ts';
import { CredentialScanner } from './credential-scan.ts';
import { accountRelayPath, preferenceRelayPath } from './email-links.ts';
import type { LinkRole } from './email-links.ts';
import { invariant, requestId } from './safe.ts';
import { CHECKOUT_ORIGIN } from './email-links.ts';

export function trustedChallengeUrl(raw:unknown):string|null {
  if(typeof raw!=='string'||raw.length>2048)return null;
  try{const u=new URL(raw);return u.href===raw&&u.origin===CHECKOUT_ORIGIN&&u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&/^\/gift-card-challenge\/[A-Za-z0-9_.-]{1,256}$/.test(u.pathname)?raw:null;}catch{return null;}
}

export function navigationDecision(raw: string, method: string, mainFrame: boolean, auditedRelays: Map<string, LinkRole> = new Map(),challengeUrls:ReadonlySet<string>=new Set(),frameUrl='',navigation=true): 'app-or-provider' | 'relay' | 'email-relay' | 'gift-frame' | 'gift-proof' | 'reject' {
  const u = new URL(raw);
  if (!/(^|\.)withflintpay\.com$/i.test(u.hostname)) return 'app-or-provider';
  if(!mainFrame&&method==='GET'&&navigation&&challengeUrls.has(raw))return 'gift-frame';
  if(!mainFrame&&method==='POST'&&challengeUrls.has(frameUrl)&&raw===`${frameUrl}/proof`)return 'gift-proof';
  if (u.origin === relayOrigin && relayPath.test(u.pathname) && !u.search && !u.hash && method === 'GET' && mainFrame) return 'relay';
  const role = auditedRelays.get(raw);
  if (u.origin === relayOrigin && method === 'GET' && mainFrame && !u.hash && (role === 'flint_account_link_relay' && accountRelayPath.test(u.pathname) || role === 'flint_email_preferences_relay' && preferenceRelayPath.test(u.pathname))) return 'email-relay';
  return 'reject';
}
export type PreferenceRelayBinding = { merchantId: string; sandboxId: string };
export function validateRelayResponse(raw: string, status: number, location: string | undefined, role: 'relay' | LinkRole, appOrigins: string[], accountOrigin: string, preferenceBinding?: PreferenceRelayBinding): string {
  invariant(status >= 300 && status < 400 && location, 'RELAY_MUST_REDIRECT_WITHOUT_DOCUMENT');
  const destination = new URL(location, raw);
  invariant(!destination.username && !destination.password && appOrigins.includes(destination.origin), 'RELAY_DESTINATION_FORBIDDEN');
  if (role !== 'relay') invariant(destination.origin === accountOrigin, 'EMAIL_RELAY_ACCOUNT_ORIGIN_REQUIRED');
  if (role === 'flint_account_link_relay') invariant(!destination.hash && destination.href.endsWith('#'), 'ACCOUNT_RELAY_CLEAR_FRAGMENT_REQUIRED');
  if (role === 'flint_email_preferences_relay') {
    invariant(preferenceBinding?.merchantId && preferenceBinding.sandboxId, 'PREFERENCE_RELAY_BINDING_REQUIRED');
    const expected = new Map([
      ['flint_action', 'manage'], ['flint_resource_type', 'email_preferences'], ['flint_mode', 'sandbox'],
      ['flint_merchant_id', preferenceBinding.merchantId], ['flint_environment_id', preferenceBinding.sandboxId],
    ]);
    const query = [...destination.searchParams];
    invariant(query.length === expected.size && [...expected].every(([key, value]) => destination.searchParams.getAll(key).length === 1 && destination.searchParams.get(key) === value), 'PREFERENCE_RELAY_ROUTING_REQUIRED');
    const fragment = [...new URLSearchParams(destination.hash.slice(1))];
    invariant(destination.pathname === '/email-preferences' && fragment.length === 1 && fragment[0][0] === 'flint_email_preference_token' && fragment[0][1].length > 0, 'PREFERENCE_FRAGMENT_DESTINATION_REQUIRED');
  }
  return destination.href;
}

export class BrowserGuard {
  readonly violations = new Set<string>();
  readonly pending = new Set<Promise<unknown>>();
  readonly relays = new Map<Page, { timer: ReturnType<typeof setTimeout>; destination: string }>();
  consoleErrors = 0;
  readonly requestIds = new Set<string>();
  readonly challengeUrls=new Set<string>();
  private readonly capturedVerificationRequests = new WeakSet<Request>();
  private proofGate?:Promise<void>;
  private releaseProof?:()=>void;
  readonly scanner: CredentialScanner; readonly appOrigins: string[]; readonly accountOrigin: string; readonly auditedRelays: Map<string, LinkRole>; readonly preferenceBindings: Map<string, PreferenceRelayBinding>;
  constructor(scanner: CredentialScanner, appOrigins: string[], accountOrigin = appOrigins[0], auditedRelays = new Map<string, LinkRole>(), preferenceBindings = new Map<string, PreferenceRelayBinding>()) { this.scanner = scanner; this.appOrigins = appOrigins; this.accountOrigin = accountOrigin; this.auditedRelays = auditedRelays; this.preferenceBindings = preferenceBindings; }
  allowGiftChallenge(url:string):void{invariant(trustedChallengeUrl(url)===url,'GIFT_CHALLENGE_URL_UNTRUSTED');this.challengeUrls.add(url);}
  holdGiftProof():()=>void{
    invariant(!this.proofGate,'CHALLENGE_PROOF_ALREADY_HELD');this.proofGate=new Promise(resolve=>{this.releaseProof=resolve;});
    return ()=>{this.releaseProof?.();this.releaseProof=undefined;this.proofGate=undefined;};
  }
  private work(p: Promise<unknown>): void {
    const safe = p.catch(() => { this.violations.add('GUARD_INSPECTION_FAILED'); });
    this.pending.add(safe); void safe.finally(() => this.pending.delete(safe));
  }
  async attach(context: BrowserContext): Promise<void> {
    invariant(context.serviceWorkers().length === 0, 'SERVICE_WORKERS_FORBIDDEN');
    context.on('serviceworker', () => this.violations.add('SERVICE_WORKER_UNINSPECTED'));
    context.on('request', request => {
      this.scanner.scan(request.url(), 'url');
      const u = new URL(request.url());
      const challengeProofSubmit=request.method()==='POST'&&this.appOrigins.includes(u.origin)&&(/^\/checkout\/[^/]+\/gift-card\/challenge$/.test(u.pathname)||u.origin===this.accountOrigin&&/^\/(invoices|returns)\/[^/]+\/pay\/gift-card\/challenge$/.test(u.pathname));
      const gift = challengeProofSubmit || request.method() === 'POST' && this.appOrigins.includes(u.origin) && (/^\/checkout\/[^/]+\/gift-card$/.test(u.pathname) || u.origin===this.accountOrigin&&/^\/(invoices|returns)\/[^/]+\/pay\/gift-card$/.test(u.pathname) || u.pathname === '/gift-cards');
      this.scanner.scan(request.postData() ?? '', 'request', { submittedGift: gift,challengeProofSubmit,stripeTransport: stripeOrigins.has(u.origin) });
      if ([...this.auditedRelays.keys()].some(url => request.headers()['referer']?.includes(url))) this.violations.add('EMAIL_RELAY_REFERRER_LEAK');
      this.scanner.scan(JSON.stringify(request.headers()), 'request', { stripeTransport: stripeOrigins.has(u.origin) });
    });
    await context.route('**/*', async route => {
      const request = route.request();
      let frame;
      try { frame = request.frame(); } catch { /* service worker is forbidden */ }
      const main = !!frame && frame === frame.page().mainFrame() && request.isNavigationRequest();
      const decision = navigationDecision(request.url(), request.method(), main, this.auditedRelays,this.challengeUrls,frame?.url(),request.isNavigationRequest());
      if (decision === 'reject') { this.violations.add('FLINT_COMMERCE_REQUEST'); await route.abort('blockedbyclient'); return; }
      if(decision==='gift-proof'&&this.proofGate)await this.proofGate;
      if ((decision === 'relay' || decision === 'email-relay') && frame) {
        const page = frame.page();
        if (this.relays.has(page)) { this.violations.add('RELAY_REENTERED'); await route.abort('blockedbyclient'); return; }
        try {
          const response = await route.fetch({ maxRedirects: 0, timeout: 10_000 });
          const role = decision === 'relay' ? 'relay' : this.auditedRelays.get(request.url())!;
          const destination = validateRelayResponse(request.url(), response.status(), response.headers()['location'], role, this.appOrigins, this.accountOrigin, this.preferenceBindings.get(request.url()));
          this.scanner.scan(destination, 'url'); this.scanner.assertClean();
          const timer = setTimeout(() => { this.violations.add('RELAY_RETURN_TIMEOUT'); this.relays.delete(page); }, 10_000);
          this.relays.set(page, { timer, destination }); await route.fulfill({ response });
        } catch { this.violations.add('RELAY_VALIDATION_FAILED'); await route.abort('blockedbyclient'); }
        return;
      }
      const url = new URL(request.url());
      if (this.appOrigins.includes(url.origin) && request.method() === 'POST' && /^\/checkout\/[^/]+\/verification(?:\/confirm)?$/.test(url.pathname)) {
        // These replies can immediately reload the page. Capture and inspect them
        // before delivery, while the original body is still available.
        const capture = (async () => {
          try {
            const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 10_000 });
            const body = await response.body();
            const contentType = response.headers()['content-type'] ?? '';
            if (response.status() >= 200 && response.status() < 300 && response.status() !== 204 && /json|text|javascript|html/.test(contentType)) {
              this.scanner.scan(body.toString('utf8'), 'body');
              this.scanner.assertClean();
            }
            this.capturedVerificationRequests.add(request);
            await route.fulfill({ response, body });
          } catch {
            this.violations.add('GUARD_INSPECTION_FAILED');
            await route.abort('blockedbyclient');
          }
        })();
        this.work(capture);
        await capture;
        return;
      }
      await route.continue();
    });
    context.on('response', response => this.work((async () => {
      const id = requestId(response.headers()['x-request-id']); if (id) this.requestIds.add(id);
      const u = new URL(response.url());
      if (!this.appOrigins.includes(u.origin)) return;
      const location = response.headers()['location']; if (location) this.scanner.scan(new URL(location, response.url()).href, 'url');
      if (response.status() < 200 || response.status() >= 300 || response.status() === 204) return;
      const contentType = response.headers()['content-type'] ?? '';
      if (!/json|text|javascript|html/.test(contentType)) return;
      if (this.capturedVerificationRequests.has(response.request())) return;
      const text = await response.text();
      let providerJob = false;
      if (/json/.test(contentType) && (/\/(?:pay|resume|attempt)$/.test(u.pathname) || /\/payment-methods\/new\/(?:setup|confirm|state)$/.test(u.pathname))) {
        try {
          const b = JSON.parse(text);
          providerJob = b.state?.attempt?.status === 'requires_action' || b.state?.next === 'authenticate' || !!b.client_setup && b.payment_method?.status === 'pending';
        } catch { /* malformed app JSON remains scanned */ }
      }
      this.scanner.scan(text, 'body', { providerJob });
    })()));
    const pageHooks = (page: Page) => {
      page.on('console', message => { this.scanner.scan(message.text(), 'console'); if (message.type() === 'error') this.consoleErrors++; });
      page.on('pageerror', error => { this.scanner.scan(error.message, 'console'); this.consoleErrors++; });
      page.on('framenavigated', frame => {
        const raw = frame.url();
        if (raw === 'about:blank') return;
        this.scanner.scan(raw, 'url');
        if (navigationDecision(raw, 'GET', frame === page.mainFrame(), this.auditedRelays,this.challengeUrls,raw) === 'reject') this.violations.add('FLINT_COMMERCE_NAVIGATION');
        const timer = this.relays.get(page);
        if (timer && frame === page.mainFrame() && this.appOrigins.includes(new URL(raw).origin)) { clearTimeout(timer.timer); this.relays.delete(page); }
      });
    };
    context.on('page', pageHooks);
    for (const page of context.pages()) pageHooks(page);
  }
  async inspect(context: BrowserContext): Promise<void> {
    this.scanner.scan(JSON.stringify(await context.cookies()), 'cookie');
    for (const page of context.pages()) for (const frame of page.frames()) {
      if (!this.appOrigins.includes(new URL(frame.url() === 'about:blank' ? this.appOrigins[0] : frame.url()).origin)) continue;
      const values = await frame.evaluate(() => ({ storage: JSON.stringify([localStorage, sessionStorage]), dom: document.documentElement.outerHTML,
        inputs: [...document.querySelectorAll('input[data-sensitive="true"], textarea[data-sensitive="true"]')].map(x => (x as HTMLInputElement).value) }));
      this.scanner.scan(values.storage, 'storage');
      this.scanner.scan(values.dom, 'dom');
      for (const input of values.inputs) this.scanner.scan(input, 'dom', { sensitiveInput: true });
    }
    await Promise.all([...this.pending]);
    this.scanner.assertClean();
    invariant(this.violations.size === 0 && this.relays.size === 0, 'BROWSER_BOUNDARY_VIOLATION');
  }
  close(): void { this.releaseProof?.();for (const timer of this.relays.values()) clearTimeout(timer.timer); this.relays.clear(); }
}
