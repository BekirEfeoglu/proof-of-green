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
  for (const rel of ['gate.cjs', 'core/ledger.cjs', 'adapters/codex.cjs']) {
    assert.ok(fs.existsSync(path.join(r.appDir, rel)), rel);
  }
  const hooks = readHooks(homeDir);
  const appDir = r.appDir.replace(/\\/g, '/');
  assert.deepEqual(commands(hooks, 'Stop'), [`node "${appDir}/gate.cjs" codex stop`]);
  assert.deepEqual(commands(hooks, 'PostToolUse'), [`node "${appDir}/gate.cjs" codex post-tool`]);
  assert.equal(hooks.hooks.PostToolUse[0].matcher, 'apply_patch|Bash');
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
