#!/usr/bin/env bash
# Validate hub scripts or an installed target repo.
# Usage: ./validate.sh [--stack claude] [--target /path/to/repo]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK="claude"
TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack) STACK="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    -h|--help) echo "Usage: $0 [--stack claude] [--target /path/to/repo]"; exit 0 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

if [[ -n "$TARGET" ]]; then
  SCRIPTS="$TARGET/.github/scripts"
  WORKFLOWS="$TARGET/.github/workflows"
else
  if [[ -d "$ROOT/.github/scripts" ]]; then
    SCRIPTS="$ROOT/.github/scripts"
    WORKFLOWS="$ROOT/.github/workflows"
  else
    SCRIPTS="$ROOT/stacks/$STACK/shared/scripts"
    WORKFLOWS="$ROOT/stacks/$STACK/shared/workflows"
  fi
  if [[ ! -f "$SCRIPTS/gate-config.js" ]]; then
    cp "$SCRIPTS/gate-config.example.js" "$SCRIPTS/gate-config.js"
  fi
fi

echo "=== JS selftests ($SCRIPTS) ==="
for selftest in "$SCRIPTS"/*-selftest.js; do
  [[ -f "$selftest" ]] || continue
  echo "Running $(basename "$selftest")..."
  node "$selftest"
done

echo "=== Callable workflow lint (hub) ==="
if [[ -d "$ROOT/.github/workflows" ]]; then
  ls "$ROOT/.github/workflows/"*-callable.yml 2>/dev/null | while read -r f; do
    echo "  $(basename "$f")"
  done
  if command -v actionlint >/dev/null 2>&1; then
    actionlint "$ROOT/.github/workflows/"*.yml
    echo "ok: actionlint"
  else
    echo "skip: actionlint not installed (brew install actionlint)"
  fi
fi

if [[ -z "$TARGET" && -d "$ROOT/.github/scripts" && -d "$ROOT/stacks/$STACK/shared/scripts" ]]; then
  echo "=== Hub vs copy-mode drift check ==="
  # install.sh --mode copy ships stacks/<stack>/shared; it must match what hub
  # callers run from .github (a fix landing in one copy only is a silent gap).
  DRIFT=0
  for f in "$ROOT/.github/scripts/"*.js "$ROOT/.github/scripts/"*.sh; do
    base="$(basename "$f")"
    [[ "$base" == "gate-config.js" ]] && continue
    if ! cmp -s "$f" "$ROOT/stacks/$STACK/shared/scripts/$base"; then
      echo "DRIFT: .github/scripts/$base != stacks/$STACK/shared/scripts/$base"
      DRIFT=1
    fi
  done
  for f in "$ROOT/.github/prompts/"*.md; do
    [[ -f "$f" ]] || continue
    if ! cmp -s "$f" "$ROOT/stacks/$STACK/shared/prompts/$(basename "$f")"; then
      echo "DRIFT: .github/prompts/$(basename "$f") != stacks/$STACK/shared/prompts/$(basename "$f")"
      DRIFT=1
    fi
  done
  for a in claude-code-action pick-oauth-token; do
    if ! cmp -s "$ROOT/.github/actions/$a/action.yml" "$ROOT/stacks/$STACK/shared/actions/$a/action.yml"; then
      echo "DRIFT: .github/actions/$a/action.yml != stacks/$STACK/shared/actions/$a/action.yml"
      DRIFT=1
    fi
  done
  [[ "$DRIFT" == 0 ]] && echo "ok: stacks/$STACK/shared matches .github" || exit 1
fi

echo "=== CI workflow name check ==="
if [[ -f "$SCRIPTS/gate-config.js" ]]; then
  CI_NAME=$(node -e "console.log(require('$SCRIPTS/gate-config.js').ciWorkflowName || '')")
  if [[ -n "$TARGET" && -n "$CI_NAME" ]]; then
    if grep -rq "name: $CI_NAME" "$TARGET/.github/workflows/" 2>/dev/null; then
      echo "ok: found workflow name '$CI_NAME'"
    else
      echo "WARN: no workflow named '$CI_NAME' in target"
    fi
  else
    echo "ok: gate-config ciWorkflowName=$CI_NAME"
  fi
fi

echo "validate.sh complete"
