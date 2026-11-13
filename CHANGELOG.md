# Changelog

## [2.4.0] - 2026-11-13

### Added

- `POST /v1/decisions`: the OpenAI Decisions API (`questions[]` of `predicate`, `choice` and
  `score`, answered with `{model, answers[], usage}` in question order). It is routed like
  `/v1/chat/completions`, with client key scopes, aliases, routing rules, provider priority,
  failover, traces (`actorId`, `metadata-only`), quotas and usage. Backends: OpenAI
  `gpt-6-luna` (passed through), and Jev through TypeSafe (`OPENAI_GENERIC` tagged
  `jev-decisions`) or OpenRouter, translated both ways. A backend that cannot express a request
  feature (Jev: images, tool items, prompt caching, `safety_identifier`) is skipped for that
  request, and with none left the answer is `400 unsupported_decision_feature` naming it.
  `CODEX` and other chat-only kinds never serve decisions. `OPENAI` providers list
  `v1.decisions` in their default supported routes; `v1.decisions` is a new endpoint kind in the
  model-admin contract and the OpenAPI document.
- `EMBERPATH_DECISIONS_JEV_ENABLED` (default `false`): explicit opt-in that seeds the
  decisions-only `typesafe-jev` and `openrouter-jev` provider records from the shadow decision
  keys. Without it the shadow keys are never used for `/v1/decisions`. Shadow mode and its
  settings are unchanged.
- A built-in `decision` alias (to `jev-latest`, with `gpt-6-luna` as the alternative) and the
  rules `route-decision-alias` and `deny-decision-alias-chat`, seeded on fresh installs only.
  Existing installations add them with a routing revision; the README's Decisions API section
  has the exact patch.
- Decisions traces record question counts and types, the input shape, the backend and answer
  types, never the question text. Cost uses only the declared input price, since only input
  tokens are billed. Decisions usage counts toward the calling key's quota; shadow decision
  calls still do not.

### Changed

- Providers that do not list `v1.models` in their supported routes are healthy when their
  host answers without a server error, so decisions-only records do not show as down.

### Security

- Update `@hono/node-server` to 2.1.8 for GHSA-qv5m-9pm6-hqp3 and GHSA-jpvv-r467-5p4w.

## [2.3.0] - 2026-11-12

### Changed

- HiveXUI is the only UI for the Hive:Magnus product line. On the admin listener, `GET /` and
  every other non-API path that used to fall through to the bundled UI now answer a short page
  saying Emberpath is managed in HiveXUI (`200`, `Cache-Control: no-store`, a strict
  `Content-Security-Policy`, no scripts or external assets). Old bookmarks move to HiveXUI:
  set the new optional `HIVEXUI_URL` to have those paths answer `302` to exactly that URL
  instead. Emberpath refuses to start unless `HIVEXUI_URL` is unset, empty or an absolute
  `http(s)` URL without credentials or a fragment. API paths answer exactly as before.

### Removed

- The standalone web UI is retired: the `ui/dist` index fallback, the `/assets/*` static file
  route, the UI build leftovers in the `clean` script and TypeScript configs, the React and
  Vite development dependencies, and the Playwright tests of the old UI and their fixture
  stack. `npm run test:e2e` now checks the HiveXUI page and redirect against two built servers.

## [2.2.0] - 2026-11-12

### Added

- Traces record the agent they belong to in a new nullable `actorId`, copied at trace start from
  the authenticating client key's metadata (`actorId`, or `memoryAgentId` when the key has none)
  and only when it is a valid agent ID. Request headers and bodies are never used. Existing
  traces and unauthenticated requests keep `actorId: null`.
- `GET /api/traces` accepts optional `actorId`, `clientKeyId`, `since` (ISO 8601) and `limit`
  (default 50, maximum 200) filters with opaque `cursor` pagination. Passing any of them returns
  a newest-first `{data, nextCursor}` page; invalid values return the existing `400` validation
  error. Calls without them return the same latest-100 `{data}` list as before. The model admin
  contract adds `traceListQuerySchema`, `tracePageSchema` and the optional `actorId` trace field.
