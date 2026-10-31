'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isCodeFile, globToRegExp } = require('../core/codefiles.cjs');

const homeDir = '/home/u';
const tmpDir = '/tmp';

test('source files are code files', () => {
  for (const p of ['src/a.ts', 'C:\\proj\\b.PY', 'lib/c.rs']) assert.equal(isCodeFile(p), true, p);
});

test('non-code and excluded locations are not code files', () => {
  for (const p of ['README.md', 'x.json', 'node_modules/a/index.js', '.git/hooks/x.js',
    `${homeDir}/.claude/hooks/a.cjs`, `${homeDir}/.codex/x.js`, `${tmpDir}/s.py`]) {
    assert.equal(isCodeFile(p, { homeDir, tmpDir }), false, p);
  }
});

test('windows home config dir is not code', () => {
  assert.equal(isCodeFile('C:\\Users\\x\\.claude\\settings.js', { homeDir: 'C:\\Users\\x' }), false);
});

test('include glob adds files', () => {
  assert.equal(isCodeFile('scripts/a/b.sh'), false);
  assert.equal(isCodeFile('scripts/a/b.sh', { include: ['scripts/**/*.sh'] }), true);
});

test('exclude glob removes files', () => {
  assert.equal(isCodeFile('generated/x.ts', { exclude: ['generated/**'] }), false);
});

test('relative globs match against path relative to root', () => {
  const opts = { root: '/proj', exclude: ['generated/**'] };
  assert.equal(isCodeFile('/proj/generated/x.ts', opts), false);
  assert.equal(isCodeFile('/proj/src/x.ts', opts), true);
});

test('globToRegExp supports **, * and ?', () => {
  assert.equal(globToRegExp('a/**/b.ts').test('a/x/y/b.ts'), true);
  assert.equal(globToRegExp('a/*.ts').test('a/x/b.ts'), false);
  assert.equal(globToRegExp('a/?.ts').test('a/x.ts'), true);
});

test('dot segments and doubled separators do not dodge the home exclusions', () => {
  assert.equal(isCodeFile('/home/u/./.claude/x.js', { homeDir }), false);
  assert.equal(isCodeFile('C:\\Users\\x\\\\.claude\\a.js', { homeDir: 'C:\\Users\\x' }), false);
  assert.equal(isCodeFile('/home/u//.codex/x.js', { homeDir }), false);
  assert.equal(isCodeFile('/home/u/proj/./src//a.js', { homeDir }), true);
  assert.equal(isCodeFile('/tmp/./s.py', { homeDir, tmpDir: '/tmp' }), false);
});

test('the real path of the temp dir is excluded too', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const real = fs.realpathSync.native(os.tmpdir());
  assert.equal(isCodeFile(real + require('node:path').sep + 'x.js', { homeDir, tmpDir: '/nowhere' }), false);
});
