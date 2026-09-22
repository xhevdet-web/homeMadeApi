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
