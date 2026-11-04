#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# deploy-hive-router.sh - Build and deploy Hive Router / Hive UI
#
# Builds the standalone router, packages source + dist artifacts, uploads via
# SCP, installs dependencies on the target, writes/preserves .env, and restarts
# the hive-router systemd service.
#
# Usage:
#   DEPLOY_HOST=router.example.com DEPLOY_USER=deploy bash scripts/deploy-hive-router.sh
#   bash scripts/deploy-hive-router.sh --dry-run
#   bash scripts/deploy-hive-router.sh --skip-build
#   bash scripts/deploy-hive-router.sh --reset-env
#   bash scripts/deploy-hive-router.sh --rollback [release-id]
#
# Required environment:
#   DEPLOY_HOST (or HIVE_ROUTER_DEPLOY_HOST)  SSH host to deploy to
#   DEPLOY_USER (or DEPLOY_USERNAME)          SSH user on that host
# Optional environment:
#   HIVE_ROUTER_DEPLOY_PATH       install root (default /opt/hive-router)
#   HIVE_ROUTER_SERVICE_NAME      systemd unit name (default hive-router)
#   HIVE_ROUTER_CERT_DOMAIN       public FQDN for TLS (default DEPLOY_HOST)
#   HIVE_ROUTER_ADMIN_USERS       admin allowlist (default admin for a new .env; an existing one is kept unless set)
#   HIVE_ROUTER_USE_TAILSCALE_CERT=true  request the TLS cert with `tailscale cert`
#   DEPLOY_SSH_KEY / HIVE_ROUTER_DEPLOY_SSH_KEY, DEPLOY_SUDO_PASSWORD
# Values are also read from .env at the repository root and in this service.
#
# Runtime ports: API 4020, admin UI 443, both HTTPS when certs are present
#
# Releases are deployed atomically: code lands in /opt/hive-router/releases/<id>,
# persistent state (db, .env, certs) lives in /opt/hive-router/shared, and
# /opt/hive-router/current is flipped to the new release only after a healthy
# start. A failed start auto-rolls-back to the previous release. The last 5
# releases are retained for manual rollback via --rollback.
# -----------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MONOREPO_ROOT="$(cd "$REPO_ROOT/../.." && pwd)"
RELEASE_MANAGER_LIB="$MONOREPO_ROOT/scripts/lib/release-manager.sh"
TARBALL="/tmp/.hive-router-deploy.tar.gz"
REMOTE_PATH="${HIVE_ROUTER_DEPLOY_PATH:-/opt/hive-router}"
SERVICE_NAME="${HIVE_ROUTER_SERVICE_NAME:-hive-router}"
KEEP_RELEASES="${HIVE_ROUTER_KEEP_RELEASES:-5}"

DRY_RUN=false
RESET_ENV=false
SKIP_BUILD=false
ROLLBACK=false
ROLLBACK_ID=""
RELEASE_OVERRIDE=""
EXPECTED_CURRENT=""
STAGE_ROOT="$MONOREPO_ROOT/.artifacts/hive-router"
PINNED_STAGE=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --reset-env) RESET_ENV=true ;;
    --skip-build) SKIP_BUILD=true ;;
    --rollback) ROLLBACK=true ;;
    --rollback=*) ROLLBACK=true; ROLLBACK_ID="${arg#*=}" ;;
    --release-id=*) RELEASE_OVERRIDE="${arg#*=}" ;;
    --expected-current=*) EXPECTED_CURRENT="${arg#*=}" ;;
    -h|--help)
      sed -n '2,/^# ---/{ /^#/s/^# \?//p }' "$0"
      exit 0
      ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done
