'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installCodex, doctor, run } = require('../bin/cli.cjs');

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pog-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const opts = (homeDir) => ({ homeDir, env: {}, platform: process.platform });
const readHooks = (homeDir) =>
  JSON.parse(fs.readFileSync(path.join(homeDir, '.codex', 'hooks.json'), 'utf8'));
const commands = (hooks, event) =>
  (hooks.hooks[event] || []).flatMap((g) => g.hooks.map((h) => h.command));

test('install into an empty home copies the app and creates hooks.json', (t) => {
  const homeDir = tempHome(t);
  const r = installCodex(opts(homeDir));
  assert.equal(r.hooksFile, path.join(homeDir, '.codex', 'hooks.json'));
  assert.deepEqual(r.added, ['PostToolUse', 'Stop']);
  assert.deepEqual(r.updated, []);
  for (const rel of ['gate.cjs', 'core/ledger.cjs', 'adapters/codex.cjs']) {
    assert.ok(fs.existsSync(path.join(r.appDir, rel)), rel);
  }
  const hooks = readHooks(homeDir);
  const appDir = r.appDir.replace(/\\/g, '/');
  assert.deepEqual(commands(hooks, 'Stop'), [`node "${appDir}/gate.cjs" codex stop`]);
  assert.deepEqual(commands(hooks, 'PostToolUse'), [`node "${appDir}/gate.cjs" codex post-tool`]);
  assert.equal(hooks.hooks.PostToolUse[0].matcher, 'apply_patch|Bash|mcp__.*');
  assert.equal(hooks.hooks.Stop[0].hooks[0].timeout, 10);
  assert.equal(hooks.hooks.Stop[0].hooks[0].type, 'command');
});

test('installing twice adds nothing and keeps the command byte-identical', (t) => {
  const homeDir = tempHome(t);
  installCodex(opts(homeDir));
  const first = fs.readFileSync(path.join(homeDir, '.codex', 'hooks.json'), 'utf8');
  const r = installCodex(opts(homeDir));
  assert.deepEqual(r.added, []);
  assert.equal(fs.readFileSync(path.join(homeDir, '.codex', 'hooks.json'), 'utf8'), first);
});

test('an unrelated Stop hook and other keys survive', (t) => {
  const homeDir = tempHome(t);
  fs.mkdirSync(path.join(homeDir, '.codex'));
  const existing = {
    other: 1,
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine', timeout: 5 }] }] },
  };
  fs.writeFileSync(path.join(homeDir, '.codex', 'hooks.json'), JSON.stringify(existing));
  installCodex(opts(homeDir));
  const hooks = readHooks(homeDir);
  assert.equal(hooks.other, 1);
  const stop = commands(hooks, 'Stop');
  assert.equal(stop.length, 2);
  assert.equal(stop[0], 'echo mine');
});

test('invalid hooks.json is not overwritten', (t) => {
  const homeDir = tempHome(t);
  fs.mkdirSync(path.join(homeDir, '.codex'));
  const file = path.join(homeDir, '.codex', 'hooks.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => installCodex(opts(homeDir)), /hooks\.json/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('doctor reports trust from config.toml without writing it', (t) => {
  const homeDir = tempHome(t);
  const { hooksFile } = installCodex(opts(homeDir));
  const o = { ...opts(homeDir), cwd: homeDir };
  assert.equal(doctor(o).codex.trusted, 'unknown');
  const config = path.join(homeDir, '.codex', 'config.toml');
  fs.writeFileSync(config, "[hooks.state.'/elsewhere/hooks.json:stop:0:0']\ntrusted_hash = \"sha256:x\"\n");
  assert.equal(doctor(o).codex.trusted, false);
  const withEntry = `[hooks.state.'${hooksFile}:stop:0:0']\ntrusted_hash = "sha256:abc"\n`;
  fs.writeFileSync(config, withEntry);
  const d = doctor(o);
  assert.equal(d.codex.installed, true);
  assert.equal(d.codex.trusted, true);
  assert.equal(fs.readFileSync(config, 'utf8'), withEntry);
});

test('doctor detects the Claude plugin and last errors', (t) => {
  const homeDir = tempHome(t);
  const o = { ...opts(homeDir), cwd: homeDir };
  assert.equal(doctor(o).claude.installed, false);
  assert.equal(doctor(o).codex.installed, false);
  fs.mkdirSync(path.join(homeDir, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ plugins: { 'proof-of-green@marketplace': [{}] } }),
  );
  assert.equal(doctor(o).claude.installed, true);
  const dir = doctor(o).ledgerDirs[0];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'errors.log'), 'a\nb\nc\nd\ne\nf\n\n');
  assert.deepEqual(doctor(o).lastErrors, ['b', 'c', 'd', 'e', 'f']);
});

test('run prints usage and fails on unknown commands', () => {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), env: {}, homeDir: os.tmpdir(), platform: process.platform, cwd: process.cwd() };
  assert.equal(run([], io), 1);
  assert.equal(run(['bogus'], io), 1);
  assert.match(err.join('\n'), /Usage/);
});

