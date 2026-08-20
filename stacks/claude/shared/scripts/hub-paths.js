/**
 * Resolve gate-config from consumer repo (hub mode) or local copy (legacy/selftest).
 */
const path = require('path');
const fs = require('fs');

function resolveGateConfigPath() {
  if (process.env.GATE_CONFIG_PATH && fs.existsSync(process.env.GATE_CONFIG_PATH)) {
    return process.env.GATE_CONFIG_PATH;
  }
  const sibling = path.join(__dirname, 'gate-config.js');
  if (fs.existsSync(sibling)) return sibling;
  const example = path.join(__dirname, 'gate-config.example.js');
  if (fs.existsSync(example)) return example;
  const ws = process.env.GITHUB_WORKSPACE;
  if (ws) {
    const local = path.join(ws, '.github/scripts/gate-config.js');
    if (fs.existsSync(local)) return local;
  }
  return example;
}

function hubScriptsDir() {
  if (process.env.HUB_SCRIPTS) return process.env.HUB_SCRIPTS;
  if (process.env.GITHUB_WORKSPACE) {
    return path.join(process.env.GITHUB_WORKSPACE, '.github/scripts');
  }
  return __dirname;
}

module.exports = { resolveGateConfigPath, hubScriptsDir };
