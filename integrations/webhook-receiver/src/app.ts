import { Hono } from 'hono';
import type { Client } from '@flintpay/node';
import type { Inbox } from './inbox.ts';
import { MAX_BODY_BYTES, receive } from './receive.ts';

export type AppDeps = { client: Client; inbox: Inbox; secrets: readonly string[]; onRecorded?: () => void };

/**
 * The server exposes only the webhook route and a health check. A tunnel makes every route public, so the
 * inbox is inspected with `npm run webhooks -- status` instead of a web page.
 */
export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.post('/webhooks/flint', async (c) => {
    const length = Number(c.req.header('content-length'));
    if (length > MAX_BODY_BYTES) return c.json({ error: 'too_large' }, 413);
    // Read the raw bytes. Don't let a JSON body parser run on this route.
    const raw = new Uint8Array(await c.req.arrayBuffer());
    const result = receive(raw, c.req.raw.headers, deps);
    if (result.recorded) deps.onRecorded?.();
    return c.json(result.body, result.status as 200 | 400 | 413);
  });

  app.get('/healthz', (c) => c.json({ ok: true, mode: 'test' }));
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((_error, c) => c.json({ error: 'internal_error' }, 500));
  return app;
}
