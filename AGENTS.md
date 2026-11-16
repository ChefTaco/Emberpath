# Emberpath contributor instructions

Emberpath is the OpenAI-compatible model gateway of the Hive:Magnus suite (formerly Hive
Router): an API plane that routes to external inference providers and an admin API that
HiveXUI, the suite's only UI, drives. It runs on its own or under the Hive suite controller.
This public Apache-2.0 product is extracted from Hive. Preserve LICENSE, NOTICE,
provenance.json and immutable database migration history. Never commit secrets, private
infrastructure, databases, runtime state, local notes or real user data.
Read AGENTS.local.md when present; never copy it into tracked content.

## Layout

- `src/main.ts` (CLI and usage text), `src/config/env.ts` (every setting and its default).
- `src/api`: API plane; `src/admin`: admin API, IAM/HiveMem proxies, HiveXUI redirect page.
- `src/providers`, `src/routing`, `src/decisions-api`, `src/security`, `src/storage`,
  `src/telemetry`, `src/contracts` (browser-safe Zod contracts), `src/openapi`.
- `prisma/schema.prisma`; `src/storage/generated-sqlite-schema.ts` is generated from it.
- `contracts/oathweave.openapi.json` feeds the generated `src/contracts/ui-api.generated.ts`.
- `tests` (Vitest; `tests/e2e` is Playwright), `scripts` (deploy, smoke, eval, codegen,
  privacy), `docs` (Oathweave sign-in, routing contract, TypeSafe notes, `openapi.json`),
  `tooling/release` (vendored release and recovery engine).

## Checks

Set up with `npm run bootstrap`. Before committing run the CI gates:

```bash
npm run typecheck && npm run build && npm test
npm run check:openapi && npm run scan:secrets && npm run check:private
```

Regenerate and commit outputs when you change their sources:
`npm run db:generate-bootstrap` after `prisma/schema.prisma` (`npm test` fails when stale),
`npm run contracts:generate` after `contracts/oathweave.openapi.json` (`npm run typecheck`
fails when stale), and `npm run generate:openapi` after a route or schema change.
`npm run test:e2e` and the `smoke:*` scripts are optional and need local servers or
live backends. Hooks live in `.githooks` (`git config core.hooksPath .githooks`); never
bypass them.

## Conventions

Use strict TypeScript and runtime validation at API boundaries. Browser code must use
public API contracts and must not import backend code or infrastructure credentials.
Security behavior requires regression tests. Use Conventional Commits.

## Release path

A `v*` tag runs `.github/workflows/release-image.yml`, which publishes the container image
`ghcr.io/cheftaco/emberpath` (amd64 and arm64, exact version tags, no `latest`) and records
its digest in a GitHub release. Hive's signed suite manifest pins that digest.

## Gotchas

- Many settings and the `hive-router` command keep their Hive Router names; do not rename
  them in docs. `emberpath` is the same binary.
- `@hivemagnus/emberpath` is not published on npm; `@hivemagnus/hive-router` is the legacy
  1.x line, which still bundles the retired UI. Emberpath has no UI of its own.
- The legacy recovery engine in `tooling/release` is build tooling, not an import from a
  sibling repository. Keep existing compatibility paths until replacement workflow and
  recovery acceptance passes.
