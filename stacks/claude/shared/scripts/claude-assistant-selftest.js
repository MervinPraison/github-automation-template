#!/usr/bin/env node
/**
 * Self-test for the Claude Assistant workflow's security gates. It runs the
 * real inline scripts from the workflow YAML (no copies) against mocks:
 *   - who may start the write-capable agent (actor gate)
 *   - which new issues get the `claude` label automatically (triage)
 *   - fork detection (fork PR code is never checked out)
 *   - repo prompt settings from gate-config.js
 * and checks every input passed to the vendored claude-code-action is declared.
 * Run: node .github/scripts/claude-assistant-selftest.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let failed = 0;
function assert(name, cond) {
  if (!cond) {
    console.error('FAIL:', name);
    failed++;
  } else {
    console.log('ok:', name);
  }
}

// Hub repo (.github/scripts), stack copy (stacks/claude/shared/scripts) and a
// copy-mode install (.github/scripts next to .github/workflows/claude.yml).
const WORKFLOW_CANDIDATES = [
  '../workflows/claude-assistant-callable.yml',
  '../../stacks/claude/profiles/sdk/claude.yml.tmpl',
  '../../profiles/sdk/claude.yml.tmpl',
  '../workflows/claude.yml',
];
const ACTION_CANDIDATES = [
  '../actions/claude-code-action/action.yml',
  '../../stacks/claude/shared/actions/claude-code-action/action.yml',
  '../../shared/actions/claude-code-action/action.yml',
];

const existing = (list) => [...new Set(list.map((p) => path.resolve(__dirname, p)))].filter((p) => fs.existsSync(p));

/** Lines of the top-level job `name` (2-space indent under `jobs:`). */
function jobBlock(text, name) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[end])) end++;
  return lines.slice(start, end);
}

/** The `script: |` body of the step named `stepName`, dedented. */
function stepScript(job, stepName) {
  const i = job.findIndex((l) => l.trim() === `- name: ${stepName}`);
  if (i < 0) return null;
  const stepIndent = job[i].indexOf('-');
  let j = i + 1;
  while (j < job.length && !/^\s+script: \|\s*$/.test(job[j])) {
    if (job[j].trim().startsWith('- ') && job[j].indexOf('-') === stepIndent) return null;
    j++;
  }
  if (j >= job.length) return null;
  const scriptIndent = job[j].indexOf('script:');
  const body = [];
  for (let k = j + 1; k < job.length; k++) {
    const l = job[k];
    if (l.trim() === '') { body.push(''); continue; }
    if (l.search(/\S/) <= scriptIndent) break;
    body.push(l);
  }
  const pad = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(pad)).join('\n');
}

