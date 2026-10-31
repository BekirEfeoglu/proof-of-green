'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig: loadConfigWithHome } = require('../core/config.cjs');

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pog-'));
// Always isolate from the developer's real ~/.proof-of-green.json.
const loadConfig = (cwd, env, home = mk()) => loadConfigWithHome(cwd, env, home);
const write = (dir, data) => fs.writeFileSync(path.join(dir, '.proof-of-green.json'), data);

test('no config file gives defaults', () => {
  const d = mk();
  fs.mkdirSync(path.join(d, '.git'));
  const c = loadConfig(d, {});
  assert.deepEqual({ ...c, root: undefined }, { enabled: true, testPatterns: [], include: [], exclude: [], testTools: [], root: undefined });
  assert.equal(c.root, d);
});

test('config in a parent dir is found up to the git root', () => {
  const d = mk();
  fs.mkdirSync(path.join(d, '.git'));
  fs.mkdirSync(path.join(d, 'a', 'b'), { recursive: true });
  write(d, JSON.stringify({ include: ['x/**'], exclude: ['y/**'] }));
  const c = loadConfig(path.join(d, 'a', 'b'), {});
  assert.deepEqual(c.include, ['x/**']);
  assert.deepEqual(c.exclude, ['y/**']);
  assert.equal(c.root, d);
});

test('config above the git root is ignored', () => {
  const d = mk();
  write(d, JSON.stringify({ include: ['x/**'] }));
  fs.mkdirSync(path.join(d, 'repo', '.git'), { recursive: true });
  assert.deepEqual(loadConfig(path.join(d, 'repo'), {}).include, []);
});

test('invalid JSON gives defaults', () => {
  const d = mk();
  fs.mkdirSync(path.join(d, '.git'));
  write(d, '{nope');
  const c = loadConfig(d, {});
  assert.equal(c.enabled, true);
  assert.deepEqual(c.testPatterns, []);
});

test('PROOF_OF_GREEN=off disables', () => {
  const d = mk();
  fs.mkdirSync(path.join(d, '.git'));
  assert.equal(loadConfig(d, { PROOF_OF_GREEN: 'off' }).enabled, false);
});

test('enabled:false in file disables', () => {
  const d = mk();
  fs.mkdirSync(path.join(d, '.git'));
  write(d, JSON.stringify({ enabled: false }));
  assert.equal(loadConfig(d, {}).enabled, false);
});

test('testCommands become RegExps and invalid ones are skipped', () => {
  const d = mk();
  fs.mkdirSync(path.join(d, '.git'));
  write(d, JSON.stringify({ testCommands: ['^make verify$', '('] }));
  const c = loadConfig(d, {});
  assert.equal(c.testPatterns.length, 1);
  assert.ok(c.testPatterns[0] instanceof RegExp);
  assert.equal(c.testPatterns[0].test('make verify'), true);
});

test('root falls back to cwd when no .git is found', () => {
  const d = mk();
  const c = loadConfig(d, {});
  assert.equal(c.root, d);
});

// ---- user-level config and MCP test tools ----
const proj = () => { const d = mk(); fs.mkdirSync(path.join(d, '.git')); return d; };
const tool = (tool, commandArg, exitCodeField) => ({ tool, commandArg, ...(exitCodeField ? { exitCodeField } : {}) });

test('user file alone supplies testTools, testCommands, include, exclude', () => {
  const d = proj(); const home = mk();
  write(home, JSON.stringify({
    testTools: [tool('mcp__x__run', 'command', 'code')],
    testCommands: ['^make$'], include: ['u/**'], exclude: ['v/**'],
  }));
  const c = loadConfig(d, {}, home);
  assert.deepEqual(c.testTools, [{ tool: 'mcp__x__run', commandArg: 'command', exitCodeField: 'code' }]);
  assert.equal(c.testPatterns.length, 1);
  assert.deepEqual(c.include, ['u/**']);
  assert.deepEqual(c.exclude, ['v/**']);
});

test('project enabled:false overrides user enabled:true', () => {
  const d = proj(); const home = mk();
  write(home, JSON.stringify({ enabled: true }));
  write(d, JSON.stringify({ enabled: false }));
  assert.equal(loadConfig(d, {}, home).enabled, false);
});

test('project enabled:true overrides user enabled:false', () => {
  const d = proj(); const home = mk();
  write(home, JSON.stringify({ enabled: false }));
  write(d, JSON.stringify({ enabled: true }));
  assert.equal(loadConfig(d, {}, home).enabled, true);
});

