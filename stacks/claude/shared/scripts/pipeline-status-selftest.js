#!/usr/bin/env node
/**
 * Run: node .github/scripts/pipeline-status-selftest.js
 */
const ps = require('./pipeline-status.js');
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

const kickComments = [
  { user: { login: 'MervinPraison' }, body: '@coderabbitai review' },
  { user: { login: 'MervinPraison' }, body: '/review' },
];

const finalComment = {
  user: { login: 'MervinPraison' },
  body: '@claude You are the FINAL architecture reviewer.',
  created_at: '2026-06-26T10:00:00Z',
};

assert(
  'reviews pending when not kicked',
  ps.deriveStage([], { ready: false, reasons: ['no FINAL Claude review trigger'] })
    === 'pipeline/reviews-pending'
);
assert(
  'final pending after kick',
  ps.deriveStage(kickComments, { ready: false, reasons: ['no FINAL Claude review trigger'] })
    === 'pipeline/final-claude-pending'
);
assert(
  'awaiting merge gate after final',
  ps.deriveStage(
    [...kickComments, finalComment],
    { ready: false, reasons: ['recent @claude within 35min'] }
  ) === 'pipeline/awaiting-merge-gate'
);
assert(
  'merge ready',
  ps.deriveStage([...kickComments, finalComment], { ready: true, reasons: [] })
    === 'pipeline/merge-ready'
);

const blockers = ps.deriveBlockerLabels({
  ready: false,
  reasons: ['CI not green on HEAD', 'SDK code added without test file changes — requires manual review'],
});
assert('maps ci blocker', blockers.includes('pipeline/blocked:ci'));
assert('maps manual blocker', blockers.includes('pipeline/blocked:manual-review'));

assert(
  'internal link matches upstream base',
  mg.isInternalPullRequestLink(
    { base: { repo: { full_name: 'MervinPraison/PraisonAI' } } },
    'MervinPraison',
    'PraisonAI'
  )
);
assert(
  'fork sync link rejected',
  !mg.isInternalPullRequestLink(
    { number: 21, base: { repo: { full_name: 'Milkmange/PraisonAI' } } },
    'MervinPraison',
    'PraisonAI'
  )
);

(async () => {
  for (const status of [422, 403]) {
    let createAttempts = 0;
    const github = {
      rest: {
        issues: {
          listLabelsForRepo: async () => ({ data: [] }),
          createLabel: async () => {
            createAttempts += 1;
            const err = new Error('label create failed');
            err.status = status;
            throw err;
          },
        },
      },
    };
    try {
      await ps.ensurePipelineLabels(github, 'owner', 'repo', { info: () => {} });
      assert(`ensurePipelineLabels skips ${status}`, createAttempts === ps.ALL_PIPELINE_LABELS.length);
    } catch (e) {
      assert(`ensurePipelineLabels skips ${status}`, false);
    }
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
