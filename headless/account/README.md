# Headless customer account

A customer account that runs on your own origin. Buyers sign in with your login, and every page, form, and payment is served by this app. The browser never calls Flint. The app talks to Flint from its server with the published `@flintpay/node` SDK and loads Stripe.js from Stripe for card entry.

The store is Cedar & Stone, a fictional coffee roaster in Austin. Emails that Flint sends show your sandbox's business name, which can differ.

This example is for test mode only. It refuses live keys.

## What it shows

- Your own email and password sign-in with server-side sessions, and a Flint email code that proves a buyer owns their email before their orders connect to the account.
- Orders with items, payments, refunds, delivery tracking from fulfillment events, packages with tracking numbers, an emailed receipt, and a printable receipt.
- Self-service returns: choose items and a reason, follow a return, send items back, withdraw a return, and pay an exchange balance on your own page.
- Invoices with PDF downloads and credit notes. A buyer pays an open invoice on your page with an embedded payment form.
- Subscriptions: pause, resume, cancel at the end of the period or now, keep a subscription you scheduled to cancel, change the card, and retry a past due payment.
- Saved cards that you add with Stripe's Payment Element, set as default, or remove.
- Profile, email change with codes sent to both addresses, password change, saved addresses, and email preferences.
- Saved gift cards by code or by a pasted link, with balance and history.
- Account deletion requests, and a page that finds guest orders placed with the buyer's email.
- Links in Flint emails (order, subscription, return, invoice, and email preferences) that sign the buyer in and land on the right page.

## Requirements

- Node.js 24
- A Flint sandbox test key (`flint_test_`) for a dedicated sandbox, with card payments ready (`accept_card_payments`). Don't give the key `commerce.gift_cards.secrets.write`. This app saves gift cards for a buyer and never needs to read card secrets.
- A mailbox you can read. Sign-up, guest order linking, and email changes send codes by email.
- Optional: a second terminal for the storefront in `headless/storefront`, so the Shop link and the "Your account" link work end to end.

## Quick start

```sh
cd headless/account
cp .env.example .env
# Add your test key and sandbox ID to .env
npm ci
npm run setup              # dry run: prints what would change
npm run setup -- --apply   # points your sandbox's account links at this app
npm run dev
```

Open http://localhost:4200, create an account, and enter the code Flint emails you.

`npm run setup -- --apply` changes your sandbox's customer account settings so emailed links open this app. All buyer emails in that sandbox move to this app, so use a sandbox that is yours. The script prints the previous values first and keeps a snapshot you can restore.

Use `npm run setup -- --check` to see whether the sandbox is ready. Add `--buyer-capabilities=demo` to `--apply` to let buyers pause, choose when to cancel, and see a pause offer before they cancel.

On first run against a sandbox that isn't set up, the home page shows a developer note that points to `npm run setup -- --apply`.

Set `FLINT_API_BASE_URL` to `https://api.staging.withflintpay.com`. Use another host only if you have run the sandbox preflight against it.

## How it works

Three kinds of credential reach Flint, and only one of them acts at a time.

| Credential | Held by | Used for |
|---|---|---|
| Merchant API key | Server only | Linking a login to a Flint customer, minting and revoking customer sessions, reading store settings and return reasons, and email preference links |
| Customer session | Server only, per signed-in buyer | Everything about the buyer's own data through `client.me.*` |
| Checkout credential | Server only, per invoice or return payment | Paying the order behind an invoice or a return balance |

A customer session can read and change a buyer's account but can't pay. To pay, the app asks Flint for an embedded checkout session for the invoice or return, stores the checkout credential next to your own record, and uses it only for that order.

The browser receives only what Stripe.js needs: the publishable key, the account ID, the Payment Element options Flint returned, and, only while a payment is waiting for the buyer, the one-time authentication details. Resource IDs appear in URLs because pages need them. They are never proof of access.

`src/flint/auth.ts` is the only file that chooses a credential. A test fails if any other file builds one.

### Paying an invoice or a return balance

1. The buyer opens `/invoices/:id/pay` or `/returns/:id/pay`. The app launches an embedded checkout session with a return path on this origin.
2. The page mounts the Payment Element and an optional wallet button. Stripe returns a single-use credential.
3. The page sends that credential and the amount the buyer saw to this app. If the order total changed, the app says so and waits for a new click.
4. The app reads the order, starts the payment, and follows the attempt. A decline keeps the form. A bank authentication runs in the page and then the app resumes the same attempt. A response that never arrives is reconciled with Flint before any new payment can start.
5. When the payment finishes, or when a provider sends the buyer back, the page goes to `/invoices/:id/pay/return` or `/returns/:id/pay/return`. Those routes read the real state, so reloading is safe.

### Emailed links

Flint adds the resource type, resource ID, mode, and environment to links in its emails. The app treats them as hints. A signed-out buyer signs in first and then lands on the page. A link for another buyer or another sandbox lands on the overview with a short notice and shows nothing about the resource.