for id in "$RELEASE_OVERRIDE" "$EXPECTED_CURRENT" "$ROLLBACK_ID"; do
  [[ -z "$id" || "$id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$ ]] || { echo "Unsafe release ID" >&2; exit 64; }
done
[[ -z "$EXPECTED_CURRENT" || "$ROLLBACK" == true ]] || { echo "--expected-current requires --rollback" >&2; exit 64; }

load_env_file() {
  local file="$1" line key value
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" == *"="* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key//[[:space:]]/}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="${value%$'\r'}"
    if [[ "$value" =~ ^\".*\"$ || "$value" =~ ^\'.*\'$ ]]; then
      value="${value:1:${#value}-2}"
    fi
    export "$key=$value"
  done < "$file"
}

load_env_file "$MONOREPO_ROOT/.env"
load_env_file "$REPO_ROOT/.env"
REMOTE_HOST="${HIVE_ROUTER_DEPLOY_HOST:-${DEPLOY_HOST:-}}"
SSH_USER="${DEPLOY_USER:-${DEPLOY_USERNAME:-}}"
if [[ "$DRY_RUN" != "true" || "$ROLLBACK" == "true" || -n "$RELEASE_OVERRIDE" ]]; then
  [[ -n "$REMOTE_HOST" ]] || { echo "ERROR: set DEPLOY_HOST (or HIVE_ROUTER_DEPLOY_HOST) to the target SSH host." >&2; exit 64; }
  [[ -n "$SSH_USER" ]] || { echo "ERROR: set DEPLOY_USER (or DEPLOY_USERNAME) to the target SSH user." >&2; exit 64; }
fi
REMOTE_HOST="${REMOTE_HOST:-localhost}"
ROUTER_PUBLIC_FQDN="${HIVE_ROUTER_CERT_DOMAIN:-${REMOTE_HOST}}"

SSH_PASS="${DEPLOY_PASSWORD:-}"
SSH_KEY="${HIVE_ROUTER_DEPLOY_SSH_KEY:-${DEPLOY_SSH_KEY:-}}"
SUDO_PASS="${DEPLOY_SUDO_PASSWORD:-${SSH_PASS:-}}"
SSH_AUTH_PASS="$SSH_PASS"
if [[ -n "$SSH_KEY" ]]; then
  SSH_AUTH_PASS=""
fi

# Password SSH is bootstrap-only. Prefer key/agent auth for routine deploys and
# require an explicit opt-in for password mode so it is a deliberate choice.
DEPLOY_ALLOW_PASSWORD="${DEPLOY_ALLOW_PASSWORD:-false}"
if [[ -n "$SSH_AUTH_PASS" && "$DEPLOY_ALLOW_PASSWORD" != "true" ]]; then
  echo "ERROR: password-based SSH deploy requires DEPLOY_ALLOW_PASSWORD=true." >&2
  echo "       Prefer key auth: set HIVE_ROUTER_DEPLOY_SSH_KEY or DEPLOY_SSH_KEY (or use an SSH agent)." >&2
  echo "       For a one-time bootstrap, re-run with DEPLOY_ALLOW_PASSWORD=true." >&2
  exit 1
fi

if [[ -n "$SSH_AUTH_PASS" ]] && ! command -v sshpass >/dev/null 2>&1; then
  echo "ERROR: sshpass is required for password-based deploy auth. Set HIVE_ROUTER_DEPLOY_SSH_KEY or DEPLOY_SSH_KEY to use key auth."
  exit 1
fi

[[ "$REMOTE_PATH" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "ERROR: unsafe HIVE_ROUTER_DEPLOY_PATH: $REMOTE_PATH" >&2; exit 1; }
[[ "$SERVICE_NAME" =~ ^[A-Za-z0-9_.@-]+$ ]] || { echo "ERROR: unsafe HIVE_ROUTER_SERVICE_NAME: $SERVICE_NAME" >&2; exit 1; }

info() { echo -e "\033[1;34m>>>\033[0m $*"; }
ok() { echo -e "\033[1;32m>>>\033[0m $*"; }
err() { echo -e "\033[1;31m>>>\033[0m $*" >&2; }

SSH_OPTIONS=(-o StrictHostKeyChecking=accept-new -o UpdateHostKeys=yes -o LogLevel=ERROR)
if [[ -n "$SSH_KEY" ]]; then
  SSH_OPTIONS+=(-i "$SSH_KEY")
fi
if [[ -z "$SSH_AUTH_PASS" ]]; then
  SSH_OPTIONS+=(-o BatchMode=yes)
fi

if [[ -n "$SSH_AUTH_PASS" ]]; then
  info "Deploy SSH auth: password bootstrap mode"
elif [[ -n "$SSH_KEY" ]]; then
  info "Deploy SSH auth: key file $SSH_KEY"
else
  info "Deploy SSH auth: SSH agent/default key mode"
fi
if [[ -z "$SUDO_PASS" ]]; then
  info "Remote sudo auth: passwordless sudo (-n)"
else
  info "Remote sudo auth: password supplied via DEPLOY_SUDO_PASSWORD/deploy password"
fi

remote_exec() {
  if [[ -n "$SSH_AUTH_PASS" ]]; then
    SSHPASS="$SSH_AUTH_PASS" sshpass -e ssh "${SSH_OPTIONS[@]}" "$SSH_USER@$REMOTE_HOST" "$@"
  else
    ssh "${SSH_OPTIONS[@]}" "$SSH_USER@$REMOTE_HOST" "$@"
  fi
}

remote_scp() {
  if [[ -n "$SSH_AUTH_PASS" ]]; then
    SSHPASS="$SSH_AUTH_PASS" sshpass -e scp "${SSH_OPTIONS[@]}" "$@"
  else
    scp "${SSH_OPTIONS[@]}" "$@"
  fi
}

cd "$REPO_ROOT"

if [[ ! -f "$RELEASE_MANAGER_LIB" ]]; then
  err "Missing release manager library: $RELEASE_MANAGER_LIB"
  exit 1
fi

ESCAPED_PASS=$(printf '%s' "$SUDO_PASS" | sed "s/'/'\\\\''/g")

# --rollback: flip the `current` symlink to a prior release and restart. No
# build or upload of application code is needed.
if [[ "$ROLLBACK" == "true" ]]; then
  if [[ "$DRY_RUN" == "true" ]]; then
    info "Dry run: would roll back $SERVICE_NAME on $REMOTE_HOST to ${ROLLBACK_ID:-the previous release}."
    exit 0
  fi
  info "Rolling back $SERVICE_NAME on $REMOTE_HOST to ${ROLLBACK_ID:-the previous release}..."
  remote_scp "$RELEASE_MANAGER_LIB" "$SSH_USER@$REMOTE_HOST:/tmp/.hive-release-manager.sh"
  remote_exec bash -s <<ROLLBACK_SCRIPT
set -euo pipefail
SUDO_PASS='${ESCAPED_PASS}'
do_sudo() {
  local output rc
  output=\$(mktemp)
  rc=0
  if [[ -n "\$SUDO_PASS" ]]; then
    printf '%s\n' "\$SUDO_PASS" | sudo -S -p '' "\$@" > "\$output" 2>&1 || rc=\$?
  else
    sudo -n "\$@" > "\$output" 2>&1 || rc=\$?
  fi
  grep -v '\\[sudo\\]' "\$output" || true
  rm -f "\$output"
  return "\$rc"
}
# shellcheck source=/dev/null
source /tmp/.hive-release-manager.sh
rm -f /tmp/.hive-release-manager.sh
BASE='${REMOTE_PATH}'
CURRENT=\$(release_manager_current_id "\$BASE")
if [[ -n '${EXPECTED_CURRENT}' && "\$CURRENT" != '${EXPECTED_CURRENT}' ]]; then
  echo "ERROR: current release differs from expected candidate" >&2
  exit 1
fi
TARGET=\$(release_manager_rollback_target "\$BASE" '${ROLLBACK_ID}')
echo ">>> Rolling back from \${CURRENT:-none} to \$TARGET"
release_manager_activate "\$BASE" "\$TARGET"
do_sudo systemctl restart ${SERVICE_NAME}.service
echo ">>> Waiting for admin health..."
HEALTHY=false
for _ in \$(seq 1 30); do
  if curl --fail --silent --show-error \
    --resolve '${ROUTER_PUBLIC_FQDN}:${PROD_ADMIN_PORT:-443}:127.0.0.1' \
    'https://${ROUTER_PUBLIC_FQDN}:${PROD_ADMIN_PORT:-443}/health/ready' >/dev/null; then
    HEALTHY=true
    break
  fi
  sleep 1
done
if [[ "\$HEALTHY" != "true" ]]; then
  echo "ERROR: service did not become healthy after rollback to \$TARGET" >&2
  exit 1
fi
curl --fail --silent --show-error \
  --resolve '${ROUTER_PUBLIC_FQDN}:${PROD_ADMIN_PORT:-443}:127.0.0.1' \
  'https://${ROUTER_PUBLIC_FQDN}:${PROD_ADMIN_PORT:-443}/health/ready'
echo
echo ">>> Rolled back to \$TARGET"
printf '{"status":"rolled-back","releaseId":"%s","installedReleaseId":"%s","health":"passed"}\n' '${EXPECTED_CURRENT}' "\$TARGET"
ROLLBACK_SCRIPT
  ok "hive-router rolled back on $REMOTE_HOST"
  exit 0
fi

if [[ -n "$RELEASE_OVERRIDE" && "$DRY_RUN" == true ]]; then
  [[ -z "$(git -C "$MONOREPO_ROOT" status --porcelain=v1 --untracked-files=all)" ]] || {
    err "Pinned Router dry-run requires a clean checkout"
    exit 1
  }
  [[ ! -L "$MONOREPO_ROOT/.artifacts" && ! -L "$STAGE_ROOT" ]] || {
    err "Router artifact stage is aliased"
    exit 1
  }
fi

if [[ -n "$RELEASE_OVERRIDE" && "$DRY_RUN" == false ]]; then
  STAGE_DIR="$STAGE_ROOT/$RELEASE_OVERRIDE"
  [[ -d "$STAGE_DIR" && ! -L "$STAGE_DIR" && -f "$STAGE_DIR/plan.json" && ! -L "$STAGE_DIR/plan.json" && -f "$STAGE_DIR/artifact.tgz" && ! -L "$STAGE_DIR/artifact.tgz" ]] || {
    err "Exact release ID requires a staged dry-run artifact"
    exit 1
  }
  mapfile -t STAGE_FIELDS < <(node -e '
    const fs = require("node:fs");
    const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (p.schema !== 1 || p.releaseId !== process.argv[2] || !/^[a-f0-9]{40}$/.test(p.revision) || !/^[a-f0-9]{64}$/.test(p.artifactSha256) || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/.test(p.priorReleaseId)) process.exit(2);
    process.stdout.write([p.revision, p.artifactSha256, p.priorReleaseId].join("\n") + "\n");
  ' "$STAGE_DIR/plan.json" "$RELEASE_OVERRIDE")
  [[ "${#STAGE_FIELDS[@]}" == 3 ]] || { err "Pinned release plan is invalid"; exit 1; }
  SOURCE_REVISION="${STAGE_FIELDS[0]}"
  ARTIFACT_SHA256="${STAGE_FIELDS[1]}"
  PRIOR_RELEASE_ID="${STAGE_FIELDS[2]}"
  [[ "$(git -C "$MONOREPO_ROOT" rev-parse HEAD)" == "$SOURCE_REVISION" ]] || { err "Pinned source revision drifted"; exit 1; }
  [[ "$(sha256sum "$STAGE_DIR/artifact.tgz" | awk '{print $1}')" == "$ARTIFACT_SHA256" ]] || { err "Pinned artifact digest drifted"; exit 1; }
  CURRENT_REMOTE="$(remote_exec "readlink '$REMOTE_PATH/current'")"
  [[ "${CURRENT_REMOTE##*/}" == "$PRIOR_RELEASE_ID" ]] || { err "Installed Router base drifted since dry-run"; exit 1; }
  TARBALL="$STAGE_DIR/artifact.tgz"
  PINNED_STAGE=true
  SKIP_BUILD=true
fi

if [[ "$PINNED_STAGE" == true ]]; then
  info "Using pinned Router artifact $ARTIFACT_SHA256"
elif [[ "$SKIP_BUILD" == "false" ]]; then
  info "Building hive-router..."
  npm run build
  ok "Build complete"
else
  info "Skipping build (--skip-build)"
  [[ -d dist && -d ui/dist ]] || { err "Missing dist/ui artifacts; rerun without --skip-build"; exit 1; }
fi

if [[ "$PINNED_STAGE" == false ]]; then
  info "Packaging hive-router..."
tar czf "$TARBALL" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='data' \
  --exclude='.artifacts' \
  --exclude='coverage' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='*.tsbuildinfo' \
  -C "$REPO_ROOT" .
ARTIFACT_SHA256="$(sha256sum "$TARBALL" | awk '{print $1}')"
SOURCE_REVISION="$(git -C "$MONOREPO_ROOT" rev-parse HEAD)"

if [[ "$DRY_RUN" == "true" && -n "$RELEASE_OVERRIDE" ]]; then
  STAGE_DIR="$STAGE_ROOT/$RELEASE_OVERRIDE"
  [[ ! -e "$STAGE_DIR" && ! -L "$STAGE_DIR" ]] || { err "Release ID already has a staged artifact"; exit 1; }
  CURRENT_REMOTE="$(remote_exec "readlink '$REMOTE_PATH/current'")"
  PRIOR_RELEASE_ID="${CURRENT_REMOTE##*/}"
  [[ "$PRIOR_RELEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$ ]] || { err "Installed Router release ID is unavailable"; exit 1; }
  (umask 077; mkdir -p "$STAGE_DIR")
  chmod 700 "$STAGE_DIR"
  mv "$TARBALL" "$STAGE_DIR/artifact.tgz"
  chmod 600 "$STAGE_DIR/artifact.tgz"
  (umask 077; printf '{"schema":1,"releaseId":"%s","revision":"%s","artifactSha256":"%s","priorReleaseId":"%s"}\n' \
    "$RELEASE_OVERRIDE" "$SOURCE_REVISION" "$ARTIFACT_SHA256" "$PRIOR_RELEASE_ID" > "$STAGE_DIR/plan.json")
  chmod 600 "$STAGE_DIR/plan.json"
fi
fi

if [[ "$DRY_RUN" == "true" ]]; then
  [[ -n "$RELEASE_OVERRIDE" ]] || rm -f "$TARBALL"
  printf '{"status":"ready","revision":"%s","artifactSha256":"%s","releaseId":"%s","priorReleaseId":"%s","sideEffect":"%s"}\n' \
    "$SOURCE_REVISION" "$ARTIFACT_SHA256" "$RELEASE_OVERRIDE" "${PRIOR_RELEASE_ID:-}" "$( [[ -n "$RELEASE_OVERRIDE" ]] && echo artifact-staged || echo local-artifact-removed )"
  exit 0
fi

info "Uploading package to $REMOTE_HOST..."
remote_scp "$TARBALL" "$SSH_USER@$REMOTE_HOST:/tmp/.hive-router-deploy.tar.gz"
remote_scp "$RELEASE_MANAGER_LIB" "$SSH_USER@$REMOTE_HOST:/tmp/.hive-release-manager.sh"
[[ "$PINNED_STAGE" == true ]] || rm -f "$TARBALL"

PROD_SECRET="${HIVE_ROUTER_SECRET:-$(openssl rand -hex 32)}"
PROD_ADMIN_USERS="${HIVE_ROUTER_ADMIN_USERS:-admin}"
PROD_ADMIN_USERS_EXPLICIT="${HIVE_ROUTER_ADMIN_USERS:+true}"
PROD_CLIENT_KEY="${SEED_CLIENT_API_KEY:-}"
PROD_METRICS_TOKEN="${HIVE_ROUTER_METRICS_TOKEN:-}"
PROD_SECURITY_EXPORT_TOKEN_HASH="${HIVE_ROUTER_SECURITY_EXPORT_TOKEN_HASH:-}"
PROD_ADMIN_HOST="${HIVE_ROUTER_ADMIN_HOST:-0.0.0.0}"
PROD_ADMIN_PORT="${HIVE_ROUTER_ADMIN_PORT:-443}"
PROD_CERT_DOMAIN="${ROUTER_PUBLIC_FQDN}"
PROD_PUBLIC_ADMIN_URL="${HIVE_ROUTER_PUBLIC_ADMIN_URL:-https://${PROD_CERT_DOMAIN}}"
PROD_HIVE_UI_PUBLIC_URL="${HIVE_UI_PUBLIC_URL:-${PROD_PUBLIC_ADMIN_URL}}"
PROD_HIVEMEM_INTERNAL_URL="${HIVEMEM_INTERNAL_URL:-https://${ROUTER_PUBLIC_FQDN}:18443}"
PROD_HIVEMEM_PUBLIC_URL="${HIVEMEM_PUBLIC_URL:-https://${PROD_CERT_DOMAIN}}"
PROD_MEMORY_PROXY_TOKEN="${HIVE_ROUTER_MEMORY_PROXY_TOKEN:-}"
PROD_HIVE_IAM_INTERNAL_URL="${HIVE_IAM_INTERNAL_URL:-https://${ROUTER_PUBLIC_FQDN}:4200}"
PROD_HIVE_IAM_PUBLIC_URL="${HIVE_IAM_PUBLIC_URL:-https://${ROUTER_PUBLIC_FQDN}:4200}"
PROD_HIVE_ROUTER_IAM_ISSUER="${HIVE_ROUTER_IAM_ISSUER:-hive-iam}"
PROD_HIVE_ROUTER_IAM_AUDIENCE="${HIVE_ROUTER_IAM_AUDIENCE:-hive-router}"
PROD_HIVE_ROUTER_SECURITY_EXPORTER_CLIENT_ID="${HIVE_ROUTER_SECURITY_EXPORTER_CLIENT_ID:-security-exporter}"
if [[ ! "$PROD_HIVE_ROUTER_SECURITY_EXPORTER_CLIENT_ID" =~ ^[A-Za-z0-9_-]{1,100}$ ]]; then
  echo "ERROR: HIVE_ROUTER_SECURITY_EXPORTER_CLIENT_ID may only contain letters, digits, _ and -." >&2
  exit 1
fi
PROD_HIVE_STATUS_ALLOW_INSECURE_TLS="${HIVE_STATUS_ALLOW_INSECURE_TLS:-false}"
PROD_HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS="${HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS:-false}"
PROD_HIVE_ROUTER_IAM_JWKS_REFRESH_MS="${HIVE_ROUTER_IAM_JWKS_REFRESH_MS:-300000}"
PROD_HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS="${HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS:-900000}"
PROD_SECURITY_EXPORT_STATIC_FALLBACK_ENABLED="${HIVE_ROUTER_SECURITY_EXPORT_STATIC_FALLBACK_ENABLED:-false}"
PROD_AUTH_MODE="${HIVE_ROUTER_AUTH_MODE:-iam-oidc}"
PROD_IAM_CLIENT_ID="${HIVE_ROUTER_IAM_CLIENT_ID:-hive-router}"
PROD_IAM_REDIRECT_URI="${HIVE_ROUTER_IAM_REDIRECT_URI:-${PROD_PUBLIC_ADMIN_URL}/api/auth/oidc/callback}"
PROD_IAM_CLIENT_SECRET="${HIVE_ROUTER_IAM_CLIENT_SECRET:-${SEED_HIVE_ROUTER_CLIENT_SECRET:-}}"
PROD_IAM_SCOPES="${HIVE_ROUTER_IAM_SCOPES:-openid profile email}"
PROD_IAM_PROXY_SCOPES="${HIVE_ROUTER_IAM_PROXY_SCOPES:-iam:users:read iam:users:write iam:users:delete iam:roles:read iam:roles:write iam:sa:read iam:sa:write iam:sa:delete iam:clients:read iam:clients:write iam:audit:read iam:sessions:revoke iam:system:login iam:tokens:introspect}"
PROD_USE_TAILSCALE_CERT="${HIVE_ROUTER_USE_TAILSCALE_CERT:-false}"
ESCAPED_PASS=$(printf '%s' "$SUDO_PASS" | sed "s/'/'\\\\''/g")

[[ "$PROD_ADMIN_USERS" =~ ^[A-Za-z_][A-Za-z0-9_-]*(,[A-Za-z_][A-Za-z0-9_-]*)*$ ]] || {
  err "HIVE_ROUTER_ADMIN_USERS must be a comma-separated list of local account names"
  exit 1
}
if [[ "$PROD_HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS" == "true" ]]; then
  err "HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS cannot be enabled for a production deploy"
  exit 1
fi
if [[ "$PROD_HIVE_STATUS_ALLOW_INSECURE_TLS" == "true" ]]; then
  err "HIVE_STATUS_ALLOW_INSECURE_TLS cannot be enabled for a production deploy"
  exit 1
fi

info "Installing on $REMOTE_HOST..."
remote_exec bash -s <<DEPLOY_SCRIPT
set -euo pipefail
SUDO_PASS='${ESCAPED_PASS}'
do_sudo() {
  local output rc
  output=\$(mktemp)
  rc=0
  if [[ -n "\$SUDO_PASS" ]]; then
    printf '%s\n' "\$SUDO_PASS" | sudo -S -p '' "\$@" > "\$output" 2>&1 || rc=\$?
  else
    sudo -n "\$@" > "\$output" 2>&1 || rc=\$?
  fi
  grep -v '\\[sudo\\]' "\$output" || true
  rm -f "\$output"
  return "\$rc"
}
read_env() { grep "^\$2=" "\$1" 2>/dev/null | cut -d= -f2- | tr -d '"' || true; }
upsert_env() {
  local file="\$1"
  local key="\$2"
  local value="\$3"
  if grep -q "^\${key}=" "\$file" 2>/dev/null; then
    sed -i "s|^\${key}=.*|\${key}=\${value}|" "\$file"
  else
    printf '%s=%s\n' "\$key" "\$value" >> "\$file"
  fi
}

# shellcheck source=/dev/null
source /tmp/.hive-release-manager.sh
rm -f /tmp/.hive-release-manager.sh

BASE='${REMOTE_PATH}'
SHARED="\$BASE/shared"
ENV_FILE="\$SHARED/.env"

do_sudo mkdir -p "\$BASE"
do_sudo chown \$USER:\$USER "\$BASE"
release_manager_init "\$BASE"

# Adopt the atomic-release layout on hosts still using the legacy real-directory
# deployment: persistent state (.env, data, certs) moves into shared/.
release_manager_migrate_legacy "\$BASE"
mkdir -p "\$SHARED/certs"

if do_sudo test -f /opt/hive-iam/certs/ca-bundle.crt; then
  echo ">>> Trusting the rotation-safe Hive IAM private CA bundle..."
  do_sudo cp /opt/hive-iam/certs/ca-bundle.crt "\$SHARED/certs/iam-ca.crt"
  do_sudo chown \$USER:\$USER "\$SHARED/certs/iam-ca.crt"
  chmod 644 "\$SHARED/certs/iam-ca.crt"
else
  echo "ERROR: /opt/hive-iam/certs/ca-bundle.crt is required for verified IAM TLS" >&2
  exit 1
fi
if do_sudo test -f /opt/hivemem/certs/server.crt; then
  echo ">>> Pinning the current HiveMem certificate..."
  do_sudo cp /opt/hivemem/certs/server.crt "\$SHARED/certs/hivemem-ca.crt"
  do_sudo chown \$USER:\$USER "\$SHARED/certs/hivemem-ca.crt"
  chmod 644 "\$SHARED/certs/hivemem-ca.crt"
else
  echo "ERROR: /opt/hivemem/certs/server.crt is required for verified HiveMem TLS" >&2
  exit 1
fi

# Back up the current systemd unit so the pre-release layout can be recovered.
if [[ -f /etc/systemd/system/${SERVICE_NAME}.service ]]; then
  mkdir -p "\$SHARED/unit-backups"
  cp /etc/systemd/system/${SERVICE_NAME}.service "\$SHARED/unit-backups/${SERVICE_NAME}-\$(date -u +%Y%m%d%H%M%S).service" 2>/dev/null || true
fi

# IAM owns the Router client secret: prefer a co-located IAM install's value,
# then the Router's previous value.
ROUTER_IAM_CLIENT_SECRET='${PROD_IAM_CLIENT_SECRET}'
if [[ -z "\$ROUTER_IAM_CLIENT_SECRET" && -f /opt/hive-iam/.env && -r /opt/hive-iam/.env ]]; then
  ROUTER_IAM_CLIENT_SECRET=\$(grep '^SEED_HIVE_ROUTER_CLIENT_SECRET=' /opt/hive-iam/.env 2>/dev/null | cut -d= -f2- || true)
fi
if [[ -z "\$ROUTER_IAM_CLIENT_SECRET" ]] && do_sudo test -f /opt/hive-iam/.env; then
  ROUTER_IAM_CLIENT_SECRET=\$(do_sudo grep '^SEED_HIVE_ROUTER_CLIENT_SECRET=' /opt/hive-iam/.env | cut -d= -f2- || true)
fi
if [[ -z "\$ROUTER_IAM_CLIENT_SECRET" && -f "\$ENV_FILE" ]]; then
  ROUTER_IAM_CLIENT_SECRET=\$(read_env "\$ENV_FILE" HIVE_ROUTER_IAM_CLIENT_SECRET)
fi
if [[ '${PROD_AUTH_MODE}' == 'iam-oidc' && -z "\$ROUTER_IAM_CLIENT_SECRET" ]]; then
  echo "ERROR: HIVE_ROUTER_AUTH_MODE=iam-oidc requires HIVE_ROUTER_IAM_CLIENT_SECRET or /opt/hive-iam/.env SEED_HIVE_ROUTER_CLIENT_SECRET" >&2
  exit 1
fi
if [[ -z "\$ROUTER_IAM_CLIENT_SECRET" ]]; then
  echo "ERROR: Router IAM proxy requires HIVE_ROUTER_IAM_CLIENT_SECRET or /opt/hive-iam/.env SEED_HIVE_ROUTER_CLIENT_SECRET" >&2
  exit 1
fi

RELEASE_ID='${RELEASE_OVERRIDE}'
if [[ -z "\$RELEASE_ID" ]]; then RELEASE_ID=\$(release_manager_new_id); fi
if [[ -e "\$BASE/releases/\$RELEASE_ID" ]]; then
  echo "ERROR: release ID already exists" >&2
  exit 1
fi
RELEASE_DIR=\$(release_manager_prepare "\$BASE" "\$RELEASE_ID")
echo ">>> Preparing release \$RELEASE_ID"

echo ">>> Extracting package..."
test "\$(sha256sum /tmp/.hive-router-deploy.tar.gz | awk '{print \$1}')" = '${ARTIFACT_SHA256}'
tar xzf /tmp/.hive-router-deploy.tar.gz -C "\$RELEASE_DIR"
printf '%s\n' '${SOURCE_REVISION}' > "\$RELEASE_DIR/REVISION"
rm -f /tmp/.hive-router-deploy.tar.gz

mkdir -p "\$SHARED/data" "\$SHARED/data/traces" "\$SHARED/certs"
chmod 700 "\$SHARED/data" "\$SHARED/data/traces"

if [[ '${PROD_USE_TAILSCALE_CERT}' == 'true' ]]; then
  echo ">>> Requesting Tailscale TLS certificate for ${PROD_CERT_DOMAIN}..."
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "ERROR: tailscale CLI is required when HIVE_ROUTER_USE_TAILSCALE_CERT=true" >&2
    exit 1
  fi
  do_sudo tailscale cert --cert-file "\$SHARED/certs/server.crt" --key-file "\$SHARED/certs/server.key" '${PROD_CERT_DOMAIN}'
  do_sudo chown \$USER:\$USER "\$SHARED/certs/server.crt" "\$SHARED/certs/server.key"
elif [[ -f "\$SHARED/certs/server.crt" && -f "\$SHARED/certs/server.key" ]] \
  && openssl x509 -in "\$SHARED/certs/server.crt" -noout >/dev/null 2>&1 \
  && ! openssl x509 -in "\$SHARED/certs/server.crt" -noout -text 2>/dev/null | grep -q 'CA:TRUE'; then
  echo ">>> Reusing existing router TLS certificate in shared/certs"
elif [[ -f /opt/hivemem/certs/server.crt && -f /opt/hivemem/certs/server.key ]]; then
  echo ">>> Copying HiveMem TLS certs for router listeners..."
  do_sudo cp /opt/hivemem/certs/server.crt "\$SHARED/certs/server.crt"
  do_sudo cp /opt/hivemem/certs/server.key "\$SHARED/certs/server.key"
  do_sudo chown \$USER:\$USER "\$SHARED/certs/server.crt" "\$SHARED/certs/server.key"
else
  echo ">>> Generating local router TLS certificate..."
  openssl req -x509 -newkey rsa:2048 \
    -keyout "\$SHARED/certs/server.key" \
    -out "\$SHARED/certs/server.crt" \
    -days 365 -nodes \
    -subj "/CN=${REMOTE_HOST}/O=Hive/C=US" \
    -addext "subjectAltName=DNS:${REMOTE_HOST},DNS:localhost,IP:127.0.0.1" \
    -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
    -addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1
fi
chmod 600 "\$SHARED/certs/server.key"
chmod 644 "\$SHARED/certs/server.crt"

WRITE_ENV=false
[[ ! -f "\$ENV_FILE" ]] && WRITE_ENV=true
[[ '${RESET_ENV}' == 'true' ]] && WRITE_ENV=true

if [[ "\$WRITE_ENV" == "true" ]]; then
  EXISTING_SECRET=\$(read_env "\$ENV_FILE" HIVE_ROUTER_SECRET)
  [[ -n "\$EXISTING_SECRET" ]] || EXISTING_SECRET='${PROD_SECRET}'
  echo ">>> Writing shared/.env..."
  cat > "\$ENV_FILE" <<ENVEOF
NODE_ENV=production
LOG_LEVEL=info

API_HOST=0.0.0.0
ADMIN_HOST=${PROD_ADMIN_HOST}
API_PORT=4020
ADMIN_PORT=${PROD_ADMIN_PORT}
PUBLIC_API_URL=https://${REMOTE_HOST}:4020
PUBLIC_ADMIN_URL=${PROD_PUBLIC_ADMIN_URL}
HIVE_UI_PUBLIC_URL=${PROD_HIVE_UI_PUBLIC_URL}
HIVEMEM_INTERNAL_URL=${PROD_HIVEMEM_INTERNAL_URL}
HIVEMEM_PUBLIC_URL=${PROD_HIVEMEM_PUBLIC_URL}
HIVEMEM_CA_CERT_PATH=${REMOTE_PATH}/shared/certs/hivemem-ca.crt
HIVE_ROUTER_MEMORY_PROXY_TOKEN=${PROD_MEMORY_PROXY_TOKEN}
HIVE_IAM_INTERNAL_URL=${PROD_HIVE_IAM_INTERNAL_URL}
HIVE_IAM_PUBLIC_URL=${PROD_HIVE_IAM_PUBLIC_URL}
HIVE_ROUTER_IAM_ISSUER=${PROD_HIVE_ROUTER_IAM_ISSUER}
HIVE_ROUTER_IAM_AUDIENCE=${PROD_HIVE_ROUTER_IAM_AUDIENCE}
HIVE_STATUS_ALLOW_INSECURE_TLS=${PROD_HIVE_STATUS_ALLOW_INSECURE_TLS}
HIVE_ROUTER_AUTH_MODE=${PROD_AUTH_MODE}
HIVE_ROUTER_IAM_CLIENT_ID=${PROD_IAM_CLIENT_ID}
HIVE_ROUTER_IAM_CLIENT_SECRET=\$ROUTER_IAM_CLIENT_SECRET
HIVE_ROUTER_IAM_REDIRECT_URI=${PROD_IAM_REDIRECT_URI}
HIVE_ROUTER_IAM_SCOPES=${PROD_IAM_SCOPES}
HIVE_ROUTER_IAM_PROXY_SCOPES=${PROD_IAM_PROXY_SCOPES}
HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS=${PROD_HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS}
HIVE_ROUTER_IAM_CA_CERT_PATH=${REMOTE_PATH}/shared/certs/iam-ca.crt
HIVE_ROUTER_IAM_JWKS_REFRESH_MS=${PROD_HIVE_ROUTER_IAM_JWKS_REFRESH_MS}
HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS=${PROD_HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS}

TLS_CERT_PATH=${REMOTE_PATH}/shared/certs/server.crt
TLS_KEY_PATH=${REMOTE_PATH}/shared/certs/server.key
REQUIRE_TLS=true

DATABASE_URL=file:${REMOTE_PATH}/shared/data/router.db
DATA_DIR=${REMOTE_PATH}/shared/data
TRACE_DIR=${REMOTE_PATH}/shared/data/traces

HIVE_ROUTER_SECRET=\$EXISTING_SECRET
HIVE_ROUTER_ADMIN_USERS=${PROD_ADMIN_USERS}
HIVE_ROUTER_OS_AUTH_COMMAND=
HIVE_ROUTER_METRICS_TOKEN=${PROD_METRICS_TOKEN}
HIVE_ROUTER_SECURITY_EXPORT_TOKEN_HASH=${PROD_SECURITY_EXPORT_TOKEN_HASH}
HIVE_ROUTER_SECURITY_EXPORT_STATIC_FALLBACK_ENABLED=${PROD_SECURITY_EXPORT_STATIC_FALLBACK_ENABLED}

SEED_CLIENT_API_KEY=${PROD_CLIENT_KEY}

OTEL_EXPORTER_OTLP_ENDPOINT=
PROMETHEUS_PREFIX=hive_router_

DEFAULT_TRACE_RETENTION_DAYS=7
MAX_REQUEST_BODY_BYTES=67108864
MAX_ADMIN_BODY_BYTES=2097152
MAX_TRACE_BODY_BYTES=1048576
CAPTURE_BINARY_MEDIA=false
CAPTURE_REQUEST_BODIES=false
CAPTURE_RESPONSE_BODIES=false
ENVEOF
  chmod 600 "\$ENV_FILE"
else
  echo ">>> Preserving existing shared/.env"
fi

# The Router's built-in API_PORT default is now 4020. Keep the previous
# built-in default (443) for an env file that never recorded API_PORT.
if [[ -z "\$(read_env "\$ENV_FILE" API_PORT)" ]]; then
  upsert_env "\$ENV_FILE" API_PORT '443'
fi
upsert_env "\$ENV_FILE" API_HOST '0.0.0.0'
upsert_env "\$ENV_FILE" ADMIN_HOST '${PROD_ADMIN_HOST}'
upsert_env "\$ENV_FILE" ADMIN_PORT '${PROD_ADMIN_PORT}'
upsert_env "\$ENV_FILE" PUBLIC_API_URL 'https://${REMOTE_HOST}:4020'
upsert_env "\$ENV_FILE" PUBLIC_ADMIN_URL '${PROD_PUBLIC_ADMIN_URL}'
upsert_env "\$ENV_FILE" HIVE_UI_PUBLIC_URL '${PROD_HIVE_UI_PUBLIC_URL}'
upsert_env "\$ENV_FILE" HIVEMEM_INTERNAL_URL '${PROD_HIVEMEM_INTERNAL_URL}'
upsert_env "\$ENV_FILE" HIVEMEM_PUBLIC_URL '${PROD_HIVEMEM_PUBLIC_URL}'
upsert_env "\$ENV_FILE" HIVEMEM_CA_CERT_PATH '${REMOTE_PATH}/shared/certs/hivemem-ca.crt'
MEMORY_PROXY_TOKEN_VALUE='${PROD_MEMORY_PROXY_TOKEN}'
if [[ -z "\$MEMORY_PROXY_TOKEN_VALUE" ]]; then
  MEMORY_PROXY_TOKEN_VALUE=\$(read_env "\$ENV_FILE" HIVE_ROUTER_MEMORY_PROXY_TOKEN)
fi
if [[ -z "\$MEMORY_PROXY_TOKEN_VALUE" && -f /opt/hivemem/shared/.env && -r /opt/hivemem/shared/.env ]]; then
  MEMORY_PROXY_TOKEN_VALUE=\$(read_env /opt/hivemem/shared/.env HIVEMEM_ADMIN_TOKEN)
  [[ -n "\$MEMORY_PROXY_TOKEN_VALUE" ]] || MEMORY_PROXY_TOKEN_VALUE=\$(read_env /opt/hivemem/shared/.env HERMES_HIVEMEM_TOKEN)
  [[ -n "\$MEMORY_PROXY_TOKEN_VALUE" ]] || MEMORY_PROXY_TOKEN_VALUE=\$(read_env /opt/hivemem/shared/.env HIVEMEM_MCP_TOKEN)
fi
if [[ -z "\$MEMORY_PROXY_TOKEN_VALUE" && -f /opt/hivemem/.env && -r /opt/hivemem/.env ]]; then
  MEMORY_PROXY_TOKEN_VALUE=\$(read_env /opt/hivemem/.env HIVEMEM_ADMIN_TOKEN)
  [[ -n "\$MEMORY_PROXY_TOKEN_VALUE" ]] || MEMORY_PROXY_TOKEN_VALUE=\$(read_env /opt/hivemem/.env HERMES_HIVEMEM_TOKEN)
  [[ -n "\$MEMORY_PROXY_TOKEN_VALUE" ]] || MEMORY_PROXY_TOKEN_VALUE=\$(read_env /opt/hivemem/.env HIVEMEM_MCP_TOKEN)
fi
if [[ -z "\$MEMORY_PROXY_TOKEN_VALUE" ]] && do_sudo test -f /opt/hivemem/shared/.env; then
  MEMORY_PROXY_TOKEN_VALUE=\$(do_sudo grep '^HIVEMEM_ADMIN_TOKEN=' /opt/hivemem/shared/.env | cut -d= -f2- || true)
  [[ -n "\$MEMORY_PROXY_TOKEN_VALUE" ]] || MEMORY_PROXY_TOKEN_VALUE=\$(do_sudo grep '^HERMES_HIVEMEM_TOKEN=' /opt/hivemem/shared/.env | cut -d= -f2- || true)
  [[ -n "\$MEMORY_PROXY_TOKEN_VALUE" ]] || MEMORY_PROXY_TOKEN_VALUE=\$(do_sudo grep '^HIVEMEM_MCP_TOKEN=' /opt/hivemem/shared/.env | cut -d= -f2- || true)
fi
if [[ -z "\$MEMORY_PROXY_TOKEN_VALUE" ]] && do_sudo test -f /opt/hivemem/.env; then
  MEMORY_PROXY_TOKEN_VALUE=\$(do_sudo grep '^HIVEMEM_ADMIN_TOKEN=' /opt/hivemem/.env | cut -d= -f2- || true)
  [[ -n "\$MEMORY_PROXY_TOKEN_VALUE" ]] || MEMORY_PROXY_TOKEN_VALUE=\$(do_sudo grep '^HERMES_HIVEMEM_TOKEN=' /opt/hivemem/.env | cut -d= -f2- || true)
  [[ -n "\$MEMORY_PROXY_TOKEN_VALUE" ]] || MEMORY_PROXY_TOKEN_VALUE=\$(do_sudo grep '^HIVEMEM_MCP_TOKEN=' /opt/hivemem/.env | cut -d= -f2- || true)
fi
if [[ -z "\$MEMORY_PROXY_TOKEN_VALUE" ]]; then
  echo "ERROR: Router Memory proxy requires HIVE_ROUTER_MEMORY_PROXY_TOKEN or a HiveMem token in /opt/hivemem/.env" >&2
  exit 1
fi
upsert_env "\$ENV_FILE" HIVE_ROUTER_MEMORY_PROXY_TOKEN "\$MEMORY_PROXY_TOKEN_VALUE"
upsert_env "\$ENV_FILE" HIVE_IAM_INTERNAL_URL '${PROD_HIVE_IAM_INTERNAL_URL}'
upsert_env "\$ENV_FILE" HIVE_IAM_PUBLIC_URL '${PROD_HIVE_IAM_PUBLIC_URL}'
upsert_env "\$ENV_FILE" HIVE_ROUTER_IAM_ISSUER '${PROD_HIVE_ROUTER_IAM_ISSUER}'
upsert_env "\$ENV_FILE" HIVE_ROUTER_IAM_AUDIENCE '${PROD_HIVE_ROUTER_IAM_AUDIENCE}'
upsert_env "\$ENV_FILE" HIVE_ROUTER_SECURITY_EXPORTER_CLIENT_ID '${PROD_HIVE_ROUTER_SECURITY_EXPORTER_CLIENT_ID}'
upsert_env "\$ENV_FILE" HIVE_STATUS_ALLOW_INSECURE_TLS '${PROD_HIVE_STATUS_ALLOW_INSECURE_TLS}'
upsert_env "\$ENV_FILE" HIVE_ROUTER_AUTH_MODE '${PROD_AUTH_MODE}'
upsert_env "\$ENV_FILE" HIVE_ROUTER_IAM_CLIENT_ID '${PROD_IAM_CLIENT_ID}'
upsert_env "\$ENV_FILE" HIVE_ROUTER_IAM_CLIENT_SECRET "\$ROUTER_IAM_CLIENT_SECRET"
upsert_env "\$ENV_FILE" HIVE_ROUTER_IAM_REDIRECT_URI '${PROD_IAM_REDIRECT_URI}'
upsert_env "\$ENV_FILE" HIVE_ROUTER_IAM_SCOPES '${PROD_IAM_SCOPES}'
upsert_env "\$ENV_FILE" HIVE_ROUTER_IAM_PROXY_SCOPES '${PROD_IAM_PROXY_SCOPES}'
upsert_env "\$ENV_FILE" HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS '${PROD_HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS}'
upsert_env "\$ENV_FILE" HIVE_ROUTER_IAM_CA_CERT_PATH '${REMOTE_PATH}/shared/certs/iam-ca.crt'
upsert_env "\$ENV_FILE" HIVE_ROUTER_IAM_JWKS_REFRESH_MS '${PROD_HIVE_ROUTER_IAM_JWKS_REFRESH_MS}'
upsert_env "\$ENV_FILE" HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS '${PROD_HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS}'
upsert_env "\$ENV_FILE" TLS_CERT_PATH '${REMOTE_PATH}/shared/certs/server.crt'
upsert_env "\$ENV_FILE" TLS_KEY_PATH '${REMOTE_PATH}/shared/certs/server.key'
upsert_env "\$ENV_FILE" REQUIRE_TLS 'true'
upsert_env "\$ENV_FILE" DATABASE_URL 'file:${REMOTE_PATH}/shared/data/router.db'
upsert_env "\$ENV_FILE" DATA_DIR '${REMOTE_PATH}/shared/data'
upsert_env "\$ENV_FILE" TRACE_DIR '${REMOTE_PATH}/shared/data/traces'
# Keep an existing allowlist unless one is passed explicitly.
if [[ '${PROD_ADMIN_USERS_EXPLICIT}' == 'true' ]]; then
  upsert_env "\$ENV_FILE" HIVE_ROUTER_ADMIN_USERS '${PROD_ADMIN_USERS}'
fi
upsert_env "\$ENV_FILE" HIVE_ROUTER_OS_AUTH_COMMAND ''
METRICS_TOKEN_VALUE='${PROD_METRICS_TOKEN}'
if [[ -z "\$METRICS_TOKEN_VALUE" ]]; then
  METRICS_TOKEN_VALUE=\$(read_env "\$ENV_FILE" HIVE_ROUTER_METRICS_TOKEN)
fi
upsert_env "\$ENV_FILE" HIVE_ROUTER_METRICS_TOKEN "\$METRICS_TOKEN_VALUE"
if [[ -n '${PROD_SECURITY_EXPORT_TOKEN_HASH}' ]]; then
  upsert_env "\$ENV_FILE" HIVE_ROUTER_SECURITY_EXPORT_TOKEN_HASH '${PROD_SECURITY_EXPORT_TOKEN_HASH}'
fi
upsert_env "\$ENV_FILE" HIVE_ROUTER_SECURITY_EXPORT_STATIC_FALLBACK_ENABLED '${PROD_SECURITY_EXPORT_STATIC_FALLBACK_ENABLED}'
# Retire the unused internal-password knobs. Admin authentication is PAM or
# IAM OIDC, and retaining these names falsely implies a password backdoor.
sed -i '/^ADMIN_USERNAME=/d; /^ADMIN_PASSWORD=/d' "\$ENV_FILE"
upsert_env "\$ENV_FILE" MAX_REQUEST_BODY_BYTES '67108864'
upsert_env "\$ENV_FILE" MAX_ADMIN_BODY_BYTES '2097152'
upsert_env "\$ENV_FILE" MAX_TRACE_BODY_BYTES '1048576'
upsert_env "\$ENV_FILE" CAPTURE_BINARY_MEDIA 'false'
upsert_env "\$ENV_FILE" CAPTURE_REQUEST_BODIES 'false'
upsert_env "\$ENV_FILE" CAPTURE_RESPONSE_BODIES 'false'

cd "\$RELEASE_DIR"

echo ">>> Installing dependencies..."
npm ci

if ! command -v pamtester >/dev/null 2>&1; then
  echo ">>> Installing pamtester for Ubuntu PAM-backed admin auth..."
  do_sudo apt-get update
  do_sudo apt-get install -y pamtester
fi

echo ">>> Rebuilding on target..."
npm run build

echo ">>> Pruning dev and peer-only tooling from runtime install..."
npm prune --omit=dev --omit=peer
npm audit --omit=dev --audit-level=high

echo ">>> Writing systemd service..."
do_sudo bash -c "cat > /etc/systemd/system/${SERVICE_NAME}.service << 'SVCEOF'
[Unit]
Description=Hive Router
After=network.target

[Service]
Type=simple
WorkingDirectory=${REMOTE_PATH}/current
EnvironmentFile=${REMOTE_PATH}/shared/.env
ExecStart=/usr/bin/env node ${REMOTE_PATH}/current/dist/src/index.js
Restart=always
RestartSec=5
User=\$USER
Group=\$USER
UMask=0077
# PAM-backed OS login needs the standard PAM helper path, including setuid
# helpers such as unix_chkpwd. Keep the rest of the sandbox below intact.
NoNewPrivileges=false
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectClock=true
ProtectHostname=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
RestrictSUIDSGID=false
RestrictRealtime=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
SystemCallArchitectures=native
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE
ReadWritePaths=${REMOTE_PATH}/shared
TimeoutStopSec=20
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
SVCEOF"

PREVIOUS_RELEASE=\$(release_manager_current_id "\$BASE")
echo ">>> Activating release \$RELEASE_ID (previous: \${PREVIOUS_RELEASE:-none})"
release_manager_activate "\$BASE" "\$RELEASE_ID"
INSTALLED_REVISION=\$(cat "\$BASE/current/REVISION")
if [[ "\$INSTALLED_REVISION" != '${SOURCE_REVISION}' ]]; then
  echo "ERROR: installed Router revision differs" >&2
  if [[ -n "\$PREVIOUS_RELEASE" && "\$PREVIOUS_RELEASE" != "\$RELEASE_ID" ]]; then
    release_manager_activate "\$BASE" "\$PREVIOUS_RELEASE"
  fi
  exit 1
fi

do_sudo systemctl daemon-reload
do_sudo systemctl enable ${SERVICE_NAME}.service
do_sudo systemctl restart ${SERVICE_NAME}.service

echo ">>> Waiting for admin health..."
HEALTHY=false
for _ in \$(seq 1 30); do
  if curl --fail --silent --show-error \
    --resolve '${PROD_CERT_DOMAIN}:${PROD_ADMIN_PORT}:127.0.0.1' \
    'https://${PROD_CERT_DOMAIN}:${PROD_ADMIN_PORT}/health/ready' >/dev/null; then
    HEALTHY=true
    break
  fi
  sleep 1
done

if [[ "\$HEALTHY" != "true" ]]; then
  echo "ERROR: release \$RELEASE_ID failed to become healthy" >&2
  if [[ -n "\$PREVIOUS_RELEASE" && "\$PREVIOUS_RELEASE" != "\$RELEASE_ID" ]]; then
    echo ">>> Auto-rolling back to \$PREVIOUS_RELEASE" >&2
    release_manager_activate "\$BASE" "\$PREVIOUS_RELEASE"
    do_sudo systemctl restart ${SERVICE_NAME}.service
    echo ">>> Rolled back to \$PREVIOUS_RELEASE" >&2
  fi
  systemctl --no-pager --lines=30 status ${SERVICE_NAME}.service || true
  exit 1
fi

echo ">>> Pruning old releases (keeping ${KEEP_RELEASES})..."
release_manager_prune "\$BASE" ${KEEP_RELEASES} || true

# Remove any legacy top-level files left after migrating to the release layout.
for entry in "\$BASE"/* "\$BASE"/.[!.]*; do
  [[ -e "\$entry" ]] || continue
  name=\$(basename "\$entry")
  case "\$name" in
    shared|releases|current) continue ;;
    *) rm -rf "\$entry" ;;
  esac
done

curl --fail --silent --show-error \
  --resolve '${PROD_CERT_DOMAIN}:${PROD_ADMIN_PORT}:127.0.0.1' \
  'https://${PROD_CERT_DOMAIN}:${PROD_ADMIN_PORT}/health/ready'
echo
curl --fail --silent --show-error \
  --resolve '${PROD_CERT_DOMAIN}:4020:127.0.0.1' \
  'https://${PROD_CERT_DOMAIN}:4020/health/ready'
echo
systemctl --no-pager --lines=20 status ${SERVICE_NAME}.service
printf '{"releaseId":"%s","revision":"%s","installedRevision":"%s","artifactSha256":"%s","previousReleaseId":"%s","backup":"%s","health":"passed","functionalFlows":["router-admin-and-api-readiness"],"status":"deployed"}\n' "\$RELEASE_ID" '${SOURCE_REVISION}' "\$INSTALLED_REVISION" '${ARTIFACT_SHA256}' "\$PREVIOUS_RELEASE" "\$BASE/releases/\$PREVIOUS_RELEASE"
DEPLOY_SCRIPT

ok "hive-router deployed to $REMOTE_HOST (${REMOTE_PATH}, release-based)"
