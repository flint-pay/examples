import type {UpdateSettingsRequestInput} from '@flintpay/node';
import type { PublicClient } from './sdk.ts';
import { VerifiedClients } from './sdk.ts';
import { Ledger } from './ledger.ts';
import { atPath } from './fixtures.ts';
import type { PlanStep, Fixtures } from './fixtures.ts';
import type { Sandbox } from './config.ts';
import { invariant, requestId, digest } from './safe.ts';
import { money } from './money.ts';
import {randomBytes,randomUUID} from 'node:crypto';
import {SdkError} from '@flintpay/node';
import {trustedChallengeUrl} from './flint-boundary.ts';

// Only published merchant SDK methods. No provider, live sandbox management or RPC calls.
export const operations = {
  'customers.create': { creates: ['customer'], cleanup: 'review' },
  'products.create': { creates: ['product'], cleanup: 'review' },
  'products.createVariant': { creates: ['variant'], cleanup: 'review' },
  'subscriptionPlans.create': { creates: ['plan'], cleanup: 'review' },
  'locations.create': { creates: ['location'], cleanup: 'review' },
  'deliveryMethods.create': { creates: ['delivery_method'], cleanup: 'review' },
  'deliveryProfiles.create': { creates: ['delivery_profile'], cleanup: 'review' },
  'promotions.create': { creates: ['promotion'], cleanup: 'review' },
  'returnPolicies.create': { creates: ['return_policy'], cleanup: 'review' },
  'returnReasons.create': { creates: ['return_reason'], cleanup: 'review' },
  'giftCards.create': { creates: ['gift_card'], cleanup: 'gift_card' },
  'invoices.create': { creates: ['invoice', 'order'], cleanup: 'invoice' },
  'invoices.issue': { creates: [], cleanup: '' },
  'invoices.getOrCreateCheckoutSession': { creates: ['checkout_session'], cleanup: 'checkout_session' },
  'orders.create': { creates: ['order'], cleanup: 'review' },
  'orders.addLineItems': { creates: ['order_line_item'], cleanup: 'review' },
  'checkoutSessions.create': { creates: ['checkout_session'], cleanup: 'checkout_session' },
  'customerSessions.create': { creates: ['customer_session'], cleanup: 'customer_session' },
  'paymentMethods.save': { creates: ['payment_method'], cleanup: 'payment_method' },
  'fulfillments.createShipment': { creates: ['shipment'], cleanup: 'review' },
  'shipments.createPackage': { creates: ['package'], cleanup: 'review' },
  'packages.createItem': { creates: ['package_item'], cleanup: 'review' },
  'packages.transition': { creates: [], cleanup: '' },
  'fulfillments.transition': { creates: [], cleanup: '' },
  'returns.decide': { creates: [], cleanup: '' },
  'returns.createResolution': { creates: ['return_resolution', 'order'], cleanup: 'return_resolution' },
  'returnResolutions.confirm': { creates: [], cleanup: '' },
  'subscriptions.update': { creates: [], cleanup: '' },
  'subscriptions.updateBillingSchedule': { creates: [], cleanup: '' },
  'customerDeletionRequests.resolve': { creates: [], cleanup: '' },
} as const;
type Operation = keyof typeof operations;
export class Operator {
  readonly clients: VerifiedClients; readonly ledger: Ledger; readonly fixtures: Fixtures;
  private giftChallengeTrippedAt=0;
  private giftChallengeProbeSequence=0;
  constructor(clients: VerifiedClients, ledger: Ledger, fixtures: Fixtures) { this.clients = clients; this.ledger = ledger; this.fixtures = fixtures;this.giftChallengeTrippedAt=ledger.state.giftChallengeTrippedAt??0;this.giftChallengeProbeSequence=Math.max(0,...Object.keys(ledger.state.actions).map(name=>Number(/^A:challenge-probe-(\d+)-(?:order|session|close)$/.exec(name)?.[1]??0))); }
  private owned(sandbox: Sandbox, id: string): void {
    invariant(this.ledger.state.resources.some(r => r.sandbox === sandbox && r.resource === id && r.owned), 'RUN_RESOURCE_AUTHORITY_REQUIRED');
  }
  validate(step: PlanStep): void {
    invariant(step.operation in operations && /^[a-zA-Z0-9_-]{1,100}$/.test(step.name) && ['A', 'B'].includes(step.sandbox), 'OPERATOR_PLAN_INVALID');
    invariant(Array.isArray(step.args) && Array.isArray(step.creates), 'OPERATOR_PLAN_INVALID');
    invariant(operations[step.operation as Operation].creates.every(type => step.creates.some(c => c.type === type)), 'ALL_CREATED_RESOURCES_MUST_BE_TRACKED');
    invariant(step.creates.every(c => c.cleanup && Number.isFinite(Date.parse(c.reviewAt))), 'RESOURCE_DISPOSITION_REQUIRED');
    const exact = (value: any, path: (string | number)[]) => {
      if (!value || typeof value !== 'object') return;
      if ('amount' in value && 'currency' in value) money(value);
      for (const [key, field] of Object.entries(value)) {
        // These published subscription fields use bounded numbers; modifiers and order integers use strings.
        const maxQuantity = key === 'quantity' && step.operation === 'subscriptionPlans.create' && path.length === 3 && path[0] === 0 && path[1] === 'line_items' && typeof path[2] === 'number' ? 9999
          : key === 'quantity' && step.operation === 'subscriptions.update' && path.length === 1 && path[0] === 1 ? 100
          : key === 'quantity' && step.operation === 'checkoutSessions.create' && path.length === 2 && path[0] === 0 && path[1] === 'subscription_terms' ? 100 : undefined;
        if (maxQuantity !== undefined) invariant(typeof field === 'number' && Number.isInteger(field) && field >= 1 && field <= maxQuantity, 'EXACT_FIXTURE_INTEGER_REQUIRED');
        else if (['quantity', 'order_revision', 'expected_version'].includes(key)) invariant(typeof field === 'string' && /^(0|[1-9]\d*)$/.test(field), 'EXACT_FIXTURE_INTEGER_REQUIRED');
        if (Array.isArray(field)) field.forEach((item, index) => exact(item, [...path, key, index])); else exact(field, [...path, key]);
      }
    }; step.args.forEach((arg, index) => exact(arg, [index]));
    // Positional target IDs must be run-owned. Creates may refer to sanctioned existing fixtures.
    if (!step.operation.endsWith('.create') && typeof step.args[0] === 'string') this.owned(step.sandbox, step.args[0]);
    if (step.operation === 'subscriptions.updateBillingSchedule') this.owned(step.sandbox, step.args[0].subscription_id);
  }
  async execute(step: PlanStep): Promise<any> {
    this.validate(step);
    return this.ledger.action(step.name, step.sandbox, step.operation, step.args, async key => {
      const client = await this.clients.writable(step.sandbox);
      const [resource, method] = step.operation.split('.');
      const target = (client as any)[resource];
      invariant(typeof target?.[`${method}WithResponse`] === 'function', 'PUBLISHED_OPERATION_UNAVAILABLE');
      const response = await target[`${method}WithResponse`](...step.args, { idempotencyKey: key });
      // Never persist raw HTTP request metadata, authorization or cookie headers.
      return { data: response.body?.data, requestId: requestId(response.meta?.requestId) };
    }, async response => {
      const creates = [...step.creates];
      const reviewAt = new Date(this.runDate() + 30 * 86400_000).toISOString();
      if (step.operation === 'giftCards.create') {
        for (const [path, type] of [['gift_card_load.gift_card_load_id', 'gift_card_load'], ['gift_card_notification.gift_card_notification_id', 'gift_card_notification']] as const) if (atPath(response.data, path)) creates.push({ path, type, cleanup: 'review', reviewAt });
        for (let i = 0; i < (response.data.gift_card_transaction_ids?.length ?? 0); i++) creates.push({ path: `gift_card_transaction_ids.${i}`, type: 'gift_card_transaction', cleanup: 'review', reviewAt });
      }
      if (['orders.create', 'orders.addLineItems'].includes(step.operation)) for (let i = 0; i < (response.data.line_items?.length ?? 0); i++) creates.push({ path: `line_items.${i}.order_line_item_id`, type: 'order_line_item', cleanup: 'review', reviewAt });
      for (const created of creates) {
        const id = atPath(response.data, created.path);
        if (typeof id !== 'string' || !id) continue;
        const pin = this.clients.config.pins[step.sandbox];
        await this.ledger.record({ resource: id, type: created.type, mode: 'test', sandbox: step.sandbox, merchant: pin.merchantId, sandboxId: pin.sandboxId, createdBy: this.ledger.run, purpose: step.purpose, creationRequestId: response.requestId, cleanup: created.cleanup, owner: 'headless e2e', reviewAt: created.reviewAt, owned: true });
      }
      invariant(creates.every(c => typeof atPath(response.data, c.path) === 'string' && atPath(response.data, c.path)), 'CREATED_RESOURCE_ID_UNRESOLVED');
    });
  }
  async applyPlan(steps: PlanStep[]): Promise<void> {
    for (const step of steps) await this.execute(step);
  }
  async issueInvoice(name: string, customerId: string, email: string): Promise<any> {
    const date = this.runDate();
    const reviewAt = new Date(date + 30 * 86400_000).toISOString();
    const response = await this.execute({ name, sandbox: 'A', operation: 'invoices.create', args: [{
      quick_pay: { customer_id: customerId, line_items: [{ name: 'Acceptance service', quantity: '1', unit_price_money: { amount: '12000', currency: 'USD' }, fulfillment: { requirement: 'none' } }] },
      collection: { mode: 'buyer_initiated', payment_policy: { enabled_payment_options: ['card', 'ach_debit', 'affirm'] } },
      payment_due: { type: 'absolute', due_at: new Date(date + 14 * 86400_000).toISOString() }, recipient_email: email, metadata: { e2e_run: this.ledger.run },
    }], creates: [{ path: 'invoice_id', type: 'invoice', cleanup: 'invoice', reviewAt }, { path: 'order_id', type: 'order', cleanup: 'review', reviewAt }], purpose: name });
    await this.execute({ name: `${name}-issue`, sandbox: 'A', operation: 'invoices.issue', args: [response.data.invoice_id, { delivery_mode: 'email' }], creates: [], purpose: name });
    return response.data;
  }
  async fundingCustomer(): Promise<string> {
    const supplied = this.fixtures.values.giftFundingCustomerId;
    if (supplied) {
      invariant(this.ledger.state.resources.some(r => r.sandbox === 'A' && r.resource === supplied && r.type === 'customer'), 'SANCTIONED_FUNDING_CUSTOMER_REQUIRED');
      const customer = await this.clients.clients.A.customers.get(supplied);
      invariant(customer.customer_id === supplied, 'FUNDING_CUSTOMER_CONTEXT_MISMATCH'); return supplied;
    }
    const email = this.fixtures.values.giftFundingBuyerEmail;
    invariant(typeof email === 'string' && email.includes('@'), 'GIFT_FUNDING_CUSTOMER_PREREQUISITE');
    const response = await this.execute({ name: 'gift-funding-customer', sandbox: 'A', operation: 'customers.create', args: [{ email, name: 'Acceptance funding buyer', external_reference_id: `${this.ledger.run}-gift-funding` }], creates: [{ path: 'customer_id', type: 'customer', cleanup: 'review', reviewAt: new Date(this.runDate() + 30 * 86400_000).toISOString() }], purpose: 'gift-funding' });
    return response.data.customer_id;
  }
  async issueGiftCard(name: string, value = '2500', email?: string): Promise<any> {
    const reviewAt = new Date(this.runDate() + 30 * 86400_000).toISOString();
    const buyerId = await this.fundingCustomer();
    const response = await this.execute({ name, sandbox: 'A', operation: 'giftCards.create', args: [{ currency: 'USD', external_reference_id: `${this.ledger.run}-${name}`, funding: { source: { funding_source_type: 'external_payment', reference_id: `${this.ledger.run}-${name}`, buyer_id: buyerId }, consideration_money: { amount: value, currency: 'USD' }, value_money: { amount: value, currency: 'USD' } }, ...(email ? { notification: { email } } : {}) }], creates: [{ path: 'gift_card.gift_card_id', type: 'gift_card', cleanup: 'gift_card', reviewAt }], purpose: name });
    return response.data;
  }
  async challengeFor(orderId:string,pageOrigin:string):Promise<{url:string;checkoutSessionId:string}>{
    this.owned('A',orderId);
    const client=this.clients.clients.A;
    const sessions=await client.checkoutSessions.list({order_id:orderId,status:'open',page_size:100});
    invariant(sessions.data.length===1&&!sessions.next_page_token,'APP_CURRENT_CHECKOUT_SESSION_AMBIGUOUS');
    const session=await client.checkoutSessions.get(sessions.data[0]!.checkout_session_id);
    const url=trustedChallengeUrl(session.gift_card_challenge?.url);
    invariant(session.order_id===orderId&&session.status==='open'&&!session.recovery_mode&&session.page_origin===pageOrigin&&url,'PUBLIC_GIFT_CHALLENGE_SESSION_REQUIRED');
    return {url,checkoutSessionId:session.checkout_session_id};
  }
  async challengeUrlFor(orderId:string,pageOrigin:string):Promise<string>{return (await this.challengeFor(orderId,pageOrigin)).url;}
  async tripGiftChallenge():Promise<void>{
    const client=await this.clients.writable('A'),origin=this.clients.config.origins.storefrontA;
    const recent=this.giftChallengeTrippedAt>Date.now()-50*60000;
    let lookups=0,tripped=false;
    for(let index=0;index<3&&!tripped;index++){
      const name=`challenge-probe-${++this.giftChallengeProbeSequence}`,reviewAt=new Date(this.runDate()+86400000).toISOString();
      const order=await this.execute({name:`${name}-order`,sandbox:'A',operation:'orders.create',args:[{line_items:[{name:'Gift card verification probe',quantity:'1',unit_price_money:{amount:'200',currency:'USD'},fulfillment:{requirement:'none'}}],metadata:{e2e_run:this.ledger.run}}],creates:[{path:'order_id',type:'order',cleanup:'review',reviewAt}],purpose:'gift-challenge-probe'});
      const launched=await this.execute({name:`${name}-session`,sandbox:'A',operation:'checkoutSessions.create',args:[{order_id:order.data.order_id,surface:'embedded',page_origin:origin}],creates:[{path:'checkout_session.checkout_session_id',type:'checkout_session',cleanup:'checkout_session',reviewAt}],purpose:'gift-challenge-probe'});
      const sessionId=launched.data.checkout_session.checkout_session_id,secret=launched.data.checkout_access.checkout_auth_token;
      invariant(sessionId&&secret,'CHALLENGE_PROBE_AUTHORITY_REQUIRED');
      try{
        for(let attempt=0;attempt<5&&lookups<15;attempt++){
          lookups++;const fresh=await client.orders.get(order.data.order_id);invariant(fresh.order_revision,'CHALLENGE_PROBE_REVISION_REQUIRED');
          let code:string|undefined;
          try{await client.orders.applyGiftCard(order.data.order_id,{gift_card_code:`E2ENOPE${randomBytes(12).toString('base64url')}`,order_revision:fresh.order_revision},{authMode:'checkout',credentials:{CheckoutSessionIDHeader:sessionId,CheckoutSessionSecretHeader:secret},idempotencyKey:randomUUID(),maxAttempts:1});}
          catch(error){if(error instanceof SdkError)code=error.code;else throw error;}
          invariant(code==='GIFT_CARD_UNAVAILABLE'||code==='GIFT_CARD_CHALLENGE_REQUIRED','CHALLENGE_TRIP_UNEXPECTED_OUTCOME');
          if(code==='GIFT_CARD_CHALLENGE_REQUIRED'){
            if(attempt===0){tripped=true;this.giftChallengeTrippedAt=Date.now();this.ledger.state.giftChallengeTrippedAt=this.giftChallengeTrippedAt;await this.ledger.save();}
            break;
          }
          // A recent trip is renewed within the same session and lookup limits.
          if(recent&&attempt===0){this.giftChallengeTrippedAt=0;this.ledger.state.giftChallengeTrippedAt=0;await this.ledger.save();}
        }
      }finally{
        await this.ledger.action(`${name}-close`,'A','checkoutSessions.closeSession',[sessionId,{}],key=>client.checkoutSessions.closeSession(sessionId,{}, {idempotencyKey:key}),async()=>{});
        const resource=this.ledger.state.resources.find(row=>row.sandbox==='A'&&row.resource===sessionId&&row.type==='checkout_session');invariant(resource,'CHALLENGE_PROBE_TRACKING_REQUIRED');await this.ledger.disposition(resource,'CLEANED UP');
      }
    }
    invariant(tripped,'CHALLENGE_TRIP_NOT_OBSERVED');
  }
  runDate(): number {
    const r = this.ledger.run;
    const date = Date.parse(`${r.slice(0, 4)}-${r.slice(4, 6)}-${r.slice(6, 8)}T${r.slice(9, 11)}:${r.slice(11, 13)}:${r.slice(13, 15)}Z`);
    invariant(Number.isFinite(date), 'INVALID_RUN_DATE'); return date;
  }
  async settings(sandbox: Sandbox, patch: Record<string, any>): Promise<void> {
    const authority = this.fixtures.settingsAuthority?.[sandbox];
    invariant(authority?.runOwned && authority.owner && authority.reviewAt, 'PREEXISTING_SETTINGS_CHANGE_FORBIDDEN');
    const client = await this.clients.writable(sandbox);
    const current = await client.settings.get();
    invariant(Object.keys(patch).every(k => ['customer_account', 'customer_email_delivery', 'checkout'].includes(k) && (k === 'customer_account' || (current as any)[k] !== undefined && (current as any)[k] !== null)), 'SETTINGS_PATCH_NOT_RESTORABLE');
    const name = `settings-${sandbox}`;
    invariant(!this.ledger.state.settings[name]?.restored, 'SETTINGS_LIFECYCLE_ALREADY_COMPLETE');
    const presence = Object.fromEntries(Object.keys(patch).map(k => [k, !Object.hasOwn(current, k) ? 'absent' : (current as any)[k] === null ? 'null' : 'value']));
    const effectiveAccount = Object.hasOwn(patch, 'customer_account') && presence.customer_account !== 'value' ? (await client.settings.getEffective()).customer_account : undefined;
    if(Object.hasOwn(patch,'customer_account')&&presence.customer_account!=='value')invariant(effectiveAccount!==undefined,'SETTINGS_EFFECTIVE_SNAPSHOT_REQUIRED');
    await this.ledger.snapshot(name, { ...Object.fromEntries(['version', ...Object.keys(patch)].map(k => [k, (current as any)[k]])), _presence: presence, ...(effectiveAccount !== undefined ? { _effective_customer_account: effectiveAccount } : {}) });
    const prior = this.ledger.state.actions[`${sandbox}:${name}`];
    const request = prior ? prior.args[0] as any : { ...patch, expected_version: current.version };
    const { expected_version, ...originalPatch } = request; invariant(digest(originalPatch) === digest(patch), 'SETTINGS_REQUEST_CHANGED');
    const response = await this.ledger.action(name, sandbox, 'settings.update', [request], key => client.settings.update(request, { idempotencyKey: key }), async () => {});
    this.ledger.state.settings[name].applied = response; await this.ledger.save();
    const readback = await client.settings.get();
    for (const key of Object.keys(patch)) invariant(digest((readback as any)[key]) === digest(patch[key]), 'SETTINGS_READBACK_MISMATCH');
  }
  async cleanup(): Promise<void> {
    let failed = false;
    // Complete prior cleanup outcomes with their exact stored bodies and keys.
    for (const [name, action] of Object.entries(this.ledger.state.actions)) {
      if (action.phase !== 'unknown' || !name.slice(2).startsWith('cleanup-')) continue;
      try {
        const c = await this.clients.writable(action.sandbox, true);
        const [resource, method] = action.operation.split('.');
        await this.ledger.action(name.slice(2), action.sandbox, action.operation, action.args, key => (c as any)[resource][method](...action.args, { idempotencyKey: key }), async () => {});
      } catch { failed = true; }
    }
    for (const r of [...this.ledger.state.resources].reverse()) {
      if (!r.owned || r.status === 'CLEANED UP') continue;
      try {
        if (r.cleanup === 'review' || r.cleanup === 'expiry') { await this.ledger.disposition(r, r.cleanup === 'expiry' ? 'PENDING EXPIRY' : 'RETAINED FOR RECONCILIATION'); continue; }
        const c = await this.clients.writable(r.sandbox, true);
        const key = `cleanup-${digest({ sandbox: r.sandbox, id: r.resource }).slice(0, 32)}`;
        const call = async (operation: string, args: unknown[], send: (key: string) => Promise<any>) => this.ledger.action(key, r.sandbox, operation, args, send, async () => {});
        if (r.cleanup === 'subscription') {
          const value = await c.subscriptions.get(r.resource);
          if (value.status !== 'canceled') await call('subscriptions.cancel', [r.resource, { cancel_immediately: true }], k => c.subscriptions.cancel(r.resource, { cancel_immediately: true }, { idempotencyKey: k }));
          invariant((await c.subscriptions.get(r.resource)).status === 'canceled', 'SUBSCRIPTION_CLEANUP_FAILED');
        } else if (r.cleanup === 'invoice') {
          const value = await c.invoices.get(r.resource);
          if (!['paid', 'void', 'uncollectible'].includes(value.status)) await call('invoices.voidResource', [r.resource, {}], k => c.invoices.voidResource(r.resource, {}, { idempotencyKey: k }));
          invariant(['paid', 'void', 'uncollectible'].includes((await c.invoices.get(r.resource)).status), 'INVOICE_CLEANUP_FAILED');
        } else if (r.cleanup === 'checkout_session') {
          const value = await c.checkoutSessions.get(r.resource);
          if (!['closed', 'expired', 'paid', 'invalidated'].includes(value.status)) await call('checkoutSessions.closeSession', [r.resource, {}], k => c.checkoutSessions.closeSession(r.resource, {}, { idempotencyKey: k }));
          invariant(['closed', 'expired', 'paid', 'invalidated'].includes((await c.checkoutSessions.get(r.resource)).status), 'CHECKOUT_CLEANUP_FAILED');
        } else if (r.cleanup === 'customer_session') {
          const result = await call('customerSessions.revoke', [r.resource, {}], k => c.customerSessions.revoke(r.resource, {}, { idempotencyKey: k }));
          invariant(result.revoked === true && result.customer_session_id === r.resource, 'SESSION_CLEANUP_FAILED');
        } else if (r.cleanup === 'gift_card') {
          const card = await c.giftCards.get(r.resource);
          if (!['frozen', 'closed'].includes(card.status)) {
            invariant(card.supported_actions.includes('close') || card.supported_actions.includes('freeze'), 'GIFT_CLEANUP_UNSUPPORTED');
            const action = card.supported_actions.includes('close') ? { action: 'close' as const } : { action: 'freeze' as const, reason: 'customer_request' as const };
            const request = { ...action, expected_version: card.version }; await call('giftCards.transition', [r.resource, request], k => c.giftCards.transition(r.resource, request, { idempotencyKey: k }));
          }
          invariant(['frozen', 'closed'].includes((await c.giftCards.get(r.resource)).status), 'GIFT_CLEANUP_FAILED');
        } else if (r.cleanup === 'payment_method') {
          const result = await call('paymentMethods.remove', [r.resource, {}], k => c.paymentMethods.remove(r.resource, {}, { idempotencyKey: k })); invariant(result.success === true, 'METHOD_CLEANUP_FAILED');
        } else if (r.cleanup === 'return_resolution') {
          const resolution = await c.returnResolutions.get(r.resource);
          if (!['fulfilled', 'canceled'].includes(resolution.status)) { const request = { reason: 'created_in_error' as const, expected_version: resolution.version }; await call('returnResolutions.cancel', [r.resource, request], k => c.returnResolutions.cancel(r.resource, request, { idempotencyKey: k })); }
          invariant(['fulfilled', 'canceled'].includes((await c.returnResolutions.get(r.resource)).status), 'RETURN_CLEANUP_FAILED');
        } else throw new Error('unsupported cleanup');
        await this.ledger.disposition(r, 'CLEANED UP');
      } catch { failed = true; }
    }
    for (const [name, settings] of Object.entries(this.ledger.state.settings)) {
      if (settings.restored) continue;
      try {
        const sandbox = name.slice(-1) as Sandbox, c = await this.clients.writable(sandbox, true);
        const current = await c.settings.get();
        const previousRestore = this.ledger.state.actions[`${sandbox}:restore-${name}`];
        invariant(previousRestore || settings.applied && current.version === settings.applied.version, 'SETTINGS_CONCURRENT_CHANGE');
        const fields = ['customer_account', 'customer_email_delivery', 'checkout'];
        const presence = settings.snapshot._presence as Record<string, 'absent' | 'null' | 'value'> | undefined;
        const patch = Object.fromEntries(fields.filter(k => presence ? Object.hasOwn(presence, k) : settings.snapshot[k] !== undefined).map(k => [k, k === 'customer_account' && presence?.[k] !== 'value' && presence?.[k] !== undefined ? clearCustomerAccount().customer_account : settings.snapshot[k]]));
        const request = previousRestore ? previousRestore.args[0] as any : { ...patch, expected_version: current.version };
        await this.ledger.action(`restore-${name}`, sandbox, 'settings.update', [request], k => c.settings.update(request, { idempotencyKey: k }), async () => {});
        const readback = await c.settings.get();
        for (const field of Object.keys(patch)) {
          if (field === 'customer_account' && patch[field] === null) {
            invariant(!Object.hasOwn(readback, field), 'SETTINGS_RESTORE_FAILED');
            invariant(digest((await c.settings.getEffective()).customer_account) === digest(settings.snapshot._effective_customer_account), 'SETTINGS_EFFECTIVE_RESTORE_FAILED');
          } else invariant(digest((readback as any)[field]) === digest(patch[field]), 'SETTINGS_RESTORE_FAILED');
        }
        settings.restored = true; await this.ledger.save();
      } catch { failed = true; }
    }
    invariant(!failed, 'TEARDOWN_FAILED'); this.ledger.assertTracked();
  }
}

function clearCustomerAccount():UpdateSettingsRequestInput{return {customer_account:null};}
