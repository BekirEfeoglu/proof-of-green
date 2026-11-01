'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ledgerDir } = require('../core/ledger.cjs');

// install codex / uninstall codex: the copied gate and the two entries in ~/.codex/hooks.json.

const PKG_ROOT = path.join(__dirname, '..');

const toSlash = (p) => p.replace(/\\/g, '/');

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

module.exports = { installCodex, uninstallCodex };
