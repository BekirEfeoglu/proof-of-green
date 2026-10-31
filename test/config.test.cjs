'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../core/config.cjs');

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pog-'));
const write = (dir, data) => fs.writeFileSync(path.join(dir, '.proof-of-green.json'), data);

test('no config file gives defaults', () => {
  const d = mk();
  fs.mkdirSync(path.join(d, '.git'));
  const c = loadConfig(d, {});
  assert.deepEqual({ ...c, root: undefined }, { enabled: true, testPatterns: [], include: [], exclude: [], root: undefined });
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
