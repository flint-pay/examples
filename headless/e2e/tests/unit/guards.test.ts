import test from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext, Request, Route } from '@playwright/test';
import { BrowserGuard, navigationDecision } from '../../support/flint-boundary.ts';
import { CredentialScanner } from '../../support/credential-scan.ts';
import { pinApiOrigin, origin, API_ORIGIN, alias } from '../../support/config.ts';
import { pinnedFetch } from '../../support/sdk.ts';
import { auditLinks, parseLinks } from '../../support/inbox.ts';
import { safeFailure, HarnessError, canonical } from '../../support/safe.ts';

test('only the exact main-frame provider relay is admitted', () => {
  assert.equal(navigationDecision(`${API_ORIGIN}/payment-returns/relay_PLACEHOLDER`, 'GET', true), 'relay');
  for (const [url, method, main] of [[`${API_ORIGIN}/payment-returns/x?token=PLACEHOLDER`, 'GET', true], [`${API_ORIGIN}/payment-returns/x`, 'POST', true], [`${API_ORIGIN}/payment-returns/x`, 'GET', false], ['https://checkout.staging.withflintpay.com/x', 'GET', true], ['https://withflintpay.com/x', 'GET', true], ['https://api.withflintpay.com/payment-returns/x', 'GET', true]] as const) assert.equal(navigationDecision(url, method, main), 'reject');
});
test('staging origin cannot be overridden by URL equivalence or a production host', () => {
  assert.equal(pinApiOrigin(API_ORIGIN), API_ORIGIN);
  for (const url of [undefined, `${API_ORIGIN}/`, 'http://api.staging.withflintpay.com', 'https://api.withflintpay.com']) assert.throws(() => pinApiOrigin(url));
});
test('merchant app origins reject credentials, Flint hosts and insecure remote origins', () => {
  assert.equal(origin('http://localhost:4100'), 'http://localhost:4100');
  for (const url of ['https://user:PLACEHOLDER@shop.example.invalid', 'https://account.withflintpay.com', 'http://shop.example.invalid', 'https://shop.example.invalid/?token=PLACEHOLDER']) assert.throws(() => origin(url));
});
test('transport refuses wrong origin, private routes, headers and redirects before writes', async () => {
  let called = 0; const transport = pinnedFetch(async () => { called++; return new Response('{}'); });
  for (const url of ['https://api.withflintpay.com/v1/orders', `${API_ORIGIN}/internal/rpc`]) await assert.rejects(() => transport(url, { method: 'POST' }));
  await assert.rejects(() => transport(`${API_ORIGIN}/v1/orders`, { method: 'POST', headers: { 'Flint-Merchant-Id': 'PLACEHOLDER' } })); assert.equal(called, 0);
  await transport(`${API_ORIGIN}/v1/orders`, { method: 'POST' }); assert.equal(called, 1);
  await assert.rejects(() => pinnedFetch(async () => new Response(null, { status: 302, headers: { location: 'https://example.invalid' } }))(`${API_ORIGIN}/v1/orders`));
});
test('Flint credentials and private DTO authority always fail scanning', () => {
  for (const value of ['flint_test_PLACEHOLDER', 'flint_live_PLACEHOLDER', 'ckat_PLACEHOLDER', 'flint_cses_PLACEHOLDER', '{"refresh_token":"PLACEHOLDER"}']) {
    const scanner = new CredentialScanner(); scanner.scan(value, 'body', { providerJob: true }); assert.throws(() => scanner.assertClean());
  }
});
test('provider client secrets are permitted only in required job or provider transport', () => {
  const scanner = new CredentialScanner(); scanner.scan('pi_PLACEHOLDER_secret_PLACEHOLDER', 'body', { providerJob: true }); scanner.assertClean();
  scanner.scan('pi_PLACEHOLDER_secret_PLACEHOLDER', 'console'); assert.throws(() => scanner.assertClean());
  for (const surface of ['url', 'storage', 'cookie', 'child', 'dom'] as const) { const s = new CredentialScanner(); s.scan('pi_PLACEHOLDER_secret_PLACEHOLDER', surface); assert.throws(() => s.assertClean()); }
});
test('gift values are confined to the specific submitted request and sensitive input', () => {
  const scanner = new CredentialScanner(); scanner.addGift('GIFT-PLACEHOLDER'); scanner.scan('GIFT-PLACEHOLDER', 'request', { submittedGift: true }); scanner.scan('GIFT-PLACEHOLDER', 'dom', { sensitiveInput: true }); scanner.assertClean();
  scanner.scan('GIFT-PLACEHOLDER', 'body'); assert.throws(() => scanner.assertClean());
});
test('token-bearing URLs fail without putting their content in an exception', () => {
  const scanner = new CredentialScanner(); scanner.scan('https://shop.example.invalid/path?email=buyer%40example.invalid', 'url'); assert.throws(() => scanner.assertClean(), { message: 'CREDENTIAL_LEAK' });
});
test('email audit rejects every unmatched Flint gift or commerce link', () => {
  const mail = { subject: '', from: '', receivedAt: '', text: '', html: '', codes: [], links: [{ text: '', href: 'https://gift.withflintpay.com/recipient/PLACEHOLDER' }] };
  assert.throws(() => auditLinks(mail, ['https://account.example.invalid']), { message: 'EMAIL_FLINT_COMMERCE_LINK' });
  mail.links = [{ text: '', href: 'https://account.example.invalid/orders/ord_PLACEHOLDER?flint_resource_type=order' }]; auditLinks(mail, ['https://account.example.invalid']);
});
test('MIME HTML link parsing decodes entities and extracts all anchors', () => {
  const links = parseLinks('<a href="https://account.example.invalid/?a=1&amp;b=2">Order</a>', 'https://carrier.example.invalid/x'); assert.equal(links[0].href, 'https://account.example.invalid/?a=1&b=2'); assert.equal(links.length, 2);
});
test('raw errors and URL data cannot enter normalized evidence', () => {
  assert.equal(safeFailure(new Error('https://example.invalid/?code=PLACEHOLDER')), 'EXECUTION_FAILED'); assert.equal(safeFailure(new HarnessError('EXPECTED_FAILURE')), 'EXPECTED_FAILURE'); assert.equal(safeFailure(new HarnessError('email@example.invalid')), 'EXECUTION_FAILED');
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
});
test('run aliases exist only in supplied private runtime configuration', () => {
  assert.equal(alias({ inboxAddress: 'buyer@example.invalid', run: '20000101T000000Z-00000000' }, 'b2'), 'buyer+fx-20000101T000000Z-00000000-b2@example.invalid');
});

