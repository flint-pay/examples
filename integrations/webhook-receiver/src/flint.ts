import { Client, SdkError } from '@flintpay/node';
import type { RequestOptions } from '@flintpay/node';

// The SDK makes one attempt per call, so reads retry here: a GET is safe to repeat. Writes send once and
// carry an idempotency key, so the caller can repeat them safely.
const READ_ATTEMPTS = 3;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_SECONDS = 2;

export function createClient(baseUrl: string, sandboxGuard?: string): Client {
  return new Client({
    baseUrl,
    timeoutMs: 20_000,
    transport: async (input, init) => {
      const response = await fetchRetryingReads(input, init);
      if (response.headers.get('Flint-Mode') === 'live') throw new Error('Live API responses are refused');
      const sandbox = response.headers.get('Flint-Sandbox-Id');
      if (sandboxGuard && sandbox && sandbox !== sandboxGuard) throw new Error('Sandbox identity guard failed');
      return response;
    },
  });
}

type ReadOptions = Omit<RequestOptions<'merchant'>, 'idempotencyKey'> & { idempotencyKey?: never };

/** The only place credential options are built. Reads take no key; every write must pass one. */
export function createAuth(apiKey: string) {
  function merchant(): ReadOptions;
  function merchant(idempotencyKey: string): RequestOptions<'merchant'>;
  function merchant(idempotencyKey?: string): RequestOptions<'merchant'> {
    return { apiKey, idempotencyKey, maxAttempts: 1 };
  }
  return { merchant };
}
export type Auth = ReturnType<typeof createAuth>;

/** Confirms the key reaches a test sandbox, and the one in FLINT_SANDBOX_ID when it is set. */
export async function preflight(client: Client, auth: Auth, sandboxGuard?: string): Promise<{ sandboxId: string }> {
  const response = await client.capabilities.listWithResponse({ capability: 'accept_card_payments' }, auth.merchant());
  const headers = response.meta.headers;
  if (headers['flint-mode'] === 'live') throw new Error('Live API responses are refused');
  const sandboxId = headers['flint-sandbox-id'];
  if (!sandboxId || (sandboxGuard && sandboxGuard !== sandboxId)) throw new Error('Sandbox identity guard failed');
  return { sandboxId };
}

/** A short description of a failed Flint call that is safe to store and print: no bodies, no credentials. */
export function describeError(error: unknown): string {
  if (error instanceof SdkError) {
    const status = error.meta?.status ? ` ${error.meta.status}` : '';
    const request = error.meta?.requestId ? ` (request ${error.meta.requestId})` : '';
    return `${error.code ?? error.kind}${status}${request}`;
  }
  return error instanceof Error ? error.message : 'unknown error';
}

/** Sends a request, retrying a GET or HEAD after a network error, 429, or 5xx with a short jittered backoff. */
export async function fetchRetryingReads(input: RequestInfo | URL, init?: RequestInit, send: typeof fetch = fetch): Promise<Response> {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const attempts = method === 'GET' || method === 'HEAD' ? READ_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt++) {
    let delay = 100 * 2 ** (attempt - 1) * (0.5 + Math.random());
    try {
      const response = await send(input, init);
      if (attempt >= attempts || !RETRY_STATUSES.has(response.status)) return response;
      const retryAfter = Number(response.headers.get('Retry-After'));
      if (retryAfter > MAX_RETRY_AFTER_SECONDS) return response;
      if (retryAfter > 0) delay = retryAfter * 1000;
      await response.body?.cancel();
    } catch (error) {
      if (attempt >= attempts || init?.signal?.aborted) throw error;
    }
    await pause(delay, init?.signal);
  }
}

function pause(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const stop = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}
