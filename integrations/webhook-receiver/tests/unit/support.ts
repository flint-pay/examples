import { createHmac, randomBytes } from 'node:crypto';
import { Client } from '@flintpay/node';
import type { Envelope } from '../../src/events.ts';

/** A fresh signing secret for each test. Secrets are never committed, not even fake ones. */
export const newSecret = () => `whsec_${randomBytes(32).toString('base64')}`;

/** The real SDK client. verifyWebhook runs locally and makes no request. */
export const sdk = () => new Client({ baseUrl: 'https://api.staging.withflintpay.com' });

export function envelope(overrides: Partial<Envelope> & Record<string, unknown> = {}) {
  return {
    api_version: '2026-10-01',
    webhook_event_id: 'whev_example_one',
    event_type: 'order.paid',
    payload_version: 1,
    mode: 'test',
    merchant_id: 'mer_example',
    created_at: '2026-10-15T12:00:00Z',
    request: null,
    data: { order_id: 'ord_example_one' },
    ...overrides,
  };
}

/** Signs a body the way Flint does, with Standard Webhooks headers. */
export function signed(body: string, secret: string, options: { id?: string; timestamp?: number } = {}) {
  const id = options.id ?? (JSON.parse(body) as { webhook_event_id: string }).webhook_event_id;
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return {
    raw: new TextEncoder().encode(body),
    headers: new Headers({
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': `v1,${signature}`,
    }),
  };
}
