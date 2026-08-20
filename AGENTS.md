# AGENTS.md — github-automation-template

Guide for humans and AI agents: how to add the **claude** automation stack from this hub to any GitHub repository.

---

## What this repo is

| Item | Value |
|------|-------|
| Hub repo | `MervinPraison/github-automation-template` |
| Current stack | `claude` (issue→PR→review→merge gate) |
| Current version | `v1.1.0` (see `stacks/claude/VERSION`) |
| Default install mode | **hub** — thin callers + central callables |
| Legacy mode | **copy** — full `.github/` copied to target |

This repo is **not** runtime code for your product. It is a **template hub** — target repos reference it via `uses: MervinPraison/github-automation-template/...`.

---

## Decision: hub vs copy

| Choose **hub** when | Choose **copy** when |
|---------------------|----------------------|
| Multiple repos should share one logic source | Target repo cannot call private reusable workflows |
| You want GitLab-style central updates | Air-gapped or forked hub unavailable |
| Org/user reusable workflow access is enabled | Debugging requires all YAML local |

**Default: hub mode.**

---

## Prerequisites (before install)

### Hub repo (once)

- [ ] `MervinPraison/github-automation-template` exists and is tagged (`v1.1.0`)
- [ ] Settings → Actions → General → **Access** → repositories can use reusable workflows
- [ ] Hub secrets for sync: `SECRETS_ADMIN_PAT`, `CLAUDE_APP_ID`, `CLAUDE_APP_PRIVATE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN`

### Target repo (each repo)

- [ ] Default branch is `main` (or update conflict/merge workflows accordingly)
- [ ] A **CI workflow** exists whose `name:` you know (e.g. `Core Tests`, `CI`)
- [ ] `AGENTS.md` or architecture doc at repo root (referenced in prompts)
- [ ] GitHub App installed: Claude automation app
- [ ] Third-party apps: **CodeRabbit** + **Greptile** (minimum for review chain)
- [ ] Secrets will be set: `CLAUDE_APP_ID`, `CLAUDE_APP_PRIVATE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN`

---

## Step-by-step: add template to any repo

### Step 1 — Clone hub and run install

```bash
git clone https://github.com/MervinPraison/github-automation-template.git
cd github-automation-template
```

Pick a **profile**:

| Profile | When |
|---------|------|
| `sdk` | Python SDK / monorepo (PraisonAI-style) |
| `tools` | Standalone tools package |
| `docs` | Documentation site repo |

**SDK example:**

```bash
CI_WORKFLOW_NAME="Core Tests" \
CI_FAILURE_WORKFLOW_NAME="Optimized Test Suite" \
CI_WORKFLOW_FILE="test-core.yml" \
CLAUDE_WORKFLOW_NAME="Claude Assistant" \
SDK_PATH_PREFIX_1="src/praisonai-agents/" \
SDK_PATH_PREFIX_2="src/praisonai/" \
TEST_COMMAND="cd src/praisonai-agents && PYTHONPATH=. python -m pytest tests/ -x -q --timeout=30" \
GIT_USER="MervinPraison" \
GIT_EMAIL="454862+MervinPraison@users.noreply.github.com" \
PRODUCT_NAME="praisonaiagents, praisonai" \
PYPI_PACKAGE_NAME="praisonaiagents" \
./install.sh \
  --stack claude \
  --profile sdk \
  --repo MervinPraison/PraisonAI-Tools \
  --mode hub
```

**Tools example:**

```bash
CI_WORKFLOW_NAME="CI" \
CI_WORKFLOW_FILE="ci.yml" \
SDK_PATH_PREFIX_1="praisonai_tools/" \
TEST_COMMAND="pytest tests/ -q" \
./install.sh --stack claude --profile tools --repo MervinPraison/PraisonAI-Tools --mode hub
```

**Docs / minimal example:**

```bash
CI_WORKFLOW_NAME="CI" \
SDK_PATH_PREFIX_1="docs/" \
TEST_COMMAND="npm run build" \
./install.sh --stack claude --profile docs --repo MervinPraison/PraisonAIDocs --mode hub
```

If the repo is cloned locally under `/Users/praison/<RepoName>/`, `install.sh` writes there automatically. Otherwise it clones to a temp directory.

### Step 2 — Review generated files

