#!/usr/bin/env bash
# Bootstrap github-automation-template stacks into a target repo.
# Usage: ./install.sh --stack claude --profile sdk --repo owner/name [--mode hub|copy] [--update]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK="claude"
PROFILE="sdk"
TARGET_REPO=""
UPDATE=false
DRY_RUN=false
MODE="hub"

usage() {
  sed -n '2,4p' "$0"
  echo "  --stack claude       Stack to install (default: claude)"
  echo "  --profile sdk|docs|tools  Profile within stack (default: sdk)"
  echo "  --repo owner/name    Target GitHub repository"
  echo "  --mode hub|copy      hub=thin callers (default); copy=full .github/ copy"
  echo "  --update             hub: refresh callers; copy: merge shared files"
  echo "  --dry-run            Print actions without writing"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack) STACK="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --repo) TARGET_REPO="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --update) UPDATE=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

[[ -n "$TARGET_REPO" ]] || { echo "Error: --repo owner/name is required"; usage; }

STACK_DIR="$ROOT/stacks/$STACK"
PROFILE_DIR="$STACK_DIR/profiles/$PROFILE"
SHARED_DIR="$STACK_DIR/shared"
CALLERS_DIR="$STACK_DIR/callers"
HUB_REF="v$(cat "$STACK_DIR/VERSION" 2>/dev/null || echo '1.1.0')"

[[ -d "$STACK_DIR" ]] || { echo "Unknown stack: $STACK"; exit 1; }
[[ -d "$PROFILE_DIR" ]] || { echo "Unknown profile: $PROFILE"; exit 1; }

OWNER="${TARGET_REPO%%/*}"
REPO="${TARGET_REPO#*/}"
VERSION="$(cat "$STACK_DIR/VERSION" 2>/dev/null || echo '0.0.0')"

if [[ -d "/Users/praison/$REPO/.git" ]]; then
  TARGET_DIR="/Users/praison/$REPO"
elif [[ -d "$REPO/.git" ]]; then
  TARGET_DIR="$(cd "$REPO" && pwd)"
else
  CLONE_DIR="${TMPDIR:-/tmp}/github-automation-install-$$"
  mkdir -p "$CLONE_DIR"
  if $DRY_RUN; then
    TARGET_DIR="$CLONE_DIR/$REPO"
    mkdir -p "$TARGET_DIR/.github"
  else
    git clone --depth 1 "https://github.com/$TARGET_REPO.git" "$CLONE_DIR/$REPO"
    TARGET_DIR="$CLONE_DIR/$REPO"
  fi
fi

GH="$TARGET_DIR/.github"
mkdir -p "$GH/workflows" "$GH/scripts"

run() {
  if $DRY_RUN; then echo "[dry-run] $*"; else "$@"; fi
}

