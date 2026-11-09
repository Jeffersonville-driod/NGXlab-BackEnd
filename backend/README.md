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
- `TEMPORARY_VIRTUAL_BALANCE_EMAIL`: temporary, optional account email for the one-time login balance adjustment described below. Keep it in the backend environment only.

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
    "virtualBalanceNgn": 1000000,
    "simulatedInvestorIds": {
      "cscs": "DEMO-CSCS-a1b2c3d4e5f60718",
      "chn": "DEMO-CHN-18273645aabbccdd"
    }
  }
}
```

Registration responds with HTTP `201`; login and Google sign-in respond with HTTP `200`.
Password accounts can sign in immediately after registration; email verification is not currently required. Google sign-in requires a Google-verified email.
New password and Google accounts start with `virtualBalanceNgn: 1000000` (₦1,000,000 in simulated practice funds, not real money). Login responses include the user's stored virtual balance. Frontends should display it as a virtual/practice balance and never describe it as a withdrawable deposit.
New-account welcome emails include the account's simulated CSCS and CHN display identifiers with a clear disclaimer that they are not valid for real trading, brokerage, settlement, or securities transfers.

### Temporary one-time login balance adjustment

For the requested account only, setting the backend-only `TEMPORARY_VIRTUAL_BALANCE_EMAIL` environment variable to that account's email enables a temporary login adjustment: after successful password login, if that account's stored virtual balance is zero or missing, it is set to ₦10,000,000. The update is atomic and only matches the configured account; nonzero balances and every other account are left unchanged. The login response includes the updated balance.

Set this variable in the backend deployment environment before the account logs in (or in the local backend environment for local testing). Remove the variable after the login; the code can be removed once the adjustment is no longer needed. This is simulated practice money only and has no cash value.

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

## Simulated investor identifiers

Every account has server-generated simulated CSCS and CHN display identifiers. They are fictional, start with `DEMO-`, and are not usable for brokerage, settlement, or securities transfers. The identifiers are generated during registration and Google account creation. On login or the authenticated profile request, older accounts missing either identifier are provisioned atomically. Unique partial database indexes protect both values against duplicates.

### `GET /api/auth/me`

Requires the signed-in account's session cookie and returns only that account's profile:

```json
{
  "user": {
    "id": "user-id",
    "name": "Jane Doe",
    "email": "jane@example.com",
    "virtualBalanceNgn": 1000000,
    "simulatedInvestorIds": {
      "cscs": "DEMO-CSCS-a1b2c3d4e5f60718",
      "chn": "DEMO-CHN-18273645aabbccdd"
    }
  }
}
```

Registration and successful login responses include the same `simulatedInvestorIds` object. The API never accepts these identifiers from a request, and the response excludes stored authentication secrets and unrelated account fields. Frontends should label both values **“Simulated — not valid for real trading.”**

## Simulated contests

Contests are authenticated, educational simulations only: no deposits, real orders, cash prizes, or withdrawable rewards. Contest portfolios are separate from a user's regular demo portfolio and start with the contest's configured virtual balance. Trades can only use symbols and prices in the server's latest stored market snapshot. Cash, holdings, trade history, portfolio value, and rankings are stored or calculated by the backend; request bodies cannot set an execution price, balance, result, or rank.

All contest routes use the signed-in `ngxlab_session` cookie. Contest IDs are lowercase slugs. The API reports status from validated `startsAt` and `endsAt` values (`upcoming`, `active`, or `completed`); it does not trust a stored status field.

Contest definitions are provisioned by the operator directly in the MongoDB `contests` collection. There is intentionally no public contest-creation endpoint. Example document:

```json
{
  "_id": "november-learning",
  "title": "November learning contest",
  "description": "Practice portfolio decisions with simulated funds.",
  "rules": [
    "Use simulated trades only.",
    "The leaderboard ranks percentage return."
  ],
  "startsAt": "2026-11-10T00:00:00.000Z",
  "endsAt": "2026-11-20T00:00:00.000Z",
  "startingBalanceNgn": 1000000,
  "maxParticipants": 200,
  "eligibility": {
    "description": "Open to all signed-in learners.",
    "minimumAccountAgeDays": 0
  },
  "participantCount": 0
}
```

Store `startsAt` and `endsAt` as MongoDB dates, not strings. `startsAt` must precede `endsAt`; the starting balance must be a positive whole number. Optional eligibility fields are `allowedUserIds` (an allowlist of account IDs) and `minimumAccountAgeDays`. `maxParticipants` is optional. Configure a new contest before its start; users may join only while it is upcoming, and trades are accepted only while active. Joining is unique per account and contest, and capacity reservation and portfolio creation run in one MongoDB transaction.

### `GET /api/contests`

Lists contests and their current status, rules, dates, balance, eligibility description, and participant counts. Personal details and participant account IDs are never included.

```json
{
  "success": true,
  "contests": [
    {
      "id": "november-learning",
      "title": "November learning contest",
      "description": "Practice portfolio decisions with simulated funds.",
      "rules": ["Use simulated trades only."],
      "startsAt": "2026-11-10T00:00:00.000Z",
      "endsAt": "2026-11-20T00:00:00.000Z",
      "status": "upcoming",
      "startingBalanceNgn": 1000000,
      "participantCount": 0,
      "maxParticipants": 200,
      "eligibilityDescription": "Open to all signed-in learners."
    }
  ]
}
```

### `GET /api/contests/:contestId`

Returns contest details, whether the signed-in account has joined, and its eligibility result.

### `POST /api/contests/:contestId/join`

Joins once when eligible, while the contest is upcoming and below capacity. Success (`201`):

```json
{
  "success": true,
  "participation": {
    "contestId": "november-learning",
    "joinedAt": "2026-11-09T12:00:00.000Z",
    "virtualBalanceNgn": 1000000
  }
}
```

### `POST /api/contests/:contestId/trades`

Places a server-priced simulated order for a joined participant while the contest is active. Only the following request fields are accepted:

```json
{
  "symbol": "DANGSUGAR",
  "side": "BUY",
  "quantity": 10
}
```

The server validates the symbol and current stored quote, calculates the rounded execution total, checks available contest cash or shares, and atomically updates the participant's contest portfolio and trade history. The response includes the server-determined trade and updated portfolio/result:

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
    "tradeDate": "2026-11-10T10:00:00.000Z",
    "marketTradeDate": "2026-11-09"
  },
  "portfolio": {
    "virtualBalanceNgn": 999350,
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
    "portfolioValueNgn": 1000000,
    "returnNgn": 0,
    "returnPercent": 0
  }
}
```

