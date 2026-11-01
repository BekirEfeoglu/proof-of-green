'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ledgerDir } = require('../core/ledger.cjs');

// Outside a hook CLAUDE_PLUGIN_DATA is unset, so find the plugin's data dir (named <plugin>-<marketplace>) directly.
function claudePluginLedgerDirs(homeDir) {
  const dataDir = path.join(homeDir, '.claude', 'plugins', 'data');
  try {
    return fs.readdirSync(dataDir)
      .filter((name) => name.startsWith('proof-of-green'))
      .map((name) => path.join(dataDir, name, 'ledgers'))
      .filter((dir) => fs.existsSync(dir));
  } catch {
    return [];
  }
}

function allLedgerDirs({ homeDir, env, platform }) {
  return [...new Set([
    ...claudePluginLedgerDirs(homeDir),
    ledgerDir('claude', env, platform, homeDir),
    ledgerDir('codex', env, platform, homeDir),
  ])];
}

module.exports = { allLedgerDirs };
