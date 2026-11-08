# NGXLab API

## Authentication configuration

Set these variables in the deployment environment:

- `MONGODB_URI`: MongoDB connection string, including the database name in its path.
- `GOOGLE_CLIENT_ID`: OAuth 2.0 web client ID used to verify Google ID tokens.
- `RESEND_API_URL`: Resend email endpoint (`https://api.resend.com/emails`).
- `RESEND_API_KEY`: Resend API key.
- `RESEND_FROM_EMAIL`: sender address verified with Resend.

The API creates unique account indexes and expiring session, password-reset, and rate-limit indexes automatically. Do not commit credentials.

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
    "email": "jane@example.com"
  }
}
```

Registration responds with HTTP `201`; login and Google sign-in respond with HTTP `200`.
Password accounts can sign in immediately after registration; email verification is not currently required. Google sign-in requires a Google-verified email.

### `POST /api/auth/forgot-password`

Request:

```json
{
  "email": "jane@example.com"
}
```

Returns the same generic response whether or not the account exists. When an account exists, the API emails a single-use link to `https://www.ngxlab.xyz/reset-password?token=...`. The link expires after 30 minutes. Login and recovery requests are rate-limited.

### `POST /api/auth/reset-password`

Request:

```json
{
  "token": "token-from-the-reset-link",
  "password": "a-new-strong-password"
}
```

A successful reset invalidates existing sessions. The frontend must provide the `/reset-password` page to read the token from the query string and submit it to this endpoint.

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
