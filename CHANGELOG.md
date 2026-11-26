# Changelog

## [Unreleased]

### Upgrade notes

- Behind a reverse proxy that is not on the same host (such as Hive's ingress), set
  `EMBERPATH_TRUSTED_PROXIES` to that proxy (an IP, CIDR range or host name) so admin sign-in
  throttling and the address forwarded to Oathweave use the real client instead of the proxy.
  The default `loopback` trusts `X-Forwarded-For` only from a proxy on the same host.
- API clients now get only an allowlist of upstream response headers (content and retry
  headers); the upstream `x-request-id` and `x-ratelimit-*` headers arrive renamed under
  `x-emberpath-upstream-`, and headers such as `server`, `cf-ray` and
  `openai-organization` are no longer relayed. Set
  `EMBERPATH_UPSTREAM_RESPONSE_HEADERS=passthrough` to keep the old behaviour, or list extra
  names in `EMBERPATH_UPSTREAM_RESPONSE_HEADER_ALLOW`.
- A routing denial (`403`) no longer returns `route_decision`; the body is
  `{"error": "<reason>"}` and the full decision stays on the trace.
- Writes through the IAM proxy need IAM permissions: `/api/iam/groups` needs
  `iam:groups:write`, `/api/iam/enrollments` `iam:sa:write` (reads `iam:sa:read`),
  `/api/iam/tokens/introspect` `iam:tokens:introspect`, `/api/iam/tokens/revoke*`
  `iam:sessions:revoke`, and any other IAM write `iam:admin:write`. Before, these fell through
  to `router:admin:write`. Full-access roles and OS sign-in are unaffected.
- Provider circuit breakers now forget failures older than one minute, so occasional
  failures no longer add up to an open circuit.

### Added

- Optional exact-match response cache (`EMBERPATH_RESPONSE_CACHE_TTL_MS`, off by default,
  with `EMBERPATH_RESPONSE_CACHE_MAX_ENTRIES` and `EMBERPATH_RESPONSE_CACHE_MAX_BYTES`) for
  deterministic, non-streaming requests: `temperature: 0` chat completions, completions and
  Responses API calls, and embeddings. Entries are per client key and exact request body.
  A hit answers with `x-emberpath-cache: hit`, is traced with a `cache.hit` event and the
  source trace, and charges no tokens or spend.
- Per-key rate and concurrency limits in the key's `quota` metadata: `requestsPerMinute`
  and `tokensPerMinute` (rolling 60 seconds, from the reservation ledger, `429` with
  `retry-after: 60`) and `maxInFlight` (requests running at once, streams included, per
  process). One runaway key can no longer fill a provider's slots for every other key.
- Per-key USD budgets: `quota.dailyCostUsd` and `quota.monthlyCostUsd` (UTC) stop a key once
  its spend from operator-declared provider prices reaches the budget. Requests without a
  known cost count as nothing. `GET /api/client-keys/:id/usage` reports `dayCostUsd` and
  `monthCostUsd` and warns at `warnAtPercent`.
- Per-key model and provider allowlists: `allowedModels` (names or `prefix*`) and
  `allowedProviders` (slugs or IDs) in the key's metadata are enforced on every inference
  route, including `/v1/decisions`, and filter `GET /v1/models`. A refused request gets `403`
  and a `DENIED` trace.
- `EMBERPATH_TRUSTED_PROXIES` (default `loopback`): the admin listener reads the client
  address from `X-Forwarded-For`, right to left, when the socket peer is a listed proxy. The
  sign-in and re-authentication throttles, the admin session's recorded address and the
  `X-Forwarded-For` sent to Oathweave and HiveMem use it; anything a caller wrote into the
  header ahead of the trusted hops is ignored. Before, all of these used the socket peer, so
  every client behind a proxy shared one sign-in throttle.

### Fixed

- A client that disconnects is noticed reliably: inference requests follow the inbound
  request's abort signal instead of a clone's, which could stop following it once the clone
  had been garbage-collected, so retries, backoff waits and failover went on for a caller
  that had gone.
- A provider's circuit breaker counts failures in a rolling window
  (`EMBERPATH_CIRCUIT_WINDOW_MS`, default 60 s) instead of until the next success, and has a
  real half-open state: after the open period (`EMBERPATH_CIRCUIT_OPEN_MS`, default 30 s) one
  trial request goes through while others skip the provider, and its result closes or reopens
  the circuit. The threshold is `EMBERPATH_CIRCUIT_FAILURE_THRESHOLD` (default 3).
- The wait for a provider's `concurrency` slot can be bounded: `EMBERPATH_PROVIDER_QUEUE_MAX`
  caps the waiting requests and `EMBERPATH_PROVIDER_QUEUE_TIMEOUT_MS` the wait (both default
  to `0`, no limit). A request turned away tries the next candidate provider without counting
  against the busy provider's circuit. `/v1/decisions` requests that disconnect while waiting
  now leave the queue too, and a provider whose `concurrency` changed gets a slot pool of the
  new size.
- A routing denial no longer returns the full routing decision (candidate providers, rule
  names, observations) to the client key.
- Admin writes to IAM groups, enrollments, tokens and other IAM routes need IAM permissions
  instead of `router:admin:write`. The default `HIVE_ROUTER_IAM_PROXY_SCOPES` also asks for
  `iam:groups:read` and `iam:groups:write`.
- Upstream response headers are relayed from an allowlist (`EMBERPATH_UPSTREAM_RESPONSE_HEADERS`).
- Ollama's native `/api/chat` and `/api/generate` accept `options.num_predict` (a positive
  integer) as the explicit output maximum that token budgets require. Native routes that
  generate nothing (`/api/tags`, `/api/ps`, `/api/show`, `/api/embed`, `/api/embeddings`,
  `/api/pull`, and vLLM `/tokenize`, `/detokenize`, `/version`) no longer need one and reserve
  only the request size.

