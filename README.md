# github-automation-template

Central **hub** for GitHub automation stacks. Target repos install **thin caller workflows** (~7 files + `gate-config.js`) that reference reusable workflows in this repo — the closest GitHub equivalent to GitLab `include:`.

**Current version:** `v1.1.15` (hub mode, default)  
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
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code OAuth (primary) |
| `CLAUDE_CODE_OAUTH_TOKEN_B` | Claude Code OAuth (secondary backup) |
| `GH_TOKEN` | PAT as maintainer — chains `@claude` between workflows (`GITHUB_TOKEN` alone cannot) |

**Repo variable:** `CLAUDE_OAUTH_ACTIVE` — `primary` (default) or `secondary`. Workflows probe the active slot and fail over on 401/429 (v1.1.8+).

---

## Who can run Claude

A person can only start Claude if they could push the change themselves. Outsiders' work still flows (their actionable issues and their fork PRs), but under stricter rules and with an independent security review before anything they influenced can merge (see [Outsider work](#outsider-work)).

| Trigger | Starts Claude? |
|---------|----------------|
| `@claude` comment or review by a user with **write or admin** access | Yes |
| `@claude` by anyone else (incl. read-only collaborators) | No — the job is skipped, or fails at its first step before any token is created |
| New issue opened by a user with write access | Yes — triage adds the `claude` label |
| New issue opened by anyone else | Yes for an actionable bug or enhancement report (titled `bug:`, `feat:`, `[...]` and so on); Claude runs with untrusted-input rules. Otherwise no: triage posts a welcome comment |
| Fork PR (including a deleted fork) | Automatic review, read-only: the fork's code is never checked out, Claude gets GitHub read tools plus one comment, and adds a security review. No automatic CI-fix or merge-conflict requests (Claude cannot push to a fork). A maintainer merges fork PRs |
| Issue labelled `claude` by the triage App | Yes, including outsiders' issues (with untrusted-input rules) |

The merge gate assessor (Opus) runs on PR content with an App token limited to contents/pull-requests read and issues write, and with web, notebook, subagent and GitHub MCP write tools denied. Its verdict counts only when posted by the gate's own App bot (`allowedTriageBots`, default `praisonai-triage-agent[bot]`) as a comment whose first line is `MERGE_GATE_VERDICT: APPROVE|BLOCK` (a comment carrying both is BLOCK); a verdict from anyone else is ignored, and the relay only reads Opus's own final answer, never text quoted from PR comments.

Scripts that run after a PR branch is checked out load `gate-config.js` from a copy of the default branch taken before the fetch, never from the PR.

A PR the merge gate BLOCKed on its current HEAD is held out of the scan (label `pipeline/blocked:merge-gate`) until a new commit, a check finishing after the verdict, or 24 h. Scheduled scans then ask Claude once per HEAD (at most 3 times per PR) to fix the findings; this needs the `GH_TOKEN` secret.

## Outsider work

A PR is **outsider-origin** when anything it was built from came from someone without write access: a fork, a non-writer author, a source issue (`claude/issue-N` branch or a closing reference) opened by a non-writer, or a non-writer's comment on that issue or PR. The flag is sticky (label `origin/outsider`, read from the timeline), and every PR the App opens during an outsider run is flagged.

| Layer | What it does |
|-------|--------------|
| Prompt rules | Claude treats outsider text as data, keeps the change to a minimal source+test fix, and stops for a maintainer if CI, dependencies, build, network, exec or secrets would change |
| Independent security review | A second Opus run with GitHub read tools only reviews the diff against a 10-point threat checklist (`.github/prompts/outsider-security-review.md`) plus deterministic risk flags |
| Same-run verdict | `merge-only` decides from an artifact of its own run (merge verdict, security verdict, reviewed HEAD), never from PR comments; the merge pins the SHA |
| Hard limits | Changes to `.github/`, manifests, lockfiles, build/install files, `conftest.py`, `.pth`, shell scripts or Claude Code config need a maintainer's approving review on that exact commit |
| No PR code next to secrets | The merge gate never checks out a PR; the assistant refuses PRs that change `.claude/`, `.mcp.json` or `CLAUDE.md`, runs Claude with `--setting-sources user --strict-mcp-config`, and does its `GH_TOKEN` steps on a fresh runner from the recorded trusted commit |