After install, the target repo contains:

```
.github/
├── workflows/
│   ├── claude.yml                 # → hub claude-assistant-callable
│   ├── claude-merge-gate.yml      # → hub merge-gate-callable + auto-dispatch
│   ├── auto-pr-comment.yml        # → hub review-chain-callable
│   ├── ci-failure-claude.yml      # → hub ci-failure-callable
│   ├── merge-conflict-claude.yml  # inline + hub scripts
│   ├── pipeline-status-sync.yml   # → hub pipeline-status-callable
│   └── bot-pr-recovery.yml        # → hub bot-recovery-callable
├── scripts/
│   └── gate-config.js             # EDIT THIS
└── automation.meta.json           # install metadata
```

Commit these files to the target repo default branch.

### Step 3 — Customise gate-config.js

Open `.github/scripts/gate-config.js` and verify:

```javascript
module.exports = {
  repoFullName: 'MervinPraison/YourRepo',     // owner/name
  ciWorkflowName: 'Core Tests',                 // MUST match CI workflow name: field
  claudeWorkflowName: 'Claude Assistant',       // MUST match claude.yml name: field
  mergeGateWorkflowRuns: ['Claude Assistant', 'Core Tests'],
  ciFailureWorkflowRuns: ['Core Tests', 'Optimized Test Suite'],
  productPathPrefixes: ['src/your-sdk/'],       // paths for merge gate
  triggerLogins: ['YourUsername', 'github-actions[bot]'],
  testCommand: 'pytest tests/ -q',
  agentPyChecks: false,                         // true only for SDK agent.py repos
  // …
};
```

**Critical:** `ciWorkflowName` must exactly match the `name:` at the top of your CI workflow YAML. Mismatch causes silent no-ops on `workflow_run` triggers.

Verify:

```bash
grep -r "^name:" .github/workflows/   # in target repo
```

### Step 4 — Sync secrets

From any machine with `gh` CLI:

```bash
gh workflow run sync-claude-secrets.yml \
  --repo MervinPraison/github-automation-template \
  -f target_repo=MervinPraison/YourRepo
```

Or set manually in target repo → Settings → Secrets:

| Secret | Description |
|--------|-------------|
| `CLAUDE_APP_ID` | GitHub App ID |
| `CLAUDE_APP_PRIVATE_KEY` | PEM private key |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code OAuth token |
| `GH_TOKEN` | Personal access token (maintainer account) for `@claude` chaining |

### Step 5 — Enable GitHub Apps on target repo

Install on the **target repo** (not just the hub):

1. Claude automation GitHub App
2. CodeRabbit
3. Greptile

Without Greptile, the review chain waits up to 30 minutes per PR.

### Step 6 — Validate

```bash
cd /path/to/github-automation-template
./validate.sh --target /path/to/YourRepo
```

Fix any `WARN: no workflow named 'X'` by aligning `gate-config.js` or CI workflow `name:`.

### Step 7 — Smoke test on GitHub

1. Open a test issue; add label `claude` or comment `@claude`
2. Confirm `Claude Assistant` workflow runs and opens a PR
3. Confirm CodeRabbit/Greptile comment; then FINAL `@claude` review posts
4. Manually dispatch **Claude PR Merge Gate** on a ready PR
5. Check `pipeline/*` labels appear after ~10 minutes (pipeline-status-sync schedule)

---

## gate-config.js field reference

