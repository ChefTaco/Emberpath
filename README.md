# Emberpath

Emberpath is an OpenAI-compatible model gateway with a separate administration API. Clients talk to one endpoint; Emberpath picks an upstream provider, fails over when it is safe to, enforces per-key quotas and records a trace for every request. Inference services stay external: Emberpath routes to them and never installs or manages them.

It is one product in the [Hive:Magnus](https://github.com/ChefTaco/hive) suite, and it also runs on its own. The [Hive installer](https://github.com/ChefTaco/hive#readme) deploys tested combinations of the suite's products.

This project was extracted from Hive with its migration history and client protocols intact. `provenance.json` records the source revision and original file hashes.

It is a single Node.js process written in strict TypeScript (Hono, Prisma 7,
SQLite).

**There is no built-in console.** The admin listener serves the administration API;
`GET /` returns only a short fallback page. In the suite, the browser console is a
separate product, [HiveXUI](https://github.com/ChefTaco/HiveXUI), which signs in through
Oathweave (see [direct browser authorization](docs/OATHWEAVE.md)). Running on its own,
Emberpath is managed through the admin API ([OpenAPI document](docs/openapi.json)) and the
`hive-router` command.

## Install

Emberpath 2.x ships only as a container image, `ghcr.io/cheftaco/emberpath`, for
`linux/amd64` and `linux/arm64`. Each release is tagged with its exact version (for example
`2.0.1`; there is no `latest` tag), and its
[GitHub release](https://github.com/ChefTaco/Emberpath/releases) records the image digest.

**With the Hive suite.** Emberpath is normally installed by `hive.sh`, the
[Hive suite controller](https://github.com/ChefTaco/hive#install-the-suite), in both the
`core` and `full` profiles. The controller pins the image by digest from a signed release
manifest and writes its configuration, secrets and Oathweave sign-in. Hive 2.0.1 pins
Emberpath 2.0.1.

**Legacy npm packages.** `@hivemagnus/emberpath`, this source's package name, is not
published on npm. The npm package `@hivemagnus/hive-router` and the image
`ghcr.io/cheftaco/hive-router` are the legacy Hive Router 1.x line, which predates this
repository: `npm install` and `npx` resolve `@hivemagnus/hive-router` to 1.2.2, not to
Emberpath 2.x, and it still bundles the old console on the admin listener. The
[Hive README](https://github.com/ChefTaco/hive#the-retired-npm-packages) describes that line.

### Run the image on its own

The image runs both listeners with TLS (`NODE_ENV=production`) and keeps its database and
traces in the `/data` volume (`/data/router`). It does not include PAM (`pamtester`), so
administrators sign in through Oathweave (`HIVE_ROUTER_AUTH_MODE=iam-oidc`). This example
joins the network of the
[Oathweave container example](https://github.com/ChefTaco/Oathweave/blob/main/apps/iam-core/README.md#run-the-container-image)
and uses the `hive-router` client secret Oathweave generated on its first start. Put a
certificate and key for the listeners in `tls/` as `server.crt` and `server.key`, readable by
the container's `node` user (uid 1000).

```bash
umask 077
cat > emberpath.env <<EOF
HIVE_AUTO_MIGRATE=true
HIVE_ROUTER_SECRET=$(openssl rand -hex 32)
HIVE_ROUTER_ADMIN_USERS=admin
HIVE_ROUTER_AUTH_MODE=iam-oidc
HIVE_IAM_INTERNAL_URL=http://oathweave:4200
HIVE_ROUTER_IAM_CLIENT_SECRET=$(docker exec oathweave sed -n 's/^SEED_HIVE_ROUTER_CLIENT_SECRET=//p' /data/iam/initial-credentials.env)
API_HOST=0.0.0.0
ADMIN_HOST=0.0.0.0
TLS_CERT_PATH=/config/tls/server.crt
TLS_KEY_PATH=/config/tls/server.key
NODE_EXTRA_CA_CERTS=/config/tls/server.crt
EOF

docker run --rm --network oathweave -v emberpath-data:/data -v "$PWD/tls:/config/tls:ro" \
  --env-file emberpath.env ghcr.io/cheftaco/emberpath:2.2.0 check
docker run -d --name emberpath --network oathweave \
  -p 127.0.0.1:4020:4020 -p 127.0.0.1:9443:9443 -v emberpath-data:/data \
  -v "$PWD/tls:/config/tls:ro" --env-file emberpath.env ghcr.io/cheftaco/emberpath:2.2.0

# Once it reports healthy
curl --cacert tls/server.crt https://localhost:4020/health
```

`NODE_EXTRA_CA_CERTS` lets the image's health check, which verifies certificates, trust a
self-signed certificate; omit it for a certificate from a CA the image already trusts. The
image entry point is the CLI, so its commands (`check`, `migrate`, `create-key`,
`env-schema`) follow the image name. See [Configuration](#configuration) for public URLs,
HiveMem and everything else, and [Docker](#docker) for building the image yourself.

## Configure and run from source

These steps run Emberpath from a [source checkout](#run-from-a-source-checkout) with OS
(PAM) sign-in. Build it first with `npm install` and `npm run build`. The commands below
are written as `hive-router`, the command name the package keeps alongside `emberpath`; a
source build runs them as `node dist/src/index.js`.

**Requirements**

- Node.js 24 (`>=24.22.3`) or 26 (`>=26.13.1`). SQLite 3.54.1 is bundled through
  `@photostructure/sqlite`; supported Linux x64 and arm64 installs need no compiler.
- For admin sign-in, either Linux with `pamtester` installed
  (`HIVE_ROUTER_AUTH_MODE=os`, the default: operators use their OS password),
  or a running [Oathweave](https://github.com/ChefTaco/Oathweave)
  (`HIVE_ROUTER_AUTH_MODE=iam-oidc`).

**1. Write an env file**

```bash
mkdir -p ~/.hive && chmod 700 ~/.hive
install -m 600 /dev/null ~/.hive/router.env
echo "HIVE_ROUTER_SECRET=$(openssl rand -hex 32)" >> ~/.hive/router.env
echo "HIVE_ROUTER_ADMIN_USERS=$USER" >> ~/.hive/router.env
```

That is the whole minimal configuration. By default the API listens on
`127.0.0.1:4020`, the admin API on `127.0.0.1:9443`, and the SQLite database and
traces go to `${HIVE_HOME:-~/.hive}/router` (created with mode `0700`).

**2. Check and start**

```bash
node dist/src/index.js check --env-file ~/.hive/router.env
node dist/src/index.js --env-file ~/.hive/router.env
```

The administration API is at `http://127.0.0.1:9443/api`. Sign in with
`POST /api/auth/login` as one of `HIVE_ROUTER_ADMIN_USERS`.
The OpenAI-compatible API is at `http://127.0.0.1:4020/v1`; both listeners
answer `GET /health`.

**Native database runtime.** The package includes Node-API binaries for supported
platforms. `npm install --ignore-scripts` works without a database rebuild or binary
download. Startup verifies the embedded SQLite version before opening application storage.

**TLS.** Set `TLS_CERT_PATH` and `TLS_KEY_PATH` to a PEM certificate and key
to serve HTTPS on both listeners. TLS is required when `NODE_ENV=production`
(or `REQUIRE_TLS=true`). For a quick test certificate:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj /CN=localhost \
  -keyout ~/.hive/router.key -out ~/.hive/router.crt
```

To expose Emberpath beyond this machine, also set `HOST=0.0.0.0` (or
`API_HOST`/`ADMIN_HOST`), `PUBLIC_API_URL` and `PUBLIC_ADMIN_URL`, for example
`https://hive.example.com:4020` and `https://hive.example.com:9443`.

**Commands**

| Command | Purpose |
|---|---|
| `hive-router [start]` | Start the API and admin listeners (default). |
| `hive-router check [--json]` | Validate configuration: env values, TLS files, writable data directory, `pamtester` or IAM, and reachability of IAM and HiveMem when configured. Starts nothing, writes nothing, exits `1` on problems. |
| `hive-router env-schema` | Print every install-time setting as JSON (name, required, secret, default, how to generate secrets), plus ports, health path and optional dependencies. |
| `hive-router create-key --name <name>` | Create a client API key (see [API keys from the command line](#api-keys-from-the-command-line)). |
| `--env-file <path>` | Load a dotenv file first. Variables already in the environment win. Without it, `.env` and `.env.apikeys` in the working directory are read. |
| `--help`, `--version` | Usage and version. |

A missing or invalid setting stops startup with one line that names the
variable and how to fix it.

**Connecting IAM and HiveMem.** Set `HIVE_ROUTER_AUTH_MODE=iam-oidc`,
`HIVE_IAM_INTERNAL_URL` and `HIVE_ROUTER_IAM_CLIENT_SECRET` (equal to IAM's
`SEED_HIVE_ROUTER_CLIENT_SECRET`) to sign in through IAM and enable the `/api/iam/*`
proxy. For the `/api/memory/*` proxy set `HIVEMEM_INTERNAL_URL` and a HiveMem credential.
The self-renewing one is an Oathweave machine client: set `EMBERPATH_HIVEMEM_CLIENT_ID` and
`EMBERPATH_HIVEMEM_CLIENT_SECRET`, give that client an Oathweave policy with audience `hivemem`
(`IAM_MACHINE_CLIENT_POLICIES` and `IAM_MACHINE_CLIENT_SECRETS`), and link it in HiveMem's
`HIVEMEM_OATHWEAVE_SERVICES_JSON`. Emberpath then fetches a short-lived token when it needs one
and fetches the next before it expires, so nothing has to be re-issued or restarted. Without it,
set `HIVE_ROUTER_MEMORY_PROXY_TOKEN` to a HiveMem admin token minted with
`hivemem-server issue-token --env-file hivemem.env --subject hive-router --role admin`
(valid for at most 30 days, so re-issue it and restart Emberpath before it
expires); with it, that token is only a fallback until its own expiry. See
[Configuration](#configuration) for everything else.

## Features

- **OpenAI-compatible API**: `/v1/models`, `/v1/responses`,
  `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, audio
  transcription/translation, image generation and moderations.
- **Many providers**: `OPENAI`, `CODEX`, `OPENAI_GENERIC`, `OPENROUTER`,
  `ANTHROPIC` (native translation), `OLLAMA` (including native `/api/*`
  passthrough), `LLAMACPP` and `VLLM` (including `/tokenize`, `/detokenize`,
  `/version`).
- **Routing**: model aliases, route rules, capability filtering, heuristic
  reranking or denial, priority/weight ranking, health checks and circuit
  breaking. An optional adaptive mode leans toward providers that have been
  faster and more reliable recently. Routing configuration is versioned and can
  be rolled back.
- **Safe failover**: streaming failures are classified as `pre-first-byte` or
  `mid-stream`. Emberpath fails over only before the first token and never
  splices two upstream streams together.
- **Client API keys and quotas**: OpenAI-style `sk-...` keys, stored only as
  hashes, with daily and monthly request and token caps (soft warnings, then
  hard `429`s).
- **Observability**: per-request traces (body capture is configurable),
  Prometheus metrics, optional OpenTelemetry export, estimated usage when the
  provider does not report it, and an audit log of admin actions.
- **Model discovery**: `POST /api/providers/:id/discover` pulls live model
  lists into the catalog and keeps any operator overrides.
- **Administration API**: providers and routing, traces, incidents, API keys,
  audit, and (when configured) IAM and Memory proxies, all behind PAM or IAM
  OIDC login. HiveXUI is its browser console.
- **Shadow decision model (optional)**: classifies prompts with the TypeSafe
  Jev decision API (with OpenRouter as fallback) and records the result on the
  trace without changing routing.

## Architecture

```
clients ──► API plane (API_HOST:API_PORT) ──► providers (OpenAI, Anthropic, Ollama, llama.cpp, vLLM, ...)
                     │
                     └─ traces, metrics, quotas ─► SQLite (DATABASE_URL)

operators ─► Admin plane (ADMIN_HOST:ADMIN_PORT)
               ├─ GET /             fallback page only (the console is HiveXUI)
               ├─ /api/*            admin API (session cookie + permission checks)
               ├─ /api/iam/*        proxied to Hive IAM with a server-side client-credentials token
               ├─ /api/memory/*     proxied to HiveMem with a self-renewing Oathweave service token
               └─ /v1/*, /dashboard proxied to HiveMem (compatibility paths)
```

On first start the app creates its SQLite schema. You do not need to run
`prisma db push`. The bootstrap SQL in `src/storage/generated-sqlite-schema.ts`
is generated from `prisma/schema.prisma`. Run `npm run db:generate-bootstrap`
after you edit the schema; `npm test` fails if the generated file is stale.

The IAM request types in `src/contracts/ui-api.generated.ts` are generated from the
Hive IAM OpenAPI spec. Run `npm run contracts:generate` after you change IAM request
schemas; `npm run typecheck` fails if the generated file is stale.

## Requirements (source checkout)

- Node.js 24 (`>=24.22.3`) or 26 (`>=26.13.1`) and npm
- For OS (PAM) login in production: `pamtester` on the host

## Run from a source checkout

The Prisma client is generated into `src/generated/prisma` (gitignored).
`npm run build` and `npm run typecheck` always regenerate it, and `dev`, `test`,
`cli` and the smoke scripts regenerate it when it is missing or older than
`prisma/schema.prisma` (`npm run db:generate` does it by hand). The build
compiles it into `dist/`, so the published package needs no Prisma CLI and
runs no install scripts of its own.

```bash
npm install
cp .env.example .env
# edit .env: at least HIVE_ROUTER_SECRET and HIVE_ROUTER_ADMIN_USERS
npm run build
npm run start
```

For development, run `npm run dev` (API and admin with reload).

`.env.example` binds the API to `https://localhost:4020` and the admin API
to `https://127.0.0.1:9443`. TLS is turned on when both `TLS_CERT_PATH` and
`TLS_KEY_PATH` point at existing files. In development, with no certificate,
the listeners use plain HTTP. Health endpoints on both listeners:
`/health`, `/health/live`, `/health/ready` and `/health/dependencies`.
`/health/live` and `/health/ready` use the suite-standard body; `/health/ready`
answers 503 when the database is down or every enabled provider is unhealthy.

Next steps:

1. Sign in with `POST /api/auth/login` as a user listed in `HIVE_ROUTER_ADMIN_USERS`,
   keeping the session cookie it sets.
2. Add a provider with `POST /api/providers`, for example `LLAMACPP` at
   `http://127.0.0.1:8000` with auth `NONE`.
3. Create a client key with `hive-router create-key --name my-service`
   (see [API keys from the command line](#api-keys-from-the-command-line)).
4. Call the API:

   ```bash
   curl -k https://localhost:4020/v1/chat/completions \
     -H "Authorization: Bearer sk-..." -H "Content-Type: application/json" \
     -d '{"messages":[{"role":"user","content":"Hello"}]}'
   ```

## Configuration

Configuration comes from environment variables. With `--env-file <path>` the
process loads that file (existing environment variables win). Otherwise it
loads `.env` from its working directory, then `.env.apikeys` if it exists,
which overrides `.env`. Relative paths are resolved against the working
directory. Variables with no default are optional unless marked **required**.
`hive-router env-schema` prints the install-time subset as JSON.

### Listeners and URLs

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test` or `production`. Production requires TLS and rejects the insecure-TLS escape hatches. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `HOST` | `127.0.0.1` | Default bind address for both listeners. Set `0.0.0.0` (or a specific interface) to expose Emberpath. |
| `API_HOST` / `ADMIN_HOST` | `HOST` | Bind address for each listener. |
| `API_PORT` | `4020` | API plane port. |
| `ADMIN_PORT` | `9443` | Admin plane port. |
| `PUBLIC_API_URL` | `http(s)://localhost:API_PORT` | Externally visible API URL, used in docs and enrollment output. The default scheme is `https` when TLS is configured. |
| `PUBLIC_ADMIN_URL` | `http(s)://localhost:ADMIN_PORT` | Externally visible admin URL. Also the base of the default OIDC redirect URI. |
| `HIVE_UI_PUBLIC_URL` | `PUBLIC_ADMIN_URL` | Public URL of the browser console. |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | | PEM certificate and key. Both are required when `NODE_ENV=production` or `REQUIRE_TLS=true`. |
| `REQUIRE_TLS` | `false` | Refuse to start without TLS, even outside production. |

### Storage and capture

| Variable | Default | Description |
|---|---|---|
| `HIVE_HOME` | `~/.hive` | Base directory for Hive state. |
| `DATA_DIR` | `$HIVE_HOME/router` | Data directory, created with mode `0700`. |
| `DATABASE_URL` | `file:$DATA_DIR/router.db` | SQLite database (`file:` URLs only). |
| `TRACE_DIR` | `$DATA_DIR/traces` | Trace body storage. |
| `DEFAULT_TRACE_RETENTION_DAYS` | `7` | Trace retention. |
| `CAPTURE_REQUEST_BODIES` / `CAPTURE_RESPONSE_BODIES` | `false` | Keep raw request and response bodies with traces. |
| `CAPTURE_BINARY_MEDIA` | `false` | Keep binary media in trace bodies. |
| `MAX_REQUEST_BODY_BYTES` | `67108864` | Largest API request body accepted. |
| `MAX_ADMIN_BODY_BYTES` | `2097152` | Largest admin and proxy body accepted. |
| `MAX_TRACE_BODY_BYTES` | `1048576` | Stored trace bodies are cut off at this size. |

### Admin authentication

| Variable | Default | Description |
|---|---|---|
| `HIVE_ROUTER_SECRET` | | **Required.** At least 32 characters. Signs admin sessions and encrypts stored provider secrets. Keep it stable: if you rotate it, sessions and stored provider credentials stop working. |
| `HIVE_ROUTER_ADMIN_USERS` | `admin` | Comma-separated allowlist of account names that may sign in. Set it explicitly. |
| `HIVE_ROUTER_AUTH_MODE` | `os` | `os`: verify the OS password through PAM (`pamtester`). `iam-oidc`: sign in through Hive IAM. |
| `HIVE_ROUTER_OS_AUTH_COMMAND` | | Replaces `pamtester` with another command. Intended for tests and development. |
| `HIVE_ROUTER_CLI_TOKEN` | | Shared token required by `hive-router create-key` when set. |
| `SEED_CLIENT_API_KEY` | | Optional client key inserted on first start. |

### Hive IAM integration (optional)

| Variable | Default | Description |
|---|---|---|
| `HIVE_IAM_INTERNAL_URL` | `http://127.0.0.1:4200` | IAM base URL as Emberpath reaches it. |
| `HIVE_IAM_PUBLIC_URL` | `PUBLIC_ADMIN_URL/iam` | IAM URL shown to users. |
| `HIVE_ROUTER_IAM_CLIENT_ID` | `hive-router` | OAuth client Emberpath uses. |
| `HIVE_ROUTER_IAM_CLIENT_SECRET` | | Secret for that client. Required when `HIVE_ROUTER_AUTH_MODE=iam-oidc`; also enables the `/api/iam/*` proxy. |
| `HIVE_ROUTER_IAM_REDIRECT_URI` | `PUBLIC_ADMIN_URL/api/auth/oidc/callback` | OIDC redirect URI. |
| `HIVE_ROUTER_IAM_SCOPES` | `openid profile email` | Scopes requested at sign-in. |
| `HIVE_ROUTER_IAM_PROXY_SCOPES` | IAM admin scopes | Permissions requested for the server-side proxy token. |
| `HIVE_ROUTER_IAM_ISSUER` / `HIVE_ROUTER_IAM_AUDIENCE` | `hive-iam` / `hive-router` | Claims required on IAM tokens presented to Emberpath. |
| `HIVE_ROUTER_SECURITY_EXPORTER_CLIENT_ID` | `security-exporter` | IAM client id accepted for the security event exporter. |
| `HIVE_ROUTER_IAM_CA_CERT_PATH` | | CA certificate trusted for IAM HTTPS (OIDC, JWKS, proxy). |
| `HIVE_ROUTER_IAM_JWKS_REFRESH_MS` / `HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS` | `300000` / `900000` | JWKS refresh interval and the maximum age of cached keys. When the maximum is exceeded, Emberpath rejects tokens. |
| `HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS` | `false` | Legacy option: keep false. Certificate verification cannot be disabled; configure the corresponding CA path for private certificates. |

### HiveMem integration (optional)

| Variable | Default | Description |
|---|---|---|
| `HIVEMEM_INTERNAL_URL` | `http://127.0.0.1:18790` | HiveMem base URL for the `/api/memory/*`, `/v1/*` and `/dashboard` proxies. |
| `HIVEMEM_PUBLIC_URL` | `PUBLIC_ADMIN_URL` | HiveMem URL shown to users and agents. |
| `HIVEMEM_CA_CERT_PATH` | | Certificate trusted for HiveMem HTTPS. |
| `EMBERPATH_HIVEMEM_CLIENT_ID` / `EMBERPATH_HIVEMEM_CLIENT_SECRET` | | Oathweave machine client for HiveMem. Emberpath fetches short-lived client credentials tokens (audience `hivemem`) and renews them in-process before they expire. Set both or neither. |
| `EMBERPATH_HIVEMEM_SCOPE` | `hivemem:admin:all` | Permissions requested for HiveMem service tokens. |
| `EMBERPATH_HIVEMEM_TOKEN_URL` | `HIVE_IAM_INTERNAL_URL/api/v1/oauth/token` | Oathweave token endpoint for the service credential; HTTPS in production. |
| `HIVE_ROUTER_MEMORY_PROXY_TOKEN` | | Server-side HiveMem admin token for `/api/memory/*`, minted with `hivemem-server issue-token --subject hive-router --role admin`. It is never sent to the browser. With the Oathweave client set, it is only a fallback and is never sent after its own expiry. |
| `HIVE_SKILLS_INTERNAL_URL` / `HIVE_SKILLS_PUBLIC_URL` | | Optional Hive Skills registry reported by the admin API. |
| `HIVE_STATUS_ALLOW_INSECURE_TLS` | `false` | Legacy option: keep false. Certificate verification cannot be disabled; configure the corresponding CA path for private certificates. |

### Metrics, export and decision model

| Variable | Default | Description |
|---|---|---|
| `HIVE_ROUTER_METRICS_TOKEN` | | Bearer token for scraping `/metrics`. If unset, `/metrics` requires an admin session. |
| `PROMETHEUS_PREFIX` | `hive_router_` | Prefix for metric names. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | | OTLP endpoint for OpenTelemetry traces. |
| `HIVE_ROUTER_SECURITY_EXPORT_TOKEN_HASH` | | Legacy static credential for the security-event export. Used only while the fallback flag below is on. |
| `HIVE_ROUTER_SECURITY_EXPORT_STATIC_FALLBACK_ENABLED` | `false` | Temporary migration switch for the static export credential. Emberpath refuses to start with it on after `2026-09-30`. |
| `OPENROUTER_API_KEY` | | Seeds an `OPENROUTER` provider on first start. |
| `HIVE_TYPESAFE_AI_KEY` / `HIVE_TYPESAFE_AI_MODEL` | / `jev-latest` | Direct TypeSafe credential and model for the shadow decision model. |
| `HIVE_ROUTER_OPENROUTER_KEY` | | OpenRouter credential for the decision model fallback. |
| `HIVE_ROUTER_DECISION_MODEL` | `~typesafe/jev-latest` | Decision model ID used on OpenRouter. |
| `HIVE_ROUTER_DECISION_MODE` | `shadow` | `shadow` records decisions on traces; `off` disables them. |
| `HIVE_ROUTER_DECISION_TIMEOUT_MS` | `10000` | Timeout for each decision provider call. |

## Admin access model

- **OS mode** (`HIVE_ROUTER_AUTH_MODE=os`): an allowlisted user signs in with
  their OS password, which is checked through PAM. Every OS-mode operator has
  full admin rights.
- **IAM OIDC mode** (`HIVE_ROUTER_AUTH_MODE=iam-oidc`): Emberpath signs the user
  in against Hive IAM with authorization code + PKCE, then checks the username
  against `HIVE_ROUTER_ADMIN_USERS`. IAM `admin` and `super_admin` roles grant
  full access. Other users need a permission for each request, reads included:
  for example `router:providers:read` or `router:providers:write`,
  `iam:users:read`, `memory:read`. Any `:write` grant also covers the matching
  `:read`. Exporting the configuration requires `router:settings:write`.
- Credential and policy changes need a sign-in from the last 15 minutes. Confirm
  the password again with `POST /api/auth/reauthenticate` when needed.
- Repeated failed logins lock out that username from that client address, and
  one address that fails against many usernames is locked out too.
  Re-authentication is rate-limited in the same way.
- Browser credentials are never forwarded upstream. The IAM proxy swaps the
  admin session for a short-lived client-credentials token. The HiveMem proxy
  passes on only HiveMem's own `hivemem_*` cookies, never Emberpath's session
  cookie.
- Configuration exports never include encrypted provider secrets. When you
  import an export, providers that already exist keep their stored secrets.

## API keys from the command line

```bash
hive-router create-key --name "my-service" --metadata '{"service":"my-api","env":"prod"}'
# from a source checkout:
npm run cli -- create-key --name "my-service"
```

It uses the same configuration (and `--env-file`) as the server and writes to
the same database.

Flags: `--disabled` creates the key disabled, `--json` prints machine-readable
output, and `--token <value>` supplies `HIVE_ROUTER_CLI_TOKEN` when that is set.
The plaintext key is printed once; only a hash is stored.

## Testing

```bash
npm run typecheck
npm test                   # unit and integration tests (vitest)
npm run test:routing-contract
npm run build
npm run test:e2e           # Playwright console tests (builds and serves a local stack)
```

Live smoke tests against a running backend:

```bash
OLLAMA_BASE_URL=http://127.0.0.1:11434 npm run smoke:ollama
LLAMACPP_BASE_URL=http://127.0.0.1:8000 npm run smoke:llamacpp
npm run smoke:jev          # needs HIVE_TYPESAFE_AI_KEY and/or HIVE_ROUTER_OPENROUTER_KEY
```

## Deploy

### systemd over SSH

`scripts/deploy-hive-router.sh` builds Emberpath, uploads it over SSH, and
installs it as a systemd service with atomic releases. Code goes into
`<path>/releases/<id>`. Persistent state (database, `.env`, certificates) lives
in `<path>/shared`. The `<path>/current` link moves to the new release only
after it starts healthy. A failed start rolls back automatically, and the last
5 releases are kept.

```bash
DEPLOY_HOST=router.example.com DEPLOY_USER=deploy \
  HIVE_ROUTER_CERT_DOMAIN=router.example.com \
  bash scripts/deploy-hive-router.sh

bash scripts/deploy-hive-router.sh --dry-run              # build and package only
DEPLOY_HOST=... DEPLOY_USER=... bash scripts/deploy-hive-router.sh --rollback
```

| Variable | Default | Description |
|---|---|---|
| `DEPLOY_HOST` (or `HIVE_ROUTER_DEPLOY_HOST`) | | **Required.** SSH host to deploy to. |
| `DEPLOY_USER` (or `DEPLOY_USERNAME`) | | **Required.** SSH user; needs sudo on the target. |
| `DEPLOY_SSH_KEY` (or `HIVE_ROUTER_DEPLOY_SSH_KEY`) | | SSH private key. Without one, the script uses your SSH agent in batch mode. |
| `DEPLOY_SUDO_PASSWORD` | | Remote sudo password. Without it, the script runs `sudo -n`. |
| `DEPLOY_PASSWORD` + `DEPLOY_ALLOW_PASSWORD=true` | | Password SSH, for a one-time bootstrap only. Needs `sshpass`. |
| `HIVE_ROUTER_DEPLOY_PATH` | `/opt/hive-router` | Install root. |
| `HIVE_ROUTER_SERVICE_NAME` | `hive-router` | systemd unit name. |
| `HIVE_ROUTER_CERT_DOMAIN` | `DEPLOY_HOST` | Public FQDN the TLS certificate must match. |
| `HIVE_ROUTER_PUBLIC_ADMIN_URL` | `https://<cert domain>` | Public admin URL written to the remote `.env`. |
| `HIVE_ROUTER_ADMIN_PORT` | `443` | Admin listener port on the target. |
| `HIVE_ROUTER_USE_TAILSCALE_CERT` | `false` | If you use a private network such as Tailscale, set `true` to issue the certificate with `tailscale cert`. |

When `HIVE_ROUTER_USE_TAILSCALE_CERT` is not set, the script reuses a valid
certificate in `shared/certs`. If there is none, it copies HiveMem's
certificate from the same host, or else generates a self-signed one. To use
your own certificate, place it at `shared/certs/server.crt` and `server.key`
before you deploy.

The script keeps an existing remote `.env`; pass `--reset-env` to rewrite it.
It also reads `.env` from the repository root and from this directory, so you
can keep the deploy variables there. On the target it installs `pamtester` if
it is missing. If IAM or HiveMem is installed on the same host, the script
recovers `HIVE_ROUTER_IAM_CLIENT_SECRET` from `/opt/hive-iam/.env` and
`HIVE_ROUTER_MEMORY_PROXY_TOKEN` from `/opt/hivemem/.env`.

### Docker

Build the image from the repository root:

```bash
docker build -t emberpath:local .
```

Release images are published as `ghcr.io/cheftaco/emberpath`; see
[Run the image on its own](#run-the-image-on-its-own). Images build from this source, use API
port 4020 and admin port 9443 by default, run as the unprivileged `node` user and persist state
under `/data/router`. The image includes neither a PAM helper nor operator accounts; use
`HIVE_ROUTER_AUTH_MODE=iam-oidc` or provide your own `HIVE_ROUTER_OS_AUTH_COMMAND`. Startup
migrations require verified backups.

`docker-compose.example.yml` is the Compose example from the legacy 1.x line: it builds or
pulls `ghcr.io/cheftaco/hive-router` and does not run Emberpath 2.x.

### Production checklist

- Set `NODE_ENV=production`. Emberpath then refuses to start without
  `TLS_CERT_PATH` and `TLS_KEY_PATH`.
- Generate `HIVE_ROUTER_SECRET` randomly (`openssl rand -hex 32`) and keep it
  out of version control.
- Set `HIVE_ROUTER_ADMIN_USERS` to the exact operators.
- Expose only the listeners you need. Bind the admin plane to a private
  interface, or put it behind a VPN or an authenticating proxy.
- Set `HIVE_ROUTER_METRICS_TOKEN` if Prometheus scrapes `/metrics`.

## Shadow decision model

Jev is a **decision model**, not a chat model. Do not configure it as an
upstream chat alias. When `HIVE_TYPESAFE_AI_KEY` or `HIVE_ROUTER_OPENROUTER_KEY`
is set and `HIVE_ROUTER_DECISION_MODE=shadow`, Emberpath sends the prompt
fields of each text chat, completion and Responses request to TypeSafe
(`https://api.typesafe.ai/v1/systemone`). If that call fails, it tries the
OpenRouter decisions API once. The result goes into a `jev-decision` trace
observation: a profile (`standard`, `coding`, `hard`, `internet_data`,
`dangerous`) plus injection and NSFW probabilities.

Shadow mode never rewrites, reroutes or blocks requests. Multimodal requests
and inputs larger than 24,000 bytes are skipped. Errors and timeouts are
recorded as unavailable, never as safe. Shadow calls add latency and provider
cost, and that cost does not count toward client quotas.

Offline and live evaluation tools:

```bash
npm run test:routing-contract                 # offline routing contract checks
npm run baseline:routing -- replay            # verify the recorded Jev baseline offline
npm run eval:decisions                        # live evaluation against synthetic fixtures
EVAL_PROVIDER=llamacpp LLAMACPP_BASE_URL=http://127.0.0.1:8000/v1 npm run eval:decisions
EVAL_PROVIDER=typesafe EVAL_LIMIT=3 npm run eval:decisions
```

The evaluation reads credentials from the repository-root `.env` (override with
`HIVE_ROUTER_EVAL_ENV_FILE`). It uses only the synthetic fixtures under
`tests/fixtures/` and writes results to `output/`. Useful knobs:
`EVAL_FIXTURES`, `EVAL_OUTPUT`, `EVAL_LIMIT`, `EVAL_REPEATS` (1–5),
`EVAL_TIMEOUT_MS`, `EVAL_MAX_TOKENS`, `LLAMACPP_MODEL`, `LLAMACPP_API_KEY` and
`LLAMACPP_THINKING=low`. See
[the routing contract](docs/ROUTING_CONTRACT.md) and
[the TypeSafe direct API notes](docs/TYPESAFE_DIRECT_API.md).

## Repository layout

| Path | Contents |
|---|---|
| `src/api` | API-plane routes, proxy execution, streaming failover |
| `src/admin` | Admin API, permission checks, IAM/HiveMem proxies, fallback page |
| `src/providers` | Provider adapters, discovery, runtime and capability parsing |
| `src/routing` | Aliases, rules, heuristics, adaptive ranking, decision model |
| `src/security` | Admin sessions, PAM/OIDC auth, API keys, quotas, crypto |
| `src/storage` | Prisma client, SQLite bootstrap, trace bodies, audit |
| `src/telemetry` | Logging, metrics, tracing, retention |
| `prisma` | Prisma schema |
| `scripts` | Deploy, smoke, evaluation and code-generation scripts |
| `tests` | Vitest suites, Playwright console tests and fixtures |

## Managed upgrades

Use `hive upgrade --dry-run`, then `hive upgrade` for the enrolled release bundle. This server's
`upgrade` and `rollback` commands delegate to the same owner-run launcher. `migrate --plan --json`
is read-only; migration requires a verified backup. Set `HIVE_AUTO_MIGRATE=true` explicitly for
startup migrations outside a managed install. Slow or one-way automatic migrations are refused.
`check --json` reports configuration without initializing state. No upgrade rotates signing keys
or reseeds existing accounts. See [UPGRADING.md](https://github.com/ChefTaco/hive/blob/v1.2.2/UPGRADING.md)
for adoption, compatibility, recovery, update notices and container controls.

Container probes use a loopback `HIVE_HEALTH_URL`. Override its port/protocol for
the selected deployment. When the service certificate uses a DNS name, set
`HIVE_HEALTH_TLS_NAME` to that name and `NODE_EXTRA_CA_CERTS` to the approved CA
bundle when needed. Probes retain certificate verification. Runtime state belongs
in `/data`; mount only product-owned protected configuration in `/config`.
Images are local candidates until registry publication and release acceptance.

For isolated restore rehearsal, set `HIVE_REHEARSAL=true` on the candidate only.
This disables provider health probes, update checks and trace/credential-receipt
retention. Readiness checks the local database and reports external providers as
unchecked (`providers.checked=false`); it does not certify inference connectivity.
Normal operation defaults to `false` and retains provider readiness requirements.
Hive verifies external discovery, generation and streaming separately before enrollment.

The provider and model-alias administration operations are described in the owned
OpenAPI document, including strict write schemas, distinct sanitized read records,
permissions, discovery and conflict responses. Detailed discovery result coverage
is explicitly pending. `src/contracts/model-admin.ts` contains only public Zod
contracts and is also used directly by the native request validators.

After reviewing and committing a contract release, run
`npm run contracts:browser -- --output NEW_DIRECTORY`. The export reads the exact
committed source and package version with Git replacement objects disabled. It
contains the browser-safe source, Apache license, source notice and a provenance
manifest with the product version, source revision and SHA-256. It never exports
working-tree edits, private configuration or backend imports, and refuses to
replace an existing directory. Browser applications vendor a reviewed release
export and verify its checksum; they do not import sibling backend source.

Configuration downloads retain the published version-1 envelope, source IDs and
read timestamps. Import accepts that exact archive and the legacy `{data: ...}`
envelope. Only known metadata is accepted and stripped; unknown fields, malformed
encoded JSON and unresolved provider references fail. Providers reconcile by slug,
then exported source IDs map aliases and current routing-rule provider references
to the destination IDs. Omitted credentials, models and optional provider settings
stay intact on existing providers. A fresh destination needs its own separately
configured credentials; exported files never include encrypted provider secrets.
Configuration writes and the import audit commit in one transaction, including
rollback on a late database failure. Health observations and persistence IDs are
never assigned from an archive. Historical runtime-setting JSON remains byte
stable; historical revision records retain their original source references and
require review before applying them in another installation. This configuration
workflow does not replace a verified database/key backup or installation restore.

### Browser administration contracts

`src/contracts/model-admin.ts` is the browser-safe Zod contract for provider and
alias administration, route rules and heuristics, objective configuration,
selection previews and revision recovery, inference tests, client keys and quota
usage, telemetry and traces, audit, runtime settings, API documentation and Codex
device authorization. Native request handlers reuse these exact schemas; owned
OpenAPI response schemas distinguish newly created keys from full rotation
records. Creation and rotation reveal an API key once and prohibit caching; list
and trace relations never expose key hashes or stored provider credentials.
Opaque stored JSON fields remain strings, preserving historical data semantics.

Run `npm run contracts:browser -- --output NEW_DIRECTORY` to export committed
contract bytes, exact source revision and checksum, product version and Apache
attribution. Browser clients vendor that reviewed export, validate responses and
requests, and check its provenance without reading sibling backend source.
`npm run check:openapi` checks the generated operation and schema snapshot.

## Fresh suite initialization

New suite deployments may preallocate console account IDs with
`EMBERPATH_INITIAL_ADMIN_IDENTITIES_JSON`, for example
`[{"username":"admin","localId":"synthetic-new-model-admin"}]`.
Each username must be in the configured administrator allowlist. Startup creates
only missing accounts and preserves all existing IDs, display names and
credentials. Conflicting bindings fail instead of merging accounts. Existing
installations use explicit reviewed Oathweave issuer/subject account links.

## Native deployment runtime checks

Source deployment checks the Node.js used by npm and `/usr/bin/node`, which the
installed systemd service uses, against the current package `engines.node` policy.
An unsupported runtime stops deployment before remote writes or service restarts.
Update the system interpreter as well as any shell-specific Node.js installation.