function firstStepName(job) {
  const i = job.findIndex((l) => l.trim() === 'steps:');
  for (let k = i + 1; k < job.length; k++) {
    const m = job[k].match(/^\s+- (?:name|uses): (.+)$/);
    if (m) return m[1].trim();
  }
  return null;
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
async function runScript(body, { github = {}, context = {}, env = {} } = {}) {
  const result = { failedMsg: null, outputs: {}, info: [] };
  const core = {
    info: (m) => result.info.push(m),
    warning: (m) => result.info.push(m),
    setFailed: (m) => { result.failedMsg = m; },
    setOutput: (k, v) => { result.outputs[k] = v; },
  };
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    await new AsyncFunction('github', 'context', 'core', 'require', body)(github, context, core, require);
  } catch (err) {
    result.error = err;
    result.failedMsg = `script threw: ${err.message}`;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return result;
}

const permissionGithub = (perms, calls) => ({
  rest: {
    repos: {
      getCollaboratorPermissionLevel: async ({ username }) => {
        calls.push(username);
        if (!(username in perms)) {
          const err = new Error('Not Found');
          err.status = 404;
          throw err;
        }
        return { data: { permission: perms[username] } };
      },
    },
  },
});
const repoCtx = (extra) => ({ repo: { owner: 'acme', repo: 'widgets' }, ...extra });

async function testWorkflow(file) {
  const label = path.relative(path.resolve(__dirname, '../..'), file);
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes('\n  claude-response:')) {
    console.log(`skip: ${label} (thin caller, no claude-response job)`);
    return;
  }
  const job = jobBlock(text, 'claude-response');

  // --- Actor gate --------------------------------------------------------
  const ifBlock = job.slice(0, job.findIndex((l) => /^\s{4}concurrency:/.test(l))).join('\n');
  assert(`${label}: job if requires OWNER/MEMBER/COLLABORATOR for comments`,
    /comment\.author_association/.test(ifBlock) && /review\.author_association/.test(ifBlock)
    && ifBlock.includes('["OWNER","MEMBER","COLLABORATOR"]'));
  assert(`${label}: authorize step runs before any token is minted`,
    firstStepName(job) === 'Authorize requester (write access required)');
  const gate = stepScript(job, 'Authorize requester (write access required)');
  assert(`${label}: authorize step script found`, !!gate);
  if (gate) {
    const scenarios = [
      ['external commenter (no access) is refused', { comment: { user: { login: 'stranger' } } }, 'stranger', {}, true],
      ['read-only collaborator is refused', { comment: { user: { login: 'reader' } } }, 'reader', { reader: 'read' }, true],
      ['writer may invoke', { comment: { user: { login: 'dev' } } }, 'dev', { dev: 'write' }, false],
      ['admin may invoke', { review: { user: { login: 'boss' } } }, 'boss', { boss: 'admin' }, false],
      ['labeler without write is refused', { sender: { login: 'triager' } }, 'triager', { triager: 'read' }, true],
      ['github-actions[bot] automation is trusted', { comment: { user: { login: 'github-actions[bot]' } } }, 'github-actions[bot]', {}, false],
      ['triage App label on a writer\'s issue is trusted', { sender: { login: 'praisonai-triage-agent[bot]' }, issue: { user: { login: 'dev' } } }, 'praisonai-triage-agent[bot]', { dev: 'write' }, false],
      ['triage App label on an App-created issue is trusted', { sender: { login: 'praisonai-triage-agent[bot]' }, issue: { user: { login: 'praisonai-triage-agent[bot]' } } }, 'praisonai-triage-agent[bot]', {}, false],
      // Deliberate: outsider issues run, with untrusted-input rules and a security review before merge.
      ['triage App label on an outsider issue is trusted', { sender: { login: 'praisonai-triage-agent[bot]' }, issue: { user: { login: 'stranger' } } }, 'praisonai-triage-agent[bot]', {}, false],
      ['a person pretending to be the App is not trusted', { sender: { login: 'praisonai-triage-agent[bot]' }, issue: { user: { login: 'stranger' } } }, 'stranger', {}, true],
      ['bot login on a comment by someone else is not trusted', { comment: { user: { login: 'github-actions[bot]' } } }, 'stranger', {}, true],
    ];
    for (const [name, payload, actor, perms, refuse] of scenarios) {
      const calls = [];
      const eventName = payload.comment ? 'issue_comment' : payload.review ? 'pull_request_review' : 'issues';
      const r = await runScript(gate, { github: permissionGithub(perms, calls), context: repoCtx({ payload, actor, eventName }) });
      assert(`${label}: ${name}`, refuse ? !!r.failedMsg : !r.failedMsg);
    }
  }

  // --- Fork handling -------------------------------------------------------
  const forkScript = stepScript(job, 'Check for Fork PR');
  assert(`${label}: fork check step found`, !!forkScript);
  if (forkScript) {
    for (const [name, headRepo, expected] of [
      ['same-repo PR is not a fork', { full_name: 'acme/widgets' }, 'false'],
      ['other-repo PR is a fork', { full_name: 'someone/widgets' }, 'true'],
      ['deleted fork counts as a fork', null, 'true'],
    ]) {
      const github = {
        rest: { pulls: { get: async () => ({ data: { head: { ref: 'b', repo: headRepo }, mergeable_state: 'clean' } }) } },
        graphql: async () => ({ repository: { pullRequest: { mergeStateStatus: 'CLEAN' } } }),
      };
      const r = await runScript(forkScript, {
        github, context: repoCtx({ eventName: 'issue_comment', payload: { issue: { number: 7, pull_request: {} } } }),
      });
      assert(`${label}: ${name}`, r.outputs.is_fork === expected && r.outputs.is_pr === 'true');
    }
  }
  const fetchIdx = job.findIndex((l) => l.trim() === '- name: Fetch PR branch and Setup Remote');
  assert(`${label}: fork PR branch is never fetched`,
    fetchIdx >= 0 && /is_fork != 'true'/.test(job[fetchIdx + 1] || ''));
  const actionWith = job.join('\n');
  const forkToken = job.slice(job.findIndex((l) => l.includes('id: app-token-fork'))).slice(0, 12).join('\n');
  assert(`${label}: fork PRs get a comment-only App token`,
    /if: steps\.check_fork\.outputs\.is_fork == 'true'/.test(forkToken)
    && /permission-contents: read/.test(forkToken) && /permission-pull-requests: read/.test(forkToken));
  const fullToken = job.slice(job.findIndex((l) => l.trim() === 'id: app-token')).slice(0, 3).join('\n');
  assert(`${label}: full App token is never minted for fork PRs`, /if: steps\.check_fork\.outputs\.is_fork != 'true'/.test(fullToken));
  const checkoutIdx = job.findIndex((l) => l.trim() === '- name: Checkout repository');
  assert(`${label}: checkout uses the default branch`,
    /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/.test(job.slice(checkoutIdx, checkoutIdx + 8).join('\n')));
  const trustedIdx = job.findIndex((l) => l.trim() === '- name: Use trusted gate-config');
  assert(`${label}: scripts after the PR fetch use the trusted gate-config copy`,
    trustedIdx > fetchIdx && /trusted-gate-config\/gate-config\.js/.test(job[trustedIdx + 1] || ''));
  assert(`${label}: fork reviews get no shell or file tools`,
    /disallowed_tools: \$\{\{ steps\.check_fork\.outputs\.is_fork == 'true' && 'Bash,Edit,Write,[^']*Read[^']*'/.test(actionWith));
  // The fork token keeps issues: write so Claude can comment; an App-authored
  // issue labelled `claude` would otherwise launder fork text into a full run.
  const forkDeny = (actionWith.match(/is_fork == 'true' && '([^']*)'/) || [])[1] || '';
  for (const tool of ['mcp__github__create_issue', 'mcp__github__update_issue', 'mcp__github__merge_pull_request',
    'mcp__github__push_files', 'mcp__github__create_or_update_file', 'mcp__github__create_pull_request_review']) {
    assert(`${label}: fork reviews deny ${tool}`, forkDeny.split(',').includes(tool));
  }

  // --- Repo prompt settings -------------------------------------------------
  const settings = stepScript(job, 'Load repo settings');
  assert(`${label}: repo settings step found`, !!settings);
  if (settings) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ws-'));
    process.env.RUNNER_TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-temp-'));
    const none = await runScript(settings, { context: repoCtx({}), env: { GITHUB_WORKSPACE: ws } });
    assert(`${label}: settings default without gate-config`,
      none.outputs.git_email === '454862+MervinPraison@users.noreply.github.com'
      && none.outputs.test_command === '' && /SCOPE:/.test(none.outputs.scope));
    fs.mkdirSync(path.join(ws, '.github/scripts'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.github/scripts/gate-config.js'),
      "module.exports = { gitUser: 'bot', gitEmail: 'bot@example.com', testCommand: 'npm test', finalClaudeScope: 'SCOPE: widgets only' };");
    const cfg = await runScript(settings, { context: repoCtx({}), env: { GITHUB_WORKSPACE: ws } });
    assert(`${label}: settings read from gate-config`,
      cfg.outputs.git_user === 'bot' && cfg.outputs.git_email === 'bot@example.com'
      && cfg.outputs.test_command === 'npm test' && cfg.outputs.scope === 'SCOPE: widgets only');
    assert(`${label}: settings step keeps a trusted gate-config copy`,
      fs.existsSync(path.join(process.env.RUNNER_TEMP, 'trusted-gate-config', 'gate-config.js')));
    fs.rmSync(ws, { recursive: true, force: true });
    const settingsIdx = job.findIndex((l) => l.trim() === '- name: Load repo settings');
    assert(`${label}: settings read before the PR branch is fetched`, settingsIdx >= 0 && settingsIdx < fetchIdx);
  }

  // --- Prompt portability -----------------------------------------------------
  const promptStart = job.findIndex((l) => l.trim() === 'direct_prompt: |');
  const promptEnd = job.findIndex((l, i) => i > promptStart && l.trim() === 'allowed_tools: |');
  const prompt = job.slice(promptStart, promptEnd).join('\n');
  assert(`${label}: prompt has no unrendered {{PLACEHOLDERS}}`, !/\{\{\s*[A-Z_]+\s*\}\}/.test(prompt));
  assert(`${label}: prompt does not hard-code the PraisonAI monorepo`,
    !/MervinPraison\/PraisonAI\b|THIS repo — PraisonAI|praisonaiagents, praisonai/.test(prompt));
  assert(`${label}: prompt does not use unset $ISSUE_NUMBER`, !prompt.includes('$ISSUE_NUMBER'));

  // --- Triage: who gets the `claude` label automatically -----------------------
  const triage = stepScript(jobBlock(text, 'issue-triage') || [], 'Triage and acknowledge issue');
  assert(`${label}: triage step found`, !!triage);
  if (triage) {
    const run = async (issue, perms) => {
      const labels = [];
      const comments = [];
      const calls = [];
      const github = permissionGithub(perms, calls);
      github.rest.issues = {
        addLabels: async ({ labels: l }) => labels.push(...l),
        createComment: async ({ body }) => comments.push(body),
      };
      await runScript(triage, { github, context: repoCtx({ payload: { issue } }) });
      return { labels, comments };
    };
    const ext = await run({ number: 1, title: 'bug: crash on start', body: 'traceback', author_association: 'NONE', user: { login: 'stranger' } }, {});
    assert(`${label}: external actionable bug is triaged`, ext.labels.includes('bug'));
    // Deliberate: outsider work flows, with untrusted-input rules and a security review before merge.
    assert(`${label}: external actionable bug gets the claude label`, ext.labels.includes('claude'));
    const chat = await run({ number: 4, title: 'How do I configure X?', body: 'question', author_association: 'NONE', user: { login: 'stranger' } }, {});
    assert(`${label}: external non-actionable issue does not get the claude label`, !chat.labels.includes('claude'));
    assert(`${label}: welcome comment links the calling repo`,
      ext.comments.length === 1 && ext.comments[0].includes('https://github.com/acme/widgets/issues')
      && !ext.comments[0].includes('MervinPraison/PraisonAI'));
    const owner = await run({ number: 2, title: 'tidy docs', body: '', author_association: 'OWNER', user: { login: 'boss' } }, { boss: 'admin' });
    assert(`${label}: maintainer issue gets the claude label`, owner.labels.includes('claude') && owner.comments.length === 0);
    const reader = await run({ number: 3, title: 'tidy x', body: '', author_association: 'COLLABORATOR', user: { login: 'reader' } }, { reader: 'read' });
    assert(`${label}: read-only collaborator is treated like an outsider (non-actionable: no label)`, !reader.labels.includes('claude'));
  }
}

/** The merge gate assessor runs Claude on PR content: read-only token, no write tools. */
function testMergeGate(file) {
  const label = path.relative(path.resolve(__dirname, '../..'), file);
  const job = jobBlock(fs.readFileSync(file, 'utf8'), 'claude-assess');
  if (!job) return;
  const text = job.join('\n');
  const tokenAt = job.findIndex((l) => l.trim() === 'id: app-token');
  const token = job.slice(tokenAt, tokenAt + 12).join('\n');
  assert(`${label}: assessor App token is read-only for code and PRs`,
    /permission-contents: read/.test(token) && /permission-pull-requests: read/.test(token) && !/: write[\s\S]*permission-contents/.test(token));
  // Each Claude step's deny list, inline ("A,B,C") or as a YAML block.
  const deniedBy = (stepName) => {
    const at = text.indexOf(`- name: ${stepName}`);
    if (at < 0) return null;
    const next = text.indexOf('\n      - ', at + 1);
    const step = text.slice(at, next < 0 ? undefined : next);
    const m = /disallowed_tools: (\|\n((?:\s{12,}\S.*\n?)+)|(.+))/.exec(step);
    if (!m) return new Set();
    return new Set((m[2] || m[3]).split(/[,\n]/).map((t) => t.trim()).filter(Boolean));
  };
  const required = ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Task', 'Read', 'Glob', 'Grep',
    'mcp__github__push_files', 'mcp__github__merge_pull_request', 'mcp__github__create_or_update_file'];
  for (const step of ['Claude merge gate assessment (read-only)', 'Independent security review (outsider-origin PRs)']) {
    const deny = deniedBy(step);
    assert(`${label}: step found: ${step}`, !!deny);
    for (const tool of required) assert(`${label}: ${step} denies ${tool}`, !!deny && deny.has(tool));
  }
  assert(`${label}: the assess job never checks out PR code`, !/fetch origin "pull\/|git checkout/.test(text));
  assert(`${label}: relay reads only Opus's final result`, !/line\.includes\('MERGE_GATE_VERDICT/.test(text));
}

/** Every `with:` key passed to the vendored action must be one of its inputs. */
function testActionInputs(workflowFiles, actionFile) {
  const declared = new Set();
  const actionLines = fs.readFileSync(actionFile, 'utf8').split('\n');
  const inputsAt = actionLines.indexOf('inputs:');
  for (let i = inputsAt + 1; i < actionLines.length && !/^\S/.test(actionLines[i]); i++) {
    const m = actionLines[i].match(/^ {2}([a-z_]+):\s*$/);
    if (m) declared.add(m[1]);
  }
  for (const file of workflowFiles) {
    const label = path.relative(path.resolve(__dirname, '../..'), file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/uses: \.\/(_hub\/)?\.github\/actions\/claude-code-action\s*$/.test(line)) return;
      const stepIndent = line.search(/\S/);
      const unknown = [];
      let withIndent = -1;
      for (let k = i + 1; k < lines.length; k++) {
        const l = lines[k];
        if (l.trim() === '') continue;
        const ind = l.search(/\S/);
        if (ind < stepIndent || (ind === stepIndent && l.trim().startsWith('- '))) break;
        if (l.trim() === 'with:') { withIndent = ind; continue; }
        if (withIndent >= 0 && ind <= withIndent) withIndent = -1;
        const m = withIndent >= 0 && ind === withIndent + 2 && l.match(/^\s+([a-z_]+):/);
        if (m && !declared.has(m[1])) unknown.push(m[1]);
      }
      assert(`${label}:${i + 1}: claude-code-action inputs are all declared${unknown.length ? ` (unknown: ${unknown.join(', ')})` : ''}`, unknown.length === 0);
    });
  }
}

(async () => {
  const workflows = existing(WORKFLOW_CANDIDATES);
  if (workflows.length === 0) {
    console.log('skip: no Claude Assistant workflow next to these scripts');
    process.exit(0);
  }
  for (const wf of workflows) await testWorkflow(wf);
  for (const mg of existing(['../workflows/claude-merge-gate-callable.yml', '../../stacks/claude/profiles/sdk/claude-merge-gate.yml.tmpl', '../../profiles/sdk/claude-merge-gate.yml.tmpl', '../workflows/claude-merge-gate.yml'])) {
    testMergeGate(mg);
  }

  const actions = existing(ACTION_CANDIDATES);
  if (actions.length) {
    const dirs = [...new Set(workflows.map((f) => path.dirname(f)))];
    const all = dirs.flatMap((d) => fs.readdirSync(d).filter((f) => /\.ya?ml(\.tmpl)?$/.test(f)).map((f) => path.join(d, f)));
    testActionInputs(all, actions[0]);
  }
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
