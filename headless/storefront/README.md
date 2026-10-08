# Headless storefront

A merchant-owned store for a fictional coffee roaster, Cedar & Stone. It shows a catalog, a cart, and an embedded checkout that runs on your domain, with delivery or pickup, discount codes, gift cards, tips, saved cards, digital wallets, ACH debit, Affirm, and subscription signup. Flint hosts no part of the checkout.

This example uses the `@flintpay/node` 3.0.0 beta, so names and shapes can still change. It runs in test mode only.

## What it shows

- A catalog read from Flint and a local cart that becomes a Flint order when the buyer checks out.
- An embedded checkout session with contact details, discounts, delivery quotes and selections, pickup, a tip for pickup orders, gift cards, and a payment form built with Stripe Elements.
- Declines, 3D Secure, interrupted payments, and bank payments that settle later, handled from Flint's payment attempt state.
- Subscription checkout, including a free trial that collects a payment method without charging.
- A sample sign-in that proves the buyer's email with a Flint verification code, so a signed-in buyer's orders show up in the account example.

## Requirements

- Node.js 24 or later.
- A Flint sandbox with payments set up (`accept_card_payments` ready), and a sandbox test key (`flint_test_...`). The app reads the catalog and capabilities, creates orders and checkout sessions, and creates customers and customer verifications. The setup script needs write access to the resources it creates.
- Optional: `accept_affirm_payments`, ACH debit (activated by Flint support), and an automatic tax connection. Run `npm run setup -- --check` to see what your sandbox has.
- Optional: a registered HTTPS domain for Apple Pay and Google Pay. On `localhost`, the wallet area stays hidden and cards still work.
- Emails from Flint Pay show the sandbox's business name, which can differ from Cedar & Stone.

## Quick start

```bash
cp .env.example .env     # add FLINT_API_KEY
npm ci
npm run setup            # dry run: prints what would be created
npm run setup -- --apply # creates the sample catalog and checkout settings
npm run dev
```

Open http://localhost:4100. On a sandbox without the sample catalog, the home page asks you to run setup.

`FLINT_API_BASE_URL` is set to Flint's staging API in `.env.example`. Use the host that matches your key. The app exits if the key is a live key, or if `FLINT_SANDBOX_ID` is set and does not match the sandbox the key belongs to.

Setup changes your sandbox: it sets the default delivery methods and the enabled payment options. It prints the old values before it writes anything and only writes with `--apply`.

## How it works

Every page is rendered on the server with `hono/html`, and each buyer state has its own URL. A small amount of JavaScript in `public/js` adds the interactive parts: saving edits, refreshing sections, and the Stripe payment form. Stripe.js is loaded from `js.stripe.com`. Nothing else is loaded from a third party.

| Where | What it does |
| --- | --- |
| `src/flint/auth.ts` | The only place credential options are built. One credential mode per Flint call. |
| `src/flint/` | Catalog, checkout, and identity calls to Flint, and the buyer-safe view of what Flint returns |
| `src/payments/` | The payment attempt engine: start, resume, cancel, and what to do next |
| `src/identity/` | Email and password sign-in, sessions, and binding a buyer to a Flint customer |
| `src/views/` | Page templates. `renderPage(pageId, context)` in `src/views/index.ts` is the only entry point. |
| `src/copy.ts` | Every string a buyer sees |
| `public/` | The stylesheet, browser scripts, and product images |
| `scripts/setup.ts` | Creates and checks the sample catalog and sandbox settings |

### Credential boundary

- Your API key, checkout credentials, customer data, and Stripe client secrets stay on the server. The browser receives the Stripe publishable key, the connected account ID, and a client secret only in the response to the request that needs it, while a payment is waiting on an action.
- The browser sends your own references, such as a cart line or a checkout reference. The server finds the Flint IDs from its own records.
- A checkout reference in a URL routes the request. It is not permission: only the browser that started the checkout, or the signed-in buyer it belongs to, can open it.
- Every request that changes data checks the request origin and a per-session CSRF token. Every Flint change sends an idempotency key that the server stores before it sends the request.
- The browser never calls Flint. If the page sends a request to a Flint host, the acceptance tests fail.

### Money

Amounts are exact integer strings in minor units and are formatted with `Intl.NumberFormat`. The browser never adds up a total. It shows what the latest order read returns, and it sends the amount the buyer saw so the server can refuse a payment if the total changed.

### Interrupted payments

