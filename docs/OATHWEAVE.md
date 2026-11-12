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

The integration is under development. A passing unit suite does not authorize
production adoption. Restore rehearsal, permissions, native clients, and browser
workflow parity must pass before switching an existing installation.

Direct model-resource credentials cannot invoke the retained IAM, Memory or Hive
proxy/coordinator paths, even if an operator mistakenly grants broad permissions.
Use each owning product API. Suite lifecycle operations belong to Hive/Magnus.
Native compatibility paths remain available while migration and parity are pending.
