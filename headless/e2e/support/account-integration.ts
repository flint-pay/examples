import { Client } from '@flintpay/node';
import type { Operator } from './operator.ts';
import { pinnedFetch } from './sdk.ts';
import { digest, invariant } from './safe.ts';

export type AccountClients = { anonymous: Pick<Client, 'customerSessions' | 'close'>; buyer: (secret: string) => Pick<Client, 'me' | 'close'> };
export async function exerciseAccountApi(operator: Operator, customerId: string, injected?: AccountClients): Promise<string[]> {
  invariant(operator.ledger.state.resources.some(r => r.sandbox === 'A' && r.type === 'customer' && r.resource === customerId && r.owned), 'DISPOSABLE_SESSION_CUSTOMER_AUTHORITY_REQUIRED');
  invariant((await operator.clients.clients.A.customers.get(customerId)).customer_id === customerId, 'SESSION_CUSTOMER_CONTEXT_MISMATCH');
  const clients = injected ?? {
    anonymous: new Client({ baseUrl: operator.clients.config.apiOrigin, transport: pinnedFetch(), maxAttempts: 1 }),
    buyer: (secret: string) => new Client({ baseUrl: operator.clients.config.apiOrigin, customerToken: secret, transport: pinnedFetch(), maxAttempts: 1 }),
  };
  const buyers: ReturnType<AccountClients['buyer']>[] = [];
  const reviewAt = new Date(operator.runDate() + 86400_000).toISOString();
  try {
    const minted = await operator.execute({ name: 'account-api-mint', sandbox: 'A', operation: 'customerSessions.create', args: [{ customer_id: customerId, expires_in_seconds: '300' }], creates: [{ path: 'customer_session_id', type: 'customer_session', cleanup: 'customer_session', reviewAt }], purpose: 'account-public-api-integration' });
    const first = minted.data; invariant(first.customer_id === customerId && first.secret && first.refresh_token, 'OWN_SESSION_AUTHORITY_REQUIRED');
    const buyer = clients.buyer(first.secret); buyers.push(buyer);
    invariant((await buyer.me.get()).customer_id === customerId, 'ACCOUNT_BUYER_CONTEXT_MISMATCH');
    for (const read of [() => buyer.me.listOrders(), () => buyer.me.listSubscriptions(), () => buyer.me.listInvoices(), () => buyer.me.listReturns(), () => buyer.me.listPaymentMethods(), () => buyer.me.listAddresses(), () => buyer.me.listGiftCards()]) invariant(Array.isArray((await read()).data), 'ACCOUNT_BUYER_LIST_ENVELOPE_REQUIRED');
    const refreshed = await operator.ledger.action('account-api-refresh', 'A', 'customerSessions.refresh', [{ credential_source: 'A:account-api-mint', refresh_token_hash: digest(first.refresh_token) }], async key => {
      await operator.clients.writable('A');
      return clients.anonymous.customerSessions.refresh({ refresh_token: first.refresh_token }, { idempotencyKey: key });
    }, async session => {
      invariant(session.customer_id === customerId && session.customer_session_id && session.secret && session.refresh_token, 'OWN_REFRESH_RESULT_REQUIRED');
      const pin = operator.clients.config.pins.A;
      await operator.ledger.record({ resource: session.customer_session_id, type: 'customer_session', mode: 'test', sandbox: 'A', merchant: pin.merchantId, sandboxId: pin.sandboxId, createdBy: operator.ledger.run, purpose: 'account-public-api-integration', cleanup: 'customer_session', owner: 'headless e2e', reviewAt, owned: true });
    });
    const rotated = clients.buyer(refreshed.secret); buyers.push(rotated);
    invariant((await rotated.me.get()).customer_id === customerId, 'ACCOUNT_REFRESH_MUST_AUTHORIZE_CUSTOMER');
    const revoked = await operator.ledger.action('account-api-revoke', 'A', 'customerSessions.revoke', [refreshed.customer_session_id, {}], async key => (await operator.clients.writable('A')).customerSessions.revoke(refreshed.customer_session_id, {}, { idempotencyKey: key }), async () => {});
    invariant(revoked.revoked === true && revoked.customer_session_id === refreshed.customer_session_id, 'ACCOUNT_SESSION_REVOCATION_REQUIRED');
    const invalid = await rotated.me.get().then(() => null, error => error);
    invariant(invalid?.code === 'INVALID_CUSTOMER_SESSION', 'ACCOUNT_REVOKED_SESSION_MUST_BE_INVALID');
    return ['PUBLIC_ACCOUNT_SESSION_MINT', 'PUBLIC_BUYER_RESOURCE_LISTS', 'PUBLIC_ACCOUNT_SESSION_REFRESH', 'PUBLIC_ACCOUNT_SESSION_REVOKE_AND_DENIAL'];
  } finally { await Promise.all(buyers.map(buyer => buyer.close())); await clients.anonymous.close(); }
}
