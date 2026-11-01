#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ledgerDir, readLedgerFile } = require('../core/ledger.cjs');
const { loadConfig, findProjectConfig, inspectConfigFile, USER_CONFIG_NAME } = require('../core/config.cjs');
const { stopDecision, parentRecords, withNote } = require('../adapters/common.cjs');

const PKG_ROOT = path.join(__dirname, '..');
const TRUST_NOTE =
  'Codex skips new hooks until you trust them: run /hooks in Codex and trust the proof-of-green hooks.';
const CODEX_NOTE = 'Note: Codex results are read from the session log only at Stop, so this verdict may differ.';
const USAGE = 'Usage: proof-of-green install codex | uninstall codex | doctor [--json] | status [--json]';

const toSlash = (p) => p.replace(/\\/g, '/');
const norm = (p) => toSlash(p).toLowerCase();

function copyApp(appDir) {
  fs.mkdirSync(appDir, { recursive: true });
  fs.copyFileSync(path.join(PKG_ROOT, 'gate.cjs'), path.join(appDir, 'gate.cjs'));
  for (const sub of ['core', 'adapters']) {
    fs.mkdirSync(path.join(appDir, sub), { recursive: true });
    for (const name of fs.readdirSync(path.join(PKG_ROOT, sub))) {
      if (name.endsWith('.cjs')) {
        fs.copyFileSync(path.join(PKG_ROOT, sub, name), path.join(appDir, sub, name));
      }
    }
  }
}