### Changed

- CI runs the gates on Node 24 and on Node 26, the runtime major of the published image.
- Every third-party GitHub Action in CI and in the image release workflow is pinned by
  commit SHA (checkout and setup-node move to v7).

### Performance

- A client key that passed its scrypt check is matched by its SHA-256 digest for
  `EMBERPATH_API_KEY_CACHE_TTL_MS` (default 60 s), so inference requests no longer run scrypt
  on the libuv thread pool every time. The key's row is still read per request, so disabling,
  deleting, expiring or rotating a key still applies at once.
- A key's `lastUsedAt` is written at most once per `EMBERPATH_KEY_LAST_USED_INTERVAL_MS`
  (default 60 s) instead of on every request, which cuts SQLite write contention with traces.
  `lastUsedAt` can now be up to a minute behind; `0` restores per-request writes.
- `GET /v1/models` keeps each provider's live model list for `EMBERPATH_MODELS_CACHE_TTL_MS`
  (default 5 s) and shares one upstream request among concurrent calls, so polling clients
  no longer fan out a request to every backend each time. `0` restores the old behaviour.

## [2.7.0] - 2026-11-26

### Upgrade notes

- `POST /api/pull` now needs a client key whose scopes include `ollama:manage` (or `*`).
  Keys without a scope list, and scoped keys that only hold `models:read` and
  `inference:write` (such as agent keys), now get `403` there. Grant `ollama:manage` to the
  keys that should make an Ollama backend download models; other routes are unchanged.
- Clients of `/api/auth/login` and `/api/auth/reauthenticate` with Oathweave sign-in should
  handle `401` with code `MFA_REQUIRED` (it lists the account's methods) and retry with
  `mfaCode`. Before, such accounts got `Invalid credentials`.
- A provider's `timeoutMs` is now a per-wait idle timeout (headers, then each body chunk),
  and its `concurrency` limits running streams. Review both on providers that serve long
  streams.

### Fixed

- Anthropic providers stream and use tools. A `stream: true` request is sent to Anthropic
  as a stream and relayed as OpenAI `chat.completion.chunk` events (or Responses API
  events), ending with `[DONE]` and, when `stream_options.include_usage` is set, a usage
  chunk. OpenAI `tools`, `tool_choice` and `parallel_tool_calls` become Anthropic tools;
  `tool_use` answers become `tool_calls` (or `function_call` output items) with the
  `tool_calls` finish reason; assistant `tool_calls` and `role: "tool"` messages become
  `tool_use` and `tool_result` blocks with their IDs. The Responses API `input`,
  `instructions`, `function_call` and `function_call_output` items are read, and
  `max_completion_tokens`, `top_p` and `stop` are passed on. Without an explicit maximum
  the output allowance is 4096 tokens (was 1024), matching the quota reservation.
- A provider's `timeoutMs` no longer cuts long streams. It now bounds the wait for the
  response headers and then each wait for the next body chunk, not the whole body.
- A provider's `concurrency` slot is held until the response body has ended (or the client
  went away), so it limits running streams, not just header waits. A request whose client
  disconnects while it waits for a slot leaves the queue without calling the provider.
