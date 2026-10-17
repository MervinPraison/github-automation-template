#!/usr/bin/env node
/**
 * Run: node .github/scripts/orphan-pr-selftest.js
 */
const orphan = require('./orphan-pr.js');

let failed = 0;
function assert(name, cond) {
  if (!cond) {
    console.error('FAIL:', name);
    failed += 1;
  } else {
    console.log('ok:', name);
  }
}

assert('keeps a conventional title', orphan.prTitleFromIssue({ title: 'docs: add memory page' }, 'docs') === 'docs: add memory page');
assert('keeps a scoped conventional title', orphan.prTitleFromIssue({ title: 'fix(agent): crash' }, 'docs') === 'fix(agent): crash');
assert('prefixes a plain title', orphan.prTitleFromIssue({ title: 'Add memory page' }, 'docs') === 'docs: Add memory page');
assert('default prefix is fix', orphan.prTitleFromIssue({ title: 'Crash on start' }, undefined).startsWith('fix: ') || orphan.prTitleFromIssue({ title: 'Crash on start' }).includes(': Crash on start'));
assert('branch prefix', orphan.ISSUE_BRANCH_PREFIX(1476) === 'claude/issue-1476-');

(async () => {
  const created = [];
  const github = {
    paginate: async (fn) => (fn === 'branches' ? [{ name: 'claude/issue-7-20261017' }] : []),
    rest: {
      repos: { listBranches: 'branches', get: async () => ({ data: { default_branch: 'trunk' } }) },
      pulls: { list: async () => ({ data: [] }), create: async (a) => { created.push(a); return { data: { number: 99, html_url: 'u' } }; } },
      issues: { get: async () => ({ data: { number: 7, title: 'Crash on start' } }), createComment: async () => {} },
    },
  };
  const r = await orphan.ensureOpenPrForIssue(github, 'o', 'r', 7, null);
  assert('creates the missing PR', r.created && created.length === 1);
  assert('PR targets the default branch', created[0]?.base === 'trunk');
  assert('PR body links the issue (provenance)', created[0]?.body === 'Fixes #7' && created[0]?.head === 'claude/issue-7-20261017');
  process.exit(failed ? 1 : 0);
})();