test('challenge navigation admits only the registered subframe and its own proof POST',()=>{
 const url='https://checkout.staging.withflintpay.com/gift-card-challenge/gccf_fixture',registered=new Set([url]);
 assert.equal(navigationDecision(url,'GET',false,new Map(),registered,'about:blank',true),'gift-frame');
 assert.equal(navigationDecision(url,'GET',true,new Map(),registered,url),'reject');assert.equal(navigationDecision(url,'GET',false),'reject');
 assert.equal(navigationDecision(url,'GET',false,new Map(),registered,url,false),'reject');
 assert.equal(navigationDecision(url+'/proof','POST',false,new Map(),registered,url,false),'gift-proof');
 for(const frame of ['about:blank',url+'other'])assert.equal(navigationDecision(url+'/proof','POST',false,new Map(),registered,frame,false),'reject');
 for(const path of ['/proof/extra','/other','?x=1'])assert.equal(navigationDecision(url+path,'POST',false,new Map(),registered,url,false),'reject');
});
test('a proof is admitted exactly once in its scoped challenge request and remembered thereafter',()=>{
 const proof='gccp_'+ 'X'.repeat(30),scanner=new CredentialScanner();scanner.scan(proof,'request',{challengeProofSubmit:true});scanner.assertClean();scanner.scan(proof,'request',{challengeProofSubmit:true});assert.throws(()=>scanner.assertClean());
 for(const surface of ['url','body','dom','storage','console','cookie','child'] as const){const scanner=new CredentialScanner();scanner.scan(proof,surface,{challengeProofSubmit:true});assert.throws(()=>scanner.assertClean());}
 const ordinary=new CredentialScanner();ordinary.scan(proof,'request',{submittedGift:true});assert.throws(()=>ordinary.assertClean());
});