### Behaviour changes in v1.1.16

- Outsiders' actionable issues start Claude again, and fork PRs get the automatic FINAL review again, now with the layers above.
- The merge gate no longer checks out PR code; its Claude runs read the PR through the GitHub API with GitHub tools only.
- `merge-only` merges only on a same-run verdict artifact bound to the reviewed HEAD, and passes `sha` to the merge.
- Claude Code runs with `--setting-sources user --strict-mcp-config` and an explicit MCP config file, so a checkout's `.claude/settings.json` hooks and `.mcp.json` servers never load.
- `.github/actions|scripts|prompts`, `_hub`, `.trusted*`, `.claude/`, `.mcp.json` and `CLAUDE.md` are always sensitive paths.
- New `orphan-pr.js`: opens the missing PR when Claude pushes `claude/issue-N-*` but skips `gh pr create` (title prefix from `orphanPrTitlePrefix`, default `fix`).

### Behaviour changes in v1.1.15

- External issues no longer start Claude automatically, whatever their title.
- The Claude Assistant prompt is generic: git identity, test command and scope come from the repo's `gate-config.js` (`gitUser`, `gitEmail`, `testCommand`, `finalClaudeScope`), with generic fallbacks. The vendored action no longer injects PraisonAI test commands.
- The merge gate prompt reads `mergeGateProductValue` / `mergeGateLayering` from `gate-config.js` and no longer re-applies its own sensitive-path list (the scan already applies `sensitivePathPatterns`).
- The merge gate callable now honours its `pr_number` and `merge_method` inputs (a dispatch for one PR used to scan every PR).
- Label sync no longer posts `@claude CI failed on HEAD` (only `ci-failure-claude` does, with `GH_TOKEN`).
- `maxAutoAdditions` / `maxAutoFiles` in `gate-config.js` are honoured.
- The thin `auto-pr-comment.yml` caller sweeps for stale/missing FINAL reviews hourly (`30 * * * *`).

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
| `testCommand` | Command Claude runs after fixes (empty: Claude follows AGENTS.md / README) |
| `gitUser` / `gitEmail` | Git identity Claude commits with |
| `finalClaudeScope` | Scope line in the FINAL review and Claude Assistant prompts |
| `mergeGateProductValue` / `mergeGateLayering` | Product-value and routing checks in the merge gate prompt |
| `maxAutoAdditions` / `maxAutoFiles` | PR size above which auto-merge needs manual review (default 800 / 30) |
| `allowedTriageBots` | App bot login(s) whose merge gate verdicts count (default `praisonai-triage-agent[bot]`) |

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
./validate.sh          # selftests, actionlint (if installed), hub vs copy-mode drift check
```

Release (`vX.Y.Z`):

1. Bump `stacks/claude/VERSION` in the commit that will be tagged.
2. If `.github/actions/hub-setup/` changed, also bump every `hub-setup@v…` pin in the callables to `@vX.Y.Z` in that same commit. GitHub does not allow `${{ inputs.hub_ref }}` in a `uses:` ref, so the pin is static; while hub-setup is unchanged the existing pin (`@v1.1.10`) stays correct, because scripts and the other actions are checked out from the caller's `hub_ref`.
3. `git tag vX.Y.Z && git push origin vX.Y.Z`, then bump `@vX.Y.Z` and `hub_ref: vX.Y.Z` together in each caller.

Future stacks (release gates, security bots) add under `stacks/<name>/` without renaming this repo.
