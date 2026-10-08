# Flint Pay examples

Example apps that use Flint Pay from your own server and your own pages. Each example is a small, working app you can read, run against a Flint sandbox, and copy into your project.

## Before you start

- The examples use the `@flintpay/node` 3.0.0 beta SDK, pinned to an exact version. Beta means method and field names can still change before 3.0.0 is final.
- Every example runs in test mode only. Use a sandbox test key (`flint_test_...`) and Stripe test cards. The apps refuse live keys, and no money moves.
- Each example needs a Flint sandbox with payments set up. The `README.md` in each example lists its requirements, the sandbox settings it changes, and the capabilities it can use. An example that needs something your sandbox does not have, such as ACH debit or Affirm, says so and stays usable without it.
- Node.js 24 or later.
- Checkout and the buyer account run on your own pages. One part stays Flint-hosted: the page a gift card recipient opens from the gift card email. The examples redeem and save gift cards but do not host that page.

## Examples

<!-- examples:index:start -->

| Example | What it shows | Guides | Run | Status |
| --- | --- | --- | --- | --- |
| [Headless customer account](headless/account/) | A merchant-owned customer account with its own sign-in: orders and delivery tracking, invoices and return balances paid on the merchant's page, subscriptions, saved cards, profile, addresses, gift cards, email preferences, account deletion, and guest order linking. | [Build your own customer account](https://developers.withflintpay.com/docs/guides/headless-customer-accounts)<br>[Customer sessions](https://developers.withflintpay.com/docs/guides/customer-sessions)<br>[Build your own checkout: collect an invoice or a return balance](https://developers.withflintpay.com/docs/guides/headless-checkout#collect-an-invoice-or-a-return-balance) | `cd headless/account && npm ci && npm run dev` | beta |
| [Headless storefront](headless/storefront/) | A merchant-owned catalog, cart, and embedded checkout with delivery, pickup, discounts, gift cards, tips, saved cards, wallets, ACH debit, Affirm, and subscription signup. | [Build your own checkout](https://developers.withflintpay.com/docs/guides/headless-checkout)<br>[Securing a headless checkout](https://developers.withflintpay.com/docs/guides/headless-checkout-security)<br>[Declines and payment attempts](https://developers.withflintpay.com/docs/guides/declines-and-payment-attempts)<br>[Build a headless storefront](https://developers.withflintpay.com/docs/guides/headless-storefront) | `cd headless/storefront && npm ci && npm run dev` | beta |

### Acceptance

| Example | What it shows | Guides | Run | Status |
| --- | --- | --- | --- | --- |
| [Headless storefront and account journeys](headless/e2e/) | Browser journeys across both apps against two staging sandboxes, with a guard that fails on any Flint checkout or account page. | [Testing](https://developers.withflintpay.com/docs/guides/testing) | `cd headless/e2e && npm ci && npm run e2e` | beta |

<!-- examples:index:end -->

## How the examples are organized

- Each folder is self-contained. Copy one folder out of this repository and it still runs: it has its own `package.json`, lockfile, `.env.example`, and tests, and it does not import code from another folder.
- Some examples are designed to run together. Where two examples share a sign-in, the folder README says how, and each still runs alone.
- Credentials stay on the server. The browser only receives what Stripe.js needs to collect and confirm a payment.
- Folders are added when their first example exists.

## Running an example

```bash
cd headless/storefront
cp .env.example .env     # add your sandbox test key
npm ci
npm run setup -- --apply # creates the sample catalog in your sandbox
npm run dev
```

The `Run` column above shows the exact command for each example. Setup changes sandbox data, so read what it prints before you apply it.

## Status

The examples are in beta. The acceptance harness in `headless/e2e` is built to test them against Flint's staging environment, and it has not yet been run against a sandbox. Local checks and unit tests do not count as acceptance. A scenario that needs something the sandbox cannot provide, such as an inbox for emailed codes, is reported as blocked, not passed. Check the latest workflow run for current results instead of relying on this file.

## Checks

```bash
node scripts/validate-manifests.mjs
node scripts/generate-index.mjs --check
```

Each example also has `npm run check` for type checks and unit tests.

## Reporting issues

Open an issue in this repository. Include the example folder, the SDK version, and the Flint request ID (`req_...`) shown on the error, if there is one. Do not paste keys, checkout credentials, or customer data.

## License

Apache License 2.0. See [LICENSE](LICENSE).
