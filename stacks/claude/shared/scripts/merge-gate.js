/**
 * Shared merge-gate helpers for claude-merge-gate.yml
 * @see .github/workflows/claude-merge-gate.yml
 */

const { resolveGateConfigPath } = require('./hub-paths.js');
const config = require(resolveGateConfigPath());
const outsider = require('./outsider-review.js');

function resolveTriggerLogins(gateConfig) {
  if (Array.isArray(gateConfig.triggerLogins) && gateConfig.triggerLogins.length > 0) {
    return gateConfig.triggerLogins;
  }
  const logins = new Set(['github-actions[bot]']);
  if (gateConfig.gitUser) logins.add(gateConfig.gitUser);
  const owner = (gateConfig.repoFullName || '').split('/')[0];
  if (owner) logins.add(owner);
  return [...logins];
}

const CLAUDE_TRIGGER_LOGINS = resolveTriggerLogins(config);
const AUTO_ACTORS = CLAUDE_TRIGGER_LOGINS;
const CONFLICT_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const CLAUDE_ACTIVE_MS = 35 * 60 * 1000;
const STALE_FINAL_RECOVERY_WINDOW_MS = 60 * 60 * 1000;
const STALE_FINAL_MAX_PER_WINDOW = 2;
const PUSH_AFTER_FINAL_DEBOUNCE_MS = 15 * 60 * 1000;
// How long after a push the "pushed soon after FINAL" debounce keeps holding
// stale-FINAL recovery back (long enough for CI / a batch of fixes). After that
// the debounce expires, so a missed completion can no longer block a PR forever.
const PUSH_SETTLE_MS = 30 * 60 * 1000;
const ALLOWED_MERGE_STATES = new Set(['CLEAN', 'UNSTABLE']);
const AGENT_PY_MAX_AUTO_LINES = 100;
const PR_MAX_AUTO_ADDITIONS = config.maxAutoAdditions || 800;
const PR_MAX_AUTO_FILES = config.maxAutoFiles || 30;
// Only the gate's own App bot may post a verdict that counts; anyone can
// comment "MERGE_GATE_VERDICT: APPROVE". Every verdict path (Opus via MCP, the
// relay, the fallback BLOCK) posts with the App token. Exact logins only.
const GATE_VERDICT_AUTHORS = new Set(
  Array.isArray(config.allowedTriageBots) && config.allowedTriageBots.length
    ? config.allowedTriageBots
    : ['praisonai-triage-agent[bot]']
);
// Automation that posts FINAL replies / rebase notes (App bot + Actions bot).
const AUTOMATION_LOGINS = new Set([...GATE_VERDICT_AUTHORS, 'github-actions[bot]']);
const MANUAL_ONLY_LABELS = new Set(['security', 'breaking-change', 'needs-manual-review', 'release']);
const WORKFLOW_ONLY_LABEL = 'merge-gate-ci-only';
const CI_ONLY_PATH_PREFIXES = ['.github/workflows/', '.github/actions/', '.github/scripts/', '.github/prompts/'];
const SDK_PATH_PREFIXES = config.productPathPrefixes;
// Always sensitive, whatever the repo config says: code that runs with the
// workflows' tokens, the paths workflows reserve for trusted copies, and
// Claude Code configuration (hooks, MCP servers, instructions).
const RESERVED_SENSITIVE_PATTERNS = [
  /^\.github\/(workflows|actions|scripts|prompts)\//,
  /^(_hub|\.trusted)/,
  /(^|\/)(\.claude\/|\.mcp\.json$|CLAUDE\.md$)/,
];
const SENSITIVE_PATH_PATTERNS = [...(config.sensitivePathPatterns || []), ...RESERVED_SENSITIVE_PATTERNS];
const REQUIRED_SDK_CHECK_PATTERNS = config.requiredCheckPatterns;
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[a-zA-Z0-9]{36,}/,
  /github_pat_/,
  /Bearer eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
