# Webhook receiver

A small server that receives Flint webhooks the way a production integration should. It verifies each delivery against the raw bytes, records the event once before it answers, does the work later from a local inbox with retries, finds events it missed, and shows you why a delivery failed so you can send it again.

The example acts on one event, `order.paid`, and records a fulfillment for the order. Replace that handler with your own work.

This example uses the `@flintpay/node` 3.0.0 beta, so names and shapes can still change. It runs in test mode only.

## What it shows

- Signature verification with `client.verifyWebhook` on the original request bytes, with a previous secret accepted during a rotation.
- Deduplication on `webhook_event_id`. Flint sends the same ID on every retry and every resend, and the events API lists the same ID, so one primary key covers live deliveries and catch-up.
- Verify, record, acknowledge. The response is sent after the event is committed to SQLite and before any work runs, well inside Flint's 10-second limit. Unhandled event types and test events still get a 2xx.
- A handler that treats the event as a signal: it reads the order again and acts on what Flint returns now, so late, repeated, or out-of-order events do no harm.
- Side effects keyed by the business object (the order), not by the event.
- Background processing with backoff, and a failed state for events that need a person.
- Catch-up with `webhookEvents.list` and `webhookEvents.get` for events that never arrived, for example while the server was down or a tunnel URL changed.
- Failed deliveries, their attempts, and resends with `webhookEvents.listWebhookDeliveries`, `webhookDeliveries.listAttempts`, and `webhookDeliveries.resend`.
- Endpoint registration, URL updates, and secret rotation with `webhookEndpoints`.

## Requirements

- Node.js 24 or later.
- A Flint sandbox and a sandbox test key (`flint_test_...`) with these scopes:

  | Scope | Used for |
  | --- | --- |
  | `webhooks.read` | Catch-up, failed deliveries, and attempts |
  | `webhooks.write` | Setup, secret rotation, resends, and test events |
  | `commerce.orders.read` | Reading the order in the `order.paid` handler. Flint also needs it to include an order event's payload in catch-up. |

- One way for events to reach the app:
  - the Flint CLI (`flint listen`), which needs nothing public, or
  - a public HTTPS URL, such as a tunnel, registered as a webhook endpoint. Flint refuses `localhost` and private addresses.

## Quick start with the Flint CLI

`flint listen` streams your sandbox's events and forwards them to a local URL, signed with a secret it makes for that run.

```bash
cp .env.example .env     # add FLINT_API_KEY
npm ci
flint listen --forward-to http://localhost:4500/webhooks/flint
```

Copy the `whsec_...` secret it prints into `FLINT_WEBHOOK_SECRET` in `.env`, then start the app in another terminal:

```bash
npm run dev
```

Pay for an order in the sandbox, for example with the headless storefront example, and watch the app log `webhook_recorded` and then `webhook_processed`. Run `npm run webhooks -- status` to see the inbox.

`flint listen` makes a new secret each time it starts, so update `.env` and restart the app when you restart it. It starts from the newest event and does not replay older ones. The app's catch-up finds `order.paid` events from before it started.

## Quick start with a registered endpoint

```bash
cp .env.example .env     # add FLINT_API_KEY
npm ci
npm run dev
cloudflared tunnel --url http://localhost:4500    # or ngrok http 4500
```

Set `WEBHOOK_URL` in `.env` to the printed `https://` host followed by `/webhooks/flint`, then:

```bash
npm run setup            # dry run: prints what would change
npm run setup -- --apply # creates the endpoint and saves its ID and secret to .env
```

Restart `npm run dev` so it loads the secret, and send a test event:

```bash
npm run webhooks -- test-event
```

Setup subscribes the endpoint to `order.paid` only. It writes the signing secret to `.env` and never prints it. When a tunnel restarts with a new URL, change `WEBHOOK_URL` and run setup again. It updates the saved endpoint instead of adding another one.

If setup finds an endpoint for your URL that `.env` has no secret for, it says so. Flint shows a secret only once, so run `npm run setup -- --apply --rotate-secret` to get a new one.

## How it works

```
Flint ──POST──▶ /webhooks/flint ──verify──▶ inbox (SQLite) ──2xx──▶ Flint
                                                  │
events API ──catch-up──────────────────────────▶  │
                                                  ▼
                                worker: read the order, record a fulfillment
```

| Where | What it does |
| --- | --- |
| `src/receive.ts` | Verify, check the envelope, record, and choose the response |
| `src/inbox.ts` | The event table and its states, leases, retry times, and the fulfillment table |
| `src/events.ts` | The `order.paid` handler and the background worker |
| `src/catch-up.ts` | Finds events that never arrived and records them in the same inbox |
| `src/deliveries.ts` | Failed deliveries, attempts, resends, and test events |
| `src/flint.ts` | The SDK client, credential options, and the sandbox check |
| `src/app.ts` | The HTTP routes: `POST /webhooks/flint` and `GET /healthz` |
| `scripts/setup.ts` | Registers or updates the endpoint and rotates its secret |
| `scripts/webhooks.ts` | The operator commands below |

### Receiving

