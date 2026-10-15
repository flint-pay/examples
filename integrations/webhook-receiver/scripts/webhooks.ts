import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readConfig } from '../src/config.ts';
import { createAuth, createClient, describeError, preflight } from '../src/flint.ts';
import { Inbox } from '../src/inbox.ts';
import { catchUp } from '../src/catch-up.ts';
import { processNext } from '../src/events.ts';
import { deliveryAttempts, failedDeliveries, resendDelivery, sendTestEvent } from '../src/deliveries.ts';

const USAGE = `Usage: npm run webhooks -- <command>

Local inbox
  status                       Events this app recorded, by status, and the fulfillments they produced
  catch-up                     Record handled events Flint has that this app missed, then process them
  requeue <webhook_event_id>   Process a recorded event again

Deliveries in Flint
  failed [--hours 72]          Deliveries Flint stopped retrying, with the last error
  attempts <webhook_delivery_id>
                               Every attempt for one delivery: status code, timing, and diagnosis
  resend <webhook_delivery_id> [--reason "text"]
                               Send the event to the endpoint again
  test-event [event_type]      Send a test event to the endpoint (default order.paid)`;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
function id(value: string | undefined, name: string): string {
  if (!value || !ID.test(value)) throw new Error(`Give a ${name}.\n\n${USAGE}`);
  return value;
}
const time = (value?: string | number | null) => (value ? new Date(value).toISOString().replace('.000Z', 'Z') : '');

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { hours: { type: 'string' }, reason: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  const [command, argument] = positionals;
  if (!command || values.help) {
    console.info(USAGE);
    return;
  }
  const config = readConfig();
  const inbox = new Inbox(config.databasePath);
  try {
    if (command === 'status') return status(inbox);
    if (command === 'requeue') {
      const eventId = id(argument, 'webhook_event_id');
      if (!inbox.requeue(eventId)) throw new Error(`${eventId} is not a recorded event that can be processed again. Test events and events without a payload can't.`);
      console.info(`${eventId} is queued. The running server processes it within a few seconds.`);
      return;
    }

    const client = createClient(config.apiBaseUrl, config.sandboxGuard);
    const auth = createAuth(config.apiKey);
    await preflight(client, auth, config.sandboxGuard);

    if (command === 'catch-up') {
      const result = await catchUp({ client, auth, inbox, endpointId: config.endpointId, lookbackHours: config.catchUpLookbackHours });
      console.info(`Listed ${result.listed} events since ${result.since}. Recorded ${result.recorded} new, ${result.unavailable} without a payload.`);
      let processed = 0;
      while (await processNext(inbox, { client, auth })) processed++;
      if (processed) console.info(`Processed ${processed} due events. Run status to see the outcomes.`);
    } else if (command === 'failed') {
      const hours = Number(values.hours ?? config.catchUpLookbackHours);
      if (!Number.isInteger(hours) || hours < 1 || hours > 336) throw new Error('--hours: use a whole number from 1 to 336');
      const found = await failedDeliveries({ client, auth }, { endpointId: config.endpointId, since: new Date(Date.now() - hours * 3_600_000), limit: 50 });
      if (!found.length) console.info(`No failed deliveries in the last ${hours} hours${config.endpointId ? ` for ${config.endpointId}` : ''}.`);
      for (const { event, delivery } of found) {
        console.info([
          `${delivery.webhook_delivery_id}  ${event.event_type}  ${event.webhook_event_id}  ${time(event.created_at)}`,
          `  ${delivery.automatic_attempt_count} of ${delivery.max_attempts} attempts, last response ${delivery.last_response_code ?? 'none'}${delivery.error_category ? `, ${delivery.error_category}` : ''}`,
          ...(delivery.error_summary ? [`  ${delivery.error_summary}`] : []),
          ...(delivery.recommended_action ? [`  Next: ${delivery.recommended_action}`] : []),
          `  Recorded here: ${inbox.event(event.webhook_event_id)?.status ?? 'no'}`,
        ].join('\n'));
      }
    } else if (command === 'attempts') {
      for (const attempt of await deliveryAttempts({ client, auth }, id(argument, 'webhook_delivery_id'))) {
        const duration = attempt.duration_milliseconds ? ` in ${attempt.duration_milliseconds} ms` : '';
        console.info(`#${attempt.attempt_number} ${attempt.delivery_trigger} ${attempt.status} ${attempt.status_code ?? ''}${duration}  ${time(attempt.started_at)}`);
        if (attempt.diagnostic_category || attempt.error_summary) console.info(`  ${[attempt.diagnostic_category, attempt.error_summary].filter(Boolean).join(': ')}`);
        if (attempt.recommended_action) console.info(`  Next: ${attempt.recommended_action}`);
      }
    } else if (command === 'resend') {
      const deliveryId = id(argument, 'webhook_delivery_id');
      const action = await resendDelivery({ client, auth }, inbox, deliveryId, values.reason);
      console.info(`Resend attempt ${action.attempt_number}: ${action.attempt_status}${action.status_code ? `, response ${action.status_code}` : ''}. Delivery is ${action.delivery_status}.`);
      if (inbox.event(action.webhook_event_id)) console.info(`This app already recorded ${action.webhook_event_id}, so the resend is a duplicate here. Use requeue to process it again.`);
    } else if (command === 'test-event') {
      if (!config.endpointId) throw new Error('Set FLINT_WEBHOOK_ENDPOINT_ID, or run npm run setup -- --apply. Test events go to a registered endpoint.');
      const eventType = argument ?? 'order.paid';
      if (!/^[a-z_]+(?:\.[a-z_]+)+$/.test(eventType)) throw new Error('Give an event type such as order.paid.');
      const action = await sendTestEvent({ client, auth }, config.endpointId, eventType);
      console.info(`Sent ${eventType} as ${action.webhook_event_id}: ${action.attempt_status}${action.status_code ? `, response ${action.status_code}` : ''}${action.error_summary ? `, ${action.error_summary}` : ''}.`);
    } else {
      throw new Error(`Unknown command ${command}.\n\n${USAGE}`);
    }
  } finally {
    inbox.close();
  }
}

function status(inbox: Inbox) {
  const { counts, recent, fulfillments } = inbox.summary();
  console.info(counts.length ? counts.map((row) => `${row.status}: ${row.count}`).join('   ') : 'No events recorded yet.');
  if (recent.length) console.info('\nRecent events');
  for (const row of recent) {
    const retry = row.status === 'pending' && row.attempts ? `, retry ${row.attempts + 1} at ${time(row.next_attempt_at)}` : '';
    console.info(`  ${time(row.received_at)}  ${row.webhook_event_id}  ${row.event_type}  ${row.source}  ${row.status}${retry}`);
    const detail = row.outcome ?? row.last_error;
    if (detail) console.info(`      ${detail}`);
  }
  if (fulfillments.length) console.info('\nFulfillments');
  for (const row of fulfillments) console.info(`  ${time(row.created_at)}  ${row.order_id}  from ${row.webhook_event_id}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(describeError(error));
    process.exitCode = 1;
  }
}
