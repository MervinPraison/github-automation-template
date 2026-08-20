# github-automation-template

Central **hub** for GitHub automation stacks. Target repos install **thin caller workflows** (~7 files + `gate-config.js`) that reference reusable workflows in this repo — the closest GitHub equivalent to GitLab `include:`.

**Current version:** `v1.1.0` (hub mode, default)  
**Repo:** https://github.com/MervinPraison/github-automation-template (private)

> **For agents and step-by-step rollout:** see [AGENTS.md](AGENTS.md)

---

## Why hub mode (not copy-paste)

| Approach | Files per target repo | Logic updates |
|----------|----------------------|---------------|
| **Hub mode** (default) | 7 thin callers + `gate-config.js` | Bump `@v1.x.x` tag in hub; re-run `install.sh --update` |
| Copy mode (legacy) | ~15 workflows/scripts/actions | Re-run `install.sh --mode copy --update` |

GitHub cannot run workflows from another repo without an explicit `uses:` reference. Hub mode keeps **triggers local** (required by GitHub) and **logic central** (like GitLab `include: project:`).

### GitLab vs GitHub

| GitLab | This hub |
|--------|----------|
| `include: project: 'org/pipeline' file: '/claude.yml'` | `uses: MervinPraison/github-automation-template/.github/workflows/foo-callable.yml@v1.1.0` |
| Shared variables in CI settings | `.github/scripts/gate-config.js` per repo |
| Pipeline triggers in consumer repo | Thin caller workflows in consumer `.github/workflows/` |
| Bump `ref:` on include | Bump `@v1.1.0` in callers or `install.sh --update` |

### What must stay in each target repo

- Workflow **triggers** (`on: issue_comment`, `workflow_run`, `schedule`, …)
- **`gate-config.js`** — paths, CI workflow names, review rules
- **Secrets** — `CLAUDE_*`, `GH_TOKEN` (per repo)
- **Product CI** — your `test-core.yml` / `ci.yml` (not part of this template)
- **GitHub App installs** — Claude App, CodeRabbit, Greptile on that repo

### What lives in the hub (referenced, not copied)

- `merge-gate.js`, `pipeline-status.js`, `pr-review-chain.js`, …
- Callable workflows (`*-callable.yml`)
- `claude-code-action` composite action
- `sync-claude-secrets.yml` (runs from hub repo only)

---

## Architecture

```
github-automation-template/              ← hub (this repo)
├── .github/
│   ├── workflows/*-callable.yml         ← reusable workflow_call jobs
│   ├── scripts/                         ← shared JS orchestrators
│   └── actions/hub-setup/               ← checks out hub + sets HUB_SCRIPTS
├── stacks/claude/
│   ├── callers/*.yml.tmpl               ← thin triggers for install.sh
│   ├── profiles/{sdk,tools,docs}/       ← gate-config templates
│   └── VERSION                          ← hub tag (e.g. 1.1.0 → v1.1.0)
├── install.sh
└── validate.sh

target-repo/
├── .github/
│   ├── workflows/                       ← 7 thin callers installed by install.sh
│   │   ├── claude.yml
│   │   ├── claude-merge-gate.yml
│   │   ├── auto-pr-comment.yml
│   │   ├── ci-failure-claude.yml
│   │   ├── merge-conflict-claude.yml
│   │   ├── pipeline-status-sync.yml
│   │   └── bot-pr-recovery.yml
│   ├── scripts/gate-config.js           ← per-repo configuration
│   └── automation.meta.json             ← mode, hubRef, version
└── AGENTS.md                            ← repo architecture (recommended)
```

### Pipeline (claude stack)

```
Issue → claude.yml → PR → CodeRabbit/Greptile → FINAL @claude → merge gate → auto-merge
         ↑                              ↑
   ci-failure-claude              merge-conflict-claude
         ↑
   pipeline-status-sync (labels + repository_dispatch)
```

---

## Quick start — add to any repo

```bash
git clone https://github.com/MervinPraison/github-automation-template.git
cd github-automation-template

# Example: SDK monorepo (PraisonAI-style)
CI_WORKFLOW_NAME="Core Tests" \
CI_FAILURE_WORKFLOW_NAME="Optimized Test Suite" \
CI_WORKFLOW_FILE="test-core.yml" \
CLAUDE_WORKFLOW_NAME="Claude Assistant" \
SDK_PATH_PREFIX_1="src/praisonai-agents/" \
SDK_PATH_PREFIX_2="src/praisonai/" \
TEST_COMMAND="cd src/praisonai-agents && PYTHONPATH=. python -m pytest tests/ -x -q --timeout=30" \
GIT_USER="YourGitHubUsername" \
GIT_EMAIL="you@users.noreply.github.com" \
./install.sh --stack claude --profile sdk --repo MervinPraison/MyRepo --mode hub
```

Then:

1. Edit `MyRepo/.github/scripts/gate-config.js`
2. Sync secrets (below)
3. Install GitHub Apps on the target repo
4. Run `./validate.sh --target /path/to/MyRepo`
5. Open a test issue with label `claude` and verify end-to-end

Full checklist: [AGENTS.md](AGENTS.md)

---

## Hub setup (one-time)

1. **Repo exists:** `MervinPraison/github-automation-template` (private)
2. **Reusable workflow access:** Settings → Actions → General → Access → *Accessible from repositories owned by the user* (or org, if applicable)
3. **Releases:** tag `vX.Y.Z` matching `stacks/claude/VERSION`
4. **Secrets in hub repo** (for sync workflow): `SECRETS_ADMIN_PAT`, plus source copies of `CLAUDE_*`, `GH_TOKEN`