| Field | Type | Purpose |
|-------|------|---------|
| `repoFullName` | string | `owner/repo` for prompts and fork detection |
| `gitUser` | string | Git commit author for Claude fixes |
| `gitEmail` | string | Git commit email |
| `triggerLogins` | string[] | Users/bots allowed to trigger review chain |
| `allowedTriageBots` | string[] | Bots allowed to auto-label issues `claude` |
| `productPathPrefixes` | string[] | Directories counted as product code |
| `sensitivePathPatterns` | RegExp[] | Paths requiring manual merge review |
| `requiredCheckPatterns` | RegExp[] | CI check name patterns for merge gate |
| `optionalCancelledChecks` | string[] | Cancelled checks that do not block merge |
| `optionalCancelledWhenCoreGreen` | string[] | Cancelled smoke/windows OK if core green |
| `ciWorkflowFile` | string | Filename reference (documentation) |
| `ciWorkflowName` | string | **Must match** CI workflow `name:` |
| `claudeWorkflowName` | string | **Must match** `claude.yml` `name:` |
| `mergeGateWorkflowRuns` | string[] | Workflows that trigger merge gate dispatch |
| `ciFailureWorkflowRuns` | string[] | Workflows that trigger CI failure bot |
| `testCommand` | string | Test command in Claude fix prompts |
| `docsUrl` | string | Documentation URL in triage comments |
| `architectureDoc` | string | Architecture file Claude reads (usually `AGENTS.md`) |
| `pypiPackageName` | string | Package name for release-related gates |
| `packagePaths` | string[] | Paths watched for package changes |
| `finalClaudeScope` | string | FINAL review scope prompt |
| `finalClaudeProductValue` | string | FINAL review product-value rules |
| `mergeGateProductValue` | string | Merge gate product-value check |
| `mergeGateLayering` | string | Merge gate repo-layer rules |
| `agentPyChecks` | boolean | Enforce agent.py size/param limits |
| `agentPyPathSuffix` | string | Path suffix for agent.py checks |
| `reviewBotLogins` | string[] | Known review bot logins |
| `externalRepos` | string[] | Optional routing targets in prompts |

---

## automation.meta.json

Written by `install.sh`:

```json
{
  "templateRepo": "MervinPraison/github-automation-template",
  "stack": "claude",
  "profile": "sdk",
  "mode": "hub",
  "hubRef": "v1.1.0",
  "templateVersion": "1.1.0",
  "installedAt": "2026-08-20T08:00:00Z"
}
```

Use `hubRef` to know which tag target callers reference.

---

## Upgrade procedure

When hub releases `v1.2.0`:

```bash
cd github-automation-template
git pull
./install.sh --stack claude --profile sdk --repo MervinPraison/YourRepo --update
```

`--update` refreshes thin callers; **preserves** existing `gate-config.js`.

Review the diff, commit, push to target repo default branch.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Merge gate never runs | `ciWorkflowName` mismatch | Align `gate-config.js` with CI `name:` |
| `@claude` does not trigger workflow | Missing or wrong `GH_TOKEN` | Set PAT secret; must be maintainer user |
| Review chain stuck 30m | Greptile not installed | Install Greptile app or adjust chain config |
| `uses: ... callable.yml@v1.1.0` fails | Hub access denied | Enable reusable workflow access on hub repo |
| Workflow not found on private hub | Tag not pushed | `git push origin v1.1.0` |
| OAuth `Token revoked` | Expired Claude token | Refresh `CLAUDE_CODE_OAUTH_TOKEN` |
| Changes not on default branch | Callers only run from default | Merge install PR to `main` |

---

## Rollout tiers (existing Praison repos)

| Tier | Repos | Action |
|------|-------|--------|
| Trivial | PraisonAI-Tools, PraisonAIUI, PraisonAI-Plugins | `install.sh --mode hub --update` |
| Easy | PraisonAIDocs | `--profile docs` |
| Medium | PraisonAI-Frameworks, praisonaicompare | Full hub install + tune `gate-config.js` |
| Reference | praisonai-package (PraisonAI) | Source of truth; adopt hub after pilot |

---

## Agent checklist (copy-paste)

When asked to add automation to repo `owner/name`:

1. Identify CI workflow `name:` and product path prefixes
2. Choose profile: `sdk` | `tools` | `docs`
3. Run `install.sh --mode hub --repo owner/name` with correct env vars
4. Edit `gate-config.js` — verify `ciWorkflowName`, `productPathPrefixes`, `triggerLogins`
5. Remind user to sync secrets and install CodeRabbit + Greptile
6. Run `validate.sh --target <repo>`
7. Do **not** modify hub repo unless fixing shared logic for all consumers

---

## Hub development (maintainers)

| Task | Command |
|------|---------|
| Run selftests | `./validate.sh` |
| Bump version | Edit `stacks/claude/VERSION`, tag `vX.Y.Z`, push tag |
| Add new stack | Create `stacks/<name>/` with callers, profiles, shared |
| Copy mode fallback | Keep `stacks/claude/shared/` in sync with `.github/scripts/` |

Protocol: hub repo holds **implementations**; target repos hold **triggers + gate-config only**.
