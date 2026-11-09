# NGXLab API

## Authentication configuration

Set these variables in the deployment environment:

- `MONGODB_URI`: MongoDB connection string, including the database name in its path.
- `GOOGLE_CLIENT_ID`: OAuth 2.0 web client ID used to verify Google ID tokens.
- `RESEND_API_URL`: Resend email endpoint (`https://api.resend.com/emails`).
- `RESEND_API_KEY`: Resend API key, stored only in the backend environment.
- `RESEND_FROM_EMAIL`: sender address verified with Resend, stored only in the backend environment.
- `KOBO_MARKET_API_KEY`: Kobo Terminal API key, stored only in the backend environment.
- `CRON_SECRET`: random secret used to authorize scheduled market-data refreshes.

Configure these values in the backend's local `backend/.env` for development and in the backend Vercel project's environment settings for deployment. Never put the Resend API key or sender configuration in frontend code or frontend environment variables.
Never expose the Kobo API key in frontend code; use the backend market-data endpoint below.

The API creates unique account indexes and expiring session, password-reset, and rate-limit indexes automatically. Do not commit credentials.

New password and Google accounts receive a one-time welcome email through the configured Resend settings. Email delivery failures are logged and do not prevent account creation.

The Vercel project root is the repository root. The root `api/index.js` function forwards `/api/*` requests to this Express app; keep API rewrites pointed at that function rather than the nested source file, which can otherwise be served as a static asset.

## Authentication endpoints

All authentication requests must have the exact origin `https://www.ngxlab.xyz`.
The frontend must send requests with credentials enabled so the browser accepts and sends the session cookie.

### `POST /api/auth/register`

Request:

```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "password": "a-strong-password"
}
```

### `POST /api/auth/login`

Request:

```json
{
  "email": "jane@example.com",
  "password": "a-strong-password"
}
```

### `POST /api/auth/google`

Request:

```json
{
  "idToken": "Google credential from the frontend"
}
```

For Google sign-in, the API verifies the ID token with Google's OAuth client and requires a verified email. It does not trust profile details from the request.

Successful requests return a profile without password data:

```json
{
  "user": {
    "id": "user-id",
    "name": "Jane Doe",
    "email": "jane@example.com",
    "virtualBalanceNgn": 1000000
  }
}
```

Registration responds with HTTP `201`; login and Google sign-in respond with HTTP `200`.
Password accounts can sign in immediately after registration; email verification is not currently required. Google sign-in requires a Google-verified email.
New password and Google accounts start with `virtualBalanceNgn: 1000000` (₦1,000,000 in simulated practice funds, not real money). Login responses include the user's stored virtual balance. Frontends should display it as a virtual/practice balance and never describe it as a withdrawable deposit.

### `POST /api/auth/forgot-password`

Request:

```json
{
  "email": "jane@example.com"
}
```

Returns the same generic response whether or not the account exists. When an account exists, the API emails a single-use link to `https://www.ngxlab.xyz/reset-password?token=...`. Only a SHA-256 hash of the token is stored; the token expires after 30 minutes and is atomically consumed on use. Recovery requests are rate-limited by IP and email.

### `POST /api/auth/reset-password`

Request:

```json
{
  "token": "token-from-the-reset-link",
  "password": "a-new-strong-password"
}
```

A successful reset invalidates existing sessions. Passwords must be between 8 and 128 characters and are stored as salted scrypt hashes. The frontend must provide the `/reset-password` page to read the token from the query string and submit it to this endpoint.

Errors use this format:

```json
{
  "error": {
    "code": "EMAIL_ALREADY_REGISTERED",
    "message": "An account with this email already exists"
  }
}
```

Invalid input returns HTTP `400` (`INVALID_INPUT`), invalid login credentials return HTTP `401` (`INVALID_CREDENTIALS`), and an existing registration email returns HTTP `409` (`EMAIL_ALREADY_REGISTERED`). Invalid Google credentials return HTTP `401` (`INVALID_GOOGLE_CREDENTIAL`).