### `GET /api/contests/:contestId/leaderboard`

Returns rank, a randomly assigned pseudonymous learner alias, portfolio value, and server-calculated return. It does not expose names, email addresses, account IDs, holdings, or trade history. Participants whose holdings cannot be valued from the applicable stored snapshot are counted in `unrankedCount` and omitted until they can be valued.

```json
{
  "success": true,
  "contest": {
    "id": "november-learning",
    "title": "November learning contest",
    "description": "Practice portfolio decisions with simulated funds.",
    "rules": ["Use simulated trades only."],
    "startsAt": "2026-11-10T00:00:00.000Z",
    "endsAt": "2026-11-20T00:00:00.000Z",
    "status": "active",
    "startingBalanceNgn": 1000000,
    "participantCount": 1,
    "maxParticipants": 200,
    "eligibilityDescription": "Open to all signed-in learners."
  },
  "asOf": "2026-11-10T18:00:00.000Z",
  "marketTradeDate": "2026-11-10",
  "unrankedCount": 0,
  "leaderboard": [
    {
      "rank": 1,
      "publicAlias": "Learner-a1b2c3d4e5f6",
      "portfolioValueNgn": 1012500,
      "returnNgn": 12500,
      "returnPercent": 1.25
    }
  ]
}
```

### `GET /api/contests/:contestId/me` and `GET /api/contests/me`

Return the signed-in account's own participation, virtual cash, holdings, trade history, and calculated result for one contest or all joined contests. These routes never return another participant's private portfolio.

```json
{
  "success": true,
  "contest": {
    "id": "november-learning",
    "title": "November learning contest",
    "status": "active",
    "startingBalanceNgn": 1000000
  },
  "participation": {
    "joinedAt": "2026-11-09T12:00:00.000Z",
    "publicAlias": "Learner-a1b2c3d4e5f6",
    "virtualBalanceNgn": 999350,
    "holdings": [],
    "tradeHistory": []
  },
  "result": {
    "portfolioValueNgn": 1000000,
    "returnNgn": 0,
    "returnPercent": 0,
    "valuedAt": "2026-11-10T18:00:00.000Z",
    "marketTradeDate": "2026-11-10"
  }
}
```

Completed contests are valued against the latest archived market snapshot refreshed at or before `endsAt`; later quotes cannot alter a completed leaderboard. The market refresh job archives snapshots going forward. A completed contest returns `503` (`CONTEST_VALUATION_NOT_READY`) if no eligible end-date snapshot exists. As with other transaction-backed portfolio endpoints, MongoDB must support transactions (for example, a replica set).

Contest errors use the standard `{ "error": { "code": "...", "message": "..." } }` response shape. Relevant codes include `CONTEST_NOT_FOUND`, `CONTEST_CONFIGURATION_INVALID`, `JOINING_CLOSED`, `ALREADY_JOINED`, `NOT_ELIGIBLE`, `CONTEST_FULL`, `NOT_JOINED`, `CONTEST_NOT_ACTIVE`, `INSUFFICIENT_VIRTUAL_FUNDS`, `INSUFFICIENT_HOLDINGS`, `UNKNOWN_SYMBOL`, `MARKET_DATA_NOT_READY`, and `CONTEST_VALUATION_NOT_READY`.

Run backend tests with `cd backend && npm test`.