- Router data format `managed-format-2` adds the `Trace.actorId` column and
  `(actorId, createdAt)` and `(clientApiKeyId, createdAt)` indexes. It is additive and fast;
  apply it with `emberpath migrate` (or `HIVE_AUTO_MIGRATE=true`) when upgrading.

## [2.1.0] - 2026-11-12

### Changed

- Verify Oathweave admin tokens with the suite's shared verifier from `@hivemagnus/hive-common`,
  keeping Emberpath's rules: people only, exact `emberpath` audience, required `clientId` and
  `roles` claims, no clock-skew tolerance, an online session check on every request, and the
  existing `EMBERPATH_OATHWEAVE_IDENTITIES_JSON` link format. The shared Oathweave conformance
  vectors now run in the test suite. Error responses are unchanged.
- `/health/live` and `/health/ready` on both listeners return the suite-standard health body
  (`status`, `service`, `version`, `time`, named `checks`) with the same status codes as before.
  `/health`, `/ready` and `/health/dependencies` keep their existing report bodies.
- Every request runs in a request context, and log lines written while serving it carry its
  request ID. The admin listener accepts a safe inbound `x-request-id`, `x-hive-request-id` or
  `x-correlation-id` and W3C `traceparent`; the inference listener ignores them and always
  generates its own ID, so external clients cannot choose request IDs. Both still echo the ID
  as `x-request-id` and `x-hive-request-id`.

## [2.0.5] - 2026-11-11

- Refuse native deployments and service restarts on Node.js below the package security minimum before changing remote state.
- Require patched Node.js 24.22.3 or 26.13.1, and refresh build and runtime image pins for upstream TLS and HTTP/2 security fixes.
- Upgrade Hono to 4.13.18 to bound request-body memory independently of transfer chunk count (GHSA-39q9-qp46-w8xg).

## [2.0.4] - 2026-11-10

### Security

- Run containers on a pinned, maintained Node 26 runtime with patched system libraries.
- Replace the embedded SQLite driver with `@photostructure/sqlite` 3.3.1 (SQLite 3.54.1); retain existing databases, transaction ownership and recovery checks. Supported Linux x64 and arm64 installs include Node-API binaries and require no compiler or dependency install scripts.
- Keep Prisma query conversion and error handling in a licensed adapter for the patched SQLite driver; release failed transaction acquisitions without disturbing another transaction.

## 2.0.3 - 2026-11-09

- Client API keys accept the documented per-key trace privacy setting through the strict public
  creation and update contracts. Metadata-only keys omit request and response bodies; invalid
  privacy values and unknown metadata fields remain rejected.

## 2.0.2 - 2026-11-06

### Added

- A self-renewing HiveMem credential. With `EMBERPATH_HIVEMEM_CLIENT_ID` and
  `EMBERPATH_HIVEMEM_CLIENT_SECRET` set to an Oathweave machine client, Emberpath
  requests a short-lived client credentials token for the `hivemem` audience when it
  first needs one and fetches the next at 80% of its lifetime, while still serving the
  current one. The console Memory pages, memory agents in the actors list, and actor
  onboarding and rotation keep working without anyone re-issuing a token or restarting
  Emberpath. Concurrent requests share one fetch, an Oathweave outage is ridden out on
  the current token and retried with backoff, and a token HiveMem refuses is replaced
  and the call retried once. `EMBERPATH_HIVEMEM_SCOPE` and `EMBERPATH_HIVEMEM_TOKEN_URL`
  are optional.
- `check` reports which HiveMem credential is in use and warns a week before a static
  `HIVE_ROUTER_MEMORY_PROXY_TOKEN` expires.

### Fixed

