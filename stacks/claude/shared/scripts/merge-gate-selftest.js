#!/usr/bin/env node
/**
 * Local self-test for merge-gate.js heuristics (no GitHub API).
 * Run: node .github/scripts/merge-gate-selftest.js
 */
const mg = require('./merge-gate.js');

let failed = 0;
function assert(name, cond) {
  if (!cond) {
    console.error('FAIL:', name);
    failed++;
  } else {
    console.log('ok:', name);
  }
}

// Stale FINAL: push after FINAL, no @claude since head
const finals = [
  { user: { login: 'github-actions[bot]' }, body: '@claude FINAL architecture reviewer', created_at: '2026-06-12T08:00:00Z' },
];
assert('stale when head after final', mg.isStaleFinalAfterPush(finals, '2026-06-12T09:00:00Z'));

const withRecovery = [
  ...finals,
  { user: { login: 'github-actions[bot]' }, body: '@claude FINAL architecture reviewer', created_at: '2026-06-12T09:30:00Z' },
];
assert('not stale when @claude after head', !mg.isStaleFinalAfterPush(withRecovery, '2026-06-12T09:00:00Z'));

const withClaudeReply = [
  ...finals,
  {
    user: { login: 'praisonai-triage-agent[bot]' },
    body: "**Claude finished @MervinPraison's task** —— [View job](https://github.com/)",
    created_at: '2026-06-12T08:30:00Z',
  },
];
// HEAD 08:25 (e.g. Claude pushed a fix during the FINAL), reply 08:30: current.
assert('not stale when Claude replied after FINAL and HEAD', !mg.isStaleFinalAfterPush(withClaudeReply, '2026-06-12T08:25:00Z'));
// HEAD 09:00 landed after the 08:30 reply: those commits were never reviewed.
assert('stale when HEAD lands after the reply', mg.isStaleFinalAfterPush(withClaudeReply, '2026-06-12T09:00:00Z'));
assert('claude final reply detected', mg.isClaudeFinalReplyComment(withClaudeReply[1]));

const triageFinalReview = {
  user: { login: 'praisonai-triage-agent[bot]' },
  body: '## Final Architecture Review — Verdict: ✅ Approve\n\nLGTM.',
  created_at: '2026-06-12T08:30:00Z',
};
assert('triage FINAL architecture review detected', mg.isClaudeFinalReplyComment(triageFinalReview));

const withTriageFinal = [...finals, triageFinalReview];
assert(
  'not stale when triage FINAL review after trigger and HEAD',
  !mg.isStaleFinalAfterPush(withTriageFinal, '2026-06-12T08:25:00Z')
);

assert(
  'resolveTriggerLogins falls back to repo owner',
  mg.resolveTriggerLogins({ repoFullName: 'MervinPraison/PraisonAIUI' }).includes('MervinPraison')
);
assert(
  'resolveTriggerLogins keeps github-actions[bot]',
  mg.resolveTriggerLogins({ repoFullName: 'MervinPraison/PraisonAIUI' }).includes('github-actions[bot]')
);
assert(
  'resolveTriggerLogins prefers explicit config',
  mg.resolveTriggerLogins({ triggerLogins: ['custom-bot'], repoFullName: 'X/Y' }).join() === 'custom-bot'
);

assert('cancelled detect-and-trigger does not block', mg.OPTIONAL_CANCELLED_CHECKS.has('detect-and-trigger'));

