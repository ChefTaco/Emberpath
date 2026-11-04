# Product contributor instructions

This public Apache-2.0 product is extracted from Hive. Preserve LICENSE, NOTICE,
provenance.json and immutable database migration history. Never commit secrets,
private infrastructure, databases, runtime state, local notes or real user data.
Read AGENTS.local.md when present; never copy it into tracked content.

Use strict TypeScript and runtime validation at API boundaries. Browser code must
use public API contracts and must not import backend code or infrastructure
credentials. Security behavior requires regression tests. Use Conventional Commits.

Before committing run `npm run typecheck`, `npm run build`, `npm test`,
`npm run scan:secrets` and `npm run check:private`. Check API snapshots after route
changes. Install hooks with `git config core.hooksPath .githooks`; never bypass them.

The legacy recovery engine is vendored in tooling/release during migration. It is
build tooling, not an import from a sibling repository. Keep existing compatibility
paths until replacement workflow and recovery acceptance passes.