- A request that no provider answered (every candidate failed, or none was available) no
  longer keeps its token reservation against the client key's daily and monthly caps.
- `POST /api/pull` needs the `ollama:manage` (or `*`) client key scope; a key without a
  scope list may no longer make an Ollama backend download models.
- Oathweave password sign-in (`HIVE_ROUTER_AUTH_MODE=iam-oidc`) works for accounts with
  multi-factor authentication: `/api/auth/login` answers `MFA_REQUIRED` with the account's
  methods instead of `Invalid credentials`, and accepts `mfaCode` (a TOTP or recovery code),
  as does `/api/auth/reauthenticate`. A correct password awaiting its second factor is not
  counted as a failed attempt. The two Oathweave sessions each sign-in opened are now ended
  once it completes, and the client address is sent as `X-Forwarded-For` so an Oathweave that
  trusts Emberpath as a proxy limits sign-in attempts per client.
- The README no longer names a stale suite pin.

## [2.6.0] - 2026-11-24

### Added

- Traces link to agent executions. On the inference plane Emberpath records the caller's
  `x-hive-execution` context (HiveCommon execution context v1), its `x-request-id` and its
  `traceparent` in new nullable `Trace` columns: `executionRootRef`, `executionSelfRef`,
  `executionParentRef`, `executionJson`, `clientRequestId` and `inboundTraceparent`. This is
  attribution only: Emberpath still generates its own request ID, `actorId` still comes from
  the client key, and routing, quotas and access never read it. Invalid or oversized values
  are ignored, never rejected. A context whose Ardent instance disagrees with the key's actor
  is stored with `asserted_by: "client"`.
- `GET /api/traces` accepts `executionRoot`, `executionTask` (a self-reference prefix; a task
  reference also matches its attempts) and `executionParent`, paged as `{data, nextCursor}`.
  With any of them each trace also carries `execution` and `attempts[]`
  (`{providerId, attempt, status?, delayMs?, retryAfterMs?, failover, outcome}`, every
  upstream attempt including retries and failover). Responses without an execution filter keep
  their shape: the new columns are not added to them, to telemetry or to incidents. The model
  admin contract adds `traceExecutionSchema`, `traceAttemptSchema` and the three filters.
- Retries back off. Between attempts on the same provider Emberpath waits a full-jitter
  exponential backoff (250 ms doubling to 2 s), or the upstream `Retry-After` when longer. A
  `Retry-After` over 10 s, or a wait that would pass the deadline, moves to the next provider
  immediately. The deadline is the earlier of the new `EMBERPATH_REQUEST_DEADLINE_MS`
  (default 300000) after arrival and the execution's `deadline_ms`; no retry or failover
  starts after it. A client disconnect during a wait stops every further attempt without a
  circuit-breaker penalty. `/v1/decisions` follows the same rules.
- Every inference-plane answer carries `x-hive-retry`: `exhausted` when Emberpath already
  retried or failed over (or the upstream answered `exhausted`) and the answer is still a
  `5xx`, `429` or `408`, otherwise `none`. An upstream that answers `exhausted` is not retried.
  Provider failure events record `attempt`, `status`, `delayMs`, `retryAfterMs`, `outcome` and
  `failover`; a disconnect during a wait records `request.aborted`.
- `GET /health` on both planes lists `capabilities`: `emberpath.execution-trace.v1` and
  `retry-signal.v1`.
- Router data format `managed-format-3` adds the six `Trace` columns and the
  `(executionRootRef, createdAt)` and `(executionSelfRef)` indexes. It is additive and fast;
  apply it with `emberpath migrate` (or `HIVE_AUTO_MIGRATE=true`) when upgrading.

### Changed

