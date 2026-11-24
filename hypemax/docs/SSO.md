# HYPEMAX Single Sign-On (SSO)

## What it is

The HYPEMAX storefront is now an **OpenID Connect (OIDC) identity provider**. A customer signs in once on the
storefront, with email and password or with Google. Any other HYPEMAX-owned app can then sign them in without
asking again: a mobile app, `app.hypemax.in`, a partner or coach portal, and so on.

```
      customer browser
            |
            | 1. "Sign in" on app.hypemax.in
            v
  app.hypemax.in ----302----> https://www.hypemax.in/oauth/authorize?...&code_challenge=...
                                     |
                                     | 2. not signed in? -> /login (password or Google)
                                     |    already signed in? -> straight through (that is the SSO part)
                                     v
  app.hypemax.in/callback?code=...&state=...&iss=...
            |
            | 3. back channel: POST /oauth/token  (code + code_verifier [+ client secret])
            v
     id_token (who) + access_token (15 min) + refresh_token (rotating)
```

**Google is not the SSO.** Google is one *upstream* way to prove identity to HYPEMAX. Every connected app only
ever talks to HYPEMAX, and HYPEMAX always issues the same customer ID (`sub`) however the customer signed in.
Duplicate accounts are therefore impossible across apps.

## Endpoints

| Purpose | URL |
|---|---|
| Discovery | `/.well-known/openid-configuration` |
| Keys (JWKS) | `/oauth/jwks` |
| Authorize | `/oauth/authorize` (GET) |
| Token | `/oauth/token` (POST, form or JSON) |
| User info | `/oauth/userinfo` (Bearer access token) |
| Revoke | `/oauth/revoke` (POST, RFC 7009) |
| Logout (RP-initiated) | `/oauth/logout?id_token_hint=…&post_logout_redirect_uri=…&state=…` |

## Security properties

* **Authorization Code + PKCE (S256)** is mandatory for every client, public or confidential.
* **No implicit flow, no password grant.** Tokens never appear in browser URLs.
* **Exact redirect URI match** against the registered list. Until the client and redirect URI are validated
  the server never redirects, so it can't be used as an open redirect.
* **state** is required and echoed back. **nonce** is placed in the ID token. The **iss** parameter is
  returned on the callback (RFC 9207, mix-up protection).
* **ID and access tokens** are RS256 JWTs with `iss`, `aud` (= client_id), `exp`, `iat`, `sub`, `sid`. Clients
  must verify the signature against `/oauth/jwks` and check `iss`, `aud`, `exp` and `nonce`.
* **Authorization codes** live 60 s, are single-use, and are stored hashed. Replaying a code revokes every
  token issued from it.
* **Refresh tokens** are opaque, stored hashed, single-use and **rotated** on every use. Presenting an already
  rotated token is treated as theft, and the whole token family is revoked.
* Every grant is **bound to the HYPEMAX browser session** that approved it. When the customer logs out of HYPEMAX
  (or their session expires), refresh stops working at once and `/oauth/userinfo` rejects their access tokens.
* **Client secrets** are only stored as SHA-256 hashes in `SSO_CLIENTS`. Public clients (mobile, SPA) have no
  secret and rely on PKCE. Secrets never go to the browser.
* **Signing key** comes from `SSO_PRIVATE_KEY`. If that is not set, a key is generated once and kept in the
  `sso_keys` table.

## Login, logout and account switching

| Action | Behaviour |
|---|---|
| Customer signs in on any app | Redirected to HYPEMAX `/login` once. Later apps get a code with no prompt. |
| `prompt=none` | Returns `error=login_required` instead of showing a login page (silent check). |
| `prompt=login` / `select_account` | Shows **"You're signed in as X – Continue / Use another account"**. |
| Customer clicks Log out on the storefront | Session deleted, **all SSO refresh tokens from that session revoked**, cookies and cache cleared, other open tabs reload. |
| A connected app logs out | Redirect to `/oauth/logout` with `id_token_hint` (and optionally a registered `post_logout_redirect_uri`). HYPEMAX ends the session only if the hint's `sid` matches this browser. This stops third-party links from logging customers out. |
| Other connected apps after a logout | Their next refresh fails (`invalid_grant`). Access tokens expire within `SSO_ACCESS_TOKEN_MINUTES`, and resource servers that call `/oauth/userinfo` see the logout immediately. |

There is no front-channel iframe logout. It is unreliable in modern browsers because of third-party cookie
blocking, so the short access-token lifetime plus refresh revocation is the logout mechanism.

## Registering a connected app

Add the app to `SSO_CLIENTS` (JSON array) and restart:

```json
[
  {
    "client_id": "hypemax-app",
    "name": "HYPEMAX App",
    "redirect_uris": ["https://app.hypemax.in/callback", "in.hypemax.app:/oauth/callback"],
    "post_logout_redirect_uris": ["https://app.hypemax.in/"]
  },
  {
    "client_id": "coach-portal",
    "name": "Coach portal (server-side)",
    "redirect_uris": ["https://coach.hypemax.in/auth/callback"],
    "client_secret_hash": "<sha256 hex of the secret>"
  }
]
```

Any standard OIDC client library works (for example `openid-client` for Node, AppAuth for Android/iOS). Point it at
`https://YOUR-DOMAIN/.well-known/openid-configuration`.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `SSO_ISSUER` | no (defaults to `SITE_URL`) | Issuer URL in tokens; must be the public https URL |
| `SSO_PRIVATE_KEY` | recommended | RS256 private key (PKCS#8 PEM; one line with `\n` is fine) |
| `SSO_CLIENTS` | yes, to connect apps | JSON list above |
| `SSO_ACCESS_TOKEN_MINUTES` | no (15) | Access token lifetime |
| `SSO_REFRESH_TOKEN_DAYS` | no (30) | Refresh token lifetime |

## Database

`migrations/002_sso.sql` adds `sso_keys`, `sso_codes` and `sso_refresh_tokens`. It is applied automatically on start.

## Tested

`test/audit.test.js` covers the following against the real server and database:

* discovery and JWKS
* the redirect to login when signed out, and `prompt=none`
* code and PKCE success, plus a wrong verifier
* ID token signature verification with the published JWKS (`iss`, `aud`, `nonce`, `exp`)
* userinfo
* code replay, which revokes the tokens from that code
* refresh rotation and stolen-token reuse detection
* central logout, after which refresh and userinfo fail
* unregistered redirect URI, which gets no redirect
* an unknown client
* a missing PKCE challenge
* confidential-client secret checking (Basic and post)
* the logout hint check and the post-logout redirect allow-list

## Current scope

At the time of writing, only the storefront exists, so **no second app is connected yet**. The provider is
deployed and tested, and connecting the first app needs only a `SSO_CLIENTS` entry.
