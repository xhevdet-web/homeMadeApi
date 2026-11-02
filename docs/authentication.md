# JWT access authentication

Existing email/username login and POST /api/v1/users registration are preserved.
No schema changes, token database storage, refresh tokens, or role authorization
are introduced.

## Environment

Set these in the backend .env or deployment environment:

```dotenv
JWT_ACCESS_SECRET=<cryptographically-random-secret-at-least-32-bytes>
JWT_ACCESS_EXPIRES_IN=60m
```

Generate a secret locally with Node's crypto.randomBytes(48).toString('hex').
Never commit it. JWT_SECRET remains a legacy fallback only when
JWT_ACCESS_SECRET is absent. The local access secret was copied from the existing
secret to preserve issued tokens. Changing it invalidates old access tokens.

Expiry accepts positive integer seconds or a suffix s, m, h, d; default is 60m.
Examples: 15m (900 seconds), 60m (3600 seconds). Invalid settings fail startup.

## Endpoints

- POST /api/v1/auth/login: accepts { email, password } or the existing
  { identifier, password } for email/username login. Argon2 verifies the password.
  Unknown, inactive, malformed-hash and wrong-password accounts return 401.
  Success returns { accessToken, expiresIn, user }. expiresIn is seconds for the
  existing mobile client. user uses the existing userName spelling and includes
  the safe profile fields; it never includes passwordHash.
- GET /api/v1/auth/me: requires Authorization: Bearer <accessToken> and returns
  the current active user through JwtAuthGuard and CurrentUser.
- POST /api/v1/users: existing registration and uniqueness validation unchanged.

Tokens contain sub and tokenUse plus standard iat/exp/iss/aud claims. No password
or profile data is included. JwtStrategy uses the existing @nestjs/jwt verifier:
HS256 only, signature, expiry, issuer and audience checks, then an active-user
lookup through the injected PrismaService. Missing expiration, invalid token
purpose, deleted and inactive users fail authentication.

## Website cookie session

The website keeps the access token in an httpOnly cookie, so a page reload stays signed
in without exposing the token to scripts. The mobile app is unchanged.

- Login with the header `X-HomeMade-Client: web`: the response sets the `hc_session`
  cookie (HttpOnly, Path=/api/v1, Max-Age = expiresIn) and returns `{ expiresIn, user }`
  without `accessToken`. Without the header, login works exactly as before.
- JwtAuthGuard and OptionalJwtAuthGuard accept `Authorization: Bearer` first, then the
  cookie. A cookie-authenticated POST/PATCH/PUT/DELETE must also send
  `X-HomeMade-Client: web`. The custom header forces a CORS preflight, which only the
  origins in CORS_ORIGINS pass, so other sites can't make writes with the cookie.
- POST /api/v1/auth/logout clears the cookie (204). Tokens are stateless, so a copied
  token stays valid until it expires.
- The browser must send `credentials: 'include'`. CORS allows credentials and the
  client header.

```dotenv
CORS_ORIGINS=http://localhost:8081,http://localhost:5173
AUTH_COOKIE_SAMESITE=lax   # lax | strict | none; use none when website and API are on different sites
AUTH_COOKIE_SECURE=false   # defaults to true when NODE_ENV=production; forced true for none
AUTH_COOKIE_DOMAIN=        # optional, e.g. .example.com to share across subdomains
```

## Google sign-in

`POST /api/v1/auth/google` with `{ idToken }`, used by the website and the app for both
sign-in and sign-up. The response is the same session as `/auth/login` (cookie for the website
with `X-HomeMade-Client: web`, `{ accessToken, expiresIn, user }` for the app), plus
`profileComplete`. Every existing endpoint then works unchanged; there is no Google-specific
authorization and the Google token is never used as the HM Craft session.

- The ID token is verified with `google-auth-library` (signature against Google's keys, issuer
  `accounts.google.com`, expiry, audience). Accepted audiences: `GOOGLE_WEB_CLIENT_ID` (website
  and Android), `GOOGLE_IOS_CLIENT_ID`, `GOOGLE_ANDROID_CLIENT_ID`. None set → 503.
- Identity is the verified `sub`, stored in `users.google_id`. Email, names and role from the
  request body are never used; `forbidNonWhitelisted` rejects extra fields.
- Linked `google_id` → that user. Otherwise a verified Google email is required (401 if not).
- **Linking policy.** If a user with that email exists, Google is linked only after the HM
  Craft password is sent with the same token: the first request answers 409
  `{ message, email }`, the apps ask for the password and resend `{ idToken, password }`. A
  wrong password → 401 `Incorrect password`. HM Craft never verified emails at registration, so
  a matching email alone doesn't prove the account belongs to the Google user. The password
  hash is kept, so both ways in keep working. An account already linked to another Google ID
  is never relinked.
- No user → a new `CUSTOMER` with `password_hash` NULL (no generated password). Missing
  `given_name`/`family_name` are stored empty and `profileComplete: false` tells the apps to
  ask for them; delivery details are asked at checkout as for every customer.
- Disabled accounts are refused (401) whichever way they sign in. Password login for a
  Google-only account fails like a wrong password; change-password answers 400.
- Errors stay generic (`Unable to sign in with Google`) so they reveal nothing about accounts;
  only the holder of a verified Google token for an email learns that it has an account.

```dotenv
GOOGLE_WEB_CLIENT_ID=<web client>.apps.googleusercontent.com
GOOGLE_IOS_CLIENT_ID=<ios client>.apps.googleusercontent.com
GOOGLE_ANDROID_CLIENT_ID=<android client>.apps.googleusercontent.com
```

Migration `20261102090000_add_google_sign_in` is additive: `password_hash` becomes nullable and
`google_id` (unique, nullable) is added. Apply with `prisma migrate deploy`.

## Public stats

GET /api/v1/stats/public (no auth) returns
`{ registeredUsers, completedOrders, products, categories }`: active customer accounts,
COMPLETED orders, active COMPANY products and active categories. Counts only, cached for
60 seconds in memory and with `Cache-Control: public, max-age=60`.

## Protect another endpoint

Import AuthModule into the endpoint's Nest module, then use:

```typescript
@UseGuards(JwtAuthGuard)
@Get('example')
example(@CurrentUser() user: AuthenticatedUser) {
  return user;
}
```

Imports:
- JwtAuthGuard: src/common/guards/jwt-auth.guard.ts
- CurrentUser: src/common/decorators/current-user.decorator.ts
- AuthenticatedUser: src/common/types/authenticated-user.type.ts

The guard attaches the user to request.user. This implementation reuses
@nestjs/jwt directly; an additional Passport dependency is unnecessary.
Only auth/me is protected by this change. Applying guards to other feature
endpoints and resource ownership rules is separate work.

## Verification

Vitest covers successful email/username login, bad credentials, unknown and
inactive users, invalid hashes, safe responses, missing/invalid/expired tokens,
issuer/audience/purpose checks, current-user lookup, guard reuse from another
module, and environment configuration. Existing registration and Users tests
remain in place. No live accounts are changed during automated mocked tests.