If a payment request gets no answer, the app keeps the original request and its idempotency key and never starts a second payment. The page then shows that your payment is being confirmed, freezes the cart, delivery, discount, gift card, and tip controls, and asks the app to continue with an empty `POST /checkout/:ref/resume`. The app replays the saved request; the page sends no new card details or approval. Each run sends at most three resume requests and reads status for at most about a minute, then shows "still confirming" with a Check again button. Check again starts a new run. A reload during the wait picks up the same state.

## Test cards and bank accounts

Use Stripe's test values.

| To test | Enter |
| --- | --- |
| Successful card | `4242 4242 4242 4242`, any future date, any CVC |
| Declined card | `4000 0000 0000 9995` |
| 3D Secure challenge | `4000 0025 0000 3155` |
| ACH debit | Routing `110000000`, account `000123456789` |

The discount code `WELCOME10` is created by setup.

## Webhooks

Webhooks are optional. The checkout reads order state from Flint and does not depend on them. To receive them locally:

```bash
flint listen --forward-to http://localhost:4100/webhooks/flint
```

Put the printed `whsec_...` value in `FLINT_WEBHOOK_SECRET`. With a secret set, the app verifies each event, ignores duplicates, and shows a "Payment confirmed by Flint" line on the confirmation page after a verified `order.paid` event.

## Tests

| Command | What it runs |
| --- | --- |
| `npm run check` | Type check and unit tests |
| `npm run test:integration` | Server tests against your sandbox |
| `npm run test:browser` | Browser tests, described below |

The browser tests come in two kinds that are different things:

- **Local state tests** (`tests/browser/local`) run the real page templates and browser scripts against an in-memory stand-in for the app's JSON requests and a stand-in for Stripe.js. They check what the page does with each state: loading, ready, declined, 3D Secure, waiting, bank processing, recovery, total changed, gift cards, layout, keyboard use, and escaping. They run by default and need no credentials. Passing them does not show that Flint or Stripe behave this way.
- **Staging acceptance tests** (`tests/browser/acceptance`) drive a running copy of this app against a sandbox with real Stripe.js in test mode. They run only when you opt in:

  ```bash
  STOREFRONT_ACCEPTANCE=1 APP_ORIGIN=http://localhost:4100 npm run test:browser
  ```

  They refuse to run unless `/healthz` reports test mode, and they fail if the browser calls a Flint host. Checks that need Flint's own records, such as the number of payment attempts, live in `headless/e2e`.

Traces, screenshots, and videos are off and the reporter prints to the terminal only, because the pages and forms involved carry buyer and payment details. The local state suite also runs `@axe-core/playwright` when it is installed; it is an `e2e` dependency, so install it with `npm install --no-save @axe-core/playwright` to include the accessibility scan.

Playwright needs a browser: `npx playwright install chromium`.

## Before production

This is starter code. Before you take real payments:

- Serve it over HTTPS. Wallets need a registered HTTPS hostname.
- Encrypt the stored checkout credentials and customer data, or keep them in a secret store. The starter keeps them in SQLite files in `./data`.
- Rotate keys, and restrict the key's scopes to what the app uses.
- Review the Content Security Policy in `src/security/headers.ts` against Stripe's published directives, and keep an inventory of the scripts on your payment pages.
- Replace the sample sign-in with your own identity system. You still need the Flint verification ID to link a buyer's earlier guest orders.
- Use the API host that matches your key. Live keys need the live API host.

## Limitations

- The SDK is a beta.
- Challenged gift card lookups depend on a Flint contract that merchant-hosted pages cannot complete yet. The app shows that gift card codes can't be checked right now.
- Gift card recipient delivery is hosted by Flint. The storefront redeems gift cards at checkout and does not sell them or host the page a recipient opens from the gift card email.
- Apple Pay and Google Pay are offered after delivery is chosen on the page. Changing the shipping address inside the wallet sheet is not supported.
- The sample sign-in is not a production identity system.
- ACH debit needs settings that only Flint support can turn on, so it can be unavailable even when a card works.
- Pickup locations are listed as Flint returns them for a postal code. The distance to each location is not shown.

## Guides

- [Build your own checkout](https://developers.withflintpay.com/docs/guides/headless-checkout)
- [Securing a headless checkout](https://developers.withflintpay.com/docs/guides/headless-checkout-security)
- [Declines and payment attempts](https://developers.withflintpay.com/docs/guides/declines-and-payment-attempts)
- [Build a headless storefront](https://developers.withflintpay.com/docs/guides/headless-storefront)