- Emberpath no longer forwards the suite-internal `x-hive-execution` and `x-hive-retry` request
  headers to upstream providers. Upstreams can be third-party model APIs, and the execution
  context carries internal node, profile and task references. The redacted inbound copy is
  still stored with the trace's request headers.
- Same-provider retries also accept the standard `Idempotency-Key` header, not only
  `X-Idempotency-Key`.
- The failover counter metric counts a move to the next provider once, instead of once per
  failed attempt while a later provider existed.
- Depend on `@hivemagnus/hive-common` ^0.6.0 for the execution context and retry helpers.

## [2.5.4] - 2026-11-20

### Security

- The container image carries `effect` 3.22.1 instead of 3.20.0, removing CVE-2026-121707
  (a ReDoS in `Schema.TemplateLiteral`, fixed in 3.22.1). Prisma 7 pins `effect` exactly 3.20.0
  through `@prisma/config`, so an npm `overrides` entry forces 3.22.1. Its only consumer is the
  Prisma CLI's config loader, which runs for migrations, not request handling. No migration and
  no setting changes.

## [2.5.3] - 2026-11-17

### Changed

- `env-schema` (the env catalog) names `--subject emberpath` in the command it lists for minting
  `HIVE_ROUTER_MEMORY_PROXY_TOKEN`, matching the README. Emberpath's HiveMem principal is
  `emberpath`; the setting keeps its Hive Router name. Data a `hive-router` principal owns in
  HiveMem moves with HiveMem 1.9.0's `rename-agent` before the token is re-issued.

## [2.5.2] - 2026-11-17

### Removed

- The static security-export credential, which expired on 2026-09-30.
  `GET /api/security/events` accepts only the `security-exporter` Oathweave client token: the
  `HIVE_ROUTER_SECURITY_EXPORT_TOKEN_HASH` check, its `Warning: 299` response header and the
  `method="static"` label of the exporter authorization metric are gone.
  `HIVE_ROUTER_SECURITY_EXPORT_STATIC_FALLBACK_ENABLED=true` is still refused at startup, now
  as a retired setting; any other value of it, and `HIVE_ROUTER_SECURITY_EXPORT_TOKEN_HASH`,
  are ignored, so existing env files keep working. Both entries are dropped from
  `.env.example`, the README and the legacy deploy script, which now deletes them from the env
  file it manages.

## [2.5.1] - 2026-11-15

### Changed

- `@hivemagnus/hive-common` 0.5.0 (from 0.1.0). It brings the shared kit's fixes since 0.1.0:
  stricter validation of verifier options at startup, the conformance vectors for native-issuer
  service tokens, and the error-envelope, request-ID and health fixes. Emberpath's own behaviour
  is unchanged.
- The admin verifier asks the shared verifier for the `roles` and `clientId` claims
  (`requireRoles`, `clientIdClaim: 'clientId'`) instead of checking them afterwards. A token
  without them is still refused as `invalid_claims`, now before the online session check, so
  it no longer costs a userinfo request.
- The metrics bearer comparison and the SHA-256 digests (request hashes, operation IDs and
  routing revisions) use the shared `/secrets` helpers. Results are byte for byte the same.

## [2.5.0] - 2026-11-13

### Security

- A stored provider credential is bound to the origin (scheme, host and port) of the provider's
  `baseUrl`. `PUT /api/providers/:id` used to keep the stored secret when `baseUrl` changed, so
  anyone allowed to edit providers could point a credential they had never seen at a server of
  their choice. An update that changes the origin must now send `authSecret` again and give
  every credential default header its real value (or leave it out); otherwise it is refused
  with `422` and code `provider_origin_change_requires_secret`, nothing is changed and the
  attempt is audited as `provider.update.denied` (also in the security export). Setting
  `authMode` to `NONE` with the new address discards the stored secret instead. The OAuth
  `CODEX` provider cannot be moved (`provider_origin_change_requires_reauthorization`):
  authorize it again or delete it. `POST /api/config/import` applies the same rule to providers
  that already exist and refuses the whole archive. A path change on the same origin still
  keeps the stored credentials. The check and the write are atomic: a provider that changes in
  between answers `409` with code `provider_changed_concurrently`.