function readHooksFile(hooksFile) {
  let text;
  try { text = fs.readFileSync(hooksFile, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return { hooks: {} };
    throw err;
  }
  let data;
  try { data = JSON.parse(text); } catch (err) {
    throw new Error(`${hooksFile} is not valid JSON (${err.message}); fix or remove it, then run the command again.`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${hooksFile} must contain a JSON object; fix or remove it, then run the command again.`);
  }
  if (data.hooks === undefined) data.hooks = {};
  if (!data.hooks || typeof data.hooks !== 'object' || Array.isArray(data.hooks)) {
    throw new Error(`${hooksFile} has a "hooks" value that is not an object; fix it, then run the command again.`);
  }
  return data;
}

function codexPaths({ homeDir, env, platform }) {
  const appDir = path.join(ledgerDir('codex', env, platform, homeDir), 'app');
  const base = `node "${toSlash(appDir)}/gate.cjs" codex`;
  return {
    appDir,
    hooksFile: path.join(homeDir, '.codex', 'hooks.json'),
    wanted: [
      { event: 'PostToolUse', matcher: 'apply_patch|Bash|mcp__.*', v01Matcher: 'apply_patch|Bash', command: `${base} post-tool` },
      { event: 'Stop', command: `${base} stop` },
    ],
  };
}

function installCodex({ homeDir = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const { appDir, hooksFile, wanted } = codexPaths({ homeDir, env, platform });
  const data = readHooksFile(hooksFile); // throws before anything is written
  copyApp(appDir);

  const added = [];
  const updated = [];
  for (const { event, matcher, v01Matcher, command } of wanted) {
    const groups = Array.isArray(data.hooks[event]) ? data.hooks[event] : [];
    const ours = groups.filter(
      (g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => h && h.command === command),
    );
    if (ours.length) {
      // Only the exact v0.1 matcher is upgraded in place; a hand-edited matcher is left alone.
      const stale = v01Matcher ? ours.filter((g) => g.matcher === v01Matcher) : [];
      for (const g of stale) g.matcher = matcher;
      if (stale.length) updated.push(event);
      continue;
    }
    const group = { hooks: [{ type: 'command', command, timeout: 10 }] };
    if (matcher) group.matcher = matcher;
    data.hooks[event] = [...groups, group];
    added.push(event);
  }
  if (added.length || updated.length) {
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
    fs.writeFileSync(hooksFile, JSON.stringify(data, null, 2) + '\n');
  }
  return { appDir, hooksFile, added, updated };
}

// Removes only the two hook entries install wrote and the copied app; ledgers, logs and
// Codex's config.toml (trust state) are left alone.
function uninstallCodex({ homeDir = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const { appDir, hooksFile, wanted } = codexPaths({ homeDir, env, platform });
  const data = readHooksFile(hooksFile); // throws before anything is removed
  const removed = [];
  for (const { event, command } of wanted) {
    const groups = Array.isArray(data.hooks[event]) ? data.hooks[event] : [];
    let found = false;
    const kept = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks) || !g.hooks.some((h) => h && h.command === command)) {
        kept.push(g);
        continue;
      }
      found = true;
      const rest = g.hooks.filter((h) => !h || h.command !== command);
      if (rest.length) kept.push({ ...g, hooks: rest });
    }
    if (!found) continue;
    if (kept.length) data.hooks[event] = kept;
    else delete data.hooks[event];
    removed.push(event);
  }
  if (removed.length) fs.writeFileSync(hooksFile, JSON.stringify(data, null, 2) + '\n');
  const appRemoved = fs.existsSync(appDir);
  if (appRemoved) fs.rmSync(appDir, { recursive: true, force: true });
  return { appDir, hooksFile, removed, appRemoved };
}

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

function allLedgerDirs({ homeDir, env, platform }) {
  return [...new Set([
    ...claudePluginLedgerDirs(homeDir),
    ledgerDir('claude', env, platform, homeDir),
    ledgerDir('codex', env, platform, homeDir),
  ])];
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

function newestLedgerFile(dirs) {
  let best = null;
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/\.jsonl?$/.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { file, mtimeMs: st.mtimeMs };
      } catch { /* vanished */ }
    }
  }
  return best;
}

function status({ homeDir = os.homedir(), env = process.env, platform = process.platform, cwd = process.cwd() } = {}) {
  const config = loadConfig(cwd, env, homeDir);
  if (!config.enabled) return { disabled: true };
  const found = newestLedgerFile(allLedgerDirs({ homeDir, env, platform }));
  if (!found) return null;
  const ledger = readLedgerFile(found.file);
  const { records, note } = parentRecords(ledger);
  const names = [];
  for (const r of records) {
    if (r && r.kind === 'edit') {
      const name = path.basename(String(r.path));
      if (!names.includes(name)) names.push(name);
    }
  }
  const commands = records
    .filter((r) => r && r.kind === 'command')
    .map((r) => ({ command: r.command, isTest: r.isTest === true, result: r.result, via: r.via, ...(r.masked === true ? { masked: true } : {}) }));
  return {
    ledger: found.file,
    modified: new Date(found.mtimeMs).toISOString(),
    turn: ledger.turn,
    edits: names,
    commands,
    decision: withNote(stopDecision(records, ledger, { enabled: config.enabled, root: config.root }, false), note),
    ...(commands.some((c) => c.result === 'unknown' && !c.via) ? { note: CODEX_NOTE } : {}),
  };
}

function formatStatus(r) {
  if (!r) return 'No ledger yet.';
  if (r.disabled) return 'Gate disabled by config';
  const shown = r.edits.slice(0, 10).join(', ');
  const edits = r.edits.length ? (r.edits.length > 10 ? `${shown} (+${r.edits.length - 10} more)` : shown) : 'none';
  const d = r.decision;
  const verdict = d.action === 'block' ? `Would block: ${d.reason}`
    : d.systemMessage ? `Would allow with note: ${d.systemMessage}` : 'Would allow';
  return [
    `Ledger: ${r.ledger}`,
    `Modified: ${r.modified}`,
    `Turn: ${r.turn}`,
    `Edits this turn: ${edits}`,
    r.commands.length ? 'Commands this turn:' : 'Commands this turn: none',
    ...r.commands.map((c) => `  ${c.command} [${c.isTest ? 'test' : c.masked ? 'test, exit code hidden' : 'not a test'}] result=${c.result || 'none'}${c.via ? ` via=${c.via}` : ''}`),
    verdict,
    ...(r.note ? [r.note] : []),
  ].join('\n');
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

function run(argv, io) {
  const ctx = { homeDir: io.homeDir, env: io.env, platform: io.platform, cwd: io.cwd };
  const [cmd, arg] = argv;
  try {
    if (cmd === 'install' && arg === 'codex') {
      const r = installCodex(ctx);
      io.out(`Hooks file: ${r.hooksFile}`);
      if (r.added.length) io.out(`Added: ${r.added.join(', ')}`);
      if (r.updated.length) io.out(`Updated: ${r.updated.join(', ')}`);
      if (!r.added.length && !r.updated.length) io.out('Codex hooks already installed.');
      io.out(TRUST_NOTE);
      return 0;
    }
    if (cmd === 'uninstall' && arg === 'codex') {
      const r = uninstallCodex(ctx);
      io.out(`Hooks file: ${r.hooksFile}`);
      io.out(r.removed.length ? `Removed hooks: ${r.removed.join(', ')}` : 'Codex hooks were not installed.');
      if (r.appRemoved) io.out(`Removed app: ${r.appDir}`);
      return 0;
    }
    if (cmd === 'doctor') {
      const r = doctor(ctx);
      io.out(argv.includes('--json') ? JSON.stringify(r, null, 2) : formatReport(r));
      return 0;
    }
    if (cmd === 'status') {
      const r = status(ctx);
      const json = argv.includes('--json');
      io.out(json ? JSON.stringify(r || { ledger: null }, null, 2) : formatStatus(r));
      return 0;
    }
  } catch (err) {
    io.err(`proof-of-green: ${err.message}`);
    return 1;
  }
  io.err(USAGE);
  return 1;
}

module.exports = { installCodex, uninstallCodex, doctor, status, run };

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2), {
    out: (s) => console.log(s),
    err: (s) => console.error(s),
    env: process.env,
    homeDir: os.homedir(),
    platform: process.platform,
    cwd: process.cwd(),
  });
}
