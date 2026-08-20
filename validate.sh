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
