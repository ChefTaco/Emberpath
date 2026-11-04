# Contributing to Hive

Thanks for your interest in improving Hive! Bug reports, documentation fixes, and pull requests are
all welcome.

## Getting set up

```bash
nvm use               # Node.js version from .nvmrc
npm run bootstrap     # install every workspace and the git hooks
npm run dev:hive      # run the full stack locally
```

The repository is a monorepo of independently locked workspaces:

| Path | Workspace |
|---|---|
| `services/hive-router` | Model gateway and Hive console |
| `services/hive-iam` | IAM service and `@hivemagnus/hive-iam-sdk` |
| `services/hive-mem` | HiveMem core, SDKs, and Hermes plugin |
| `services/hive-skills` | Skills registry |
| `packages/hive` | The `hive` launcher (`@hivemagnus/hive`) |

## Before opening a pull request

Run the same gates that CI runs:

```bash
npm run typecheck
npm test
npm run check:openapi
npm run scan:secrets
npm run check:private
```

- Keep TypeScript strict and follow the style of the surrounding code.
- Add or update tests for behaviour changes.
- If you change an HTTP route or schema, run `npm run generate:openapi` and commit the updated
  snapshot.
- If you change IAM request schemas, run `npm --prefix services/hive-router run contracts:generate`.
- Never commit `.env` files, keys, certificates, databases, or other credentials, or details of
  private infrastructure (real hostnames, IPs, usernames, home paths). The git hooks in `.githooks/`
  enforce this. See [AGENTS.md](AGENTS.md) for the full rules, which apply to people and AI agents
  alike.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`,
`chore:` and so on), with an optional scope such as `fix(router): ...`.

## Reporting bugs and requesting features

Open a GitHub issue using one of the templates. For security issues, follow
[SECURITY.md](SECURITY.md) and do **not** open a public issue.

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
