#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ledgerDir } = require('../core/ledger.cjs');

const PKG_ROOT = path.join(__dirname, '..');
const TRUST_NOTE =
  'Codex skips new hooks until you trust them: run /hooks in Codex and trust the proof-of-green hooks.';
const USAGE = 'Usage: proof-of-green install codex | doctor [--json]';

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
    throw new Error(`${hooksFile} is not valid JSON (${err.message}); fix or remove it, then run install again.`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${hooksFile} must contain a JSON object; fix or remove it, then run install again.`);
  }
  if (data.hooks === undefined) data.hooks = {};
  if (!data.hooks || typeof data.hooks !== 'object' || Array.isArray(data.hooks)) {
    throw new Error(`${hooksFile} has a "hooks" value that is not an object; fix it, then run install again.`);
  }
  return data;
}

function installCodex({ homeDir = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const appDir = path.join(ledgerDir('codex', env, platform, homeDir), 'app');
  const hooksFile = path.join(homeDir, '.codex', 'hooks.json');
  const data = readHooksFile(hooksFile); // throws before anything is written
  copyApp(appDir);

  const base = `node "${toSlash(appDir)}/gate.cjs" codex`;
  const wanted = [
    { event: 'PostToolUse', matcher: 'apply_patch|Bash', command: `${base} post-tool` },
    { event: 'Stop', command: `${base} stop` },
  ];
  const added = [];
  for (const { event, matcher, command } of wanted) {
    const groups = Array.isArray(data.hooks[event]) ? data.hooks[event] : [];
    const present = groups.some(
      (g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => h && h.command === command),
    );
    if (present) continue;
    const group = { hooks: [{ type: 'command', command, timeout: 10 }] };
    if (matcher) group.matcher = matcher;
    data.hooks[event] = [...groups, group];
    added.push(event);
  }
  if (added.length) {
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
    fs.writeFileSync(hooksFile, JSON.stringify(data, null, 2) + '\n');
  }
  return { appDir, hooksFile, added };
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

function claudeInstalled(homeDir) {
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'),
    );
    const table = data && typeof data.plugins === 'object' && data.plugins ? data.plugins : data;
    return Object.keys(table || {}).some((k) => k.startsWith('proof-of-green@'));
  } catch { return false; }
}

function doctor({ homeDir = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const hooksFile = path.join(homeDir, '.codex', 'hooks.json');
  let codexInstalled = false;
  try {
    const data = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
    codexInstalled = Object.values((data && data.hooks) || {}).some(
      (groups) => Array.isArray(groups) && groups.some(
        (g) => g && Array.isArray(g.hooks) && g.hooks.some(
          (h) => h && typeof h.command === 'string' && h.command.includes('gate.cjs" codex '),
        ),
      ),
    );
  } catch { /* missing or unreadable: not installed */ }

  const ledgerDirs = [...new Set([
    ledgerDir('claude', env, platform, homeDir),
    ledgerDir('codex', env, platform, homeDir),
  ])];
  const lines = [];
  for (const dir of ledgerDirs) {
    try {
      lines.push(...fs.readFileSync(path.join(dir, 'errors.log'), 'utf8').split(/\r?\n/).filter((l) => l.trim()));
    } catch { /* no log */ }
  }
  return {
    claude: { installed: claudeInstalled(homeDir) },
    codex: {
      installed: codexInstalled,
      trusted: codexTrusted(path.join(homeDir, '.codex', 'config.toml'), hooksFile),
    },
    ledgerDirs,
    lastErrors: lines.slice(-5),
  };
}

function formatReport(r) {
  const trust = r.codex.trusted === 'unknown' ? 'unknown (no ~/.codex/config.toml)' : r.codex.trusted ? 'yes' : 'NO - run /hooks in Codex and trust them';
  return [
    'proof-of-green doctor',
    `Claude Code plugin installed: ${r.claude.installed ? 'yes' : 'no'}`,
    `Codex hooks installed:        ${r.codex.installed ? 'yes' : 'no'}`,
    `Codex hooks trusted:          ${trust}`,
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
      io.out(r.added.length ? `Added: ${r.added.join(', ')}` : 'Codex hooks already installed.');
      io.out(TRUST_NOTE);
      return 0;
    }
    if (cmd === 'doctor') {
      const r = doctor(ctx);
      io.out(argv.includes('--json') ? JSON.stringify(r, null, 2) : formatReport(r));
      return 0;
    }
  } catch (err) {
    io.err(`proof-of-green: ${err.message}`);
    return 1;
  }
  io.err(USAGE);
  return 1;
}

module.exports = { installCodex, doctor, run };

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