- Provider requests no longer follow redirects. The HTTP client drops `Authorization` on a
  cross-origin redirect but forwarded `x-api-key`, custom auth headers, default headers and
  (for 307/308) the request body. A redirect is now a provider failure whose trace reason names
  the target server; health checks and model discovery report it the same way. No supported
  provider API redirects. The Codex sign-in and token requests refuse redirects too.
- Provider reads (`GET /api/providers`, the write answers, the Codex status) and
  `GET /api/config/export` no longer return default header values that may carry a credential.
  Headers known to be harmless (`anthropic-version`, `HTTP-Referer`, `X-Title`, `User-Agent`
  and similar) are shown; every other value is `[redacted]` and named in the new
  `redactedDefaultHeaders` field, next to the new `hasAuthSecret`. Sending `[redacted]` back
  keeps the stored value, so an edit round-trips; it is never stored itself
  (`400 provider_redacted_value_not_stored` when there is nothing stored to keep). A
  `user:password@` part of a stored `baseUrl` is left out of every read and export.

### Upgrade notes

- Scripts that `PUT` a provider with a new `baseUrl` host, port or scheme without `authSecret`
  are now refused with `422` when the provider has a stored secret. Send the secret in the same
  request. The same applies to default headers other than the harmless ones listed above: send
  their real values with the new address.
- Scripts that read `defaultHeaders` from `GET /api/providers` and write the object back keep
  working: `[redacted]` values are resolved to the stored ones. Scripts that read header
  *values* from the API or from an export now get `[redacted]`.
- Configuration archives no longer carry credential header values. Importing one into another
  installation leaves those headers out and lists them in `redactedHeadersNotImported`; enter
  them again there. Stored header text that is not a JSON object is exported as `null`.
- `baseUrl` with `user:password@` is rejected on create, update and import. It never worked
  (the HTTP client refuses such URLs); move the credential to the auth secret or a header.
- A provider behind a redirect (for example `http://` redirecting to `https://`, or a moved
  host) now fails until `baseUrl` is set to the final address. The trace and the provider's
  health error say where it redirects to.
- Error answers of the model administration API may carry a stable `code` next to `error`.

### Fixed

- A client that disconnects before a provider answers no longer counts as a provider failure.
  Three such disconnects used to open the circuit breaker of every candidate provider for 30
  seconds, because each aborted request was also retried against the remaining providers.
- Upstream responses abandoned during failover (a retryable status, or a stream that reported
  an error before its first token) are now cancelled, so their connections are released
  instead of being held until garbage collection. The `failover` metric names the provider
  that is actually tried next.
- Ollama streaming: an upstream error status is returned as is, so it can fail over, instead of
  becoming an empty `200` event stream. The trace is written when the stream ends, with the
  relayed text and first-byte time (it used to be finalized empty when the stream started).
  The stream is relayed with backpressure, an error Ollama reports mid-stream is passed on as
  an `error` event, and a client that leaves cancels the upstream request.
- Ollama providers send their configured credential and default headers on every call. The
  stored secret was never sent, and default headers only on native `/api/*` routes.
- Codex OAuth: concurrent requests share one token refresh. Rotating refresh tokens made the
  second concurrent refresh fail with `401`, which quarantined the token and overwrote the
  bundle the first refresh had just stored.
- Trace retention removes the stored request body, which is filed under the request ID and was
  left on disk when its trace expired. Body directories orphaned this way by earlier releases
  are removed once they are older than the retention window. Expired traces are deleted in
  batches, so a large backlog can no longer exceed SQLite's parameter limit.
- vLLM native routes (`/tokenize`, `/detokenize`, `/version`) stop the upstream request when
  the client disconnects, like every other route.
- Expired Codex device authorizations that were never polled are dropped.

### Changed

- Inference requests no longer run scrypt on the event loop, where it stalled every stream
  being relayed. Client API keys are verified on the thread pool, and the envelope key for
  provider secrets is derived once per process instead of once per provider per request.
- Dependency reports requested within five seconds share one provider health sweep, so polling
  the unauthenticated `/health/ready`, `/health/dependencies` or `/ready` endpoints cannot
  multiply calls to the providers.
- Provider `baseUrl` must be an `http:` or `https:` URL when a provider is created, updated or
  imported. Other schemes never worked and are now rejected with a validation error.

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
