import type { CheckoutState, GiftChallengeView } from '@/shared/types.ts';
import type { ClientAction } from '@/client/stripe-payment.ts';

export type JobError = { kind?: string; code?: string; message_key?: string; request_id?: string };
export type JobResult = {
  ok: boolean;
  status: number;
  transport?: boolean;
  error?: JobError;
  state?: CheckoutState;
  gift_challenge?: GiftChallengeView;
  next?: string;
  client_action?: ClientAction;
  pending_action_id?: string;
};

/** Calls one of this app's checkout routes. The browser never calls Flint. */
export async function checkoutRequest(ref: string, csrf: string, method: 'GET' | 'POST', suffix: string, body?: unknown): Promise<JobResult> {
  try {
    const headers: Record<string, string> = { Accept: 'application/json', 'X-CSRF-Token': csrf };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const response = await fetch(`/checkout/${encodeURIComponent(ref)}${suffix}`, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const json = (await response.json().catch(() => null)) as (Omit<JobResult, 'ok' | 'status'> & { error?: JobError }) | null;
    if (!json) {
      const kind = response.status === 429 ? 'rate_limited' : response.status === 401 ? 'auth' : response.status >= 500 ? 'unknown_outcome' : 'bug';
      return { ok: false, status: response.status, error: { kind, code: `HTTP_${response.status}` } };
    }
    if (json.error) return { ok: false, status: response.status, error: json.error, state: json.state, next: json.next, client_action: json.client_action, pending_action_id: json.pending_action_id };
    return { ...json, ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: 0, transport: true, error: { kind: 'unknown_outcome', code: 'NETWORK_ERROR', message_key: 'network_error' } };
  }
}
