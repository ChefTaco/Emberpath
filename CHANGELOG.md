# Changelog

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
