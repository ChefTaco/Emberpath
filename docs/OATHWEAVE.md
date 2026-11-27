# Direct browser authorization

The optional suite integration verifies RS256 credentials against explicit
`OATHWEAVE_ISSUER`, `OATHWEAVE_JWKS_URL` and `OATHWEAVE_USERINFO_URL` HTTPS
configuration. Configure all three together; the issuer is the browser issuer
selected in Oathweave, not an inferred native JWT issuer. TLS verification and
online session revocation are mandatory. Tokens have one exact product audience
and a maximum fifteen-minute lifetime, with no clock-skew tolerance. Tokens must
carry `clientId` and `roles` claims, and only people (not service accounts) are
accepted. Permissions are not inferred from roles. Verification uses the suite's
shared verifier in `@hivemagnus/hive-common`, and the shared Oathweave conformance
vectors run in the test suite. Native machine credentials and standalone
authentication remain available.

`EMBERPATH_OATHWEAVE_IDENTITIES_JSON` is a protected JSON array of explicit account links:

```json
[{"issuer":"https://identity.example.com","subject":"example-subject","localId":"existing-product-identity"}]
```

`localId` means existing AdminUser ID; it may not be `system` or start with `service:`.
Link issuers must be HTTPS URLs. Unlinked subjects are denied.
Duplicate issuer/subject links, extra fields, and email-based mappings are rejected.
Do not put live links or credentials in Git. Prepare and review links independently
for each installation before applying configuration. No API request creates a
replacement identity to impersonate a legacy account.

The Hive suite controller configures this integration, and the links, for suite
installations. Before switching an existing standalone installation, rehearse a
restore and check permissions, native clients and browser workflows; a passing unit
suite alone is not enough.

Direct model-resource credentials cannot invoke the retained IAM, Memory or Hive
proxy/coordinator paths, even if an operator mistakenly grants broad permissions.
Use each owning product API. Suite lifecycle operations belong to Hive/Magnus.
Native compatibility paths remain available. HiveXUI is the only UI; Emberpath serves
no UI of its own.

## Step-up with an ID token

Credential and policy changes need a sign-in from the last 15 minutes
(`EMBERPATH_RECENT_AUTH_SECONDS`, default `900`, 60-43200) and otherwise answer `403` with
`STEP_UP_REQUIRED`. They are the writes (every method but `GET`, `HEAD` and `OPTIONS`) under
`/api/client-keys`, `/api/iam/clients`, `/api/iam/roles`, `/api/iam/password-policy`,
`/api/hive/actors` and `/api/hive/upgrades`: issuing, rotating, changing, deleting or revoking a
key, client secret, role, actor credential or password policy, acknowledging a credential
receipt, and planning or applying an upgrade. Reads of those paths (listing keys, key usage,
clients, roles, the password policy, actors, upgrade status) need only the read permission,
never a step-up: none of them returns secret material. A new key or client secret is shown once,
in the answer to the write that issued or rotated it (`Cache-Control: no-store`); lists and
details carry only the key prefix. For a bearer token the sign-in time is its `auth_time`. To
confirm a sign-in without a password:

1. Start a step-up. The answer holds a single-use `nonce` (valid for 10 minutes), when the
   re-authentication started, the window and the accepted clients:

   ```http
   POST /api/auth/step-up/challenge
   Authorization: Bearer <the caller's Emberpath access token>
   ```

   ```json
   {"nonce": "...", "startedAt": "...", "expiresIn": 600, "maxAgeSeconds": 300, "audiences": ["hivexui-emberpath"]}
   ```

2. Ask Oathweave for a fresh authorization with that nonce: `prompt=login` (or `max_age`), PKCE,
   for one of the `audiences` clients, and exchange the code.
3. Send the ID token:

   ```http
   POST /api/auth/step-up
   Authorization: Bearer <an Emberpath access token of the same Oathweave session>
   Content-Type: application/json

   {"idToken": "<ID token>"}
   ```

Emberpath checks it with HiveCommon's `createRecentAuthenticationVerifier`: RS256 against
`OATHWEAVE_JWKS_URL`, issuer `OATHWEAVE_ISSUER`, an audience in `EMBERPATH_STEP_UP_AUDIENCES`
(default `hivexui-emberpath`), a lifetime of at most 15 minutes, the `nonce` of a challenge this
user started (used up by the attempt), `sub` equal to the caller's Oathweave subject and `sid`
equal to the caller's Oathweave session, and `auth_time` at most
`EMBERPATH_STEP_UP_MAX_AGE_SECONDS` (default 300) old and not earlier than the challenge (30 s of
clock tolerance): a forced sign-in must be new. An access token is never accepted as an
ID token. The answer is `{"ok": true, "authTime": "...", "recentUntil": "..."}`; that session's
credential and policy changes then count from `authTime` for `EMBERPATH_RECENT_AUTH_SECONDS`
(15 minutes by default), until `recentUntil`. A refused proof is
`401` with `error` `REAUTH_REQUIRED`, `REAUTH_STALE` or `REAUTH_INVALID` and a `reason`; `503`
means Oathweave is not configured (`STEP_UP_UNAVAILABLE`) or its keys are unavailable
(`REAUTH_UNAVAILABLE`). Step-ups are kept in memory: after a restart, step up again. A session
signed in with the deprecated password sign-in can step up the same way when its account is
linked to the Oathweave identity (`EMBERPATH_OATHWEAVE_IDENTITIES_JSON`) or was signed in through
Oathweave.

## Password sign-in is retired

In `iam-oidc` mode, `POST /api/auth/login` and `POST /api/auth/reauthenticate` took a person's
Oathweave username and password and relayed them to Oathweave. Emberpath no longer handles
Oathweave passwords: in that mode both are off by default and answer `410 Gone` with `{"error": "PASSWORD_RELAY_DISABLED", "stepUp": "/api/auth/step-up", "docs": ...}`.
Sign in through HiveXUI with Oathweave browser sign-in, and confirm sensitive actions with
[step-up](#step-up-with-an-id-token).

A standalone installation that has no Oathweave browser sign-in can keep the relay for now with
`EMBERPATH_PASSWORD_RELAY=true`. It is deprecated (`Deprecation` and `Sunset` headers on every
answer in `iam-oidc` mode) and is removed in the next major release.

OS mode (`HIVE_ROUTER_AUTH_MODE=os`, the standalone default) is not a relay: it checks the
operator's OS password locally through PAM, and its sign-in and re-authentication are unchanged.
