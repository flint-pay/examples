import { randomUUID } from 'node:crypto';
import { SdkError } from '@flintpay/node';
import type { Client, CreateWebhookTestEventRequestInput, WebhookDelivery, WebhookDeliveryAction, WebhookDeliveryAttempt, WebhookEvent } from '@flintpay/node';
import type { Auth } from './flint.ts';
import type { Inbox } from './inbox.ts';

type Deps = { client: Client; auth: Auth };

/**
 * Events with a delivery that Flint gave up on, and those deliveries. A delivery fails after its last automatic
 * attempt, about three days after the event. With an endpoint ID, only that endpoint's deliveries are returned.
 */
export async function failedDeliveries({ client, auth }: Deps, options: { endpointId?: string; since: Date; limit: number }) {
  const found: Array<{ event: WebhookEvent; delivery: WebhookDelivery }> = [];
  const events = client.webhookEvents.listItems({
    page_size: 100,
    delivery_status: ['failed'],
    created_after: options.since.toISOString(),
    ...(options.endpointId ? { webhook_endpoint_id: options.endpointId } : {}),
  }, auth.merchant());
  for await (const event of events) {
    const deliveries = await client.webhookEvents.listWebhookDeliveries({ webhook_event_id: event.webhook_event_id, page_size: 100 }, auth.merchant());
    for (const delivery of deliveries.data) {
      if (delivery.status !== 'failed') continue;
      if (options.endpointId && delivery.webhook_endpoint_id !== options.endpointId) continue;
      found.push({ event, delivery });
    }
    if (found.length >= options.limit) break;
  }
  return found.slice(0, options.limit);
}

/** Every attempt Flint made for one delivery, oldest first, with the status code and diagnosis for each. */
export async function deliveryAttempts({ client, auth }: Deps, webhookDeliveryId: string): Promise<WebhookDeliveryAttempt[]> {
  const attempts: WebhookDeliveryAttempt[] = [];
  for await (const attempt of client.webhookDeliveries.listAttemptsItems(webhookDeliveryId, { page_size: 100 }, auth.merchant())) attempts.push(attempt);
  return attempts.sort((a, b) => a.attempt_number - b.attempt_number);
}

/**
 * Asks Flint to send the event again to the endpoint's current URL. The idempotency key is saved before the
 * request. If the answer is lost, running the same command again replays the saved key instead of sending a
 * second resend. Once Flint answers, the key is cleared so a later resend is a new request.
 *
 * The resent event keeps its webhook_event_id. If this app already recorded the event, the inbox treats the
 * resend as a duplicate; use `requeue` to process a recorded event again.
 */
export async function resendDelivery({ client, auth }: Deps, inbox: Inbox, webhookDeliveryId: string, reason?: string): Promise<WebhookDeliveryAction> {
  const key = inbox.resendKey(webhookDeliveryId, () => `examples-webhook-resend-${randomUUID()}`);
  try {
    const action = await client.webhookDeliveries.resend(webhookDeliveryId, reason ? { reason_message: reason } : {}, auth.merchant(key));
    inbox.finishResend(webhookDeliveryId);
    return action;
  } catch (error) {
    // Keep the key when the outcome is unknown, so the retry can't resend twice.
    if (error instanceof SdkError && error.outcome !== 'unknown') inbox.finishResend(webhookDeliveryId);
    throw error;
  }
}

/** Asks Flint to send a small fixture event to the endpoint now. Test events are delivered once and never retried. */
export async function sendTestEvent({ client, auth }: Deps, endpointId: string, eventType: string): Promise<WebhookDeliveryAction> {
  return client.webhookEndpoints.createWebhookTestEvent(
    endpointId,
    { event_type: eventType as CreateWebhookTestEventRequestInput['event_type'] },
    auth.merchant(`examples-webhook-test-${randomUUID()}`),
  );
}