substitute() {
  local file="$1"
  escape_sed() { printf '%s' "$1" | sed "s/[\\&|]/\\\\&/g; s/'/'\\\\''/g"; }
  sed \
    -e "s|{{OWNER}}|$OWNER|g" \
    -e "s|{{REPO}}|$REPO|g" \
    -e "s|{{HUB_REF}}|$HUB_REF|g" \
    -e "s|{{GIT_USER}}|$(escape_sed "${GIT_USER:-$OWNER}")|g" \
    -e "s|{{GIT_EMAIL}}|$(escape_sed "${GIT_EMAIL:-$OWNER@users.noreply.github.com}")|g" \
    -e "s|{{CI_WORKFLOW_NAME}}|$(escape_sed "${CI_WORKFLOW_NAME:-Core Tests}")|g" \
    -e "s|{{CLAUDE_WORKFLOW_NAME}}|$(escape_sed "${CLAUDE_WORKFLOW_NAME:-Claude Assistant}")|g" \
    -e "s|{{CI_FAILURE_WORKFLOW_NAME}}|$(escape_sed "${CI_FAILURE_WORKFLOW_NAME:-Optimized Test Suite}")|g" \
    -e "s|{{CI_WORKFLOW_FILE}}|$(escape_sed "${CI_WORKFLOW_FILE:-test-core.yml}")|g" \
    -e "s|{{TEST_COMMAND}}|$(escape_sed "${TEST_COMMAND:-pytest tests/ -q}")|g" \
    -e "s|{{DOCS_URL}}|$(escape_sed "${DOCS_URL:-https://docs.praison.ai}")|g" \
    -e "s|{{PYPI_PACKAGE_NAME}}|$(escape_sed "${PYPI_PACKAGE_NAME:-$REPO}")|g" \
    -e "s|{{PRODUCT_NAME}}|$(escape_sed "${PRODUCT_NAME:-$REPO}")|g" \
    -e "s|{{SDK_PATH_PREFIX_1}}|$(escape_sed "${SDK_PATH_PREFIX_1:-src/}")|g" \
    -e "s|{{SDK_PATH_PREFIX_2}}|$(escape_sed "${SDK_PATH_PREFIX_2:-lib/}")|g" \
    "$file"
}

echo "Installing stack=$STACK profile=$PROFILE mode=$MODE → $TARGET_REPO (hub $HUB_REF)"

if [[ "$MODE" == "hub" ]]; then
  for tmpl in "$CALLERS_DIR/"*.yml.tmpl; do
    [[ -f "$tmpl" ]] || continue
    base="$(basename "$tmpl" .tmpl)"
    dest="$GH/workflows/$base"
    if $DRY_RUN; then
      echo "[dry-run] render $tmpl → $dest"
    else
      substitute "$tmpl" > "$dest"
    fi
  done
else
  for wf in "$SHARED_DIR/workflows/"*.yml; do
    [[ -f "$wf" ]] || continue
    [[ "$(basename "$wf")" == "sync-claude-secrets.yml" ]] && continue
    run cp "$wf" "$GH/workflows/"
  done
  WF_PROFILE="$PROFILE_DIR"
  if ! compgen -G "$PROFILE_DIR/*.yml.tmpl" > /dev/null; then
    WF_PROFILE="$STACK_DIR/profiles/sdk"
  fi
  for tmpl in "$WF_PROFILE/"*.yml.tmpl; do
    [[ -f "$tmpl" ]] || continue
    base="$(basename "$tmpl" .tmpl)"
    if $DRY_RUN; then echo "[dry-run] render $tmpl"; else substitute "$tmpl" > "$GH/workflows/$base"; fi
  done
  for js in "$SHARED_DIR/scripts/"*.js; do
    [[ -f "$js" ]] || continue
    base="$(basename "$js")"
    [[ "$base" == "gate-config.example.js" || "$base" == "gate-config.js" ]] && continue
    run cp "$js" "$GH/scripts/$base"
  done
  if [[ -d "$SHARED_DIR/actions" ]]; then
    mkdir -p "$GH/actions"
    run cp -R "$SHARED_DIR/actions/." "$GH/actions/"
  fi
fi

GATE_CONFIG="$GH/scripts/gate-config.js"
if [[ -f "$PROFILE_DIR/gate-config.js.tmpl" ]]; then
  if [[ -f "$GATE_CONFIG" && "$UPDATE" == true ]]; then
    echo "Preserving existing gate-config.js"
  elif $DRY_RUN; then
    echo "[dry-run] render gate-config.js.tmpl"
  else
    substitute "$PROFILE_DIR/gate-config.js.tmpl" > "$GATE_CONFIG"
  fi
fi

if ! $DRY_RUN; then
  cat > "$GH/automation.meta.json" <<EOF
{
  "templateRepo": "MervinPraison/github-automation-template",
  "stack": "$STACK",
  "profile": "$PROFILE",
  "mode": "$MODE",
  "hubRef": "$HUB_REF",
  "templateVersion": "$VERSION",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
fi

echo "Done ($MODE mode)."
if [[ "$MODE" == "hub" ]]; then
  echo "  Hub workflows: MervinPraison/github-automation-template@$HUB_REF"
  echo "  Local files: $(ls "$CALLERS_DIR"/*.yml.tmpl 2>/dev/null | wc -l | tr -d ' ') thin callers + gate-config.js"
else
  echo "  Full copy installed under .github/"
fi
echo "  1. Review $GH/scripts/gate-config.js"
echo "  2. Sync secrets: gh workflow run sync-claude-secrets.yml --repo MervinPraison/github-automation-template -f target_repo=$TARGET_REPO"
echo "  3. Enable org access: github-automation-template → Settings → Actions → access for org repos"