test('run install codex and doctor --json work against a temp home', (t) => {
  const homeDir = tempHome(t);
  const out = [];
  const io = { out: (s) => out.push(s), err: () => {}, env: {}, homeDir, platform: process.platform, cwd: homeDir };
  assert.equal(run(['install', 'codex'], io), 0);
  assert.match(out.join('\n'), /Codex skips new hooks until you trust them: run \/hooks in Codex and trust the proof-of-green hooks\./);
  out.length = 0;
  assert.equal(run(['doctor', '--json'], io), 0);
  assert.equal(JSON.parse(out.join('\n')).codex.installed, true);
  out.length = 0;
  assert.equal(run(['install', 'codex'], io), 0);
  assert.match(out.join('\n'), /already installed/);
});

test('doctor reads enabledPlugins from settings.json', (t) => {
  const homeDir = tempHome(t);
  const o = { ...opts(homeDir), cwd: homeDir };
  assert.equal(doctor(o).claude.installed, false);
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  const settings = path.join(homeDir, '.claude', 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ enabledPlugins: { 'proof-of-green@marketplace': false } }));
  assert.equal(doctor(o).claude.installed, false);
  fs.writeFileSync(settings, JSON.stringify({ enabledPlugins: { 'proof-of-green@marketplace': true } }));
  assert.equal(doctor(o).claude.installed, true);
  fs.writeFileSync(settings, '{ broken');
  assert.equal(doctor(o).claude.installed, false);
});

test('doctor reports codex installed only when both hooks are present', (t) => {
  const homeDir = tempHome(t);
  const o = { ...opts(homeDir), cwd: homeDir };
  const { hooksFile } = installCodex(opts(homeDir));
  assert.equal(doctor(o).codex.installed, true);
  const data = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  delete data.hooks.PostToolUse;
  fs.writeFileSync(hooksFile, JSON.stringify(data));
  assert.equal(doctor(o).codex.installed, false);
});

test('doctor report does not ask to trust Codex hooks that are not installed', (t) => {
  const homeDir = tempHome(t);
  const out = [];
  run(['doctor'], { ...opts(homeDir), out: (s) => out.push(s), err: () => {} });
  const text = out.join('\n');
  assert.match(text, /Codex hooks trusted: +n\/a \(Codex hooks not installed\)/);
  assert.doesNotMatch(text, /run \/hooks/);
});

test('doctor finds the Claude plugin ledger dir and its errors without CLAUDE_PLUGIN_DATA', (t) => {
  const homeDir = tempHome(t);
  const dir = path.join(homeDir, '.claude', 'plugins', 'data', 'proof-of-green-proof-of-green', 'ledgers');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'errors.log'), '2026-10-31T00:00:00.000Z Error: boom\n');
  const r = doctor(opts(homeDir));
  assert.ok(r.ledgerDirs.includes(dir), r.ledgerDirs.join(', '));
  assert.deepEqual(r.lastErrors, ['2026-10-31T00:00:00.000Z Error: boom']);
});

test('a v0.1 install gets the new PostToolUse matcher in place; a second install changes nothing', (t) => {
  const homeDir = tempHome(t);
  const { appDir } = installCodex(opts(homeDir));
  const file = path.join(homeDir, '.codex', 'hooks.json');
  const v01 = readHooks(homeDir);
  v01.hooks.PostToolUse[0].matcher = 'apply_patch|Bash';
  fs.writeFileSync(file, JSON.stringify(v01, null, 2) + '\n');

  const r = installCodex(opts(homeDir));
  assert.deepEqual([r.added, r.updated], [[], ['PostToolUse']]);
  const hooks = readHooks(homeDir);
  assert.equal(hooks.hooks.PostToolUse.length, 1);
  assert.equal(hooks.hooks.PostToolUse[0].matcher, 'apply_patch|Bash|mcp__.*');
  assert.deepEqual(commands(hooks, 'PostToolUse'), [`node "${appDir.replace(/\\/g, '/')}/gate.cjs" codex post-tool`]);
  assert.equal(hooks.hooks.Stop.length, 1);

  const after = fs.readFileSync(file, 'utf8');
  const again = installCodex(opts(homeDir));
  assert.deepEqual([again.added, again.updated], [[], []]);
  assert.equal(fs.readFileSync(file, 'utf8'), after);
});

test('run install codex prints Updated for a v0.1 install', (t) => {
  const homeDir = tempHome(t);
  installCodex(opts(homeDir));
  const file = path.join(homeDir, '.codex', 'hooks.json');
  const v01 = readHooks(homeDir);
  v01.hooks.PostToolUse[0].matcher = 'apply_patch|Bash';
  fs.writeFileSync(file, JSON.stringify(v01));
  const out = [];
  const io = { out: (s) => out.push(s), err: () => {}, env: {}, homeDir, platform: process.platform, cwd: homeDir };
  assert.equal(run(['install', 'codex'], io), 0);
  assert.match(out.join('\n'), /^Updated: PostToolUse$/m);
  assert.doesNotMatch(out.join('\n'), /already installed/);
});

test('a hand-edited PostToolUse matcher is left alone and not reported as updated', (t) => {
  const homeDir = tempHome(t);
  installCodex(opts(homeDir));
  const file = path.join(homeDir, '.codex', 'hooks.json');
  const edited = readHooks(homeDir);
  edited.hooks.PostToolUse[0].matcher = '.*';
  fs.writeFileSync(file, JSON.stringify(edited, null, 2) + '\n');
  const before = fs.readFileSync(file, 'utf8');

  const r = installCodex(opts(homeDir));
  assert.deepEqual([r.added, r.updated], [[], []]);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(readHooks(homeDir).hooks.PostToolUse[0].matcher, '.*');
});