const verificationOrigin = 'https://store.example.invalid';
async function verificationGuard(options: {
  url?: string; method?: string; body?: string; status?: number;
  fail?: 'fetch' | 'body' | 'fulfill'; readBody?: () => Promise<Buffer>; onDeliver?: () => void;
} = {}) {
  const scanner = new CredentialScanner(), guard = new BrowserGuard(scanner, [verificationOrigin]);
  const listeners = new Map<string, (event: any) => void>();
  let routeHandler!: (route: Route) => Promise<void>;
  const context = {
    serviceWorkers: () => [], pages: () => [], cookies: async () => [],
    on: (event: string, listener: (event: any) => void) => { listeners.set(event, listener); },
    route: async (_pattern: string, listener: (route: Route) => Promise<void>) => { routeHandler = listener; },
  } as unknown as BrowserContext;
  const request = {
    url: () => options.url ?? `${verificationOrigin}/checkout/unit-ref/verification`,
    method: () => options.method ?? 'POST', isNavigationRequest: () => false,
    postData: () => '{}', headers: () => ({}), frame: () => { throw new Error('no frame'); },
  } as unknown as Request;
  const body = Buffer.from(options.body ?? '{"state":{"verification":{"status":"code_sent"}}}');
  const headers = { 'content-type': 'application/json', 'x-unit-header': 'preserved' };
  const response = {
    status: () => options.status ?? 200, headers: () => headers,
    body: async () => {
      if (options.fail === 'body') throw new Error('body capture unavailable');
      return options.readBody ? options.readBody() : body;
    },
  };
  let fetches = 0, continues = 0, aborts = 0, deliveries = 0, duplicateReads = 0;
  let delivered: any;
  const route = {
    request: () => request,
    fetch: async (settings: unknown) => {
      fetches++; assert.deepEqual(settings, { maxRedirects: 0, maxRetries: 0, timeout: 10_000 });
      if (options.fail === 'fetch') throw new Error('fetch unavailable');
      return response;
    },
    fulfill: async (settings: any) => {
      if (options.fail === 'fulfill') throw new Error('delivery unavailable');
      options.onDeliver?.();
      delivered = settings; deliveries++;
      // Model the immediate reload: Chromium can no longer provide this body.
      listeners.get('response')!({
        url: request.url, request: () => request, status: response.status, headers: response.headers,
        text: async () => { duplicateReads++; throw new Error('body lost on reload'); },
      });
    },
    continue: async () => { continues++; },
    abort: async (reason: string) => { assert.equal(reason, 'blockedbyclient'); aborts++; },
  } as unknown as Route;
  await guard.attach(context);
  return {
    scanner, guard, context, body, headers, response,
    run: async () => { listeners.get('request')!(request); await routeHandler(route); },
    counts: () => ({ fetches, continues, aborts, deliveries, duplicateReads }),
    delivered: () => delivered,
    inspect: () => guard.inspect(context),
    browserResponse: (text: string, responseHeaders: Record<string, string> = headers) => listeners.get('response')!({
      url: request.url, request: () => ({ ...request }), status: () => 200, headers: () => responseHeaders,
      text: async () => text,
    }),
  };
}

test('verification capture scans before delivery and survives an immediate reload', async () => {
  let completeBody!: (body: Buffer) => void;
  const bodyReady = new Promise<Buffer>(resolve => { completeBody = resolve; });
  let bodyScans = 0;
  const f = await verificationGuard({ readBody: () => bodyReady, onDeliver: () => assert.equal(bodyScans, 1) });
  const scan = f.scanner.scan.bind(f.scanner);
  f.scanner.scan = (value, surface, context) => { if (surface === 'body') bodyScans++; scan(value, surface, context); };
  const handling = f.run();
  await Promise.resolve();
  assert.equal(f.guard.pending.size, 1);
  assert.equal(f.counts().deliveries, 0); assert.equal(bodyScans, 0);
  completeBody(f.body); await handling; await f.inspect();
  assert.equal(bodyScans, 1);
  assert.deepEqual(f.counts(), { fetches: 1, continues: 0, aborts: 0, deliveries: 1, duplicateReads: 0 });
  assert.equal(f.delivered().response, f.response); assert.deepEqual(f.delivered().body, f.body);
  assert.deepEqual(f.delivered().response.headers(), f.headers);
});

for (const body of ['{"credential":"flint_test_PLACEHOLDER"}', '{"client_setup":"seti_PLACEHOLDER_secret_PLACEHOLDER"']) {
  test('verification capture rejects leaked authority even in malformed JSON', async () => {
    const f = await verificationGuard({ body }); await f.run();
    assert.equal(f.counts().deliveries, 0); assert.equal(f.counts().aborts, 1);
    assert.equal(f.guard.violations.has('GUARD_INSPECTION_FAILED'), true);
    await assert.rejects(f.inspect, { code: 'CREDENTIAL_LEAK' });
  });
}