### Files

| Path | What it does |
|---|---|
| `src/server.ts`, `src/app.ts`, `src/config.ts` | Startup, routes, and settings |
| `src/flint/` | The one place credentials are chosen, the SDK client, error mapping, startup checks |
| `src/identity/` | The sample login, copied byte for byte into the storefront |
| `src/payments/` | The payment attempt engine for invoices and return balances |
| `src/store/`, `src/security/` | SQLite storage, rate limits, headers, and log redaction |
| `src/views/` | Server-rendered pages. `renderPage(pageId, context)` in `src/views/index.ts` is the only entry |
| `src/copy.ts` | Every buyer-facing string |
| `public/` | Stylesheet, images, and the browser modules |
| `scripts/setup.ts` | Sandbox setup, check, and restore |

The pages use `hono/html`, which escapes every value. Page scripts are plain ES modules in `public/js`. Stripe.js is loaded from `https://js.stripe.com/v3/` and is never bundled.

## Test values

Stripe test cards for the payment form and for adding a card:

| Number | Result |
|---|---|
| 4242 4242 4242 4242 | Succeeds |
| 4000 0000 0000 9995 | Declined |
| 4000 0025 0000 3155 | Asks for authentication |
| 4000 0000 0000 0341 | Saves, then fails when charged |

Use any future expiry and any three-digit security code.

Test bank account for the ACH option (routing 110000000):

| Account number | Result |
|---|---|
| 000123456789 | Succeeds |
| 000000000009 | Stays processing |
| 000222222227 | Fails after it is accepted |

ACH is a one-time payment option on invoices and return balances. A bank payment shows as processing until it clears.

## Webhooks

This app doesn't use webhooks and has no webhook setting. It reads orders, invoices, and subscriptions from Flint when a page loads and when a payment finishes.

## Tests

| Command | What it covers |
|---|---|
| `npm run check` | Type check and unit tests |
| `npm run test:integration` | Routes driven with `app.request`, local SQLite, and an injected Flint transport. No sandbox key and no `.env` |
| `npm run test:browser` | Browser tests of the page states |

The browser tests are **local state tests**. They render the real pages with made-up data on a small local server, answer the app's JSON routes with scripted responses, and replace Stripe.js with a local stand-in. They check declines, authentication, lost responses, waiting, bank processing, dialogs, forms, keyboard use, layout at 390, 768, 1024, and 1440 pixels, and escaping. They do not show that Flint or Stripe accept anything.

Real behavior is checked against a sandbox. `ACCOUNT_BROWSER_MODE=staging ACCOUNT_BASE_URL=http://localhost:4200 npm run test:browser` runs signed-out smoke checks against a running copy of the app. Sign-up, email codes, payments, returns, and subscriptions with real sandbox resources run in `headless/e2e`.

Browser tests keep traces, screenshots, and videos off, because they capture signed-in pages and network bodies.

## Production checklist

- Serve the app over HTTPS and set `APP_ORIGIN` to that origin. Cookies are `Secure` when it is HTTPS.
- Keep the Content-Security-Policy that `src/security/headers.ts` sends. It allows Stripe's published script, frame, and connection hosts and nothing else. Review any script you add to a payment page.
- Encrypt the SQLite files or move them to a managed database. They hold customer session secrets and checkout credentials in plain text so the example stays small.
- Rotate the API key, and revoke customer sessions when a buyer signs out or changes a password. The app does both.
- Apple Pay and Google Pay need a registered HTTPS hostname. They don't appear on `localhost`.
- Replace the sample login. It is not a production identity system. It has no email service and uses a Flint code to prove an email.
- Live keys use the default Flint API host, so leave `FLINT_API_BASE_URL` unchanged. This example refuses live keys.

## Limitations

- It uses the `@flintpay/node` 3.0.0 beta.
- Gift card emails that Flint sends open Flint's own gift card page in every customer account mode. That is an intentional part of Flint's hosted design, not a missing API. On a live store with a checkout custom domain, the page uses your checkout hostname. This example doesn't link to it. Buyers can paste the link from that email into this account's Gift cards page to save the card and see its balance. The page reads the link in the browser without opening it, ignores its query, and sends only the grant ID and token to this app. It accepts https links on any host, and http only on localhost.
- This example doesn't sell gift cards. Cards you issue with `POST /v1/gift-cards` return their code once, so you can deliver those yourself.
- If Flint asks for a challenge when a buyer saves a gift card by code, the app says it can't check codes right now. This version doesn't include the public challenge flow, and it doesn't try to work around the challenge.
- `npm run setup -- --apply` can't yet start from a sandbox that has no customer account settings. It records that state before it writes anything, but the pinned SDK can't restore it afterward, so the script stops. Use a sandbox whose customer account settings already exist.
- Email changes use codes only. Merchant-hosted accounts don't use confirmation links.
- Closed accounts are found through the deletion requests list, because the customer record doesn't show a deletion state.
- The sample login is not production identity.
