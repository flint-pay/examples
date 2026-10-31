# Headless storefront (Next.js)

The [headless storefront](../storefront/) rebuilt with the Next.js App Router. It is the same fictional coffee roaster, Cedar & Stone, with the same features: a catalog, a cart, and an embedded checkout on your domain with delivery or pickup, discount codes, gift cards (including the gift card check), tips, saved cards, digital wallets, ACH debit, Affirm, and subscription signup with free trials. Flint hosts no part of the checkout.

This example uses `@flintpay/node` 7.0.0 and runs in test mode only.

## How it maps to Next.js

| Where | What it does |
| --- | --- |
| `src/app/` | Pages as server components. Each page reads the session cookie, so every page renders on request. |
| `src/app/checkout/[ref]/*/route.ts` | The JSON routes the checkout page calls, such as `POST /checkout/:ref/pay`. Each file binds one handler from `src/server/checkout-routes.ts`. |
| `src/server/actions.ts` | Server actions behind the store's forms: add to cart, change the cart, start checkout, sign in, sign up, and email verification. They work as plain form posts without JavaScript. |
| `src/proxy.ts` | Security headers, a per-request script nonce for the Content Security Policy, and the session cookie. |
| `src/server/` | Everything that talks to Flint, as in the Hono example: credentials (`flint/auth.ts`), checkouts and the action journal (`flint/checkouts.ts`), the payment engine (`payments/`), sign-in (`identity/`), and SQLite storage (`store/`). |
| `src/components/checkout/controller.ts` | The checkout page's payment state machine, job queue, Stripe form, and gift card check. React renders its snapshot with `useSyncExternalStore`. |
| `src/shared/` | Copy, money formatting, and checkout rules shared by server and client components. |

The server keeps state in SQLite files and process memory, so it runs as one long-lived Node.js server (`next start`), not as serverless functions.

Credentials stay on the server. The browser calls only this app's routes and Stripe.js; it never calls Flint. Stripe.js loads from `js.stripe.com/v3`, the version Flint's Elements guidance is written for.

## Requirements

The same as the [Hono storefront](../storefront/README.md#requirements): Node.js 24 or later, a Flint sandbox with payments set up, and a sandbox test key (`flint_test_...`). Optional capabilities (Affirm, ACH debit, automatic tax, wallets on an HTTPS domain) work the same way.

## Quick start

```bash
cp .env.example .env     # add FLINT_API_KEY and FLINT_SANDBOX_ID
npm ci
npm run setup            # dry run: prints what would be created
npm run setup -- --apply # creates the sample catalog and checkout settings
npm run dev
```

Open http://localhost:4300. The setup script is the same as the Hono example's, so a sandbox set up by either works for both.

For production, `npm run build && npm start`. Serve it over HTTPS and see [Before production](../storefront/README.md#before-production).

## Running with the account example

Combined mode works as described in [Headless examples](../README.md#run-both-apps-together-combined-mode). Point both apps at the same identity database and cookie name, and set `ACCOUNT_APP_ORIGIN=http://localhost:4200` here.

## Tests

| Command | What it runs |
| --- | --- |
| `npm run check` | Type check and unit tests for the server modules |
| `STOREFRONT_ACCEPTANCE=1 npm run test:browser` | Browser journeys against a running copy of this app, a sandbox, and Stripe test mode |

The browser journeys are the Hono example's staging acceptance specs, with the same steps and assertions: browsing and the cart, card payments, declines, 3D Secure, an interrupted payment, a lost pay response, a double click on Pay, pickup with a tip, discounts, and subscriptions with and without a trial. Set `STOREFRONT_BUYER_EMAIL` to an inbox you control if you want to read the emails they cause. Playwright needs a browser: `npx playwright install chromium`.

## Test cards

| To test | Enter |
| --- | --- |
| Successful card | `4242 4242 4242 4242`, any future date, any CVC |
| Declined card | `4000 0000 0000 9995` |
| 3D Secure challenge | `4000 0025 0000 3155` |
| ACH debit | Routing `110000000`, account `000123456789` |

The discount code `WELCOME10` is created by setup.

## Webhooks

Optional, as in the Hono example: `flint listen --forward-to http://localhost:4300/webhooks/flint`, then put the printed `whsec_...` value in `FLINT_WEBHOOK_SECRET`.

## Limitations

The [Hono example's limitations](../storefront/README.md#limitations) apply here too. In addition:

- The checkout page needs JavaScript to take a payment, as the Hono example's does. Browsing, adding to the cart, sign-in, and starting checkout work without it.
- Run one server process. The action journal and payment locks live in local SQLite.

## Guides

- [Build your own checkout](https://developers.withflintpay.com/docs/guides/headless-checkout)
- [Securing a headless checkout](https://developers.withflintpay.com/docs/guides/headless-checkout-security)
- [Declines and payment attempts](https://developers.withflintpay.com/docs/guides/declines-and-payment-attempts)
- [Build a headless storefront](https://developers.withflintpay.com/docs/guides/headless-storefront)