## Session and browser setup

Successful registration and login create a random opaque session token. Only its SHA-256 hash is stored in MongoDB; the raw token is set in an `HttpOnly`, `Secure` production cookie with a 14-day lifetime. Passwords are stored as salted scrypt hashes.

The cookie is configured as `SameSite=None` on production because the current `vercel.app` API host is cross-site from `www.ngxlab.xyz`. Some browsers block such third-party cookies. Prefer mapping the API to `api.ngxlab.xyz` and use credentialed frontend requests; this makes the frontend and API same-site and avoids relying on third-party cookies.

## Market data

### `GET /api/market/overview`

Returns the latest-session NGX market summary, five largest daily gainers, five largest daily decliners, and five stocks with the highest trading volume from MongoDB. Frontend requests do not call Kobo, so page views do not consume the Kobo quota.

The response contains `as_of`, `trade_date`, `total_stocks`, `market`, `gainers`, `losers`, and `top_volume`. Each stock entry contains `symbol`, `name`, `current_price`, `change_percent`, `volume`, `sector`, and `trade_date`.

Vercel runs `GET /api/market/refresh` once daily at 18:00 UTC. That protected route fetches the provider's stock list once and stores the complete snapshot and rankings in the `marketSnapshots` MongoDB collection. A MongoDB-backed guard allows at most one Kobo request per UTC calendar day, including manual refreshes and duplicate cron invocations. A failed attempt also uses that day's allowance to prevent retries from consuming the quota. Configure the same `CRON_SECRET` environment variable in Vercel so scheduled requests are authorized. For a manual refresh, send `Authorization: Bearer <CRON_SECRET>` to the refresh route.

### `GET /api/market/stocks`

Returns all stocks from the latest MongoDB snapshot, without making a Kobo request.

### `GET /api/market/stocks/:symbol`

Returns the selected stock's quote and snapshot dates from MongoDB, without making a Kobo request. The symbol is case-insensitive. For example, `GET /api/market/stocks/dangsugar` returns:

```json
{
  "success": true,
  "as_of": "2026-11-06T18:00:00.000Z",
  "trade_date": "2026-11-06T00:00:00",
  "stock": {
    "symbol": "DANGSUGAR",
    "name": "Dangote Sugar Refinery Plc",
    "current_price": 65,
    "change_percent": -0.99,
    "volume": 5396684,
    "sector": "Consumer Goods",
    "trade_date": "2026-11-06T00:00:00"
  }
}
```

An invalid symbol returns `400` (`INVALID_SYMBOL`), and a symbol not found in the latest snapshot returns `404` (`UNKNOWN_SYMBOL`).

### `GET /api/market/dangsugar`

Returns DANGSUGAR's latest quote from the MongoDB snapshot. It does not call Kobo or consume API quota.

```json
{
  "success": true,
  "symbol": "DANGSUGAR",
  "trade_date": "2026-11-06T00:00:00",
  "stock": {
    "symbol": "DANGSUGAR",
    "current_price": 65,
    "change_percent": -0.99,
    "volume": 5396684
  }
}
```

Historical price data is not included in this daily snapshot.

## Demo portfolio and trading

These authenticated endpoints use the signed-in `ngxlab_session` cookie. Send browser requests with credentials enabled. All funds and orders are simulated: these routes never place real orders and never call Kobo for an individual trade. Trade prices come only from the latest stored `marketSnapshots` quote.

### `GET /api/portfolio`

Returns the signed-in user's virtual cash balance, current holdings, and up to the 100 most recent executed trades:

