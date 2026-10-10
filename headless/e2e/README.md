# Headless storefront and account acceptance

This package holds the acceptance harness for the headless storefront and account examples. It drives the real apps in Chromium against two Flint staging sandboxes, reads a real inbox, and uses the published `@flintpay/node` package pinned to `3.0.0-beta.20261009223830`. It runs on Node 24 with no build step.

**Status: no staging, API, provider, browser, or email run has been executed.** What exists today is code that type checks, static checks of the scenario inventory, and unit tests that use injected clients. Those tests exercise the harness's own safeguards. They are not acceptance evidence, and a passing unit run never counts as a row passing.

## What it covers

The inventory has 59 entries: the 52 settled acceptance rows in `scenarios/matrix.json` and seven supplemental entries (`SF-05Z1`, `SF-05Z2`, `SF-05Z3`, `SF-GIFTCHALLENGE`, `SF-ACH-MICRODEP`, `AC-15API`, `AC-GIFTCHALLENGE`). Every row ends in one of `PASS`, `FAIL`, `BLOCKED`, or `NOT RUN`. A row that depends on an unresolved prerequisite is `NOT RUN`. A skipped test is never `PASS`, and a run that leaves rows unexecuted exits unsuccessfully. Only a user-accepted exception recorded in the private fixture file can exclude a row. This README records none.

Two rows stay gated by design:

- `AC-15` replays a superseded refresh token that the account app holds in its own database. That needs extracting an application session, which this harness does not do. It stays `NOT RUN` under `PRQ-REFRESH-REPLAY`.
- `AC-16` revokes a public customer session you supply and checks that the old secret is refused. It does not prove that the account app's own sign-out revokes the exact secret it held. That evidence gate remains open.

`AC-15API` is a separate supplemental entry. It mints its own public customer session, refreshes it, replays the superseded token, and checks that only that session family is revoked. It does not prove `AC-15`.

## Install and check

```sh
npm ci --prefix headless/e2e
(cd headless/e2e && npx playwright install chromium)
npm run check --prefix headless/e2e
npm test --prefix headless/e2e
```

`npm run check` runs the type check and the static inventory check. `npm test` runs the unit tests. Neither creates a fixture or contacts a service.

## Configuration

The parent process injects every variable from private configuration. The harness never loads `.env` files. [.env.example](.env.example) lists the names with placeholder values.

Keep the populated fixture manifest and every run file in an absolute directory outside this checkout. The directory must be owned by the current user with mode 0700, and files must be mode 0600. [fixtures/manifest.example.json](fixtures/manifest.example.json) is the placeholder template. `E2E_RUN_ID` and the manifest's `run` must match. Use a fresh `{yyyymmddThhmmssZ}-{8hex}` ID and keep it for reconciliation.

The harness uses separate keys and never shares them between roles:

| Variable | Role |
|---|---|
| `E2E_SANDBOX_A_API_KEY`, `E2E_SANDBOX_B_API_KEY` | Narrow keys for the apps. They must not hold a wildcard scope or `commerce.gift_cards.secrets.write`. Each app process receives only its own key. |
| `E2E_OPERATOR_A_API_KEY` | Required. Fixture and operator authority for sandbox A, including gift card issuing. It differs from both app keys and is never passed to an app process. |
| `E2E_OPERATOR_B_API_KEY` | Optional. When absent, the narrow B key performs sandbox B operations. |

All keys must be test keys. The harness reads each key's public authentication context and checks merchant, sandbox, and test mode. Provider account IDs are attested by the parent because the public context does not expose them. API requests are pinned to `https://api.staging.withflintpay.com`. The harness rejects live credentials, private RPC, first-party headers, and redirects from SDK requests.

Gift card funding uses a real customer as the buyer. Supply `giftFundingCustomerId`, or `giftFundingBuyerEmail` so the harness creates and immediately records a run-owned customer. Synthetic run IDs are refused.

## Source and build checks

Before any launch or write, the harness checks that the checkout is clean, that `HEAD` equals `E2E_TARGET_COMMIT`, and that each app's artifact label is `<sha>:headless/storefront` or `<sha>:headless/account`. The API has its own candidate, `E2E_API_TARGET_COMMIT`, and artifact, `E2E_API_ARTIFACT_ID`.

Health checks default to `/healthz` on the apps and `/health` on the API. Override them with the `E2E_*_HEALTH_PATH` variables. A response must include `build: { sha, artifactId, startedAt }` that matches. A healthy response without matching build identity cannot establish that the candidate was tested.

## Commands

Run these from the checkout root with the injected environment. Every command that changes anything needs `--apply`.

```sh
npm run fixtures --prefix headless/e2e -- --dryrun
npm run fixtures:check --prefix headless/e2e
npm run fixtures --prefix headless/e2e -- --apply
npm run apps --prefix headless/e2e -- --apply
npm run e2e --prefix headless/e2e -- --apply
npm run fixtures --prefix headless/e2e -- --apply --cleanup
```

