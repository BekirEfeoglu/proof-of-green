'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installCodex, doctor, status, run } = require('../bin/cli.cjs');

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

// ---- status ----
function writeStatusLedger(homeDir, name, ledger, mtime) {
  const dir = doctor(opts(homeDir)).ledgerDirs.find((d) => d.includes('proof-of-green')) ||
    path.join(homeDir, process.platform === 'win32' ? 'AppData/Local' : '.local/state', 'proof-of-green');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(ledger));
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}
const statusIo = (homeDir, out) => ({ ...opts(homeDir), cwd: homeDir, out: (s) => out.push(s), err: () => {} });

test('status without a ledger says so and exits 0', (t) => {
  const homeDir = tempHome(t);
  const out = [];
  assert.equal(run(['status'], statusIo(homeDir, out)), 0);
  assert.deepEqual(out, ['No ledger yet.']);
});

test('status reports the newest ledger, ignores logs, and would block after an edit with no test', (t) => {
  const homeDir = tempHome(t);
  const old = new Date(Date.now() - 86400000);
  writeStatusLedger(homeDir, 'a.json', { turn: '1', nextSeq: 2, records: [] }, old);
  const newest = writeStatusLedger(homeDir, 'b.json', {
    turn: '2', nextSeq: 3,
    records: [
      { seq: 0, turn: '1', kind: 'edit', path: 'old.js' },
      { seq: 1, turn: '2', kind: 'edit', path: 'src/x.js' },
    ],
  });
  fs.writeFileSync(path.join(path.dirname(newest), 'errors.log'), 'boom\n');
  fs.writeFileSync(path.join(path.dirname(newest), 'debug.log'), 'x\n');
  const out = [];
  assert.equal(run(['status', '--json'], statusIo(homeDir, out)), 0);
  const r = JSON.parse(out[0]);
  assert.equal(r.ledger, newest);
  assert.equal(r.turn, '2');
  assert.deepEqual(r.edits, ['x.js']);
  assert.deepEqual(r.commands, []);
  assert.equal(r.decision.action, 'block');
  const text = [];
  run(['status'], statusIo(homeDir, text));
  assert.match(text.join('\n'), /Would block: .*x\.js/);
  assert.match(text.join('\n'), /Turn: 2/);
});

test('status lists commands and allows after a passing test; caps edits at 10', (t) => {
  const homeDir = tempHome(t);
  const records = [];
  for (let i = 0; i < 12; i++) records.push({ seq: i, turn: '1', kind: 'edit', path: `d/f${i}.js` });
  records.push({ seq: 12, turn: '1', kind: 'command', command: 'npm test', isTest: true, result: 'pass', via: 'npm' });
  writeStatusLedger(homeDir, 'c.json', { turn: '1', nextSeq: 13, records });
  const out = [];
  run(['status'], statusIo(homeDir, out));
  const text = out.join('\n');
  assert.match(text, /\+2 more/);
  assert.match(text, /npm test.*test.*pass.*npm/);
  assert.match(text, /Would allow$/m);
});

test('status reads the newest .jsonl ledger merged with its legacy .json', (t) => {
  const homeDir = tempHome(t);
  const old = new Date(Date.now() - 86400000);
  writeStatusLedger(homeDir, 'other.json', { turn: '9', nextSeq: 1, records: [] }, new Date(Date.now() - 3600000));
  const legacy = writeStatusLedger(homeDir, 'h.json', {
    turn: '1', nextSeq: 2, records: [{ seq: 1, turn: '1', kind: 'edit', path: 'legacy.js' }],
  }, old);
  const lines = [
    { kind: 'command', command: 'npm test', isTest: true, result: 'fail' },
    { kind: 'edit', path: 'src/new.js' },
  ];
  const file = legacy + 'l';
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const out = [];
  run(['status', '--json'], statusIo(homeDir, out));
  const r = JSON.parse(out[0]);
  assert.equal(r.ledger, file);
  assert.equal(r.turn, '1');
  assert.deepEqual(r.edits, ['legacy.js', 'new.js']);
  assert.deepEqual(r.commands.map((c) => [c.command, c.result]), [['npm test', 'fail']]);
  assert.equal(r.decision.action, 'block');
});

