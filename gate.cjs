'use strict';
const { loadConfig } = require('./core/config.cjs');
const { ledgerDir, logError, debugLog } = require('./core/ledger.cjs');
const { handleClaude } = require('./adapters/claude.cjs');
const { handleCodex } = require('./adapters/codex.cjs');

const ADAPTERS = {
  claude: { handle: handleClaude, events: new Set(['user-prompt', 'post-tool', 'post-tool-failure', 'stop']) },
  codex: { handle: handleCodex, events: new Set(['post-tool', 'stop']) },
};

function parsePayload(stdinText) {
  try {
    const data = JSON.parse(stdinText);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

function main(argv, stdinText, env) {
  const [agent, event] = Array.isArray(argv) ? argv : [];
  try {
    const adapter = Object.prototype.hasOwnProperty.call(ADAPTERS, agent) ? ADAPTERS[agent] : null;
    if (!adapter || !adapter.events.has(event)) return '{}';
    const payload = parsePayload(stdinText);
    if (env && env.PROOF_OF_GREEN_DEBUG === '1') debugLog(ledgerDir(agent, env), agent, event, payload);
    const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
    const config = loadConfig(cwd, env);
    const result = adapter.handle(event, payload, { dir: ledgerDir(agent, env), config, env });
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