const coreGreenRuns = [
  { name: 'test-core', status: 'completed', conclusion: 'success' },
  { name: 'test-core (cli)', status: 'completed', conclusion: 'success' },
  { name: 'smoke', status: 'completed', conclusion: 'cancelled' },
  { name: 'test-windows', status: 'completed', conclusion: 'cancelled' },
];
assert('core green allows cancelled smoke', mg.isAcceptableCheckConclusion(
  { name: 'smoke', status: 'completed', conclusion: 'cancelled' },
  coreGreenRuns
));
assert('core green allows cancelled test-windows', mg.isAcceptableCheckConclusion(
  { name: 'test-windows', status: 'completed', conclusion: 'cancelled' },
  coreGreenRuns
));
assert('cancelled smoke blocks when core missing', !mg.isAcceptableCheckConclusion(
  { name: 'smoke', status: 'completed', conclusion: 'cancelled' },
  [{ name: 'smoke', status: 'completed', conclusion: 'cancelled' }]
));
assert('cancelled smoke blocks when core failed', !mg.isAcceptableCheckConclusion(
  { name: 'smoke', status: 'completed', conclusion: 'cancelled' },
  [
    { name: 'test-core', status: 'completed', conclusion: 'failure' },
    { name: 'smoke', status: 'completed', conclusion: 'cancelled' },
  ]
));
assert('bestRunsByName prefers success over cancelled', (() => {
  const best = mg.bestRunsByName([
    { name: 'smoke', conclusion: 'cancelled' },
    { name: 'smoke', conclusion: 'success' },
  ]);
  return best.length === 1 && best[0].conclusion === 'success';
})());
assert('bestRunsByName prefers pending over completed cancelled', (() => {
  const best = mg.bestRunsByName([
    { name: 'smoke', status: 'completed', conclusion: 'cancelled' },
    { name: 'smoke', status: 'in_progress', conclusion: null },
  ]);
  return best.length === 1 && best[0].status === 'in_progress';
})());
assert('bestRunsByName keeps pending regardless of order', (() => {
  const best = mg.bestRunsByName([
    { name: 'smoke', status: 'in_progress', conclusion: null },
    { name: 'smoke', status: 'completed', conclusion: 'success' },
  ]);
  return best.length === 1 && best[0].status === 'in_progress';
})());
assert('allChecksGreenOnSha style: pending re-run blocks despite core green', (() => {
  const runs = mg.bestRunsByName([
    { name: 'test-core', status: 'completed', conclusion: 'success' },
    { name: 'smoke', status: 'completed', conclusion: 'cancelled' },
    { name: 'smoke', status: 'queued', conclusion: null },
  ]);
  const smoke = runs.find((r) => r.name === 'smoke');
  return smoke.status !== 'completed';
})());

// Stale-FINAL recovery guards (PR #2560 push loop)
const nowMs = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const firstFinal = {
  user: { login: 'MervinPraison' },
  body: '@claude You are the FINAL architecture reviewer.',
  created_at: iso(nowMs - 20 * 60 * 1000),
};
const pushSoonAfter = mg.shouldSkipStaleFinalRecovery(
  [firstFinal],
  iso(nowMs - 16 * 60 * 1000)
);
assert('debounce push soon after FINAL', pushSoonAfter.skip && pushSoonAfter.reason.includes('soon after'));

const secondFinal = {
  user: { login: 'MervinPraison' },
  body: '@claude You are the FINAL architecture reviewer.',
  created_at: iso(nowMs - 20 * 60 * 1000),
};
const capped = mg.shouldSkipStaleFinalRecovery(
  [firstFinal, secondFinal],
  iso(nowMs - 2 * 60 * 1000)
);
assert('hourly cap blocks third FINAL in window', capped.skip && capped.reason.includes('capped'));

const botPush = mg.shouldSkipStaleFinalRecovery(
  [firstFinal],
  iso(nowMs - 16 * 60 * 1000),
  'praisonai-triage-agent[bot]'
);
assert('skip when automation pushed head', botPush.skip && botPush.reason.includes('automation'));

assert('claude automation login', mg.isClaudeAutomationLogin('praisonai-triage-agent[bot]'));