// ---- doctor config check ----
const goodTool = { tool: 'mcp__x__t', commandArg: 'command' };
function cfgCtx(homeDir, cwd) { return { ...opts(homeDir), cwd }; }

test('doctor config: missing user and project files', (t) => {
  const homeDir = tempHome(t);
  const proj = path.join(homeDir, 'proj');
  fs.mkdirSync(proj);
  const c = doctor(cfgCtx(homeDir, proj)).config;
  assert.deepEqual(c.user, { path: path.join(homeDir, '.proof-of-green.json'), exists: false, valid: false, testTools: 0, editTools: 0, skipped: 0 });
  assert.deepEqual(c.project, { path: null, exists: false, valid: false, testTools: 0, editTools: 0, skipped: 0 });
});

test('doctor config: counts kept and skipped testTools in user and project files', (t) => {
  const homeDir = tempHome(t);
  const proj = path.join(homeDir, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(homeDir, '.proof-of-green.json'),
    JSON.stringify({ testTools: [goodTool, { tool: 'Bash', commandArg: 'command' }, 7, { tool: 'mcp__y' }] }));
  fs.writeFileSync(path.join(proj, '.proof-of-green.json'), JSON.stringify({ testTools: [goodTool] }));
  const c = doctor(cfgCtx(homeDir, proj)).config;
  assert.equal(c.user.exists, true);
  assert.equal(c.user.valid, true);
  assert.equal(c.user.testTools, 1);
  assert.equal(c.user.skipped, 3);
  assert.equal(c.project.path, path.join(proj, '.proof-of-green.json'));
  assert.equal(c.project.valid, true);
  assert.equal(c.project.testTools, 1);
  assert.equal(c.project.skipped, 0);
});

test('doctor config: invalid JSON and non-object files are valid=false', (t) => {
  const homeDir = tempHome(t);
  const proj = path.join(homeDir, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(homeDir, '.proof-of-green.json'), '{nope');
  fs.writeFileSync(path.join(proj, '.proof-of-green.json'), '[1]');
  const c = doctor(cfgCtx(homeDir, proj)).config;
  assert.equal(c.user.exists, true);
  assert.equal(c.user.valid, false);
  assert.equal(c.project.exists, true);
  assert.equal(c.project.valid, false);
});

test('doctor report prints config lines', (t) => {
  const homeDir = tempHome(t);
  const proj = path.join(homeDir, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(homeDir, '.proof-of-green.json'), JSON.stringify({ testTools: [goodTool, 1] }));
  fs.writeFileSync(path.join(proj, '.proof-of-green.json'), '{bad');
  const out = [];
  run(['doctor'], { ...cfgCtx(homeDir, proj), out: (s) => out.push(s), err: () => {} });
  const text = out.join('\n');
  assert.ok(text.includes(`User config: ${path.join(homeDir, '.proof-of-green.json')} (1 test tool, 0 edit tools, 1 skipped)`), text);
  assert.ok(text.includes(`Project config: ${path.join(proj, '.proof-of-green.json')} (invalid JSON)`), text);
});

test('doctor config: counts editTools and folds their invalid entries into skipped', (t) => {
  const homeDir = tempHome(t);
  const proj = path.join(homeDir, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(homeDir, '.proof-of-green.json'),
    JSON.stringify({ editTools: [{ tool: 'mcp__x__w', pathArg: 'path' }, { tool: 'Edit', pathArg: 'file_path' }, { tool: 'mcp__y' }] }));
  const c = doctor(cfgCtx(homeDir, proj)).config;
  assert.equal(c.user.editTools, 1);
  assert.equal(c.user.skipped, 2);
});

