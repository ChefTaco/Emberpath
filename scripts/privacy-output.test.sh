#!/usr/bin/env bash
# Regression test: scripts/check-private-data.sh and scripts/scan-secrets.sh report a
# finding as path, line number and rule only. Planted fake terms and secrets, and the
# text around them, must never appear in their output (CI logs are public).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
problem() {
  echo "FAIL: $1" >&2
  failures=$((failures + 1))
}
# Runs a command, storing its combined output in $WORK/out and its exit status in $status.
run() {
  status=0
  "$@" > "$WORK/out" 2>&1 || status=$?
}
expect_status() {
  [[ "$status" -eq "$1" ]] || problem "$2: exit status $status, expected $1"
}
expect_in_output() {
  grep -qF -- "$1" "$WORK/out" || problem "$2: output lacks \"$1\""
}
# The needles are fixed fragments of the planted values; the output is never printed.
expect_nothing_leaked() {
  if grep -qiF -e planted -e surrounding-context "$WORK/out"; then
    problem "$1: output contains planted text"
  fi
}

# Fake values are assembled at run time so this file never contains them literally.
TERM_VALUE="zq$(printf 'x%.0s' 1 2 3)planted$((40 + 2))"
CONTEXT="surrounding-context-$((6 * 7))"

new_repo() {
  rm -rf "$WORK/repo"
  mkdir -p "$WORK/repo/scripts"
  cp "$ROOT_DIR/scripts/$1" "$WORK/repo/scripts/"
  git -C "$WORK/repo" init -q
}

# --- check-private-data.sh ---------------------------------------------------------
new_repo check-private-data.sh
cd "$WORK/repo"
printf '%s\n' '.private-terms' > .gitignore
printf '%s\n' '# fake denylist' 'zqx+planted[0-9]+' > .private-terms
printf 'first line\nhost %s %s\n' "$TERM_VALUE" "$CONTEXT" > notes.txt
printf 'clean\n' > "docs-$TERM_VALUE.txt"
git add -A

run bash scripts/check-private-data.sh
expect_status 1 "tracked check"
expect_in_output "notes.txt:2: private term" "tracked check"
expect_in_output "(path redacted): private term in file name" "tracked check"
expect_nothing_leaked "tracked check"

run bash scripts/check-private-data.sh --staged
expect_status 1 "staged check"
expect_in_output "notes.txt:2: private term" "staged check"
expect_nothing_leaked "staged check"

printf 'fix: update %s\n\nnear %s\n' "$TERM_VALUE" "$CONTEXT" > "$WORK/message"
run bash scripts/check-private-data.sh --message "$WORK/message"
expect_status 1 "message check"
expect_nothing_leaked "message check"

git rm -q --cached -- notes.txt "docs-$TERM_VALUE.txt"
rm -f -- notes.txt "docs-$TERM_VALUE.txt"
run bash scripts/check-private-data.sh
expect_status 0 "clean tracked check"
run bash scripts/check-private-data.sh --unknown-flag
expect_status 2 "usage error"
cd "$ROOT_DIR"

# --- scan-secrets.sh (not every repository has it) ---------------------------------
if [[ -f "$ROOT_DIR/scripts/scan-secrets.sh" ]]; then
  new_repo scan-secrets.sh
  cd "$WORK/repo"
  name="DEPLOY_PASS""WORD"
  value="Zq9$(printf 'Planted%.0s' 1 2)Value"
  {
    printf '%s=%s # %s\n' "$name" "$value" "$CONTEXT"
    printf 'token %s %s\n' "sk-$(printf 'Planted%.0s' 1 2 3 4)" "$CONTEXT"
    printf '%s\n%s\n' "-----BEGIN ""PRIVATE KEY-----" "planted-body-$CONTEXT"
  } > settings.txt
  git add -A

  run bash scripts/scan-secrets.sh
  expect_status 1 "secret scan"
  expect_in_output "settings.txt:1: DEPLOY_PASSWORD assignment" "secret scan"
  expect_in_output "settings.txt:2: API key" "secret scan"
  expect_in_output "settings.txt:3: private key" "secret scan"
  expect_nothing_leaked "secret scan"

  git rm -q --cached -- settings.txt
  rm -f -- settings.txt
  run bash scripts/scan-secrets.sh
  expect_status 0 "clean secret scan"
  cd "$ROOT_DIR"
fi

if [[ "$failures" -gt 0 ]]; then
  echo "privacy output test failed with $failures problem(s)." >&2
  exit 1
fi
echo "Privacy output test passed."
