import { serve } from '@hono/node-server';
import { readConfig } from './config.ts';
import { createAuth, createClient, describeError, preflight } from './flint.ts';
import { Inbox } from './inbox.ts';
import { Worker } from './events.ts';
import { catchUp, scheduleCatchUp } from './catch-up.ts';
import { createApp } from './app.ts';

async function main() {
  const config = readConfig();
  if (!config.webhookSecrets.length) {
    throw new Error('FLINT_WEBHOOK_SECRET is not set. Run npm run setup -- --apply, or copy the secret printed by flint listen.');
  }
  const client = createClient(config.apiBaseUrl, config.sandboxGuard);
  const auth = createAuth(config.apiKey);
  const { sandboxId } = await preflight(client, auth, config.sandboxGuard);

  const inbox = new Inbox(config.databasePath);
  const worker = new Worker(inbox, { client, auth });
  const app = createApp({ client, inbox, secrets: config.webhookSecrets, onRecorded: () => worker.kick() });
  const server = serve({ fetch: app.fetch, port: config.port });
  worker.start();
  const stopCatchUp = scheduleCatchUp(
    () => catchUp({ client, auth, inbox, endpointId: config.endpointId, lookbackHours: config.catchUpLookbackHours }),
    config.catchUpIntervalSeconds,
    () => worker.kick(),
  );

  console.info(`Receiving at http://localhost:${config.port}/webhooks/flint (sandbox ${sandboxId}${config.endpointId ? `, endpoint ${config.endpointId}` : ''})`);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      server.close(() => {
        void Promise.all([stopCatchUp(), worker.stop()]).finally(() => {
          inbox.close();
          process.exit(0);
        });
      });
    });
  }
}

try {
  await main();
} catch (error) {
  console.error(`Startup failed: ${describeError(error)}`);
  process.exitCode = 1;
}