- `fixtures --dryrun` validates the private operator plan without API requests.
- `fixtures:check` makes read-only SDK requests and fails when a prerequisite for the selected schedule is unresolved.
- `fixtures --apply --reconcile` resolves an unknown action by replaying its original request and key.
- `apps --apply` starts only the storefront, account, and second-sandbox storefront processes and shuts down the children it started. Coordinate service ownership with the parent first. Sandbox A's two apps share a temporary identity database and the `cedar_session` cookie. Sandbox B has its own database and cookie. You can test externally managed endpoints without this launcher.
- `e2e --apply` runs the rows. `E2E_SUITE=standard` marks extended rows `NOT RUN`. `E2E_SUITE=extended` runs them too.
- `browser:staging -- --apply --app storefront|account` runs one app's browser suite for the root CI jobs, using `single-app.config.ts`. It borrows the shared fixtures and records only what it creates. It starts no local stand-in server. The account suite is signed-out smoke only, and full account journeys belong to `e2e`.
- `scripts/account-integration.ts --apply` is the account API check that the root runner calls. It mints a public customer session for a run-owned disposable customer, reads buyer resources, refreshes, and revokes through the public API. It does not cover account sign-in, email, the H1 and H2 payment flows, or provider journeys.

A sandbox-pair lock serializes runs on one host. Root CI must serialize the same pair across hosts.

## Run lifecycle and cleanup

Every action's request and durable key are written to the private ledger before they are sent, and every returned resource is recorded before the run continues, including after partial failures. A lost response leaves an unknown action. Reconcile it with the original request. Never create a replacement action to avoid an unknown outcome.

Cleanup covers subscriptions, invoices, checkout sessions, customer sessions, cards, gifts, resolutions, and settings. Settings change only with explicit run-owned authority and a saved snapshot, and a concurrent change stops restoration. Resources marked `ownedByRun: false` are read-only. Any unknown outcome, missing resource, or failed supported cleanup makes teardown incomplete. Unsupported cleanup needs a named owner and a review or expiry date before creation.

Child processes are tracked. Their output is scanned for credentials and discarded. A failed suite, interrupt, startup or build failure, early exit, or failed cleanup cannot produce a pass.

## Email

Use `E2E_INBOX=imap` with IMAP values for TLS on port 993, or operator mode. The IMAP adapter matches the exact recipient alias and receive time, reads MIME locally, and never deletes mail. In operator mode the harness writes a private `inbox-request.json` and waits for a private `inbox-response.json` with the nonce, the exact recipient, receive time, subject, sender, codes, and links from the real inbox. Operator observations are recorded separately from automatic retrieval. Without a mailbox, every email-dependent row stays `NOT RUN`.

Every email link is classified by pure rules, with the family set by the harness for the trigger that produced the mail:

- **Merchant app links** on the run's app origins pass.
- **Account and email preference relays** on the pinned staging API origin (`/account/...` and `/email-preferences/...`) pass only in families that send them, with the exact path shape and query. Opening one is allowed only as a main-frame GET to a URL audited from this run's email. It must return a redirect with no rendered page and land on the right merchant page within ten seconds. Preference tokens must arrive in the fragment only.
- **The brand credit** `https://withflintpay.com/`, with no query or fragment, is recorded and never followed.
- **The gift card recipient link** is recorded only. Exactly one is expected in a `gift_card_notification` email, with the exact staging checkout origin, `/gift-cards/gcg_` plus 26 characters, `?mode=test`, and a `token=` fragment. It is never opened, fetched, logged, or written to results. The same link shape in any other family fails.
- Any other Flint host or path, and any unknown external host, fails.

## Browser boundary

Every browser context blocks service workers and guards frames and popups. Requests to a Flint host fail. The only navigation allowances are the exact staging `/payment-returns/{id}` relay and the audited email relays above. Each names one origin, one path shape, one source, and one destination. There is no host-wide allowance and no allowance for a Flint checkout, account, or gift recipient page. Document downloads must stay on the merchant origin.

Responses, storage, cookies, the DOM, requests, URLs, console output, and child output are scanned for Flint authority. Short-lived Stripe client authority is allowed only in the payment and setup responses that need it and in Stripe transport.

No trace, screenshot, video, HAR, HTML report, or raw JSON reporter is enabled, and nothing is uploaded. Only normalized results and request IDs are reported. `acceptance.json`, `readiness.json`, and `ledger.json` are private artifacts.

## Open gates

These are recorded once as prerequisites. Rows that depend on them are `NOT RUN`.

- **Runtime, source, and SDK:** a reachable staging runtime at the candidate build, a clean reviewed source checkout at the target commit, and the pinned SDK installed.
- **Absent account settings restoration:** the pinned SDK accepts and preserves `customer_account: null`. The account setup script snapshots an absent `customer_account` as explicit absence and restores it by sending explicit `null`. It validates the restore request locally before any settings write.
- **Gift card challenge:** `PRQ-GIFT-CHALLENGE` stays unresolved until a published SDK carries the public challenge flow and it is installed and verified. The harness has the guarded row and no way around the challenge.
- **Sandbox readiness:** card and Affirm admission, ACH settlement and debit-email readiness, automatic tax, and workers, attested by the parent. A readiness statement expires after 24 hours.
- **Device wallets** need a real Safari or Chrome wallet flow with an operator. **Microdeposit ACH** is outside the supported matrix and is never faked. ACH uses actual instant verification.
