# Changelog

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

## Unreleased ecosystem extraction

Preserve existing provider credentials, route edits, alias bindings, model settings
and administrator display names during repeated startup; seed environment values
only initialize missing defaults.

Independent product snapshot, container build and direct Oathweave authorization with explicit product-account links. Existing machine protocols remain available. Suite lifecycle and migration acceptance remain pending.

Resource credentials cannot enter retained cross-product proxies, suite coordinators or legacy documentation routes. Permission-protected documentation returns only provider identity fields. Containers bind their service listener explicitly.
