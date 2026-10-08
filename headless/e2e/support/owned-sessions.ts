import { Client } from '@flintpay/node';
import type { Operator } from './operator.ts';
import { pinnedFetch } from './sdk.ts';
import { anonymousSessionClient, sessionCall } from './app-vault.ts';
import { invariant, apiFailure } from './safe.ts';

// This exercises only a harness-created public session family. It cannot prove that
// an application detects reuse of its own vault's family or signs its user out.
export async function exerciseOwnSessionRefresh(operator: Operator, customerId: string, buyerClient: (secret: string) => Pick<Client, 'me'> = secret => new Client({ baseUrl: operator.clients.config.apiOrigin, customerToken: secret, transport: pinnedFetch(), maxAttempts: 1 }), anonymous: Pick<Client, 'customerSessions'> = anonymousSessionClient(operator.clients.requestIds)): Promise<string[]> {
  invariant(operator.ledger.state.resources.some(r => r.sandbox === 'A' && r.type === 'customer' && r.resource === customerId && r.owned), 'DISPOSABLE_SESSION_CUSTOMER_AUTHORITY_REQUIRED');
  invariant((await operator.clients.clients.A.customers.get(customerId)).customer_id === customerId, 'SESSION_CUSTOMER_CONTEXT_MISMATCH');
  const reviewAt = new Date(operator.runDate() + 86400_000).toISOString();
  const minted = await operator.execute({ name: 'own-session-mint', sandbox: 'A', operation: 'customerSessions.create', args: [{ customer_id: customerId, expires_in_seconds: '300' }], creates: [{ path: 'customer_session_id', type: 'customer_session', cleanup: 'customer_session', reviewAt }], purpose: 'own-public-refresh-family' });
  const first = minted.data; invariant(first.secret && first.refresh_token, 'OWN_SESSION_AUTHORITY_REQUIRED');
  const args = [{ credential_source: 'A:own-session-mint', customer_session_id: first.customer_session_id, generation: 'superseded' }];
  const second = await operator.ledger.action('own-session-refresh', 'A', 'customerSessions.refresh', args, async key => {
    return sessionCall(() => anonymous.customerSessions.refresh({ refresh_token: first.refresh_token }, { idempotencyKey: key }));
  }, async session => {
    invariant(session.customer_id === customerId && session.customer_session_id && session.refresh_token && session.secret, 'OWN_REFRESH_RESULT_REQUIRED');
    const pin = operator.clients.config.pins.A;
    await operator.ledger.record({ resource: session.customer_session_id, type: 'customer_session', mode: 'test', sandbox: 'A', merchant: pin.merchantId, sandboxId: pin.sandboxId, createdBy: operator.ledger.run, purpose: 'own-public-refresh-family', cleanup: 'customer_session', owner: 'headless e2e', reviewAt, owned: true });
  });
  invariant((await sessionCall(() => buyerClient(second.secret).me.get())).customer_id === customerId, 'OWN_REFRESH_MUST_AUTHORIZE_CUSTOMER');
  let replayError: any;
  try {
    await operator.ledger.action('own-session-superseded-replay', 'A', 'customerSessions.refresh', args, async key => {
      return sessionCall(() => anonymous.customerSessions.refresh({ refresh_token: first.refresh_token }, { idempotencyKey: key }));
    }, async () => {});
  } catch (error) { replayError = error; }
  invariant(replayError?.code === 'CUSTOMER_SESSION_REFRESH_REUSED', 'OWN_SUPERSEDED_REFRESH_MUST_REVOKE_FAMILY');
  const invalid = await sessionCall(() => buyerClient(second.secret).me.get()).then(() => null, apiFailure);
  invariant(invalid?.code === 'INVALID_CUSTOMER_SESSION', 'OWN_REUSED_SESSION_FAMILY_MUST_BE_INVALID');
  return ['PUBLIC_OWN_SESSION_REFRESH_ROTATION_REUSE_FAMILY_REVOCATION'];
}