for (const fail of ['fetch', 'body', 'fulfill'] as const) test(`verification ${fail} failure aborts without falling back`, async () => {
  const f = await verificationGuard({ fail }); await f.run();
  assert.deepEqual(f.counts(), { fetches: 1, continues: 0, aborts: 1, deliveries: 0, duplicateReads: 0 });
  await assert.rejects(f.inspect, { code: 'BROWSER_BOUNDARY_VIOLATION' });
});

for (const options of [
  { url: 'https://other.example.invalid/checkout/unit-ref/verification' },
  { method: 'GET' },
  { url: `${verificationOrigin}/checkout/unit-ref/verification/confirm/extra` },
  { url: `${verificationOrigin}/checkout/unit-ref/verification/` },
  { url: `${verificationOrigin}/checkout/unit-ref/state` },
  { url: `${verificationOrigin}/checkout/unit-ref/other/verification` },
]) test('verification capture leaves other origins, methods and paths on their existing route', async () => {
  const f = await verificationGuard(options); await f.run(); await f.inspect();
  assert.deepEqual(f.counts(), { fetches: 0, continues: 1, aborts: 0, deliveries: 0, duplicateReads: 0 });
});

for (const status of [200, 204, 303, 503]) test(`verification confirm preserves the original ${status} response and bytes`, async () => {
  const f = await verificationGuard({ url: `${verificationOrigin}/checkout/unit-ref/verification/confirm`, status });
  await f.run(); await f.inspect();
  assert.equal(f.delivered().response.status(), status);
  assert.deepEqual(f.delivered().response.headers(), f.headers); assert.deepEqual(f.delivered().body, f.body);
});

test('capture skips only the original request body, retaining other response and URL scans', async () => {
  const f = await verificationGuard(); await f.run(); await f.inspect();
  f.browserResponse('flint_test_PLACEHOLDER');
  await assert.rejects(f.inspect, { code: 'CREDENTIAL_LEAK' });
  assert.equal(f.scanner.violations.has('CREDENTIAL_BODY'), true);
  const second = await verificationGuard(); await second.run();
  second.browserResponse('{}', { ...second.headers, location: `${verificationOrigin}/?client_secret=seti_PLACEHOLDER_secret_PLACEHOLDER` });
  await assert.rejects(second.inspect, { code: 'CREDENTIAL_LEAK' });
  assert.equal(second.scanner.violations.has('SENSITIVE_URL'), true);
});

const setupSecret = 'seti_PLACEHOLDER_secret_PLACEHOLDER';
const elementsUrl = `https://api.stripe.com/v1/elements/sessions?client_secret=${setupSecret}&key=pk_test_PLACEHOLDER&locale=en&type=setup_intent&stripe_js_id=unit`;
function elementsScan(value = elementsUrl, scanner = new CredentialScanner()): CredentialScanner {
  scanner.scan(value, 'url', { stripeTransport: true }); return scanner;
}
test('Elements setup transport permits only the client-secret query slot and scans ordinary metadata', () => {
  elementsScan().assertClean();
  elementsScan(elementsUrl.replace(setupSecret, setupSecret.replaceAll('_', '%5F'))).assertClean();
});

for (const [name, value] of [
  ['other origin', elementsUrl.replace('api.stripe.com', 'api.stripe.com.example.invalid')],
  ['other Stripe origin', elementsUrl.replace('api.stripe.com', 'js.stripe.com')],
  ['other path', elementsUrl.replace('/elements/sessions', '/setup_intents/unit')],
  ['path suffix', elementsUrl.replace('/elements/sessions?', '/elements/sessions/extra?')],
  ['basic auth', elementsUrl.replace('https://', 'https://user:pass@')],
  ['fragment', elementsUrl + '#fragment'],
  ['empty fragment', elementsUrl + '#'],
  ['duplicate secret', elementsUrl + `&client_secret=${setupSecret}`],
  ['encoded duplicate secret key', elementsUrl + `&%63lient_secret=${setupSecret}`],
  ['duplicate publishable key', elementsUrl + '&key=pk_test_PLACEHOLDER'],
  ['live publishable key', elementsUrl.replace('pk_test_', 'pk_live_')],
  ['wrong publishable-key parameter', elementsUrl.replace('&key=', '&api_key=')],
  ['invalid secret', elementsUrl.replace(setupSecret, 'pi_PLACEHOLDER_secret_PLACEHOLDER')],
  ['wrong secret parameter', elementsUrl.replace('client_secret=', 'setup_secret=')],
  ['another sensitive parameter', elementsUrl + '&email=buyer%40example.invalid'],
  ['another encoded sensitive key', elementsUrl + '&%2574oken=unit'],
  ['mixed-case sensitive key', elementsUrl + '&CLIENT_SECRET=unit'],
  ['duplicate sensitive values', elementsUrl + '&code=one&code=two'],
  ['non-slot provider secret', elementsUrl + `&metadata=${setupSecret}`],
  ['encoded non-slot provider secret', elementsUrl + `&metadata=${setupSecret.replaceAll('_', '%5F')}`],
  ['double-encoded non-slot provider secret', elementsUrl + `&metadata=${setupSecret.replaceAll('_', '%255F')}`],
  ['malformed escape hiding an encoded extra secret', elementsUrl + '&metadata=%25ZZseti_EXTRA%255Fsecret%255FEXTRA'],
  ['malformed encoded metadata key', elementsUrl + '&%25ZZ=unit'],
  ['encoding beyond the five-layer bound', elementsUrl + '&metadata=' + setupSecret.replaceAll('_', '%2525252525255F')],
]) test(`Elements URL exception rejects ${name}`, () => {
  assert.throws(() => elementsScan(value).assertClean(), { code: 'CREDENTIAL_LEAK' });
});