1. The route reads the body as bytes. Nothing parses it first, because re-serialized JSON no longer matches the signature.
2. `client.verifyWebhook` checks the signature, the timestamp (five minutes of tolerance), and the `webhook-id` header. A failure returns 400 and logs only the error code.
3. The app checks that the body is a Flint event, that its `webhook_event_id` matches the `webhook-id` header, and that `mode` is `test`.
4. The event is inserted with `webhook_event_id` as the primary key. A second delivery of the same event changes nothing and gets `{"received": true, "duplicate": true}`.
5. The app answers 200 after the insert commits. If the process stops before that, Flint delivers the event again.

Event types without a handler, and test events, are recorded as `ignored` and still get a 200. Test events carry small fixtures instead of real orders, so they are never processed.

### Processing

The worker takes due events from the inbox one at a time with a one-minute lease, so the server and a command like `catch-up` never process the same event at once. The `order.paid` handler reads the order from Flint. If it is paid, it inserts a fulfillment keyed by `order_id`, in the same transaction that marks the event processed. A second event for the same order finds the fulfillment and records `already fulfilled`.

A failed read is retried after 30 seconds, then with doubling delays up to an hour, for up to 10 attempts. An order that doesn't exist, or an event without an order ID, fails at once. Failed events wait for `npm run webhooks -- requeue <webhook_event_id>`.

### Catching up

At startup and every `CATCH_UP_INTERVAL_SECONDS` (default 300, `0` runs it at startup only), the app lists `order.paid` events created since its last run, with ten minutes of overlap. On the first run it looks back `CATCH_UP_LOOKBACK_HOURS` (default 72, at most 336). With `FLINT_WEBHOOK_ENDPOINT_ID` set, only events that had a delivery to that endpoint are listed.

The list has no payloads, so each event the inbox doesn't have is read by ID and recorded with source `catch_up`. If Flint returns no payload, for example because the key can't read orders, the event is recorded as `unavailable`. A later delivery of the same event fills it in.

The cursor moves only after a complete run, so a failed run is repeated from the same point.

### Failed deliveries and resends

Flint makes up to 9 attempts at a delivery over about three days, then marks it failed. To see why:

```bash
npm run webhooks -- failed                 # deliveries Flint stopped retrying, with the last error
npm run webhooks -- attempts <delivery_id> # status code, timing, and diagnosis for each attempt
npm run webhooks -- resend <delivery_id> --reason "fixed the route"
```

A resend keeps the event's `webhook_event_id`. If the app already recorded the event, the resend is a duplicate and is not processed again. Use `requeue` for that. Each resend saves its idempotency key before the request. If the answer is lost, running the same command again replays that request instead of sending a second resend.

### Rotating the signing secret

```bash
npm run setup -- --apply --rotate-secret
```

The new secret goes to `FLINT_WEBHOOK_SECRET` and the current one moves to `FLINT_WEBHOOK_PREVIOUS_SECRET`. Restart the app. Flint signs deliveries with both secrets for 24 hours, and the app accepts either. Remove `FLINT_WEBHOOK_PREVIOUS_SECRET` after that.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the receiver on port 4500 and restarts it when code changes |
| `npm run setup` | Registers or updates the webhook endpoint. Dry run unless you add `--apply`. |
| `npm run webhooks -- status` | Recorded events by status, recent outcomes and errors, and fulfillments |
| `npm run webhooks -- catch-up` | Runs catch-up now and processes what is due |
| `npm run webhooks -- requeue <webhook_event_id>` | Processes a recorded event again |
| `npm run webhooks -- failed [--hours 72]` | Failed deliveries in Flint |
| `npm run webhooks -- attempts <webhook_delivery_id>` | Attempts for one delivery |
| `npm run webhooks -- resend <webhook_delivery_id>` | Sends the event to the endpoint again |
| `npm run webhooks -- test-event [event_type]` | Sends a test event to the endpoint |

The server exposes only the webhook route and `/healthz`. A tunnel makes every route public, so the inbox is shown by these commands instead of a web page.

## Tests

| Command | What it runs |
| --- | --- |
| `npm run check` | Type check and unit tests |
| `npm test` | Unit tests |
| `npm run test:integration` | Reads events and deliveries from the sandbox in `.env`. With `FLINT_WEBHOOK_ENDPOINT_ID` set, it also sends one test event. Requires `FLINT_SANDBOX_ID`. |

The unit tests sign requests the way Flint does and verify them with the real SDK. They need no credentials. Flint's API is replaced by stand-ins in the unit tests, so passing them doesn't show that Flint behaves this way. The integration tests have not yet been run against a sandbox.

## Before production

This is starter code. Before you rely on it:

- Replace the `order.paid` handler with your own work, and keep each side effect idempotent under a business key.
- Put the inbox in your own database or queue. SQLite in `./data` suits one process.
- Alert on events in the `failed` and `unavailable` states and on failed deliveries in Flint.
- Restrict the key to the scopes above. Live keys need the live API host, and this example refuses them.
- Decide how long to keep processed events. Keep their IDs at least as long as Flint can still deliver or resend them.

## Limitations

- The SDK is a beta.
- Only `order.paid` has a handler. Catch-up lists only the event types that have one.
- Catch-up can't read events whose payload Flint no longer has. Keep the lookback within 14 days.
- One server process is assumed. The leases also cover a second process using the same database file, but SQLite isn't meant for many writers.

## Guides

- [Webhooks](https://developers.withflintpay.com/docs/guides/webhooks)
