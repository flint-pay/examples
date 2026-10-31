import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Client, WebhookEndpoint } from '@flintpay/node';
import { readConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { createAuth, createClient, describeError, preflight } from '../src/flint.ts';
import type { Auth } from '../src/flint.ts';
import { handledEventTypes } from '../src/events.ts';
import { updateEnvFile } from '../src/env-file.ts';

const ENV_PATH = fileURLToPath(new URL('../.env', import.meta.url));
const DESCRIPTION = 'Flint examples webhook receiver';

export type Step =
  | { kind: 'create'; url: string; events: string[] }
  | { kind: 'update'; changes: { url?: string; enabled_events?: string[]; status?: 'active'; expected_version?: `${bigint}` } }
  | { kind: 'rotate' }
  | { kind: 'save_endpoint_id' }
  | { kind: 'needs_secret' };

/**
 * Decides what setup does, without calling Flint. An endpoint is matched by FLINT_WEBHOOK_ENDPOINT_ID first,
 * then by URL. A tunnel that restarted with a new URL updates the endpoint instead of adding a second one.
 */
export function planSetup(input: { endpoint?: WebhookEndpoint; url: string; savedEndpointId?: string; hasSecret: boolean; rotate: boolean }): Step[] {
  const { endpoint, url } = input;
  if (!endpoint) return [{ kind: 'create', url, events: [...handledEventTypes] }];
  const steps: Step[] = [];
  const changes: { url?: string; enabled_events?: string[]; status?: 'active'; expected_version?: `${bigint}` } = {};
  if (endpoint.url !== url) changes.url = url;
  // A wildcard means every event. Otherwise add the types this app handles.
  const missing = handledEventTypes.filter((type) => !endpoint.enabled_events.includes('*') && !endpoint.enabled_events.includes(type));
  if (missing.length) changes.enabled_events = [...endpoint.enabled_events, ...missing];
  if (endpoint.status !== 'active') changes.status = 'active';
  if (changes.enabled_events) changes.expected_version = endpoint.version;
  if (Object.keys(changes).length) steps.push({ kind: 'update', changes });
  const known = input.savedEndpointId === endpoint.webhook_endpoint_id;
  if (!known) steps.push({ kind: 'save_endpoint_id' });
  // Flint shows a secret only when the endpoint is created. A secret in .env for another endpoint, or from
  // flint listen, won't verify this endpoint's deliveries. Rotating is the way to get a new one.
  if (input.rotate) steps.push({ kind: 'rotate' });
  else if (!input.hasSecret || !known) steps.push({ kind: 'needs_secret' });
  return steps;
}

function describe(step: Step, endpoint?: WebhookEndpoint): string {
  switch (step.kind) {
    case 'create': return `Create a webhook endpoint for ${step.url}, subscribed to ${step.events.join(', ')}, and save its ID and signing secret to .env`;
    case 'update': return `Update endpoint ${endpoint?.webhook_endpoint_id}: ${Object.entries(step.changes).map(([name, value]) => `${name} = ${JSON.stringify(value)}`).join(', ')}`;
    case 'rotate': return `Rotate the signing secret of endpoint ${endpoint?.webhook_endpoint_id}. The new secret goes to FLINT_WEBHOOK_SECRET and the current one to FLINT_WEBHOOK_PREVIOUS_SECRET. Flint signs with both for 24 hours.`;
    case 'save_endpoint_id': return `Save FLINT_WEBHOOK_ENDPOINT_ID=${endpoint?.webhook_endpoint_id} to .env`;
    case 'needs_secret': return `.env has no signing secret saved for endpoint ${endpoint?.webhook_endpoint_id}, and Flint shows a secret only once. Run again with --apply --rotate-secret to get a new one.`;
  }
}

/** The same URL and sandbox always produce the same key, so a repeated create returns the first endpoint. */
const createKey = (sandboxId: string, url: string) =>
  `examples-webhook-receiver-${sandboxId}-${createHash('sha256').update(url).digest('hex').slice(0, 16)}-v1`;

async function findEndpoint(client: Client, auth: Auth, config: Config): Promise<WebhookEndpoint | undefined> {
  if (config.endpointId) return client.webhookEndpoints.get(config.endpointId, {}, auth.merchant());
  for await (const endpoint of client.webhookEndpoints.listItems({ page_size: 100 }, auth.merchant())) {
    if (endpoint.url === config.webhookUrl) return endpoint;
  }
  return undefined;
}

async function main() {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, 'rotate-secret': { type: 'boolean' } } });
  const config = readConfig();
  if (!config.webhookUrl) {
    throw new Error([
      'Set WEBHOOK_URL in .env to the public https URL of this app, ending in /webhooks/flint.',
      'Flint refuses localhost and private addresses. Put a tunnel in front of the app, for example',
      `  cloudflared tunnel --url http://localhost:${config.port}`,
      'or skip setup and use the Flint CLI instead:',
      `  flint listen --forward-to http://localhost:${config.port}/webhooks/flint`,
    ].join('\n'));
  }
  const client = createClient(config.apiBaseUrl, config.sandboxGuard);
  const auth = createAuth(config.apiKey);
  const { sandboxId } = await preflight(client, auth, config.sandboxGuard);
  const endpoint = await findEndpoint(client, auth, config);
  const steps = planSetup({
    endpoint,
    url: config.webhookUrl,
    savedEndpointId: config.endpointId,
    hasSecret: config.webhookSecrets.length > 0,
    rotate: values['rotate-secret'] === true,
  });

  console.info(`Sandbox ${sandboxId}`);
  if (!steps.length) {
    console.info(`Endpoint ${endpoint!.webhook_endpoint_id} already posts to ${config.webhookUrl}. Nothing to change.`);
    return;
  }
  for (const step of steps) console.info(`- ${describe(step, endpoint)}`);
  if (!values.apply) {
    console.info('\nDry run. Nothing was changed. Run npm run setup -- --apply to make these changes.');
    return;
  }

  let endpointId = endpoint?.webhook_endpoint_id;
  for (const step of steps) {
    if (step.kind === 'create') {
      const created = await client.webhookEndpoints.create(
        { url: step.url, enabled_events: step.events, description: DESCRIPTION, status: 'active', signing_methods: ['hmac'] },
        auth.merchant(createKey(sandboxId, step.url)),
      );
      if (!created.secret) throw new Error(`Endpoint ${created.webhook_endpoint_id} was created, but no secret was returned. Run again with --rotate-secret.`);
      endpointId = created.webhook_endpoint_id;
      updateEnvFile(ENV_PATH, { FLINT_WEBHOOK_ENDPOINT_ID: endpointId, FLINT_WEBHOOK_SECRET: created.secret, FLINT_WEBHOOK_PREVIOUS_SECRET: null });
      console.info(`Created endpoint ${endpointId}. Its ID and signing secret are in .env.`);
    } else if (step.kind === 'update') {
      await client.webhookEndpoints.update(endpointId!, step.changes, auth.merchant(`examples-webhook-update-${randomUUID()}`));
      console.info(`Updated endpoint ${endpointId}.`);
    } else if (step.kind === 'save_endpoint_id') {
      updateEnvFile(ENV_PATH, { FLINT_WEBHOOK_ENDPOINT_ID: endpointId! });
      console.info('Saved FLINT_WEBHOOK_ENDPOINT_ID to .env.');
    } else if (step.kind === 'rotate') {
      // Keyed by the current secret: if the answer is lost, running again replays this rotation instead of starting another.
      const current = config.webhookSecrets[0];
      const key = current ? `examples-webhook-rotate-${createHash('sha256').update(current).digest('hex').slice(0, 24)}` : `examples-webhook-rotate-${randomUUID()}`;
      const rotated = await client.webhookEndpoints.rotateWebhookSecret(endpointId!, {}, auth.merchant(key));
      if (!rotated.secret) throw new Error('Rotation returned no signing secret. The saved secret was kept.');
      updateEnvFile(ENV_PATH, { FLINT_WEBHOOK_SECRET: rotated.secret, FLINT_WEBHOOK_PREVIOUS_SECRET: current ?? null });
      console.info('Rotated the signing secret and saved it to .env. Remove FLINT_WEBHOOK_PREVIOUS_SECRET after 24 hours.');
    }
  }
  console.info('\nRestart npm run dev to use the new settings. Then send a test event: npm run webhooks -- test-event');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(describeError(error));
    process.exitCode = 1;
  }
}