test('user enabled:false disables when project is silent', () => {
  const d = proj(); const home = mk();
  write(home, JSON.stringify({ enabled: false }));
  assert.equal(loadConfig(d, {}, home).enabled, false);
});

test('PROOF_OF_GREEN=off wins over project enabled:true', () => {
  const d = proj(); const home = mk();
  write(d, JSON.stringify({ enabled: true }));
  assert.equal(loadConfig(d, { PROOF_OF_GREEN: 'off' }, home).enabled, false);
});

test('lists concatenate user first, then project', () => {
  const d = proj(); const home = mk();
  write(home, JSON.stringify({ include: ['u'], exclude: ['ue'], testCommands: ['^a$'] }));
  write(d, JSON.stringify({ include: ['p'], exclude: ['pe'], testCommands: ['^b$'] }));
  const c = loadConfig(d, {}, home);
  assert.deepEqual(c.include, ['u', 'p']);
  assert.deepEqual(c.exclude, ['ue', 'pe']);
  assert.deepEqual(c.testPatterns.map((r) => r.source), ['^a$', '^b$']);
});

test('project testTools entry replaces the user entry with the same tool', () => {
  const d = proj(); const home = mk();
  write(home, JSON.stringify({ testTools: [tool('mcp__a', 'cmd'), tool('mcp__b', 'cmd')] }));
  write(d, JSON.stringify({ testTools: [tool('mcp__a', 'script', 'rc'), tool('mcp__c', 'cmd')] }));
  assert.deepEqual(loadConfig(d, {}, home).testTools, [
    { tool: 'mcp__b', commandArg: 'cmd', exitCodeField: 'exit_code' },
    { tool: 'mcp__a', commandArg: 'script', exitCodeField: 'rc' },
    { tool: 'mcp__c', commandArg: 'cmd', exitCodeField: 'exit_code' },
  ]);
});

test('exitCodeField defaults to exit_code and output has exactly three keys', () => {
  const d = proj();
  write(d, JSON.stringify({ testTools: [{ tool: 'mcp__a', commandArg: 'c', extra: 1 }, tool('mcp__b', 'c', '')] }));
  const t = loadConfig(d, {}).testTools;
  assert.deepEqual(t, [
    { tool: 'mcp__a', commandArg: 'c', exitCodeField: 'exit_code' },
    { tool: 'mcp__b', commandArg: 'c', exitCodeField: 'exit_code' },
  ]);
});

test('malformed testTools entries are skipped', () => {
  const d = proj();
  write(d, JSON.stringify({ testTools: [
    { commandArg: 'c' }, { tool: 'mcp__a' }, { tool: '', commandArg: 'c' }, { tool: 'mcp__a', commandArg: '' },
    { tool: 1, commandArg: 'c' }, { tool: 'mcp__a', commandArg: 2 }, null, 'x', [], tool('mcp__ok', 'c'),
  ] }));
  assert.deepEqual(loadConfig(d, {}).testTools, [{ tool: 'mcp__ok', commandArg: 'c', exitCodeField: 'exit_code' }]);
});

test('bad user files give defaults without throwing', () => {
  for (const raw of ['[]', '"x"', '{nope', JSON.stringify({ testTools: {} })]) {
    const d = proj(); const home = mk();
    write(home, raw);
    const c = loadConfig(d, {}, home);
    assert.equal(c.enabled, true);
    assert.deepEqual(c.testTools, []);
    assert.deepEqual(c.include, []);
  }
});

test('when homeDir is the project root the file is read once, not merged with itself', () => {
  const d = proj();
  write(d, JSON.stringify({ include: ['x'], testTools: [tool('mcp__a', 'c')] }));
  const c = loadConfig(d, {}, d);
  assert.deepEqual(c.include, ['x']);
  assert.equal(c.testTools.length, 1);
});

test('only mcp__ tools can be test tools; shell and edit tools are dropped', () => {
  const d = proj(); const home = mk();
  write(home, JSON.stringify({ testTools: [tool('Bash', 'command'), tool('mcp__u__run', 'cmd')] }));
  write(d, JSON.stringify({ testTools: [
    tool('Bash', 'command'), tool('PowerShell', 'command'), tool('Edit', 'file_path'),
    tool('MCP__x__run', 'c'), tool('xmcp__y', 'c'), tool('mcp__s__t', 'komut'),
  ] }));
  assert.deepEqual(loadConfig(d, {}, home).testTools, [
    { tool: 'mcp__u__run', commandArg: 'cmd', exitCodeField: 'exit_code' },
    { tool: 'mcp__s__t', commandArg: 'komut', exitCodeField: 'exit_code' },
  ]);
});