### Sync secrets to a target repo

```bash
gh workflow run sync-claude-secrets.yml \
  --repo MervinPraison/github-automation-template \
  -f target_repo=MervinPraison/MyRepo
```

---

## Install modes

| Mode | Flag | Installs |
|------|------|----------|
| **Hub** (default) | `--mode hub` | 7 thin callers + `gate-config.js` + `automation.meta.json` |
| **Copy** (legacy) | `--mode copy` | Full `.github/` tree (~15 files) |

```bash
# Upgrade thin callers (preserves gate-config.js)
./install.sh --stack claude --profile sdk --repo owner/name --update

# Dry run
./install.sh --stack claude --profile tools --repo owner/name --dry-run
```

### Install environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CI_WORKFLOW_NAME` | `Core Tests` | Must match `name:` in your CI workflow YAML |
| `CLAUDE_WORKFLOW_NAME` | `Claude Assistant` | Must match `name:` in installed `claude.yml` |
| `CI_FAILURE_WORKFLOW_NAME` | `Optimized Test Suite` | Secondary CI for failure bot |
| `CI_WORKFLOW_FILE` | `test-core.yml` | Reference only (gate-config) |
| `SDK_PATH_PREFIX_1` / `_2` | `src/`, `lib/` | Product code paths for merge gate |
| `TEST_COMMAND` | `pytest tests/ -q` | Embedded in Claude fix prompts |
| `GIT_USER` / `GIT_EMAIL` | repo owner | Git identity for Claude commits |
| `DOCS_URL` | `https://docs.praison.ai` | Links in issue triage |
| `PRODUCT_NAME` | repo name | Prompt scope text |
| `PYPI_PACKAGE_NAME` | repo name | Release/gate references |

---

## Profiles

| Profile | Use for | CI defaults |
|---------|---------|-------------|
| `sdk` | Python SDK monorepos | `Core Tests`, full merge gate |
| `tools` | Agent-callable tools repos | `CI`, no agent.py checks |
| `docs` | Documentation sites | Custom CI, lighter gate |

Profiles without workflow templates fall back to `sdk` caller templates; differences are mainly in `gate-config.js`.

---

## Callable workflows (hub)

| Hub callable | Thin caller in target repo |
|--------------|---------------------------|
| `claude-assistant-callable.yml` | `claude.yml` |
| `review-chain-callable.yml` | `auto-pr-comment.yml` |
| `claude-merge-gate-callable.yml` | `claude-merge-gate.yml` (+ inline auto-dispatch) |
| `ci-failure-claude-callable.yml` | `ci-failure-claude.yml` |
| `pipeline-status-sync-callable.yml` | `pipeline-status-sync.yml` |
| `bot-pr-recovery-callable.yml` | `bot-pr-recovery.yml` |
| *(inline script)* | `merge-conflict-claude.yml` |

Example thin caller reference:

```yaml
jobs:
  claude:
    uses: MervinPraison/github-automation-template/.github/workflows/claude-assistant-callable.yml@v1.1.0
    secrets: inherit
    with:
      hub_ref: v1.1.0
```

---

## Required secrets (each target repo)

| Secret | Purpose |
|--------|---------|
| `CLAUDE_APP_ID` | GitHub App for Claude execution |
| `CLAUDE_APP_PRIVATE_KEY` | App private key |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code OAuth |
| `GH_TOKEN` | PAT as maintainer — chains `@claude` between workflows (`GITHUB_TOKEN` alone cannot) |

---

## Required GitHub Apps (each target repo)

| App | Required? | Notes |
|-----|-----------|-------|
| Claude GitHub App | Yes | Same app ID/key as other Praison repos |
| CodeRabbit | Yes | Review chain kicks `@coderabbitai review` |
| Greptile | Yes | Passive — no kick step; chain waits up to 30m if missing |
| Qodo | Optional | Kicked via `/review` |
| Gemini Code Assist | Optional | Detected in review chain |

---

## Per-repo configuration

After install, edit **`.github/scripts/gate-config.js`**. Key fields:

| Field | Must match |
|-------|------------|
| `ciWorkflowName` | `name:` field in your CI workflow file |
| `claudeWorkflowName` | `name:` in `claude.yml` (default `Claude Assistant`) |
| `mergeGateWorkflowRuns` | Names in `claude-merge-gate.yml` `workflow_run` filter |
| `productPathPrefixes` | Directories that count as product code |
| `triggerLogins` | GitHub users allowed to post chain-trigger comments |
| `testCommand` | Command Claude runs after fixes |

**`.github/automation.meta.json`** records `mode`, `hubRef`, `profile`, `templateVersion`.

---

## Validate

```bash
./validate.sh                              # hub script selftests
./validate.sh --target /path/to/MyRepo   # after install
```

---

## Upgrade hub version

1. Hub maintainer bumps `stacks/claude/VERSION` and tags `vX.Y.Z`
2. Target repos:

```bash
./install.sh --stack claude --profile sdk --repo owner/name --update
```

Or manually change `@v1.1.0` → `@v1.2.0` in thin caller `uses:` lines.

---

## Development

```bash
./validate.sh
git tag v1.1.0 && git push origin v1.1.0
```

Future stacks (release gates, security bots) add under `stacks/<name>/` without renaming this repo.