```json
{
  "success": true,
  "portfolio": {
    "virtualBalanceNgn": 999350,
    "as_of": "2026-11-06T18:00:00.000Z",
    "market_trade_date": "2026-11-06T00:00:00",
    "holdings": [
      {
        "symbol": "DANGSUGAR",
        "name": "Dangote Sugar Refinery Plc",
        "quantity": 10,
        "averagePrice": 65,
        "currentPrice": 65,
        "marketValueNgn": 650
      }
    ],
    "tradeHistory": [
      {
        "id": "trade-id",
        "symbol": "DANGSUGAR",
        "name": "Dangote Sugar Refinery Plc",
        "side": "BUY",
        "quantity": 10,
        "price": 65,
        "total": 650,
        "trade_date": "2026-11-09T06:00:00.000Z",
        "market_trade_date": "2026-11-06T00:00:00"
      }
    ]
  }
}
```

Holding `averagePrice` is the weighted average purchase price. Each trade's `price` is the stored quote per share and `total` is the rounded-to-kobo execution value. `trade_date` is the execution timestamp; `market_trade_date` identifies the quote's market date.
The portfolio's `as_of` and `market_trade_date` identify the MongoDB snapshot used to value holdings. Each holding includes its weighted `averagePrice`, latest stored `currentPrice`, and `marketValueNgn`; current price and market value are `null` if that holding has no quote in the latest snapshot.

### `POST /api/portfolio/trades`

Request:

```json
{
  "symbol": "DANGSUGAR",
  "side": "BUY",
  "quantity": 10
}
```

`side` must be `BUY` or `SELL`; `quantity` must be a positive whole number of shares. A successful response (`200`) includes the executed trade and the updated portfolio in the same shapes returned above:

```json
{
  "success": true,
  "trade": {
    "id": "trade-id",
    "symbol": "DANGSUGAR",
    "name": "Dangote Sugar Refinery Plc",
    "side": "BUY",
    "quantity": 10,
    "price": 65,
    "total": 650,
    "trade_date": "2026-11-09T06:00:00.000Z",
    "market_trade_date": "2026-11-06T00:00:00"
  },
  "portfolio": {
    "virtualBalanceNgn": 999350,
    "as_of": "2026-11-06T18:00:00.000Z",
    "market_trade_date": "2026-11-06T00:00:00",
    "holdings": [
      {
        "symbol": "DANGSUGAR",
        "name": "Dangote Sugar Refinery Plc",
        "quantity": 10,
        "averagePrice": 65,
        "currentPrice": 65,
        "marketValueNgn": 650
      }
    ],
    "tradeHistory": [
      {
        "id": "trade-id",
        "symbol": "DANGSUGAR",
        "name": "Dangote Sugar Refinery Plc",
        "side": "BUY",
        "quantity": 10,
        "price": 65,
        "total": 650,
        "trade_date": "2026-11-09T06:00:00.000Z",
        "market_trade_date": "2026-11-06T00:00:00"
      }
    ]
  }
}
```

A buy deducts `price × quantity` from the account's existing `virtualBalanceNgn`; a sell credits it and removes the sold shares. Trades update the user balance, holdings, and trade history in one MongoDB transaction. The database must support transactions (for example, a MongoDB replica set). Existing accounts are not automatically topped up; the one-time opening balance is assigned only when an account is created.

Trade errors use the standard `{ "error": { "code": "...", "message": "..." } }` shape:

| HTTP | Code | Meaning |
|---|---|---|
| `400` | `INVALID_TRADE` | Malformed request, invalid symbol format, side, quantity, or unsupported trade value |
| `401` | `UNAUTHENTICATED` | Missing, expired, or invalid session |
| `404` | `UNKNOWN_SYMBOL` | Symbol is not present in the latest stored snapshot |
| `409` | `INSUFFICIENT_VIRTUAL_FUNDS` | Buy exceeds the user's available virtual cash |
| `409` | `INSUFFICIENT_HOLDINGS` | Sell exceeds the user's available shares |
| `503` | `MARKET_DATA_NOT_READY` | No current snapshot or usable quote is available |

Malformed JSON returns `400` (`INVALID_JSON`), request bodies over the 10 KB limit return `413` (`REQUEST_TOO_LARGE`), and unexpected server errors return `500` (`INTERNAL_SERVER_ERROR`).
