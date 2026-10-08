import { Client } from '@flintpay/node';
import type { Driver } from './driver.ts';
import { pinnedFetch } from './sdk.ts';
import { invariant } from './safe.ts';
import { money } from './money.ts';

export async function createBuyerClient(d: Driver, name: string, customerId: string, sandbox: 'A' | 'B' = 'A'): Promise<Client> {
  const response = await d.operator.execute({ name, sandbox, operation: 'customerSessions.create', args: [{ customer_id: customerId, expires_in_seconds: '300' }], creates: [{ path: 'customer_session_id', type: 'customer_session', cleanup: 'customer_session', reviewAt: new Date(d.operator.runDate() + 86400_000).toISOString() }], purpose: name });
  return new Client({ baseUrl: d.config.apiOrigin, customerToken: response.data.secret, transport: pinnedFetch(), maxAttempts: 1 });
}
export async function buyerInvoiceLaunch(d: Driver, buyer: Client, name: string, invoiceId: string): Promise<any> {
  const args = { surface: 'embedded' as const, redirects: { success_redirect_url: `${d.config.origins.accountA}/invoices/${invoiceId}/pay/return` } };
  return d.operator.ledger.action(name, 'A', 'me.createInvoiceCheckoutSession', [invoiceId, args], async key => {
    await d.operator.clients.verify('A');
    const response = await buyer.me.createInvoiceCheckoutSessionWithResponse(invoiceId, args, { idempotencyKey: key });
    return response.body.data;
  }, async response => {
    invariant(response.checkout_session?.checkout_session_id && response.checkout_session.order_id, 'INVOICE_LAUNCH_SESSION_MISSING');
    await d.track('A', 'checkout_session', response.checkout_session.checkout_session_id, 'checkout_session');
    await d.trackOrder('A', response.checkout_session.order_id);
  });
}
export async function hostedInvoiceLaunch(d: Driver, name: string, invoiceId: string): Promise<any> {
  const response = await d.operator.execute({ name, sandbox: 'A', operation: 'invoices.getOrCreateCheckoutSession', args: [invoiceId, { surface: 'hosted' }], creates: [{ path: 'checkout_session.checkout_session_id', type: 'checkout_session', cleanup: 'checkout_session', reviewAt: new Date(d.operator.runDate() + 86400_000).toISOString() }], purpose: name });
  return response.data;
}
export async function beginHostedAuthentication(d: Driver, name: string, launch: any): Promise<void> {
  invariant(launch.checkout_access?.checkout_auth_token && launch.checkout_session?.checkout_session_id && launch.checkout_session.order_id, 'PUBLIC_CHECKOUT_AUTHORITY_REQUIRED');
  const id = launch.checkout_session.checkout_session_id;
  const checkout = new Client({ baseUrl: d.config.apiOrigin, authMode: 'checkout', credentials: { checkout: { CheckoutSessionIDHeader: id, CheckoutSessionSecretHeader: launch.checkout_access.checkout_auth_token } }, transport: pinnedFetch(), maxAttempts: 1 });
  const order = await checkout.orders.get(launch.checkout_session.order_id);
  const request = { order_id: order.order_id, body: { action: 'pay' as const, expected_outstanding_money: money(order.settlement_amounts.outstanding_money), payment_source: { token: 'pm_card_authenticationRequired' } } };
  const result = await d.operator.ledger.action(name, 'A', 'orders.pay-checkout', [request], async key => {
    await d.operator.clients.verify('A'); return checkout.orders.pay(request, { idempotencyKey: key });
  }, async () => { await d.trackOrder('A', order.order_id); });
  invariant(result.payment_attempt?.status === 'requires_action', 'HOSTED_AUTHENTICATION_NOT_PENDING');
}