const BLOCK_LABELS = new Set([
  'claude-conflict-pending',
  'claude-merge-gate-active',
  'no-auto-merge',
  'auto-merged-by-gate',
]);
const MERGE_READY_LABEL = 'pipeline/merge-ready';
/** Superseded concurrency runs; must not block merge when real tests passed. */
const OPTIONAL_CANCELLED_CHECKS = new Set(config.optionalCancelledChecks || ['detect-and-trigger']);
/** Cancelled smoke/windows after timeout are non-blocking when core shards passed on HEAD. */
const OPTIONAL_CANCELLED_WHEN_CORE_GREEN = new Set(
  config.optionalCancelledWhenCoreGreen || ['smoke', 'test-windows']
);
const BOT_REVIEWER_PATTERNS = [
  'coderabbit',
  'qodo',
  'gemini',
  'copilot',
  'greptile',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Exact logins only: a substring match trusted any account whose name merely
 * contains "github-actions" or "praisonai-triage" (both are registrable).
 */
function isTrustedAutomationLogin(login) {
  const lower = (login || '').toLowerCase();
  if (!lower) return false;
  return [...AUTOMATION_LOGINS, ...AUTO_ACTORS].some((a) => a.toLowerCase() === lower);
}

function isFinalClaudeTriggerComment(c) {
  const body = (c.body || '').toLowerCase();
  if (!AUTO_ACTORS.includes(c.user.login)) return false;
  if (!body.includes('@claude')) return false;
  if (body.includes('merge conflict')) return false;
  return body.includes('final architecture reviewer') || body.includes('lead engineer');
}

function isClaudeTriggerNoise(c) {
  const body = c.body || '';
  if (body.includes('Merge gate scan')) return true;
  if (body.includes('MERGE_GATE_VERDICT')) return true;
  if (body.includes('Merged by **Claude PR merge gate**')) return true;
  return false;
}

// Markers of a completed FINAL review. anthropics/claude-code-action posted a
// "Claude finished" tracking comment; the vendored action posts the review
// itself under a heading such as "## Final architecture review: PR #109",
// "## Final review: PR #307" or "## Architecture Review — Final Verdict".
const FINAL_REPLY_MARKERS = [
  /Claude finished/,
  /^#{1,4}[^\n]*\bfinal\b[^\n]*\breview\b/im,
  /^#{1,4}[^\n]*\breview\b[^\n]*\bfinal\b/im,
];

function isClaudeFinalReplyComment(c) {
  if (!isTrustedAutomationLogin(c.user?.login)) return false;
  const body = c.body || '';
  // The FINAL trigger ("You are the FINAL architecture reviewer") is posted by
  // an automation login too; an @claude request is never its own completion.
  if (/^\s*@claude\b/i.test(body)) return false;
  return FINAL_REPLY_MARKERS.some((re) => re.test(body));
}

function hasRecentClaudeTrigger(comments, minutes = 35) {
  const cutoff = Date.now() - minutes * 60 * 1000;
  return comments.some((c) => {
    if (!CLAUDE_TRIGGER_LOGINS.includes(c.user.login)) return false;
    if (isClaudeTriggerNoise(c)) return false;
    if (!(c.body || '').includes('@claude')) return false;
    return new Date(c.created_at).getTime() > cutoff;
  });
}

function isConflictRebaseTriggerComment(c) {
  if (!AUTO_ACTORS.includes(c.user.login)) return false;
  const body = (c.body || '').toLowerCase();
  return body.includes('@claude') && body.includes('merge conflict');
}

function isConflictRebaseCompletionComment(c) {
  if (!isTrustedAutomationLogin(c.user?.login)) return false;
  const body = (c.body || '').toLowerCase();
  return (
    body.includes('rebase complete') ||
    body.includes('rebase onto') ||
    body.includes('force-pushed') ||
    (body.includes('conflict') && body.includes('resolved'))
  );
}

/** HEAD landed after conflict rebase but no FINAL @claude since that push. */
function needsFinalReReviewAfterConflictRebase(comments, headPushedAt) {
  if (!headPushedAt) return false;
  const headTime = new Date(headPushedAt).getTime();
  const conflictTriggers = comments.filter(isConflictRebaseTriggerComment);
  if (conflictTriggers.length === 0) return false;

  const latestConflict = conflictTriggers.reduce((a, b) =>
    new Date(a.created_at) > new Date(b.created_at) ? a : b
  );
  const conflictTime = new Date(latestConflict.created_at).getTime();
  if (headTime <= conflictTime) return false;

  const rebaseDone = comments.some(
    (c) =>
      new Date(c.created_at).getTime() > conflictTime && isConflictRebaseCompletionComment(c)
  );
  if (!rebaseDone) return false;

  const finalsAfterHead = comments.filter(
    (c) =>
      isFinalClaudeTriggerComment(c) &&
      new Date(c.created_at).getTime() >= headTime - 60000
  );
  return finalsAfterHead.length === 0;
}

function conflictRebaseQuiescent(comments, headPushedAt) {
  const conflictTriggers = comments.filter(isConflictRebaseTriggerComment);
  if (conflictTriggers.length === 0) return true;

  const latestConflict = conflictTriggers.reduce((a, b) =>
    new Date(a.created_at) > new Date(b.created_at) ? a : b
  );
  const conflictTime = new Date(latestConflict.created_at).getTime();

  const rebaseDone = comments.some(
    (c) =>
      new Date(c.created_at).getTime() > conflictTime && isConflictRebaseCompletionComment(c)
  );
  if (!rebaseDone) return false;

  return finalClaudeCompletedOnSha(comments, headPushedAt);
}

function hasRecentConflictComment(comments, headPushedAt = null) {
  const cutoff = Date.now() - CONFLICT_COOLDOWN_MS;
  const hasRecentTrigger = comments.some((c) => {
    if (!isConflictRebaseTriggerComment(c)) return false;
    return new Date(c.created_at).getTime() > cutoff;
  });
  if (!hasRecentTrigger) return false;

  if (headPushedAt && conflictRebaseQuiescent(comments, headPushedAt)) {
    return false;
  }
  return true;
}

function isBotReviewer(login, userType) {
  const lower = (login || '').toLowerCase();
  if (userType === 'Bot') return true;
  if (lower.endsWith('[bot]')) return true;
  return ['coderabbit', 'qodo', 'gemini', 'copilot', 'greptile'].some((p) => lower.includes(p));
}

function latestReviewsByUser(reviews) {
  const latestByUser = new Map();
  for (const r of reviews) {
    const login = r.user?.login;
    if (!login) continue;
    const prev = latestByUser.get(login);
    if (!prev || new Date(r.submitted_at) > new Date(prev.submitted_at)) {
      latestByUser.set(login, r);
    }
  }
  return latestByUser;
}

function hasHumanChangesRequested(reviews) {
  for (const [login, review] of latestReviewsByUser(reviews)) {
    if (review.state !== 'CHANGES_REQUESTED') continue;
    if (!isBotReviewer(login, review.user?.type)) return true;
  }
  return false;
}

function hasAnyChangesRequested(reviews) {
  for (const [, review] of latestReviewsByUser(reviews)) {
    if (review.state === 'CHANGES_REQUESTED') return true;
  }
  return false;
}

function hasFinalClaudeReviewTrigger(comments) {
  return comments.some(isFinalClaudeTriggerComment);
}

function isStaleFinalAfterPush(comments, headPushedAt) {
  if (!headPushedAt) return false;
  const headTime = new Date(headPushedAt).getTime();
  const finals = comments.filter(isFinalClaudeTriggerComment);
  if (finals.length === 0) return true;
  const latestFinal = finals.reduce((a, b) =>
    new Date(a.created_at) > new Date(b.created_at) ? a : b
  );
  const finalTime = new Date(latestFinal.created_at).getTime();
  if (headTime <= finalTime + 60000) return false;
  // The reply must follow BOTH the latest FINAL trigger and HEAD: a reply that
  // predates HEAD reviewed older commits and must not hide the new ones.
  const replyFloor = Math.max(finalTime, headTime - 60000);
  const claudeRepliedOnHead = comments.some((c) => {
    if (!isClaudeFinalReplyComment(c)) return false;
    return new Date(c.created_at).getTime() >= replyFloor;
  });
  if (claudeRepliedOnHead) return false;
  const claudeSinceHead = comments.some((c) => {
    if (!CLAUDE_TRIGGER_LOGINS.includes(c.user.login)) return false;
    if (isClaudeTriggerNoise(c)) return false;
    if (!(c.body || '').includes('@claude')) return false;
    return new Date(c.created_at).getTime() >= headTime - 60000;
  });
  return !claudeSinceHead;
}

function needsStaleFinalRecovery(comments, headPushedAt) {
  return (
    hasFinalClaudeReviewTrigger(comments) &&
    isStaleFinalAfterPush(comments, headPushedAt)
  );
}

function shouldSkipFinalRecovery(comments, headPushedAt) {
  const isStale = isStaleFinalAfterPush(comments, headPushedAt);
  if (isStale) return false;
  return hasRecentClaudeTrigger(comments, 35);
}

function countFinalTriggersSince(comments, sinceMs) {
  return comments.filter(
    (c) => isFinalClaudeTriggerComment(c) && new Date(c.created_at).getTime() > sinceMs
  ).length;
}

function isClaudeAutomationLogin(login) {
  const lower = (login || '').toLowerCase();
  return [...AUTOMATION_LOGINS].some((a) => a.toLowerCase() === lower);
}

function isPushSoonAfterLatestFinal(comments, headPushedAt) {
  if (!headPushedAt) return false;
  const finals = comments.filter(isFinalClaudeTriggerComment);
  if (finals.length === 0) return false;
  const latestFinal = finals.reduce((a, b) =>
    new Date(a.created_at) > new Date(b.created_at) ? a : b
  );
  const finalTime = new Date(latestFinal.created_at).getTime();
  const headTime = new Date(headPushedAt).getTime();
  if (headTime <= finalTime) return false;
  return headTime - finalTime < PUSH_AFTER_FINAL_DEBOUNCE_MS;
}

/** Returns { skip: true, reason } when stale-FINAL recovery should not post. */
function shouldSkipStaleFinalRecovery(comments, headPushedAt, headPusherLogin = null) {
  if (!isStaleFinalAfterPush(comments, headPushedAt)) {
    return { skip: true, reason: 'not stale' };
  }
  // The debounces below compare the push to the FINAL trigger, a relation that
  // never changes; only hold recovery back while the push is still settling.
  const pushSettling =
    !!headPushedAt && Date.now() - new Date(headPushedAt).getTime() < PUSH_SETTLE_MS;
  if (pushSettling && headPusherLogin && isClaudeAutomationLogin(headPusherLogin)) {
    return { skip: true, reason: 'head pushed by Claude automation' };
  }
  if (needsFinalReReviewAfterConflictRebase(comments, headPushedAt)) {
    return { skip: false, reason: '' };
  }
  if (pushSettling && isPushSoonAfterLatestFinal(comments, headPushedAt)) {
    return {
      skip: true,
      reason: 'head pushed soon after FINAL (wait for CI / batched fixes)',
    };
  }
  const windowStart = Date.now() - STALE_FINAL_RECOVERY_WINDOW_MS;
  const finalsInWindow = countFinalTriggersSince(comments, windowStart);
  if (finalsInWindow >= STALE_FINAL_MAX_PER_WINDOW) {
    return {
      skip: true,
      reason: `stale-FINAL capped (${finalsInWindow} FINAL triggers in last hour)`,
    };
  }
  return { skip: false, reason: '' };
}

function finalClaudeCompletedOnSha(comments, headPushedAt) {
  if (!hasFinalClaudeReviewTrigger(comments)) return false;
  if (isStaleFinalAfterPush(comments, headPushedAt)) return false;
  return true;
}

const FINAL_CLAUDE_REVIEW_BODY =
  `@claude You are the FINAL architecture reviewer. If the branch is under ${config.repoFullName} (not a fork), you are able to make modifications to this branch and push directly. ${config.finalClaudeScope} Read ALL comments above from Gemini, Qodo, CodeRabbit, and Copilot carefully before responding.\n\n**Phase 1: Review per AGENTS.md**\n1. Protocol-driven: check heavy implementations vs core SDK\n2. Backward compatible: ensure zero feature regressions\n3. Performance: no hot-path regressions (lazy imports, import-time <200ms)\n${config.finalClaudeProductValue}\n\n**Phase 2: FIX Valid Issues**\n5. For any VALID bugs or architectural flaws found by Gemini, CodeRabbit, Qodo, Copilot, or any other reviewer: implement the fix\n6. Push all code fixes directly to THIS branch (do NOT create a new PR)\n7. Comment a summary of exact files modified and what you skipped\n\n**Phase 3: Final Verdict**\n8. If all issues are resolved, approve the PR / close the Issue\n9. If blocking issues remain, request changes / leave clear action items`;

async function getMergeState(github, owner, repo, prNumber) {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          mergeStateStatus
          maintainerCanModify
          isDraft
          headRefOid
          headRef { repository { nameWithOwner } }
        }
      }
    }
  `;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await github.graphql(query, { owner, repo, number: prNumber });
    const prGql = result.repository.pullRequest;
    const status = (prGql?.mergeStateStatus || '').toUpperCase();
    if (status && status !== 'UNKNOWN') {
      return {
        status,
        isDraft: prGql.isDraft,
        headRepo: prGql.headRef?.repository?.nameWithOwner,
        headSha: prGql.headRefOid,
        maintainerCanModify: prGql.maintainerCanModify === true,
      };
    }
    if (attempt < 2) await sleep(10000);
  }
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
  return {
    status: (pr.mergeable_state || '').toUpperCase(),
    isDraft: pr.draft,
    headRepo: pr.head.repo?.full_name,
    headSha: pr.head.sha,
    maintainerCanModify: pr.maintainer_can_modify === true,
  };
}

async function listChecksOnSha(github, owner, repo, sha) {
  const { data } = await github.rest.checks.listForRef({
    owner,
    repo,
    ref: sha,
    per_page: 100,
  });
  return (data.check_runs || []).filter((r) => r.head_sha === sha);
}

function listFailedChecksOnSha(runs) {
  return (runs || []).filter((run) => {
    if (run.status !== 'completed') return false;
    return run.conclusion === 'failure';
  });
}

function isCoreTestRun(run) {
  const name = run?.name || '';
  return name === 'test-core' || name.startsWith('test-core ') || name === 'test-core-collect';
}

function coreTestsGreenOnRuns(runs) {
  const coreRuns = (runs || []).filter(isCoreTestRun);
  if (coreRuns.length === 0) return false;
  return coreRuns.every(
    (run) =>
      run.status === 'completed' &&
      ['success', 'neutral', 'skipped'].includes(run.conclusion)
  );
}

function checkConclusionRank(conclusion) {
  if (conclusion === 'success') return 4;
  if (conclusion === 'neutral') return 3;
  if (conclusion === 'skipped') return 2;
  if (conclusion === 'cancelled') return 1;
  return 0;
}

function isPendingRun(run) {
  return !!(run && run.status && run.status !== 'completed');
}

function bestRunsByName(runs) {
  const byName = new Map();
  for (const run of runs || []) {
    if (!run) continue;
    const existing = byName.get(run.name);
    if (!existing) {
      byName.set(run.name, run);
      continue;
    }
    const runPending = isPendingRun(run);
    const existingPending = isPendingRun(existing);
    if (existingPending) continue;
    if (
      runPending ||
      checkConclusionRank(run.conclusion) > checkConclusionRank(existing.conclusion)
    ) {
      byName.set(run.name, run);
    }
  }
  return [...byName.values()];
}

function isAcceptableCheckConclusion(run, runs) {
  if (['success', 'neutral', 'skipped'].includes(run.conclusion)) return true;
  if (run.conclusion === 'cancelled' && OPTIONAL_CANCELLED_CHECKS.has(run.name)) return true;
  if (
    run.conclusion === 'cancelled' &&
    OPTIONAL_CANCELLED_WHEN_CORE_GREEN.has(run.name) &&
    coreTestsGreenOnRuns(runs)
  ) {
    return true;
  }
  return false;
}

async function allChecksGreenOnSha(github, owner, repo, sha, core) {
  const runs = bestRunsByName(await listChecksOnSha(github, owner, repo, sha));
  if (runs.length === 0) {
    core?.info?.(`No check runs on ${sha.slice(0, 7)} — allowing (e.g. docs-only PR)`);
    return true;
  }
  for (const run of runs) {
    if (run.status !== 'completed') {
      core?.info?.(`Check pending: ${run.name} (${run.status})`);
      return false;
    }
    if (!isAcceptableCheckConclusion(run, runs)) {
      core?.info?.(`Check failed: ${run.name} (${run.conclusion})`);
      return false;
    }
    if (
      run.conclusion === 'cancelled' &&
      OPTIONAL_CANCELLED_WHEN_CORE_GREEN.has(run.name) &&
      coreTestsGreenOnRuns(runs)
    ) {
      core?.info?.(`Ignoring cancelled ${run.name} — test-core green on HEAD`);
    }
  }
  return true;
}

function claudeRunBlocksPr(run, headRef) {
  if (!run || run.event === 'issues') return false;
  if (!headRef) return true;
  return run.head_branch === headRef;
}

function hasBlockingClaudeRunForPr(runs, headRef) {
  return (runs || []).some((r) => claudeRunBlocksPr(r, headRef));
}

async function hasInProgressClaudeAssistant(github, owner, repo, prNumber = null) {
  try {
    const { data } = await github.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: 'claude.yml',
      status: 'in_progress',
      per_page: 20,
    });
    const runs = (data.workflow_runs || []).filter((r) => r.event !== 'issues');
    if (runs.length === 0) return false;
    if (prNumber == null) return runs.length > 0;

    const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
    const headRef = pr.head.ref;
    return hasBlockingClaudeRunForPr(runs, headRef);
  } catch {
    return false;
  }
}

function isCiOnlyChange(files) {
  if (!files.length) return false;
  return files.every((f) => CI_ONLY_PATH_PREFIXES.some((p) => f.filename.startsWith(p)));
}

function isInternalPullRequestLink(link, owner, repo) {
  if (link?.base?.repo?.full_name === `${owner}/${repo}`) return true;
  const baseUrl = link?.base?.repo?.url || '';
  return baseUrl.endsWith(`/repos/${owner}/${repo}`);
}

async function resolvePrNumberFromLinkedPullRequests(github, owner, repo, linked) {
  const repoFull = `${owner}/${repo}`;
  const internal = (linked || []).filter((l) => isInternalPullRequestLink(l, owner, repo));
  for (const link of internal) {
    if (!link.number) continue;
    try {
      const { data } = await github.rest.pulls.get({
        owner,
        repo,
        pull_number: link.number,
      });
      if (data.state === 'open' && data.base?.repo?.full_name === repoFull) {
        return data.number;
      }
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
  return null;
}

async function resolvePrNumberFromHeadBranch(github, owner, repo, branch) {
  if (!branch || branch === 'main' || branch === 'master') return null;
  const { data } = await github.rest.pulls.list({
    owner,
    repo,
    state: 'open',
    head: `${owner}:${branch}`,
    per_page: 1,
  });
  return data[0]?.number || null;
}

async function resolvePrNumberFromWorkflowRun(github, owner, repo, workflowRun) {
  const fromLinked = await resolvePrNumberFromLinkedPullRequests(
    github, owner, repo, workflowRun.pull_requests
  );
  if (fromLinked) return fromLinked;

  const fromBranch = await resolvePrNumberFromHeadBranch(
    github, owner, repo, workflowRun.head_branch
  );
  if (fromBranch) return fromBranch;

  return null;
}

async function listPullFiles(github, owner, repo, prNumber) {
  if (typeof github.paginate === 'function') {
    return github.paginate(github.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
  }
  const { data } = await github.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  return data;
}

function countNewAgentParams(patch) {
  if (!patch) return 0;
  return patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .filter((l) => {
      const t = l.slice(1).trim();
      if (!t || t.startsWith('#') || t.startsWith('"""') || t.startsWith("'''")) return false;
      if (/^(def|class|@|return\b|if\b|elif\b|else\b|for\b|while\b)/.test(t)) return false;
      if (/^\w+\s*[:=]/.test(t) && !t.startsWith('self.')) return true;
      return false;
    }).length;
}

function getAgentPyChangeFromFiles(files) {
  const suffix = config.agentPyPathSuffix || 'praisonaiagents/agent/agent.py';
  const agentFile = files.find((f) => f.filename.endsWith(suffix));
  if (!agentFile) {
    return { touched: false, additions: 0, newParams: 0 };
  }
  return {
    touched: true,
    additions: agentFile.additions || 0,
    newParams: countNewAgentParams(agentFile.patch || ''),
  };
}

async function getAgentPyChange(github, owner, repo, prNumber) {
  const files = await listPullFiles(github, owner, repo, prNumber);
  return getAgentPyChangeFromFiles(files);
}

function touchesSdk(files) {
  return files.some((f) => SDK_PATH_PREFIXES.some((p) => f.filename.startsWith(p)));
}

function hasManualOnlyLabel(labels) {
  return labels.some((l) => MANUAL_ONLY_LABELS.has(l));
}

function sensitivePathReasons(files, labels = []) {
  if (labels.includes(WORKFLOW_ONLY_LABEL) && isCiOnlyChange(files)) {
    return [];
  }
  const reasons = [];
  for (const f of files) {
    if (SENSITIVE_PATH_PATTERNS.some((p) => p.test(f.filename))) {
      reasons.push(`sensitive path: ${f.filename}`);
      break;
    }
  }
  return reasons;
}

function prSizeReasons(files) {
  const reasons = [];
  const totalAdditions = files.reduce((sum, f) => sum + (f.additions || 0), 0);
  if (totalAdditions > PR_MAX_AUTO_ADDITIONS) {
    reasons.push(`PR +${totalAdditions} lines (>${PR_MAX_AUTO_ADDITIONS}) requires manual review`);
  }
  if (files.length > PR_MAX_AUTO_FILES) {
    reasons.push(`${files.length} files changed (>${PR_MAX_AUTO_FILES}) requires manual review`);
  }
  return reasons;
}

function missingTestsReason(files) {
  const sdkAdds = files.filter(
    (f) =>
      SDK_PATH_PREFIXES.some((p) => f.filename.startsWith(p)) &&
      f.filename.endsWith('.py') &&
      !f.filename.endsWith('__init__.py') &&
      (f.additions || 0) > 0
  );
  if (sdkAdds.length === 0) return null;
  const hasTestChange = files.some(
    (f) => /\/tests?\//.test(f.filename) || /test_.*\.py$/.test(f.filename) || /_test\.py$/.test(f.filename)
  );
  if (!hasTestChange) return 'SDK code added without test file changes — requires manual review';
  return null;
}

function secretScanReasons(files) {
  for (const f of files) {
    if (/\/tests?\//.test(f.filename) || /test_.*\.py$/.test(f.filename)) continue;
    const patch = f.patch || '';
    if (!patch) continue;
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(patch)) {
        return [`possible secret in diff (${f.filename}) — requires manual review`];
      }
    }
  }
  return [];
}

async function sdkTestChecksReason(github, owner, repo, sha, files, core) {
  if (!touchesSdk(files)) return null;
  const { data } = await github.rest.checks.listForRef({
    owner,
    repo,
    ref: sha,
    per_page: 100,
  });
  const runs = (data.check_runs || []).filter((r) => r.head_sha === sha);
  if (runs.length === 0) {
    return 'SDK code changed but no CI checks on HEAD';
  }
  const testRuns = runs.filter((r) => REQUIRED_SDK_CHECK_PATTERNS.some((p) => p.test(r.name || '')));
  if (testRuns.length === 0) {
    return 'SDK code changed but no test check runs on HEAD';
  }
  core?.info?.(`SDK test checks on HEAD: ${testRuns.map((r) => r.name).join(', ')}`);
  return null;
}

function manualReviewReasonForAgentPy(agentChange) {
  if (!agentChange.touched) return null;
  if (agentChange.additions > AGENT_PY_MAX_AUTO_LINES) {
    return `agent.py +${agentChange.additions} lines (>${AGENT_PY_MAX_AUTO_LINES}) requires manual review`;
  }
  if (agentChange.newParams > 0) {
    return `agent.py adds ${agentChange.newParams} new Agent param(s) — requires manual review`;
  }
  return null;
}

async function listAllComments(github, owner, repo, issueNumber) {
  if (typeof github.paginate === 'function') {
    return github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    });
  }
  const { data } = await github.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  return data;
}

async function getHeadCommitDate(github, owner, repo, prNumber) {
  try {
    let commits;
    if (typeof github.paginate === 'function') {
      commits = await github.paginate(github.rest.pulls.listCommits, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });
    } else {
      const { data } = await github.rest.pulls.listCommits({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });
      commits = data;
    }
    const last = commits[commits.length - 1];
    return last?.commit?.committer?.date || last?.commit?.author?.date || null;
  } catch {
    return null;
  }
}

async function loadPrContext(github, owner, repo, prNumber) {
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: prNumber });
  const comments = await listAllComments(github, owner, repo, prNumber);
  const { data: reviews } = await github.rest.pulls.listReviews({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  const mergeState = await getMergeState(github, owner, repo, prNumber);
  const headSha = mergeState.headSha || pr.head.sha;
  const headCommitDate = await getHeadCommitDate(github, owner, repo, prNumber);
  const headPushedAt = headCommitDate || pr.updated_at;

  return {
    pr,
    issue,
    comments,
    reviews,
    mergeState,
    headSha,
    headPushedAt,
    labels: issue.labels.map((l) => l.name),
    baseRepo: `${owner}/${repo}`,
  };
}

async function evaluatePipelineQuiescent(github, owner, repo, prNumber, core, options = {}) {
  const {
    forMergeStep = false,
    skipGlobalClaudeRunCheck = false,
    skipRecentClaudeCooldown = false,
  } = options;
  const ctx = await loadPrContext(github, owner, repo, prNumber);
  const reasons = [];

  if (ctx.pr.draft) reasons.push('draft');
  if (ctx.pr.state !== 'open') reasons.push('not open');
  if (ctx.labels.includes('auto-merged-by-gate')) reasons.push('already merged by gate');
  if (ctx.labels.includes('no-auto-merge')) reasons.push('no-auto-merge label');
  if (ctx.labels.includes('claude-conflict-pending')) reasons.push('claude-conflict-pending');
  if (!forMergeStep && ctx.labels.includes('claude-merge-gate-active')) {
    reasons.push('claude-merge-gate-active');
  }

  const { status, headRepo, maintainerCanModify } = ctx.mergeState;
  if (!ALLOWED_MERGE_STATES.has(status)) reasons.push(`mergeState=${status}`);

  const isFork = isForkHeadRepo(headRepo, ctx.baseRepo);
  if (isFork) reasons.push('fork PR');

  if (hasRecentConflictComment(ctx.comments, ctx.headPushedAt)) {
    reasons.push('recent merge-conflict @claude');
  }
  if (!skipRecentClaudeCooldown && hasRecentClaudeTrigger(ctx.comments, 35)) {
    const verdictOnHead = findMergeGateVerdict(ctx.comments, null, ctx.headPushedAt) !== null;
    if (!verdictOnHead) reasons.push('recent @claude within 35min');
  }

  if (!skipGlobalClaudeRunCheck && (await hasInProgressClaudeAssistant(github, owner, repo, prNumber))) {
    reasons.push('claude.yml in progress');
  }

  const checksOk = await allChecksGreenOnSha(github, owner, repo, ctx.headSha, core);
  if (!checksOk) reasons.push('CI not green on HEAD');

  if (!finalClaudeCompletedOnSha(ctx.comments, ctx.headPushedAt)) {
    if (!hasFinalClaudeReviewTrigger(ctx.comments)) {
      reasons.push('no FINAL Claude review trigger');
    } else if (isStaleFinalAfterPush(ctx.comments, ctx.headPushedAt)) {
      reasons.push('stale FINAL after new commits (needs @claude re-review)');
    } else {
      reasons.push('FINAL Claude not complete on HEAD');
    }
  }

  if (hasAnyChangesRequested(ctx.reviews)) reasons.push('CHANGES_REQUESTED review');

  if (hasManualOnlyLabel(ctx.labels)) {
    const manualLabel = ctx.labels.find((l) => MANUAL_ONLY_LABELS.has(l));
    reasons.push(`manual-only label: ${manualLabel}`);
  }

  const pullFiles = await listPullFiles(github, owner, repo, prNumber);

  if (config.agentPyChecks) {
    const agentChange = getAgentPyChangeFromFiles(pullFiles);
    const agentManual = manualReviewReasonForAgentPy(agentChange);
    if (agentManual) reasons.push(agentManual);
  }

  reasons.push(...sensitivePathReasons(pullFiles, ctx.labels));
  reasons.push(...prSizeReasons(pullFiles));
  reasons.push(...secretScanReasons(pullFiles));

  // Outsider-origin PRs (see outsider-review.js). Provenance costs API calls,
  // so it is skipped on scans that are already blocked for other reasons.
  let outsiderOrigin = [];
  if (forMergeStep || reasons.length === 0) {
    outsiderOrigin = await outsider.outsiderOriginReasons(github, owner, repo, ctx.pr, ctx.comments);
    let securityStatus = null;
    if (forMergeStep && outsiderOrigin.length) {
      const statuses = await github.paginate(github.rest.repos.listCommitStatusesForRef, {
        owner, repo, ref: ctx.headSha, per_page: 100,
      });
      securityStatus = outsider.findSecurityReviewStatus(statuses);
    }
    const maintainerReviewed = outsiderOrigin.length > 0
      && (await outsider.maintainerApprovedHead(github, owner, repo, prNumber, ctx.headSha));
    reasons.push(...outsider.outsiderGateReasons({
      origin: outsiderOrigin,
      files: pullFiles,
      securityStatus,
      maintainerReviewed,
      forMergeStep,
    }));
  }

  const testsReason = missingTestsReason(pullFiles);
  if (testsReason) reasons.push(testsReason);

  const sdkCheckReason = await sdkTestChecksReason(github, owner, repo, ctx.headSha, pullFiles, core);
  if (sdkCheckReason) reasons.push(sdkCheckReason);

  if (ctx.pr.mergeable === false) reasons.push('not mergeable');

  // Starvation guard (see BLOCKED_ON_HEAD_REASON). Not applied on the merge
  // step itself, which only runs right after a fresh verdict.
  let blockedOnHead = false;
  if (!forMergeStep && latestMergeGateVerdictComment(ctx.comments, ctx.headPushedAt)) {
    const runs = await listChecksOnSha(github, owner, repo, ctx.headSha);
    if (blockedOnUnchangedHead(ctx.comments, ctx.headPushedAt, runs)) {
      blockedOnHead = true;
      reasons.push(BLOCKED_ON_HEAD_REASON);
    }
  }

  const ready = reasons.length === 0;
  return {
    ready,
    reasons,
    headSha: ctx.headSha,
    prNumber,
    blockedOnHead,
    // Never ask Claude to work on fork code automatically.
    blockFixDue: blockedOnHead && !isFork && blockFixRequestDue(ctx.comments, ctx.headSha),
    outsiderOrigin,
  };
}

/** A deleted fork has no head repo; it counts as a fork. */
function isForkHeadRepo(headRepo, baseRepo) {
  return headRepo !== baseRepo;
}

// ---------------------------------------------------------------------------
// Starvation guard. Candidates are scanned oldest-first and capped, so PRs the
// gate keeps BLOCKing on an unchanged HEAD used to take every slot on every
// scan while newer ready PRs were never looked at. A BLOCK on the current HEAD
// now holds the PR out until a commit lands, a check completes after the
// verdict, or BLOCK_RECHECK_AFTER_MS. While held out, Claude is asked (once per
// HEAD, capped) to fix the findings.
// ---------------------------------------------------------------------------
const BLOCK_RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;
const BLOCK_FIX_MARKER = 'merge-gate-fix-request:';
const MAX_BLOCK_FIX_REQUESTS = 3;
const BLOCKED_ON_HEAD_REASON = 'merge gate blocked this HEAD (waiting for a fix commit)';
const BLOCKED_MERGE_GATE_LABEL = 'pipeline/blocked:merge-gate';

function latestMergeGateVerdictComment(comments, headPushedAt) {
  const headTime = headPushedAt ? new Date(headPushedAt).getTime() - 60000 : 0;
  let latest = null;
  for (const c of comments || []) {
    if (!GATE_VERDICT_AUTHORS.has(c.user?.login)) continue;
    if (!isMergeGateVerdictComment(c.body)) continue;
    if (isAutomatedFallbackVerdict(c.body)) continue;
    const t = new Date(c.created_at).getTime();
    if (headTime && t < headTime) continue;
    if (!latest || t > new Date(latest.created_at).getTime()) latest = c;
  }
  return latest;
}

/** True when the newest verdict on HEAD is BLOCK and nothing has changed since. */
function blockedOnUnchangedHead(comments, headPushedAt, checkRuns, nowMs = Date.now()) {
  const verdict = latestMergeGateVerdictComment(comments, headPushedAt);
  if (!verdict || parseVerdictText(verdict.body, { firstLine: true }) !== 'BLOCK') return false;
  const verdictMs = new Date(verdict.created_at).getTime();
  if (nowMs - verdictMs >= BLOCK_RECHECK_AFTER_MS) return false;
  const checkCompletedSince = (checkRuns || []).some(
    (r) => r.completed_at && new Date(r.completed_at).getTime() > verdictMs
  );
  return !checkCompletedSince;
}

function buildBlockFixRequestBody(headSha) {
  // Must start with @claude and must NOT contain the verdict marker or the
  // FINAL-review phrases: claude-response ignores comments with the marker, and
  // the gate would mistake the others for a FINAL trigger.
  return [
    '@claude The merge gate blocked this PR on HEAD `' + headSha.slice(0, 12) + '`.',
    '',
    'Read the latest merge gate BLOCK verdict comment on this PR and the review threads it cites.',
    'Fix every blocking finding on this branch, add or update tests for each fix, and push.',
    'Do not post an approval or a verdict yourself; the review chain re-runs after your push.',
    'If a finding is wrong, or needs a maintainer rather than a code change, say so in a reply instead of changing code.',
    '',
    `<!-- ${BLOCK_FIX_MARKER}${headSha.slice(0, 12)} -->`,
  ].join('\n');
}

/** One fix request per HEAD, at most MAX_BLOCK_FIX_REQUESTS per PR (trusted posters only). */
function blockFixRequestDue(comments, headSha) {
  const requests = (comments || []).filter(
    (c) => CLAUDE_TRIGGER_LOGINS.includes(c.user?.login) && (c.body || '').includes(`<!-- ${BLOCK_FIX_MARKER}`)
  );
  if (requests.length >= MAX_BLOCK_FIX_REQUESTS) return false;
  const marker = `<!-- ${BLOCK_FIX_MARKER}${headSha.slice(0, 12)} -->`;
  return !requests.some((c) => (c.body || '').includes(marker));
}

async function listOpenIssuesWithLabel(github, owner, repo, label) {
  const params = { owner, repo, state: 'open', labels: label, per_page: 100 };
  if (typeof github.paginate === 'function') {
    return github.paginate(github.rest.issues.listForRepo, params);
  }
  return (await github.rest.issues.listForRepo(params)).data;
}

async function listPrNumbersForMergeGateScan(github, owner, repo, core) {
  const prsOnly = (issues) => issues.filter((issue) => issue.pull_request).map((issue) => issue.number);
  const labelledReady = prsOnly(await listOpenIssuesWithLabel(github, owner, repo, MERGE_READY_LABEL));
  // Label sync swaps merge-ready for the merge-gate blocker on held-out PRs;
  // keep scanning them (they never take a slot while held) so the fix request
  // is still posted and they re-enter once a fix lands.
  const heldOut = prsOnly(await listOpenIssuesWithLabel(github, owner, repo, BLOCKED_MERGE_GATE_LABEL));
  const mergeReady = [...labelledReady, ...heldOut]
    .filter((n, i, all) => all.indexOf(n) === i)
    .sort((a, b) => a - b);

  // Only a real merge-ready PR may short-circuit the scan; held-out PRs alone
  // must not hide unlabelled ready PRs from the oldest-open fallback below.
  if (labelledReady.length > 0) {
    core?.info?.(
      `Merge gate scan: ${mergeReady.length} ${MERGE_READY_LABEL} PR(s) (skipping unlabelled open PRs)`
    );
    return mergeReady;
  }

  core?.info?.(`No ${MERGE_READY_LABEL} PRs — scanning oldest open PRs`);
  const prs =
    typeof github.paginate === 'function'
      ? await github.paginate(github.rest.pulls.list, {
          owner,
          repo,
          state: 'open',
          per_page: 100,
          sort: 'created',
          direction: 'asc',
        })
      : (await github.rest.pulls.list({
          owner,
          repo,
          state: 'open',
          per_page: 100,
          sort: 'created',
          direction: 'asc',
        })).data;
  return prs.map((pr) => pr.number);
}

async function selectMergeGateCandidates(github, owner, repo, prNumbers, maxCandidates, core) {
  const readyList = [];
  const skipped = [];
  for (const num of prNumbers) {
    if (readyList.length >= maxCandidates) {
      core?.info?.(`Found ${maxCandidates} candidate(s) — skipping remaining PR scans`);
      break;
    }
    const result = await evaluatePipelineQuiescent(github, owner, repo, num, core);
    if (result.ready) {
      readyList.push({ pr_number: num, head_sha: result.headSha });
    } else {
      skipped.push({
        pr: num,
        reasons: result.reasons,
        head_sha: result.headSha,
        block_fix_due: !!result.blockFixDue,
      });
    }
  }
  readyList.sort((a, b) => a.pr_number - b.pr_number);
  return {
    candidates: readyList.slice(0, maxCandidates),
    skipped,
  };
}

const AUTOMATED_FALLBACK_MARKER = 'Automated fallback —';

function isAutomatedFallbackVerdict(body) {
  return (body || '').includes(AUTOMATED_FALLBACK_MARKER);
}

const MERGE_GATE_SCAN_MARKER = 'Merge gate scan';

const VERDICT_LINE_RE = /^\s*MERGE_GATE_VERDICT:\s*(APPROVE|BLOCK)\b/;

/**
 * Verdict in `text`: only markers at the start of a line count, and any BLOCK
 * marker wins over APPROVE. With firstLine, the first non-empty line must be
 * the marker (how every gate verdict comment is written).
 */
function parseVerdictText(text, { firstLine = false } = {}) {
  const lines = String(text || '').split('\n');
  if (firstLine) {
    const first = lines.find((l) => l.trim() !== '');
    if (!first || !VERDICT_LINE_RE.test(first)) return null;
  }
  const found = lines.map((l) => (l.match(VERDICT_LINE_RE) || [])[1]).filter(Boolean);
  if (found.length === 0) return null;
  return found.includes('BLOCK') ? 'BLOCK' : 'APPROVE';
}

/** A verdict comment starts with MERGE_GATE_VERDICT: APPROVE|BLOCK, never the scan notice. */
function isMergeGateVerdictComment(body) {
  const text = body || '';
  if (text.includes(MERGE_GATE_SCAN_MARKER)) return false;
  return parseVerdictText(text, { firstLine: true }) !== null;
}

/**
 * Verdict from Opus's own final answer in the claude-code stream-json output.
 * Only the final `type: "result"` event counts: earlier events include tool
 * results (PR comments, diffs) that anyone can fill with verdict text.
 */
function verdictFromAssessOutput(jsonl) {
  const lines = String(jsonl || '').split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let evt;
    try {
      evt = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (evt && evt.type === 'result') {
      return typeof evt.result === 'string' ? parseVerdictText(evt.result) : null;
    }
  }
  return null;
}

/** Throttle the scan's eligibility notice now that dispatches target one PR. */
function hasRecentMergeGateScanComment(comments, withinMinutes = 30) {
  const cutoff = Date.now() - withinMinutes * 60 * 1000;
  return (comments || []).some((c) => {
    if (!(c.body || '').includes(MERGE_GATE_SCAN_MARKER)) return false;
    return new Date(c.created_at).getTime() > cutoff;
  });
}

function findMergeGateVerdict(comments, minCreatedAt = null, headPushedAt = null, options = {}) {
  const { excludeAutomatedFallback = false } = options || {};
  const minTime = minCreatedAt ? new Date(minCreatedAt).getTime() : 0;
  const headTime = headPushedAt ? new Date(headPushedAt).getTime() - 60000 : 0;
  const gateComments = comments
    .filter((c) => {
      // A verdict counts only from the gate's own automation logins.
      if (!GATE_VERDICT_AUTHORS.has(c.user?.login)) return false;
      if (!isMergeGateVerdictComment(c.body)) return false;
      if (excludeAutomatedFallback && isAutomatedFallbackVerdict(c.body)) return false;
      const created = new Date(c.created_at).getTime();
      if (minTime && created < minTime) return false;
      if (headTime && created < headTime) return false;
      return true;
    })
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (gateComments.length === 0) return null;
  return parseVerdictText(gateComments[0].body, { firstLine: true });
}

module.exports = {
  GATE_VERDICT_AUTHORS,
  BLOCKED_ON_HEAD_REASON,
  BLOCKED_MERGE_GATE_LABEL,
  BLOCK_FIX_MARKER,
  MERGE_GATE_SCAN_MARKER,
  PR_MAX_AUTO_ADDITIONS,
  PR_MAX_AUTO_FILES,
  isForkHeadRepo,
  isMergeGateVerdictComment,
  parseVerdictText,
  verdictFromAssessOutput,
  AUTOMATION_LOGINS,
  isTrustedAutomationLogin,
  hasRecentMergeGateScanComment,
  latestMergeGateVerdictComment,
  blockedOnUnchangedHead,
  blockFixRequestDue,
  buildBlockFixRequestBody,
  resolveTriggerLogins,
  CLAUDE_TRIGGER_LOGINS,
  AUTO_ACTORS,
  isFinalClaudeTriggerComment,
  isClaudeTriggerNoise,
  isClaudeFinalReplyComment,
  hasRecentClaudeTrigger,
  hasRecentConflictComment,
  isConflictRebaseTriggerComment,
  isConflictRebaseCompletionComment,
  needsFinalReReviewAfterConflictRebase,
  conflictRebaseQuiescent,
  hasHumanChangesRequested,
  hasAnyChangesRequested,
  hasFinalClaudeReviewTrigger,
  finalClaudeCompletedOnSha,
  getMergeState,
  OPTIONAL_CANCELLED_CHECKS,
  OPTIONAL_CANCELLED_WHEN_CORE_GREEN,
  listChecksOnSha,
  listFailedChecksOnSha,
  bestRunsByName,
  isCoreTestRun,
  allChecksGreenOnSha,
  isAcceptableCheckConclusion,
  coreTestsGreenOnRuns,
  hasInProgressClaudeAssistant,
  claudeRunBlocksPr,
  hasBlockingClaudeRunForPr,
  isCiOnlyChange,
  isInternalPullRequestLink,
  resolvePrNumberFromLinkedPullRequests,
  resolvePrNumberFromHeadBranch,
  resolvePrNumberFromWorkflowRun,
  WORKFLOW_ONLY_LABEL,
  getAgentPyChange,
  getAgentPyChangeFromFiles,
  manualReviewReasonForAgentPy,
  countNewAgentParams,
  listPullFiles,
  touchesSdk,
  hasManualOnlyLabel,
  sensitivePathReasons,
  prSizeReasons,
  missingTestsReason,
  secretScanReasons,
  sdkTestChecksReason,
  listAllComments,
  getHeadCommitDate,
  isStaleFinalAfterPush,
  needsStaleFinalRecovery,
  shouldSkipFinalRecovery,
  shouldSkipStaleFinalRecovery,
  isClaudeAutomationLogin,
  isPushSoonAfterLatestFinal,
  countFinalTriggersSince,
  STALE_FINAL_RECOVERY_WINDOW_MS,
  STALE_FINAL_MAX_PER_WINDOW,
  FINAL_CLAUDE_REVIEW_BODY,
  loadPrContext,
  evaluatePipelineQuiescent,
  MERGE_READY_LABEL,
  listPrNumbersForMergeGateScan,
  selectMergeGateCandidates,
  isAutomatedFallbackVerdict,
  AUTOMATED_FALLBACK_MARKER,
  findMergeGateVerdict,
};