test('doctor report uses singular and plural for tool counts', (t) => {
  const homeDir = tempHome(t);
  const proj = path.join(homeDir, 'proj');
  fs.mkdirSync(proj);
  const e = (n) => ({ tool: 'mcp__e' + n, pathArg: 'path' });
  fs.writeFileSync(path.join(homeDir, '.proof-of-green.json'), JSON.stringify({ testTools: [goodTool], editTools: [e(1), e(2)] }));
  fs.writeFileSync(path.join(proj, '.proof-of-green.json'), JSON.stringify({ testTools: [goodTool, { tool: 'mcp__t2', commandArg: 'c' }], editTools: [e(3)] }));
  const out = [];
  run(['doctor'], { ...cfgCtx(homeDir, proj), out: (s) => out.push(s), err: () => {} });
  const text = out.join('\n');
  assert.ok(text.includes(`User config: ${path.join(homeDir, '.proof-of-green.json')} (1 test tool, 2 edit tools)`), text);
  assert.ok(text.includes(`Project config: ${path.join(proj, '.proof-of-green.json')} (2 test tools, 1 edit tool)`), text);
});

test('doctor report says missing for absent configs', (t) => {
  const homeDir = tempHome(t);
  const out = [];
  run(['doctor'], { ...cfgCtx(homeDir, homeDir), out: (s) => out.push(s), err: () => {} });
  const text = out.join('\n');
  assert.match(text, /User config: .*\(missing\)/);
  assert.match(text, /Project config: none \(missing\)/);
});

// ---- status: no-ledger JSON and Codex note ----
const CODEX_NOTE = 'Note: Codex results are read from the session log only at Stop, so this verdict may differ.';

test('status --json without a ledger prints {"ledger":null}', (t) => {
  const homeDir = tempHome(t);
  const out = [];
  assert.equal(run(['status', '--json'], statusIo(homeDir, out)), 0);
  assert.deepEqual(JSON.parse(out.join('\n')), { ledger: null });
  assert.equal(out.join('\n').replace(/\s/g, ''), '{"ledger":null}');
});

test('status adds the Codex note when a command result is unknown without via', (t) => {
  const homeDir = tempHome(t);
  writeStatusLedger(homeDir, 'u.json', {
    turn: '1', nextSeq: 3,
    records: [
      { seq: 1, turn: '1', kind: 'edit', path: 'a.js' },
      { seq: 2, turn: '1', kind: 'command', command: 'npm test', isTest: true, result: 'unknown' },
    ],
  });
  const text = [];
  run(['status'], statusIo(homeDir, text));
  assert.ok(text.join('\n').split('\n').includes(CODEX_NOTE));
  const json = [];
  run(['status', '--json'], statusIo(homeDir, json));
  assert.equal(JSON.parse(json[0]).note, CODEX_NOTE);
});

test('status has no Codex note when results are known or unknown with via', (t) => {
  const homeDir = tempHome(t);
  writeStatusLedger(homeDir, 'k.json', {
    turn: '1', nextSeq: 3,
    records: [
      { seq: 1, turn: '1', kind: 'command', command: 'npm test', isTest: true, result: 'pass' },
      { seq: 2, turn: '1', kind: 'command', command: 'x', isTest: true, result: 'unknown', via: 'mcp__x__t' },
    ],
  });
  const text = [];
  run(['status'], statusIo(homeDir, text));
  assert.doesNotMatch(text.join('\n'), /Codex results/);
  const json = [];
  run(['status', '--json'], statusIo(homeDir, json));
  assert.equal('note' in JSON.parse(json[0]), false);
});

test('status leaves out a running subagent and adds the note; a stopped one counts', (t) => {
  const homeDir = tempHome(t);
  const legacy = writeStatusLedger(homeDir, 'r.json', { turn: '1', nextSeq: 1, records: [] });
  const write = (lines) => fs.writeFileSync(legacy + 'l', lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const lines = [{ kind: 'edit', path: 'src/sub.js', agent: 'A1' }];
  write(lines);
  let out = [];
  run(['status', '--json'], statusIo(homeDir, out));
  let r = JSON.parse(out[0]);
  assert.deepEqual(r.edits, []);
  assert.equal(r.decision.action, 'allow');
  assert.equal(r.decision.systemMessage, 'proof-of-green: subagent A1 is still running; its changes will be checked when it stops.');
  write([...lines, { kind: 'agent-stop', agent: 'A1' }]);
  out = [];
  run(['status', '--json'], statusIo(homeDir, out));
  r = JSON.parse(out[0]);
  assert.deepEqual(r.edits, ['sub.js']);
  assert.equal(r.decision.action, 'block');
});
