# packages/modules/auth

Signing in, with Better Auth on our own tables in the `auth` schema. This is the only code that uses
the `crm_auth` role, which finds people before any tenant context exists.

```ts
const auth = createAuthentication({
  connectionString, // crm_auth's
  secret, // 32 characters or more
  publicUrl: 'https://crm.example.com',
  onConnectionError: (error) => logger.error({ err: error }, 'database connection failed'),
  log: (level, message, ...details) => logger[level]({ details }, message), // Better Auth's own
  sendMail: (email) => mailer.send(email), // sign-in links and resets (@repo/mail)
});

await auth.handle(request); // Better Auth's endpoints, under /api/auth
await auth.signedIn(headers); // who, where they work, and their two-factor state; or undefined
await auth.workplace(person, businessId); // the agency or a business, with its permissions; or a refusal
await auth.whoIs(person); // name, agency and the businesses they may enter, for GET /me
await auth.apiKey(key); // what a request signed with an API key may do, or undefined
await auth.createUser({ email, name, password, emailVerified }); // trusted provisioning
await auth.sendInvitation(email, token); // true when delivered; false leaves it available for resend
await auth.close(); // waits for mail being sent, then closes the pool
```

- **Email and password; nobody signs themselves up.** People arrive through the first
  start and invitations. Each consumes its link and writes the user,
  password and membership in one `crm_auth` transaction. `createUser` remains the trusted
  provisioning helper for a user and password together.
- **Invitations:** `GET /invitations/check?token=...` checks possession; `POST
  /invitations/accept` locks and consumes the hashed, unexpired token for its invited email.
  Existing accounts must have a matching signed-in session; acceptance never changes their
  password or an existing membership's role. New people choose a name and password and
  are signed in afterward. A failed acceptance leaves the token unused. These endpoints
  live under `/api/auth`, separate from the tenant API. Better Auth's origin checks and
  shared rate limits apply. `readTeamPeople` reads names/emails within the caller's tenant
  transaction so tenancy never queries auth's tables itself.
- **Links by email**: a sign-in link works once within 15 minutes, a password
  reset once within an hour. Mail goes only to people who exist, after the answer, so the
  answer's timing shows nothing.
- **Two-factor sign-in and passkeys** (`src/factors.ts`):
  - codes from an authenticator app, with ten recovery codes, asked for after a password
    or a sign-in link;
  - passkeys that verify the person, which sign in on their own;
  - an agency can require two-factor sign-in of its staff. `signedIn` says whether it's
    required and whether it's on, and `GET /api/auth/security` tells the dashboard.
- **Session cookies** are `HttpOnly` and `SameSite=Lax`. When the public URL is HTTPS,
  they're also `Secure`, with the `__Secure-` prefix. Only pages from the public URL may
  post to the endpoints.
- **Rate limits:** 10 sign-in attempts per client in 15 minutes, plus Better Auth's own
  limits, such as 5 sign-in links a minute and 3 two-factor requests in 10 seconds. They're
  counted in `auth.rate_limits`, so every app container shares them. The client's IP comes
  only from `CLIENT_IP_HEADER`, which the server sets from its own `TRUST_PROXY` reckoning.
- **`signedIn`** gives the person's agency, whether they're agency staff, and the
  businesses they're members of. It only reads the session: Better Auth's own
  `/api/auth/get-session` renews it, because only that response can carry the renewed
  cookie. Without a session cookie, it doesn't ask the database.
- **`workplace`** decides where a request works.
  - Agency staff work at the agency, or in any business of their agency they name.
  - A business user works only in their own businesses, or their only one when they name
    none, and never at the agency, which would show them every business.
  - A refusal comes with its status: 404 outside the agency, 403 otherwise.
  - Working somewhere comes with what the person's role allows there. That's the agency
    role for its staff, at the agency and in every business, and the membership's role for
    a business user. `signedIn` reads each membership's role with the memberships.
- **`whoIs`** gives the person's name, their agency, and the businesses they may enter,
  by name. That's all of the agency's for its staff, and the active ones a business user
  belongs to.
- **`apiKey(key)`** signs an API request in with a key. It hashes the key and finds it
  through `crm_auth`: not revoked or expired, in an active business. It's read on every
  request, so a revoked key fails on its next. It gives the key's business and its scopes,
  which the server uses as the request's permissions. It notes `last_used_at` at most once
  a minute.
- **`readUserNames(trx, ids)`** names people for other modules, such as a record's
  activity: their
  name, or their email address when they've given none. It runs in the reader's tenant
  transaction, as `crm_app`, so it leaves out anyone the reader can't see.

The integration tests sign in as real clients would: `@repo/testing`'s `totpCode` computes
an authenticator app's codes, and `softPasskey` answers WebAuthn as an authenticator does.

```bash
pnpm --filter @repo/module-auth build
pnpm --filter @repo/module-auth test:integration   # against Postgres in Docker
```