test('Elements transport retains known, Flint, gift, and challenge authority checks across encoded URL values', () => {
  for (const secret of ['flint_test_PLACEHOLDER', 'registered-authority', 'GIFT-PLACEHOLDER', 'gccp_' + 'X'.repeat(30)]) {
    const scanner = new CredentialScanner(['registered-authority']); scanner.addGift('GIFT-PLACEHOLDER');
    const encoded = [...secret].map(character => '%' + character.charCodeAt(0).toString(16)).join('');
    assert.throws(() => elementsScan(elementsUrl + '&metadata=' + encoded, scanner).assertClean(), { code: 'CREDENTIAL_LEAK' });
  }
  const scanner = new CredentialScanner([setupSecret]);
  assert.throws(() => elementsScan(elementsUrl, scanner).assertClean(), { code: 'CREDENTIAL_LEAK' });
});

test('transport context never permits a provider secret in persistent or visible surfaces', () => {
  for (const surface of ['console', 'dom', 'storage', 'cookie', 'child'] as const) {
    const scanner = new CredentialScanner(); scanner.scan(setupSecret, surface, { stripeTransport: true });
    assert.throws(() => scanner.assertClean(), { code: 'CREDENTIAL_LEAK' });
  }
  const scanner = new CredentialScanner(); scanner.scan(elementsUrl, 'url');
  assert.throws(() => scanner.assertClean(), { code: 'CREDENTIAL_LEAK' });
});

async function browserElementsRequest(options: { url?: string; method?: string; navigation?: boolean; resourceType?: string; referer?: string } = {}) {
  const scanner = new CredentialScanner(), guard = new BrowserGuard(scanner, ['https://store.example.invalid']);
  let listener!: (request: Request) => void;
  const context = {
    serviceWorkers: () => [], pages: () => [],
    on: (event: string, callback: (request: Request) => void) => { if (event === 'request') listener = callback; },
    route: async () => {},
  } as unknown as BrowserContext;
  await guard.attach(context);
  listener({
    url: () => options.url ?? elementsUrl, method: () => options.method ?? 'GET',
    isNavigationRequest: () => options.navigation ?? false, resourceType: () => options.resourceType ?? 'fetch',
    postData: () => '', headers: () => options.referer ? { referer: options.referer } : {},
  } as unknown as Request);
  return scanner;
}

test('BrowserGuard classifies only non-navigation GET fetch/xhr Elements requests', async () => {
  for (const resourceType of ['fetch', 'xhr']) (await browserElementsRequest({ resourceType })).assertClean();
  for (const options of [
    { method: 'POST' }, { navigation: true }, { resourceType: 'document' }, { resourceType: 'image' },
    { url: elementsUrl.replace('api.stripe.com', 'other.example.invalid') },
    { url: elementsUrl.replace('/elements/sessions', '/other') },
  ]) {
    const scanner = await browserElementsRequest(options);
    assert.throws(() => scanner.assertClean(), { code: 'CREDENTIAL_LEAK' });
  }
});

test('BrowserGuard scans referrers independently of permitted Stripe transport', async () => {
  for (const referer of [elementsUrl, elementsUrl.replace(setupSecret, setupSecret.replaceAll('_', '%5F'))]) {
    const scanner = await browserElementsRequest({ referer });
    assert.throws(() => scanner.assertClean(), { code: 'CREDENTIAL_LEAK' });
  }
});
