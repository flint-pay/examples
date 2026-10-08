import { join } from 'node:path';
import type { Scenario } from './storefront.ts';
import { readPrivate, writePrivate } from '../support/private-files.ts';
import { invariant, emit } from '../support/safe.ts';
import { assertOneCharge } from '../support/money.ts';
import { syncAppAudit } from '../support/audit-feed.ts';

type Observation = { wallet: 'apple_pay' | 'google_pay'; browser: 'Safari' | 'Chrome'; appOrigin: string; orderId: string; subscriptionId: string; observedAt: string; operatorReference: string; commerceNavigationViolations: number; credentialViolations: number };
export const walletScenario: Scenario = async d => {
  let observations: Observation[] | undefined = d.fixtures.values.walletObservations;
  if (!observations) {
    await writePrivate(join(d.config.privateDir, 'wallet-request.json'), { run: d.config.run, origin: d.sf(), instruction: 'Perform actual Apple Pay in Safari and Google Pay in Chrome against the registered merchant hostname, for one order and one subscription each. Supply the observed resource IDs and normalized guard counts privately.' });
    emit({ event: 'WALLET_OPERATOR_OBSERVATION_REQUIRED' });
    const end = Date.now() + 600_000;
    while (!observations && Date.now() < end) {
      try { observations = await readPrivate<Observation[]>(join(d.config.privateDir, 'wallet-response.json')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      if (!observations) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  invariant(observations?.length === 2, 'WALLET_DEVICE_OBSERVATIONS_REQUIRED');
  await syncAppAudit(d);
  const domains = await d.operator.clients.clients.A.paymentMethodDomains.list();
  const registered = domains.data.find(domain => domain.domain_name === new URL(d.sf()).hostname);
  invariant(d.sf().startsWith('https:') && registered?.status === 'active' && registered.validation_status === 'active', 'REGISTERED_HTTPS_WALLET_DOMAIN_REQUIRED');
  for (const [wallet, browser] of [['apple_pay', 'Safari'], ['google_pay', 'Chrome']] as const) {
    const observed = observations.find(o => o.wallet === wallet && o.browser === browser);
    invariant(observed && observed.appOrigin === d.sf() && Date.parse(observed.observedAt) >= d.operator.runDate() && /^[A-Z0-9_-]+$/.test(observed.operatorReference), 'WALLET_OBSERVATION_IDENTITY');
    invariant(observed.commerceNavigationViolations === 0 && observed.credentialViolations === 0, 'MANUAL_WALLET_GUARD_VIOLATION');
    invariant(d.operator.ledger.state.resources.some(r => r.resource === observed.orderId && r.owned) && d.operator.ledger.state.resources.some(r => r.resource === observed.subscriptionId && r.owned), 'WALLET_RUN_RESOURCE_OWNERSHIP');
    const order = await d.trackOrder('A', observed.orderId), attempts = await d.operator.clients.clients.A.orders.listPaymentAttempts(observed.orderId);
    assertOneCharge(order, attempts.data);
    const subscription = await d.operator.clients.clients.A.subscriptions.get(observed.subscriptionId);
    invariant(subscription.status === 'active' && subscription.payment_method_id, 'WALLET_SUBSCRIPTION_NOT_ACTIVE');
    const method = await d.operator.clients.clients.A.paymentMethods.get(subscription.payment_method_id);
    invariant(method.card?.wallet === wallet && method.usage === 'off_session' && method.status === 'active', 'WALLET_SAVED_SUBSCRIPTION_METHOD');
    await d.track('A', 'subscription', subscription.subscription_id, 'subscription');
  }
  return ['MANUAL_SAFARI_APPLE_PAY_CHROME_GOOGLE_PAY_ORDERS_SUBSCRIPTIONS'];
};
