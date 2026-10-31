'use strict';
const { loadConfig } = require('./core/config.cjs');
const { ledgerDir, logError } = require('./core/ledger.cjs');
const { handleClaude } = require('./adapters/claude.cjs');

const CLAUDE_EVENTS = new Set(['user-prompt', 'post-tool', 'post-tool-failure', 'stop']);

function parsePayload(stdinText) {
  try {
    const data = JSON.parse(stdinText);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

function main(argv, stdinText, env) {
  const [agent, event] = Array.isArray(argv) ? argv : [];
  try {
    if (agent !== 'claude' || !CLAUDE_EVENTS.has(event)) return '{}';
    const payload = parsePayload(stdinText);
    const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
    const config = loadConfig(cwd, env);
    const result = handleClaude(event, payload, { dir: ledgerDir(agent, env), config, env });
    return JSON.stringify(result);
  } catch (err) {
    try { logError(ledgerDir(agent || 'claude', env), err); } catch { /* fail open */ }
    return '{}';
  }
}

if (require.main === module) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    process.stdout.write(main(process.argv.slice(2), Buffer.concat(chunks).toString('utf8'), process.env));
    process.exitCode = 0;
  });
  process.stdin.on('error', () => {
    process.stdout.write('{}');
    process.exitCode = 0;
  });
}

module.exports = { main };
