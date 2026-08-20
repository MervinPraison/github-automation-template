/**
 * Example gate-config for template selftests and documentation.
 * install.sh copies profiles/<profile>/gate-config.js.tmpl → target .github/scripts/gate-config.js
 */
module.exports = {
  repoFullName: 'MervinPraison/PraisonAI',
  gitUser: 'MervinPraison',
  gitEmail: '454862+MervinPraison@users.noreply.github.com',
  triggerLogins: ['MervinPraison', 'github-actions[bot]'],
  allowedTriageBots: ['praisonai-triage-agent[bot]'],
  productPathPrefixes: ['src/praisonai-agents/', 'src/praisonai/'],
  sensitivePathPatterns: [
    /^\.github\/workflows\//,
    /praisonaiagents\/(auth|approval|policy|sandbox)\//,
    /^src\/praisonai-agents\/pyproject\.toml$/,
    /^src\/praisonai\/pyproject\.toml$/,
    /\.env(\.|$)/,
    /credentials\.json$/i,
  ],
  requiredCheckPatterns: [/test/i, /smoke/i, /core/i, /python package/i, /comprehensive/i, /optimized/i],
  optionalCancelledChecks: ['detect-and-trigger'],
  optionalCancelledWhenCoreGreen: ['smoke', 'test-windows'],
  ciWorkflowFile: 'test-core.yml',
  ciWorkflowName: 'Core Tests',
  claudeWorkflowName: 'Claude Assistant',
  mergeGateWorkflowRuns: ['Claude Assistant', 'Core Tests'],
  ciFailureWorkflowRuns: ['Core Tests', 'Optimized Test Suite'],
  testCommand: 'cd src/praisonai-agents && PYTHONPATH=. python -m pytest tests/ -x -q --timeout=30',
  docsUrl: 'https://docs.praison.ai',
  architectureDoc: 'AGENTS.md',
  pypiPackageName: 'praisonaiagents',
  packagePaths: ['src/praisonai-agents', 'src/praisonai'],
  finalClaudeScope:
    'SCOPE: Focus ONLY on Python packages (praisonaiagents, praisonai). Do NOT modify praisonai-rust or praisonai-ts.',
  finalClaudeProductValue:
    '4. SDK value: review whether the change genuinely adds value — reject scope creep.',
  mergeGateProductValue: 'Confirm product value gate: no scope creep.',
  mergeGateLayering: 'Layering routing: BLOCK if logic was added to the wrong repo.',
  agentPyChecks: true,
  agentPyPathSuffix: 'praisonaiagents/agent/agent.py',
  reviewBotLogins: ['coderabbitai[bot]', 'qodo-code-review[bot]', 'greptile-apps[bot]'],
  externalRepos: [],
};