// Bot CHANGES_REQUESTED then APPROVE
const reviews = [
  { user: { login: 'coderabbit[bot]', type: 'Bot' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-06-12T08:00:00Z' },
  { user: { login: 'coderabbit[bot]', type: 'Bot' }, state: 'APPROVED', submitted_at: '2026-06-12T09:00:00Z' },
];
assert('bot approve clears CR', !mg.hasAnyChangesRequested(reviews));
assert('human CR blocks', mg.hasAnyChangesRequested([
  { user: { login: 'MervinPraison', type: 'User' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-06-12T09:00:00Z' },
]));

// Verdict after HEAD
const verdictComments = [
  { user: { login: 'praisonai-triage-agent[bot]' }, body: 'MERGE_GATE_VERDICT: APPROVE', created_at: '2026-06-12T08:00:00Z' },
];
assert('verdict before head rejected', mg.findMergeGateVerdict(verdictComments, null, '2026-06-12T09:00:00Z') === null);
assert('verdict after head accepted', mg.findMergeGateVerdict(
  [{ user: { login: 'praisonai-triage-agent[bot]' }, body: 'MERGE_GATE_VERDICT: APPROVE', created_at: '2026-06-12T10:00:00Z' }],
  null,
  '2026-06-12T09:00:00Z'
) === 'APPROVE');

const fallbackApprove = [
  {
    user: { login: 'praisonai-triage-agent[bot]' },
    body: 'MERGE_GATE_VERDICT: APPROVE\n\nAutomated fallback — Claude assess did not post a verdict comment.',
    created_at: '2026-06-12T10:00:00Z',
  },
];
assert(
  'automated fallback APPROVE ignored when Opus required',
  mg.findMergeGateVerdict(fallbackApprove, null, '2026-06-12T09:00:00Z', { excludeAutomatedFallback: true }) === null
);
assert(
  'automated fallback APPROVE still visible without Opus-only filter',
  mg.findMergeGateVerdict(fallbackApprove, null, '2026-06-12T09:00:00Z') === 'APPROVE'
);

const fallbackBlockNewFormat = [
  {
    user: { login: 'praisonai-triage-agent[bot]' },
    body: 'MERGE_GATE_VERDICT: BLOCK\n\nAutomated fallback — Opus merge gate assessment did not complete.',
    created_at: '2026-06-12T10:00:00Z',
  },
];
assert(
  'new-format fallback BLOCK ignored when Opus required',
  mg.findMergeGateVerdict(fallbackBlockNewFormat, null, '2026-06-12T09:00:00Z', { excludeAutomatedFallback: true }) === null
);
assert(
  'new-format fallback BLOCK detected by marker helper',
  mg.isAutomatedFallbackVerdict(fallbackBlockNewFormat[0].body)
);
assert(
  'findMergeGateVerdict null-safe with explicit null options',
  mg.findMergeGateVerdict(fallbackApprove, null, '2026-06-12T09:00:00Z', null) === 'APPROVE'
);

const noise = [{ user: { login: 'MervinPraison' }, body: '**Merge gate scan** — wait for `@claude`', created_at: new Date().toISOString() }];
assert('diagnostic comment not a trigger', !mg.hasRecentClaudeTrigger(noise, 35));

// Cooldown skip requires an actual verdict on HEAD, not just a FINAL trigger comment
const recentFinalOnHead = [
  {
    user: { login: 'MervinPraison' },
    body: '@claude You are the FINAL architecture reviewer.',
    created_at: '2026-06-27T10:00:00Z',
  },
];
assert(
  'final trigger alone does not count as verdict on head',
  mg.findMergeGateVerdict(recentFinalOnHead, null, '2026-06-27T09:55:00Z') === null
);
const recentVerdictOnHead = [
  ...recentFinalOnHead,
  {
    user: { login: 'github-actions[bot]' },
    body: 'MERGE_GATE_VERDICT: APPROVE',
    created_at: '2026-06-27T10:05:00Z',
  },
];
assert(
  'verdict on head skips cooldown gate',
  mg.findMergeGateVerdict(recentVerdictOnHead, null, '2026-06-27T09:55:00Z') === 'APPROVE'
);

// Sensitive + secrets
assert('workflow path sensitive', mg.sensitivePathReasons([{ filename: '.github/workflows/foo.yml' }]).length === 1);
assert('ci-only label exempts workflows', mg.sensitivePathReasons(
  [{ filename: '.github/workflows/foo.yml' }],
  [mg.WORKFLOW_ONLY_LABEL]
).length === 0);
assert('ci-only label not exempt mixed changes', mg.sensitivePathReasons(
  [{ filename: '.github/workflows/foo.yml' }, { filename: 'src/foo.py' }],
  [mg.WORKFLOW_ONLY_LABEL]
).length === 1);
assert('secret in patch', mg.secretScanReasons([{ filename: 'x.py', patch: '+key = "ghp_abcdefghijklmnopqrstuvwxyz1234567890"' }]).length === 1);

// Claude run scoping — other PR branches must not block
assert('other branch claude does not block', !mg.hasBlockingClaudeRunForPr(
  [{ event: 'issue_comment', head_branch: 'other-branch' }],
  'my-branch'
));
assert('same branch claude blocks', mg.hasBlockingClaudeRunForPr(
  [{ event: 'issue_comment', head_branch: 'my-branch' }],
  'my-branch'
));
assert('issues event never blocks', !mg.hasBlockingClaudeRunForPr(
  [{ event: 'issues', head_branch: 'my-branch' }],
  'my-branch'
));

// Conflict rebase clears after bot completion + FINAL on HEAD (within 12h cooldown)
const conflictNowMs = Date.now();
const conflictIso = (offsetMs) => new Date(conflictNowMs + offsetMs).toISOString();
const conflictTrigger = {
  user: { login: 'MervinPraison' },
  body: '@claude this PR has merge conflicts with main. Please rebase',
  created_at: conflictIso(-30 * 60 * 1000),
};
const rebaseDone = {
  user: { login: 'praisonai-triage-agent[bot]' },
  body: 'Rebase complete — PR #2308 onto latest main',
  created_at: conflictIso(-29 * 60 * 1000),
};
const finalAfterRebase = {
  user: { login: 'MervinPraison' },
  body: '@claude You are the FINAL architecture reviewer.',
  created_at: conflictIso(-20 * 60 * 1000),
};
const headAfterRebase = conflictIso(-21 * 60 * 1000);
const rebaseComments = [conflictTrigger, rebaseDone, finalAfterRebase];
assert('conflict blocks before rebase done', mg.hasRecentConflictComment([conflictTrigger], headAfterRebase));
assert('conflict clears after rebase + FINAL on HEAD', !mg.hasRecentConflictComment(rebaseComments, headAfterRebase));
assert('conflict still blocks without FINAL on HEAD', mg.hasRecentConflictComment(
  [conflictTrigger, rebaseDone],
  headAfterRebase
));

// Tests heuristic
assert('sdk without tests', mg.missingTestsReason([{ filename: 'src/praisonai-agents/a/b.py', additions: 3 }]) !== null);
assert('sdk with tests ok', mg.missingTestsReason([
  { filename: 'src/praisonai-agents/a/b.py', additions: 3 },
  { filename: 'src/praisonai-agents/tests/test_x.py', additions: 10 },
]) === null);

// PR size
assert('large PR blocked', mg.prSizeReasons([{ additions: 900 }]).length > 0);

assert('internal PR link accepted', mg.isInternalPullRequestLink(
  { base: { repo: { full_name: 'MervinPraison/PraisonAI' } } },
  'MervinPraison',
  'PraisonAI'
));
assert('fork sync PR link rejected', !mg.isInternalPullRequestLink(
  { number: 21, base: { repo: { full_name: 'Milkmange/PraisonAI' } } },
  'MervinPraison',
  'PraisonAI'
));

// FINAL completion (#5794 port): the FINAL trigger is never its own completion,
// and a heading-style review reply from the triage bot is.
const finalTrigger = { user: { login: 'MervinPraison' }, body: '@claude You are the FINAL architecture reviewer. ...', created_at: '2026-10-14T22:49:10Z' };
const finalReply = { user: { login: 'praisonai-triage-agent[bot]' }, body: '## Final architecture review: PR #109 (Mirelo SFX 2.0)\n\n### Phase 1: Review against AGENTS.md', created_at: '2026-10-14T22:50:44Z' };
assert('FINAL trigger is not a FINAL reply', !mg.isClaudeFinalReplyComment(finalTrigger));
assert('heading FINAL review reply is a FINAL reply', mg.isClaudeFinalReplyComment(finalReply));
for (const heading of ['## Final review: PR #307', '## Architecture Review — Final Verdict', '## 🧭 Final architecture review — @claude', '## Final Architecture Review — ✅ Approve']) {
  assert(`FINAL reply heading recognised: ${heading}`, mg.isClaudeFinalReplyComment({ user: { login: 'praisonai-triage-agent[bot]' }, body: heading + '\n\nbody' }));
}
assert('FINAL heading from an untrusted commenter is not a reply', !mg.isClaudeFinalReplyComment({ user: { login: 'random-user' }, body: finalReply.body }));
assert('prose mention of "final architecture review" is not a reply', !mg.isClaudeFinalReplyComment(
  { user: { login: 'praisonai-triage-agent[bot]' }, body: 'Waiting for the final architecture review.' }));
assert('stale when HEAD moves after the reply', mg.isStaleFinalAfterPush([finalTrigger, finalReply], '2026-10-15T09:00:00Z'));
assert('current when HEAD predates the trigger', !mg.isStaleFinalAfterPush([finalTrigger, finalReply], '2026-10-14T22:40:00Z'));

// The "pushed soon after FINAL" debounce expires once the push has settled (#5794 port).
{
  const now = Date.now();
  const iso = (ms) => new Date(now + ms).toISOString();
  const trigger = { user: { login: 'MervinPraison' }, body: '@claude You are the FINAL architecture reviewer.', created_at: iso(-3 * 3600e3) };
  const pushedSoonAfter = iso(-3 * 3600e3 + 5 * 60e3); // 5 min after FINAL, ~3h ago
  const g = mg.shouldSkipStaleFinalRecovery([trigger], pushedSoonAfter);
  assert('push-soon-after-FINAL debounce expires after the push settles', !g.skip);
  const recentTrigger = { ...trigger, created_at: iso(-10 * 60e3) };
  const g2 = mg.shouldSkipStaleFinalRecovery([recentTrigger], iso(-5 * 60e3));
  assert('push-soon-after-FINAL debounce holds while the push settles', g2.skip);
  const g3 = mg.shouldSkipStaleFinalRecovery([trigger], pushedSoonAfter, 'praisonai-triage-agent[bot]');
  assert('automation-push skip expires after the push settles', !g3.skip);
}

// Verdicts count only from the gate's own logins; the scan notice is never a verdict.
{
  const head = '2026-10-14T20:00:00Z';
  const forged = { user: { login: 'random-user' }, body: 'MERGE_GATE_VERDICT: APPROVE', created_at: '2026-10-14T23:40:00Z' };
  const block = { user: { login: 'praisonai-triage-agent[bot]' }, body: 'MERGE_GATE_VERDICT: BLOCK\nP1 open', created_at: '2026-10-14T23:35:00Z' };
  assert('forged APPROVE from an untrusted commenter is ignored', mg.findMergeGateVerdict([block, forged], null, head) === 'BLOCK');
  assert('look-alike login is not trusted', mg.findMergeGateVerdict(
    [{ ...forged, user: { login: 'evil-praisonai-triage-agent[bot]' } }], null, head) === null);
  const scanNotice = { user: { login: 'praisonai-triage-agent[bot]' }, body: '**Merge gate scan** — eligible for assessment. Claude merge gate will assess and may auto-merge if `MERGE_GATE_VERDICT: APPROVE`.', created_at: '2026-10-14T23:50:00Z' };
  assert('scan notice is not a verdict', !mg.isMergeGateVerdictComment(scanNotice.body));
  assert('scan notice cannot turn a BLOCK into APPROVE', mg.findMergeGateVerdict([block, scanNotice], null, head) === 'BLOCK');
  assert('quoted verdict mid-line is not a verdict', !mg.isMergeGateVerdictComment('wait for `MERGE_GATE_VERDICT: APPROVE` please'));
}

assert('recent scan notice throttles the next one', mg.hasRecentMergeGateScanComment(
  [{ user: { login: 'praisonai-triage-agent[bot]' }, body: '**Merge gate scan** — eligible', created_at: new Date().toISOString() }]));
assert('old scan notice does not throttle', !mg.hasRecentMergeGateScanComment(
  [{ user: { login: 'praisonai-triage-agent[bot]' }, body: '**Merge gate scan** — eligible', created_at: '2026-01-01T00:00:00Z' }]));

// Fork detection: a deleted fork (no head repo) counts as a fork.
assert('same repo is not a fork', !mg.isForkHeadRepo('o/r', 'o/r'));
assert('other repo is a fork', mg.isForkHeadRepo('someone/r', 'o/r'));
assert('deleted fork counts as a fork', mg.isForkHeadRepo(undefined, 'o/r') && mg.isForkHeadRepo(null, 'o/r'));

// gate-config maxAutoAdditions / maxAutoFiles are honoured (PraisonAI-Tools sets 2000).
{
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-cfg-'));
  const cfg = path.join(dir, 'gate-config.js');
  fs.writeFileSync(cfg, `module.exports = Object.assign({}, require(${JSON.stringify(path.join(__dirname, 'gate-config.example.js'))}), { maxAutoAdditions: 2000, maxAutoFiles: 40 });`);
  const out = execFileSync(process.execPath, ['-e',
    `const m = require(${JSON.stringify(path.join(__dirname, 'merge-gate.js'))}); console.log(JSON.stringify([m.PR_MAX_AUTO_ADDITIONS, m.PR_MAX_AUTO_FILES, m.prSizeReasons([{ additions: 900 }]).length]));`,
  ], { env: { ...process.env, GATE_CONFIG_PATH: cfg } }).toString().trim();
  assert('gate-config maxAutoAdditions/maxAutoFiles honoured', out === '[2000,40,0]');
  fs.rmSync(dir, { recursive: true, force: true });
}

// Starvation guard (#5805 port): a PR the gate already BLOCKed on its current HEAD
// is not re-assessed (and takes no candidate slot) until something changes.
{
  const t0 = Date.parse('2026-10-13T10:00:00Z');
  const isoAt = (ms) => new Date(ms).toISOString();
  const head = isoAt(t0 - 60 * 60 * 1000);
  const block = { user: { login: 'praisonai-triage-agent[bot]' }, body: 'MERGE_GATE_VERDICT: BLOCK\nP1 open', created_at: isoAt(t0) };
  const approve = { user: { login: 'praisonai-triage-agent[bot]' }, body: 'MERGE_GATE_VERDICT: APPROVE', created_at: isoAt(t0) };
  const oldChecks = [{ name: 'test', completed_at: isoAt(t0 - 30 * 60 * 1000) }];
  const newChecks = [...oldChecks, { name: 'lint', completed_at: isoAt(t0 + 10 * 60 * 1000) }];
  const now = t0 + 2 * 60 * 60 * 1000;
  assert('BLOCK on unchanged HEAD is held out', mg.blockedOnUnchangedHead([block], head, oldChecks, now));
  assert('BLOCK is re-assessed once a check completes after it', !mg.blockedOnUnchangedHead([block], head, newChecks, now));
  assert('BLOCK is re-assessed after 24h', !mg.blockedOnUnchangedHead([block], head, oldChecks, t0 + 25 * 60 * 60 * 1000));
  assert('APPROVE never holds a PR out', !mg.blockedOnUnchangedHead([approve], head, oldChecks, now));
  assert('BLOCK from an older HEAD does not count', !mg.blockedOnUnchangedHead([block], isoAt(t0 + 60 * 60 * 1000), oldChecks, now));
  assert('no verdict, no hold-out', !mg.blockedOnUnchangedHead([], head, oldChecks, now));
  const fallback = { ...block, body: 'MERGE_GATE_VERDICT: BLOCK\n\nAutomated fallback — Opus merge gate assessment did not complete.' };
  assert('automated fallback BLOCK does not hold a PR out', !mg.blockedOnUnchangedHead([fallback], head, oldChecks, now));

  const sha = 'ab3416547aaedf4689eb89534e3724b7ae13b08a';
  const body = mg.buildBlockFixRequestBody(sha);
  assert('fix request starts with @claude', /^@claude\b/.test(body));
  assert('fix request avoids the verdict marker', !body.includes('MERGE_GATE_VERDICT'));
  assert('fix request avoids the scan marker', !body.includes(mg.MERGE_GATE_SCAN_MARKER));
  assert('fix request is not a FINAL trigger', !mg.isFinalClaudeTriggerComment({ user: { login: 'MervinPraison' }, body }));
  assert('fix request is not merge-gate noise', !mg.isClaudeTriggerNoise({ body }));
  assert('fix request due when none posted', mg.blockFixRequestDue([], sha));
  const posted = { user: { login: 'MervinPraison' }, body, created_at: isoAt(now) };
  assert('fix request not repeated for the same HEAD', !mg.blockFixRequestDue([posted], sha));
  const other = (s) => ({ user: { login: 'MervinPraison' }, body: mg.buildBlockFixRequestBody(s), created_at: isoAt(now) });
  assert('fix request due again on a new HEAD', mg.blockFixRequestDue([posted], 'f'.repeat(40)));
  assert('fix requests capped per PR', !mg.blockFixRequestDue([other('1'.repeat(40)), other('2'.repeat(40)), other('3'.repeat(40))], 'f'.repeat(40)));

  // Untrusted commenters cannot forge gate state.
  assert('BLOCK from an untrusted commenter is ignored', !mg.blockedOnUnchangedHead([{ ...block, user: { login: 'random-user' } }], head, oldChecks, now));
  assert('fix-request marker from an untrusted commenter is ignored', mg.blockFixRequestDue([{ ...posted, user: { login: 'random-user' } }], sha));
  assert('bare marker text (not the HTML comment) is ignored', mg.blockFixRequestDue([{ ...posted, body: 'see ' + mg.BLOCK_FIX_MARKER + sha.slice(0, 12) }], sha));
}

const asyncTests = (async () => {
  const fakeGithub = (byLabel, openPrs) => ({
    rest: {
      issues: { listForRepo: async ({ labels }) => ({ data: byLabel[labels] || [] }) },
      pulls: { list: async () => ({ data: openPrs }) },
    },
  });
  const pr = (n) => ({ number: n, pull_request: {}, labels: [] });
  const onlyHeld = await mg.listPrNumbersForMergeGateScan(
    fakeGithub({ [mg.BLOCKED_MERGE_GATE_LABEL]: [pr(10)] }, [{ number: 10 }, { number: 20 }]), 'o', 'r', null);
  assert('held-out PRs alone fall back to scanning all open PRs', onlyHeld.includes(20) && onlyHeld.includes(10));
  const mixed = await mg.listPrNumbersForMergeGateScan(
    fakeGithub({ [mg.MERGE_READY_LABEL]: [pr(30), pr(10)], [mg.BLOCKED_MERGE_GATE_LABEL]: [pr(10)] }, []), 'o', 'r', null);
  assert('merge-ready plus held-out PRs are both scanned (deduped)', mixed.join(',') === '10,30');
})();

asyncTests.then(() => process.exit(failed ? 1 : 0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
