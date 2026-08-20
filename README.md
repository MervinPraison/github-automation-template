# github-automation-template

Central **hub** for GitHub automation. Target repos install **thin caller workflows** (~7 files + `gate-config.js`) that reference reusable workflows in this repo — similar to GitLab `include:`.

**v1.1.0 — hub mode (default).** v1.0.0 copy mode still available via `--mode copy`.

## Architecture

```
github-automation-template/          ← hub (this repo)
├── .github/workflows/*-callable.yml  ← reusable workflow_call jobs
├── .github/scripts/                  ← merge-gate.js, pipeline-status.js, …
└── stacks/claude/callers/*.tmpl      ← thin triggers installed per target repo

target-repo/
├── .github/workflows/                ← 7 thin callers (~15 lines each)
│   ├── claude.yml                    → uses claude-assistant-callable.yml@v1.1.0
│   ├── claude-merge-gate.yml         → auto-dispatch + merge-gate-callable
│   └── …
└── .github/scripts/gate-config.js    ← per-repo paths, CI names, prompts
```

## Quick start (hub mode)

```bash
git clone https://github.com/MervinPraison/github-automation-template.git
cd github-automation-template

CI_WORKFLOW_NAME="Core Tests" \
SDK_PATH_PREFIX_1="src/praisonai-agents/" \
SDK_PATH_PREFIX_2="src/praisonai/" \
./install.sh --stack claude --profile sdk --repo MervinPraison/MyRepo --mode hub
```

Target repo gets **7 thin workflow files + gate-config.js** — not ~15 copied scripts/workflows.

## Hub setup (one-time, org admin)

1. Create private repo `MervinPraison/github-automation-template`
2. **Settings → Actions → General → Access** → allow reusable workflows for org repos
3. Tag releases: `git tag v1.1.0 && git push origin v1.1.0`
4. Sync secrets to target repos:

```bash
gh workflow run sync-claude-secrets.yml \
  --repo MervinPraison/github-automation-template \
  -f target_repo=MervinPraison/MyRepo
```

## Install modes

| Mode | Command | Files per target repo |
|------|---------|----------------------|
| **hub** (default) | `--mode hub` | 7 thin callers + gate-config.js |
| **copy** (legacy) | `--mode copy` | Full `.github/` copy (~15 files) |

```bash
# Upgrade thin callers (preserves gate-config.js)
./install.sh --stack claude --profile sdk --repo MervinPraison/MyRepo --update

# Legacy full copy
./install.sh --stack claude --profile sdk --repo MervinPraison/MyRepo --mode copy
```

## Callable workflows (hub)

| Callable | Thin caller |
|----------|-------------|
| `claude-assistant-callable.yml` | `claude.yml` |
| `review-chain-callable.yml` | `auto-pr-comment.yml` |
| `claude-merge-gate-callable.yml` | `claude-merge-gate.yml` (+ inline auto-dispatch) |
| `ci-failure-claude-callable.yml` | `ci-failure-claude.yml` |
| `merge-conflict-claude.yml` | inline in caller (small) |
| `pipeline-status-sync-callable.yml` | `pipeline-status-sync.yml` |
| `bot-pr-recovery-callable.yml` | `bot-pr-recovery.yml` |

## Per-repo config

Edit `.github/scripts/gate-config.js` after install — see v1.0 README fields (`ciWorkflowName`, `productPathPrefixes`, `triggerLogins`, etc.).

`.github/automation.meta.json` records `mode`, `hubRef`, `templateVersion`.

## Validate

```bash
./validate.sh                    # hub scripts selftests
./validate.sh --target /path/to/MyRepo
```

## Profiles

| Profile | Use for |
|---------|---------|
| `sdk` | Python SDK monorepos (PraisonAI-style) |
| `tools` | Agent-callable tools repos |
| `docs` | Documentation sites (lighter gate-config) |

## GitLab include comparison

| GitLab | GitHub hub model |
|--------|------------------|
| `include: project: 'org/pipeline'` | `uses: org/github-automation-template/.github/workflows/foo-callable.yml@v1.1.0` |
| Per-repo variables | `gate-config.js` |
| Triggers in consumer `.gitlab-ci.yml` | Thin caller workflows (must stay local) |

## Required secrets (each target repo)

| Secret | Purpose |
|--------|---------|
| `CLAUDE_APP_ID` / `CLAUDE_APP_PRIVATE_KEY` | GitHub App token |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code OAuth |
| `GH_TOKEN` | PAT for `@claude` workflow chaining |

## Development

Bump `stacks/claude/VERSION` and tag `vX.Y.Z` when hub callables change. Target repos upgrade via `hubRef` in `install.sh --update` or manual tag bump in caller `uses:` lines.
