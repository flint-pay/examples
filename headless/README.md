# Headless examples

Two apps that show a merchant running checkout and the buyer account on its own domain, using only the Flint API and Stripe.js. Flint hosts neither page.

| App | What it is | Default URL |
| --- | --- | --- |
| [`storefront`](storefront/) | Catalog, cart, and embedded checkout for a fictional coffee roaster, Cedar & Stone | http://localhost:4100 |
| [`account`](account/) | Orders, invoices, return balances, subscriptions, saved cards, and profile for the same buyers | http://localhost:4200 |
| [`e2e`](e2e/) | Browser journeys across both apps against Flint staging | not an app |

The apps are beta. They use the `@flintpay/node` 3.0.0 beta, and they run in test mode only.

## Two credentials, two jobs

Each app keeps its credentials on its own server.

| Credential | Held by | Used for |
| --- | --- | --- |
| Sandbox API key (`flint_test_...`) | Both apps | Catalog, orders, creating checkout sessions, linking a signed-in buyer to a Flint customer |
| Checkout credential for one checkout | Storefront | Reading and paying that one order, delivery choices, contact details |
| Customer session | Account | Everything a signed-in buyer can read or do on their own data |

The browser never calls Flint. It calls the app, and the app calls Flint.

## What each app does not do

- No Flint-hosted checkout, hosted invoice page, or hosted account page, and no fallback to one.
- No gift card sales flow. Gift cards are redeemed at checkout and on invoice and exchange payments, and saved in the account. Headless sales are supported, but Flint delivers purchased cards through its hosted recipient email, which these examples do not demonstrate.
- No microdeposit ACH. Instant bank verification only.
- No wallet shipping-address changes inside the Apple Pay or Google Pay sheet.
- The sample sign-in is not a production identity system. It proves a buyer's email with a Flint verification code so earlier guest orders can be linked without exposing someone else's orders.

## Run one app

Each app runs on its own. See its README for requirements and the first run.

## Run both apps together (combined mode)

Both apps can share one sign-in, the way a merchant with a single login would work. Start them on `localhost` with the same identity database and the same session cookie name:

```bash
# in headless/storefront/.env
IDENTITY_DATABASE_PATH=/absolute/path/to/shared-identity.sqlite
SESSION_COOKIE_NAME=cedar_session
ACCOUNT_APP_ORIGIN=http://localhost:4200

# in headless/account/.env
IDENTITY_DATABASE_PATH=/absolute/path/to/shared-identity.sqlite
SESSION_COOKIE_NAME=cedar_session
STOREFRONT_ORIGIN=http://localhost:4100
```

Pick a path outside the repository so the database is not committed. A buyer who signs in on one app is signed in on the other, and the storefront links to the account for order tracking.

## Sandbox setup order

1. Create or choose a sandbox with payments set up. The scripts do not create sandboxes.
2. In `storefront`, run `npm run setup -- --apply`. It creates the sample catalog, delivery methods, a pickup location, and a discount code, and prints the checkout settings it changes first.
3. In `account`, run `npm run setup -- --apply`. It points the sandbox's account links at the account app.
4. Run `npm run setup -- --check` in either app to see which optional capabilities your sandbox has.

| Prerequisite | Needed for | If it is missing |
| --- | --- | --- |
| Card payments ready | All checkout | The storefront shows that payments are unavailable |
| Affirm ready and enabled | Affirm at checkout, invoices, and return balances | The option is not offered |
| ACH debit activated by Flint support | Bank payments at checkout | The option is not offered |
| Automatic tax connection | Tax at checkout | The order has no tax line and checkout shows the tax prerequisite |
| A mailbox that receives Flint emails | Sign-in code, email links, guest order linking | Email steps cannot be completed |
| A registered HTTPS domain | Apple Pay and Google Pay | The wallet area stays hidden and cards still work |

## Known limits

- After repeated failed gift card codes, Flint needs a check on one of its own pages before it looks up a code. Both apps show that page in an iframe on their own checkout or payment page, and they accept its answer only from that frame. A browser that blocks the frame, or a frame that never answers, ends in a message that gift card codes can't be checked right now. The apps don't work around the check.
- Saving a gift card in the account is not challenged. The check runs when a code is applied at checkout or to an invoice or an exchange payment.
- Gift card recipient delivery is hosted by Flint by design, not by the merchant, and is not an API gap. When a gift card is sold, the recipient's email links to a Flint-hosted page where the recipient reveals the code. The examples do not host that page and do not sell gift cards. A buyer who has a gift card redeems it at checkout, and the account example can save a gift card when the buyer pastes the link from that email without opening it.
- Past-due subscription retries depend on a billing worker that the examples cannot trigger on demand.

## Guides

- [Build your own checkout](https://developers.withflintpay.com/docs/guides/headless-checkout)
- [Build a headless storefront](https://developers.withflintpay.com/docs/guides/headless-storefront)
- [Securing a headless checkout](https://developers.withflintpay.com/docs/guides/headless-checkout-security)
- [Build your own customer account](https://developers.withflintpay.com/docs/guides/headless-customer-accounts)
- [Customer sessions](https://developers.withflintpay.com/docs/guides/customer-sessions)
