# Ordrino Backend

Express API behind the [Ordrino](https://github.com/Laraib2004/orderman) Android POS app. It does three things the phone must never do itself:

1. **Holds Stripe secrets.** Each restaurant's secret key lives encrypted in Firestore and is decrypted per request — the app only ever sends a `restaurant_id`.
2. **Talks to Stripe** — Terminal connection tokens, PaymentIntents, invoices, tax calculation, product catalogue.
3. **Fiscalizes** every sale through **A-Cube** (Italian electronic receipts), then serves the resulting receipt PDF behind a public URL for the customer's QR code.

Deployed at `https://ordrino-backend.onrender.com`.

---

## Table of contents

- [Multi-tenancy model](#multi-tenancy-model)
- [Tech stack](#tech-stack)
- [Project layout](#project-layout)
- [Environment variables](#environment-variables)
- [Running locally](#running-locally)
- [API reference](#api-reference)
- [Payment flows](#payment-flows)
- [Fiscalization](#fiscalization)
- [Encrypting a Stripe key](#encrypting-a-stripe-key)
- [Firestore configuration](#firestore-configuration)
- [Deployment](#deployment)
- [Known issues](#known-issues)

---

## Multi-tenancy model

There is **no global Stripe client**. Every route:

```js
const restaurantDoc = await db.collection('restaurants').doc(restaurant_id).get();
const config        = restaurantDoc.data();
const tenantStripe  = require('stripe')(decrypt(config.stripe_secret_key));
```

So the same deployment serves any number of restaurants, each charging into its own Stripe account and filing receipts under its own A-Cube credentials. `restaurant_id` is required on every route.

```
Android app ──POST restaurant_id──► Ordrino backend
                                        │
                                        ├─► Firestore (Admin SDK)  read tenant config
                                        ├─► decrypt(stripe_secret_key)  AES-256-CBC
                                        ├─► Stripe (per-tenant client)
                                        └─► A-Cube (per-tenant login)
```

---

## Tech stack

| Purpose | Package |
|---|---|
| HTTP server | `express` ^5.1.0 |
| Firestore access | `firebase-admin` ^13.6.1 |
| Payments | `stripe` ^18.3.0 |
| A-Cube / HTTP client | `axios` ^1.13.5 |
| Config | `dotenv` ^17.2.4 |
| CORS | `cors` ^2.8.5 |
| Key encryption | Node built-in `crypto` (AES-256-CBC) |

CommonJS (`"type": "commonjs"`), single-file server.

---

## Project layout

```
stripe-terminal-backend/
├── server.js        # everything: helpers, fiscalization, all 7 routes
├── crypto.js        # encrypt() / decrypt() for stripe_secret_key
├── package.json
├── .env             # gitignored — never commit
└── .gitignore       # node_modules/, .env, package-lock.json
```

`server.js` is organised as:

| Lines | Section |
|---|---|
| 1–30 | bootstrap: express, CORS, Firebase Admin init from `FIREBASE_SERVICE_ACCOUNT` |
| 32–75 | A-Cube auth manager (`getAcubeToken`, 23 h cache) |
| 77–185 | `fiscalizeTransaction` — build payload, POST, poll 15× for `ready`, fetch PDF |
| 187–200 | `formatDate` helper |
| 204–965 | routes + `getOrCreateCustomerByEmail` |

---

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `PORT` | no | defaults to `3000` |
| `FIREBASE_SERVICE_ACCOUNT` | **yes** | the whole service-account JSON as one string. Missing → process exits at boot |
| `ENCRYPTION_KEY` | **yes** | 32-byte key, hex-encoded (64 hex chars). Used by `crypto.js` |
| `ACUBE_API_URL` | no | defaults to `https://api-sandbox.acubeapi.com` |
| `NODE_ENV` | no | anything other than `production` uses the A-Cube **sandbox** login host |

Note the two independent switches: `ACUBE_API_URL` selects the receipts host, `NODE_ENV` selects the login host. Set **both** when going live:

```
NODE_ENV=production
ACUBE_API_URL=https://api.acubeapi.com
```

---

## Running locally

```bash
npm install
node server.js          # → Server running on port 3000
```

Create a `.env` first:

```
PORT=3000
NODE_ENV=development
ACUBE_API_URL=https://api-sandbox.acubeapi.com
ENCRYPTION_KEY=<64 hex chars>
FIREBASE_SERVICE_ACCOUNT={"type":"service_account", ... }
```

The service-account JSON is the file in `Ordrino/firebase/`. There is no `npm start` script and no test suite.

To hit it from the Android app while developing, set the tenant's `api_domain` in Firestore to your tunnel/LAN URL — the app reads its base URL from there, nothing is hardcoded on the device.

---

## API reference

All routes take JSON. Every route requires `restaurant_id` in the body except the public receipt endpoint.

### `POST /connection_token`

Stripe Terminal connection token, used by the app's `CustomConnectionTokenProvider`.

```jsonc
// request
{ "restaurant_id": "abc123" }
// response
{ "secret": "pst_test_..." }
```

### `POST /create_payment_intent`

Creates a `card_present` PaymentIntent with **manual capture** against an anonymous customer.

```jsonc
{ "amount": 1250, "currency": "eur", "restaurant_id": "abc123" }
→ { "client_secret": "pi_..._secret_...", "id": "pi_..." }
```

`amount` is in cents and must already include the tip.

### `POST /capture_payment_intent`

Captures the intent, builds a Stripe invoice, then fiscalizes as an **electronic** payment.

```jsonc
{
  "payment_intent_id": "pi_...",
  "items": [{ "name": "Espresso", "quantity": 2, "unit_price": 120 }],
  "currency": "eur",
  "subtotal_amount_cents": 240,
  "tip_amount_cents": 100,
  "business_vat": "IT01234567890",
  "restaurant_id": "abc123",
  "backendUrl": "https://ordrino-backend.onrender.com",
  "service_date": "16-02-2026 20:30"   // DD-MM-YYYY HH:mm, optional
}
```

```jsonc
{
  "success": true,
  "stripe_status": "succeeded",
  "hosted_invoice_url": ".../public/receipt/<uuid>",   // ← goes in the QR code
  "invoice_pdf": "https://pay.stripe.com/...",
  "fiscal_receipt": { "success": true, "status": "completed", "uuid": "...", "document_number": "0001-1300", "public_url": "..." }
}
```

A captured-vs-expected amount mismatch is logged as a warning, not rejected.

### `POST /cash_payment`

Same shape minus `payment_intent_id`/`subtotal_amount_cents`. Creates the invoice, finalizes it, pays it `paid_out_of_band`, then fiscalizes as **cash**. `transaction_ref` is the invoice id.

### `POST /create-update-product`

Keeps the Stripe product catalogue in sync with the Ordrino menu. Called from `AddEditMenuItemActivity`.

```jsonc
{
  "create": true,            // false → update path, requires prod_id
  "prod_id": "prod_...",
  "itemName": "Espresso",
  "description": "",
  "unit_amount": 120,        // cents, tax_behavior: inclusive
  "tax_code": "txcd_...",
  "currency": "eur",
  "restaurant_id": "abc123"
}
→ { "prodId": "prod_..." }
```

On update, a new Price is created only when `unit_amount` actually changed; otherwise the existing default price is reused.

### `POST /void_receipt`

Voids a fiscal receipt at A-Cube (`DELETE /receipts/:uuid`). A-Cube answers with a **new** void document, whose UUID gets its own public receipt URL.

```jsonc
{ "receipt_uuid": "...", "restaurant_id": "abc123" }
→ { "success": true, "original_uuid": "...", "void_uuid": "...", "status": "..." }
```

### `GET /public/receipt/:uuid`

Public, unauthenticated. Streams the A-Cube receipt PDF straight through with `Content-Type: application/pdf` and `Content-Disposition: inline`. This is the URL encoded into the customer-facing QR code.

---

## Payment flows

**Card (Tap to Pay)**

```
app → /connection_token          → Terminal SDK connects
app → /create_payment_intent     → client_secret
     …SDK collects the card on-device…
app → /capture_payment_intent    → capture + invoice + fiscal receipt → QR URL
```

**Cash**

```
app → /cash_payment              → invoice (paid out of band) + fiscal receipt → QR URL
```

Both then land on `InvoiceQRCodeActivity`, which renders `hosted_invoice_url` as a QR code and stores it under `restaurants/{id}/tables/{tableId}/historyReceiptToday`.

---

## Fiscalization

`fiscalizeTransaction()` is the heart of the service:

1. **Auth** — `getAcubeToken(email, password)` logs into A-Cube with the tenant's credentials (password decrypted with the same AES key). The token is cached for 23 h and refreshed 5 min before expiry.
2. **Items** — each line becomes `{ description, quantity, unit_price (euros), vat_rate_code }`. The VAT rate is not taken from the menu directly: the routes run a **Stripe Tax calculation** per item (`tax_behavior: "inclusive"`) and use the returned `percentage_decimal`. Default is `"22"`.
3. **Tip** — appended as a line `"Mancia / Tip"` with VAT code **`N2`** (not subject to VAT).
4. **Payment kind** — `electronic_payment_amount` for card, `cash_payment_amount` for cash.
5. **Create** — `POST {ACUBE_API_URL}/receipts` → returns a `uuid`.
6. **Poll** — up to 15 attempts, 1 s apart, on `GET /receipts/{uuid}/details` until `status === 'ready'` and a `document_number` exists; then fetches the same endpoint with `Accept: application/pdf`.
7. **Return** — `public_url = {backendUrl}/public/receipt/{uuid}`, plus `status: 'completed' | 'pending'`.

If polling times out the call still succeeds with `status: 'pending'` — the QR code works as soon as A-Cube finishes, because the public route fetches live.

---

## Encrypting a Stripe key

`crypto.js` uses AES-256-CBC with a random IV, stored as `<iv-hex>:<ciphertext-hex>`. The same scheme protects `acube_password`.

```bash
node -e "require('dotenv').config(); console.log(require('./crypto').encrypt('sk_live_...'))"
```

Paste the output into `restaurants/{id}.stripe_secret_key`. Generate a fresh key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Rotating `ENCRYPTION_KEY` invalidates every stored secret — re-encrypt them all.

---

## Firestore configuration

Read by this service (written by the Android app / by hand):

```
restaurants/{restaurantId}
  name, address, city, province, country
  vat_number            # sent as fiscal_id / business_vat
  recipient_code
  api_domain            # backend base URL the app should call
  stripe_secret_key     # AES-encrypted
  acube_email
  acube_password        # AES-encrypted
```

Missing `stripe_secret_key`, `acube_email` or `acube_password` produces a `500` naming the specific field.

**Stripe prerequisites per tenant account:**
- Stripe Tax enabled (invoices are created with `automatic_tax: { enabled: true }`)
- a product literally named **`Tip`** — tips fail hard without it
- every menu item present as an active product with a price, since line items are matched by product **name**

---

## Deployment

Hosted on Render as a Node web service. Push to `main` on `github.com/Laraib2004/ordrino-backend` triggers a redeploy. Set all environment variables in the Render dashboard — `.env` is gitignored and not deployed.

On the free tier the instance sleeps; the first request after idle (usually `/connection_token`) can take several seconds. If reader connection times out in the app after a quiet period, that's why.

---

## Known issues

Worth knowing before debugging — these are real, present in `server.js`:

- **`GET /public/receipt/:uuid` calls `getAcubeToken()` with no arguments.** It only works while a token from an earlier payment is still cached. After a restart or 23 h idle, the cache is empty and it reaches `decrypt(undefined)` → the customer's QR code returns *"Could not retrieve receipt."* Fix: look up the receipt's restaurant and pass its credentials.
- **The A-Cube token cache is a single global.** `acubeTokenCache` is shared across all tenants, so restaurant B's request can be signed with restaurant A's token. Should be keyed by `restaurant_id`.
- **`getOrCreateCustomerByEmail` references undefined variables** (`customer_name`, `customer_address`, `customer_city`, `customer_postal_code`, `province`, `customer_country`, `customer_fiscal_code`, `customer_vat`) in its `create` branch. It survives only because the anonymous customer already exists in each account; against a fresh Stripe account it throws `ReferenceError`.
- **No authentication.** Any caller who knows a `restaurant_id` can mint connection tokens, create PaymentIntents, void receipts or rewrite the product catalogue, and `cors()` is wide open. Firebase ID-token verification on every route is the natural fix.
- **`if (!restaurant_id.length)` throws on `undefined`** rather than returning 400. In `/create_payment_intent`, `/capture_payment_intent` and `/cash_payment` this guard and the Firestore read sit *outside* the `try`, so a malformed request becomes an unhandled rejection instead of a 500.
- **Invoice line items are matched by product name** (`products.search({ query: "name:'…'" })`) even though the app already stores `prodId` on each menu item. Renaming or duplicating a product breaks payment; looking up by id would not.
- **The `crypto` package in `dependencies`** is the deprecated npm placeholder, not Node's built-in module — the code correctly uses the built-in, so the dependency can be dropped.
- **`package-lock.json` is gitignored** while the file exists locally, so deploys don't get reproducible installs.
