'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findProjectConfig, inspectConfigFile, USER_CONFIG_NAME } = require('../core/config.cjs');
const { allLedgerDirs } = require('./ledger-dirs.cjs');

const norm = (p) => p.replace(/\\/g, '/').toLowerCase();

function codexTrusted(configFile, hooksFile) {
  let text;
  try { text = fs.readFileSync(configFile, 'utf8'); } catch { return 'unknown'; }
  const want = norm(hooksFile);
  for (const line of text.split(/\r?\n/)) {
    const m = /^\[hooks\.state\.'(.+):stop:\d+:\d+'\]/.exec(line.trim());
    if (m && norm(m[1]) === want) return true;
  }
  return false;
}

function readJsonObject(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function claudeInstalled(homeDir) {
  const claudeDir = path.join(homeDir, '.claude');
  const installed = readJsonObject(path.join(claudeDir, 'plugins', 'installed_plugins.json'));
  if (installed && typeof installed === 'object') {
    const table = installed.plugins && typeof installed.plugins === 'object' ? installed.plugins : installed;
    if (Object.keys(table).some((k) => k.startsWith('proof-of-green@'))) return true;
  }
  const settings = readJsonObject(path.join(claudeDir, 'settings.json'));
  const enabled = settings && settings.enabledPlugins;
  if (enabled && typeof enabled === 'object') {
    return Object.entries(enabled).some(([k, v]) => k.startsWith('proof-of-green@') && Boolean(v));
  }
  return false;
}

function doctor({ homeDir = os.homedir(), env = process.env, platform = process.platform, cwd } = {}) {
  const hooksFile = path.join(homeDir, '.codex', 'hooks.json');
  let codexInstalled = false;
  try {
    const data = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
    const has = (event, suffix) => {
      const groups = data && data.hooks && data.hooks[event];
      return Array.isArray(groups) && groups.some(
        (g) => g && Array.isArray(g.hooks) && g.hooks.some(
          (h) => h && typeof h.command === 'string' && h.command.includes('gate.cjs" codex ' + suffix),
        ),
      );
    };
    codexInstalled = has('PostToolUse', 'post-tool') && has('Stop', 'stop');
  } catch { /* missing or unreadable: not installed */ }

  const ledgerDirs = allLedgerDirs({ homeDir, env, platform });
  // One line per error: the timestamped first line of each entry, newest last across all dirs.
  // Stack frames are left out; the log itself keeps them.
  const entries = [];
  for (const dir of ledgerDirs) {
    try {
      for (const l of fs.readFileSync(path.join(dir, 'errors.log'), 'utf8').split(/\r?\n/)) {
        if (/^\d{4}-\d\d-\d\dT[\d:.]+Z /.test(l)) entries.push(l);
      }
    } catch { /* no log */ }
  }
  entries.sort((a, b) => (a.slice(0, 24) < b.slice(0, 24) ? -1 : a.slice(0, 24) > b.slice(0, 24) ? 1 : 0));
  const projectFile = cwd ? findProjectConfig(cwd).file : null;
  return {
    claude: { installed: claudeInstalled(homeDir) },
    config: {
      user: inspectConfigFile(path.join(path.resolve(homeDir), USER_CONFIG_NAME)),
      project: inspectConfigFile(projectFile),
    },
    codex: {
      installed: codexInstalled,
      trusted: codexTrusted(path.join(homeDir, '.codex', 'config.toml'), hooksFile),
    },
    ledgerDirs,
    lastErrors: entries.slice(-5),
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function configLine(label, c) {
  const where = c.path || 'none';
  if (!c.exists) return `${label} config: ${where} (missing)`;
  if (!c.valid) return `${label} config: ${where} (invalid JSON)`;
  return `${label} config: ${where} (${plural(c.testTools, 'test tool')}, ${plural(c.editTools, 'edit tool')}${c.skipped ? `, ${c.skipped} skipped` : ''})`;
}

function formatReport(r) {
  const trust = !r.codex.installed ? 'n/a (Codex hooks not installed)'
    : r.codex.trusted === 'unknown' ? 'unknown (no ~/.codex/config.toml)'
    : r.codex.trusted ? 'yes' : 'NO - run /hooks in Codex and trust them';
  return [
    'proof-of-green doctor',
    `Claude Code plugin installed: ${r.claude.installed ? 'yes' : 'no'}`,
    `Codex hooks installed:        ${r.codex.installed ? 'yes' : 'no'}`,
    `Codex hooks trusted:          ${trust}`,
    configLine('User', r.config.user),
    configLine('Project', r.config.project),
    'Ledger dirs:',
    ...r.ledgerDirs.map((d) => `  ${d}`),
    r.lastErrors.length ? 'Last errors:' : 'Last errors: none',
    ...r.lastErrors.map((l) => `  ${l}`),
  ].join('\n');
}

module.exports = { doctor, formatReport };