- The page at `GET /` on the admin port names Emberpath and describes its admin API, with
  HiveXUI as the console in a suite. It no longer says "Hive Router Admin UI" or refers to a
  nonexistent `npm run build:ui`. The `name: 'Hive Router'` status field is unchanged.

### Changed

- `HIVE_ROUTER_MEMORY_PROXY_TOKEN` is a fallback when the service credential is
  configured: it is used only while no service token can be obtained, and never after
  its own expiry.

## 2.0.1 - 2026-11-05

### Security

- Remove npm, npx, corepack and yarn and the apt package tooling (apt,
  libapt-pkg6.0) from the runtime image; the service never invokes a package
  manager at runtime. This drops the bundled npm's brace-expansion 5.0.9
  (CVE-2026-102276, CVE-2026-102278) and undici 6.28.0 (CVE-2026-19534,
  CVE-2026-109383, CVE-2026-109869, CVE-2026-87018) and apt 2.6.1
  (CVE-2026-109518). dpkg and its package database remain so scanners can still
  inventory OS packages. The image has no HIGH or CRITICAL finding with an
  available fix (Trivy 0.70.0).
- HIGH and CRITICAL findings in Debian 12 base packages that have no fix yet:
  zlib1g CVE-2023-45853 (critical) and CVE-2026-76844; util-linux and its
  libraries CVE-2026-53613, CVE-2026-53615 and CVE-2026-78410; ncurses
  CVE-2025-69720; libsystemd0 and libudev1 CVE-2026-16742; gzip CVE-2026-41992;
  libacl1 CVE-2026-54369; perl-base CVE-2026-9538.

## 2.0.0 - 2026-11-05

- Publish native browser contracts and OpenAPI for routing policies, selection
  previews and revisions, quotas and client keys, telemetry, audit, runtime
  settings and Codex device authorization. Reuse the exact native request schemas,
  omit stored provider credentials from trace relations, and prevent caching of
  one-time credential responses.

- Round-trip native version-1 configuration archives and legacy bare envelopes
  through strict known metadata validation. Import configuration and audit
  atomically, preserve omitted credentials and provider state, and map source
  provider references by slug without copying foreign IDs.

- Publish product-owned browser-safe provider and alias contracts and generated
  OpenAPI operations. Export committed contract bytes with version, revision,
  checksum and attribution; omit credential storage from nested alias providers.

- Replace a provider's models within its atomic update, preserving all original
  rows and credentials when a save fails. Return a generic conflict for duplicate
  unique records without exposing stored values or database diagnostics.

- Store atomically issued native credential timestamps in the Prisma adapter format so verified enrollment keys authenticate and expire correctly.

- Decode bounded gzip, deflate and zstd inference requests before routing and
  accounting; preserve alias rewriting and streaming for native Responses clients.
  Reject unsupported, malformed and oversized expanded bodies before forwarding.

- Add product-owned idempotent native credential operations with atomic encrypted receipts, exact owner/policy binding, bounded recovery, unchanged credential deadlines and explicit containment. Oathweave coordinates identities through these authorized APIs while native model-key ownership remains in Emberpath.


- Disable external provider probes, update checks and trace/receipt retention
  during isolated restore rehearsals; report providers as unchecked and retain
  normal provider readiness checks outside rehearsal mode.
- Support explicit initial model-console IDs for fresh suite initialization;
  preserve existing identities and reject conflicting bindings before creation.

### Ecosystem extraction

Preserve existing provider credentials, route edits, alias bindings, model settings
and administrator display names during repeated startup; seed environment values
only initialize missing defaults.

Independent product snapshot, container build and direct Oathweave authorization with explicit product-account links. Existing machine protocols remain available. Suite lifecycle and migration acceptance remain pending.

Resource credentials cannot enter retained cross-product proxies, suite coordinators or legacy documentation routes. Permission-protected documentation returns only provider identity fields. Containers bind their service listener explicitly.
