'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isTestCommand, isMasked, suggestTestCommand, BUILTIN_TEST_PATTERNS } = require('../core/detect.cjs');

const yes = ['npm test', 'npm run test:unit', 'pnpm test', 'yarn test', 'bun test', 'npx vitest run',
  'npx jest', 'pytest -q', 'python -m pytest tests/', 'python3 -m unittest', 'go test ./...',
  'cargo test', 'cargo nextest run', 'dotnet test', 'mvn test', 'gradle test', './gradlew test',
  'make test', 'make check', 'rspec', 'phpunit', 'mix test', 'cd api && npm test',
  'npm test; if ($?) { "ok" }'];
const no = ['echo "tests passed"', 'npm test || true', 'pytest || :', 'go test ./... ; exit 0',
  'cargo test || exit 0', 'npm test | tail -5', 'npm test 2>&1 | Tee-Object out.txt',
  'ls', 'npm install', 'cat test.py', 'git commit -m "npm test"'];

test('detects test commands', () => { for (const c of yes) assert.equal(isTestCommand(c), true, c); });
test('rejects masked or fake commands', () => { for (const c of no) assert.equal(isTestCommand(c), false, c); });
test('pipefail keeps a piped test', () => assert.equal(isTestCommand('set -o pipefail; npm test | tail -5'), true));
test('extra patterns', () => assert.equal(isTestCommand('make verify', [/^make verify$/]), true));
test('env assignment prefix is stripped', () => assert.equal(isTestCommand('CI=1 npm test'), true));
test('isMasked flags masking forms', () => {
  assert.equal(isMasked('npm test || true'), true);
  assert.equal(isMasked('npm test | tail'), true);
  assert.equal(isMasked('npm test'), false);
  assert.equal(isMasked('set -o pipefail; npm test | tail'), false);
});
test('BUILTIN_TEST_PATTERNS is a RegExp array', () => {
  assert.ok(Array.isArray(BUILTIN_TEST_PATTERNS) && BUILTIN_TEST_PATTERNS.every((p) => p instanceof RegExp));
});

function withDir(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pog-'));
  try {
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    return fn(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('suggestTestCommand: package.json with scripts.test', () =>
  withDir({ 'package.json': JSON.stringify({ scripts: { test: 'x' } }) }, (d) => assert.equal(suggestTestCommand(d), 'npm test')));
test('suggestTestCommand: package.json without scripts.test', () =>
  withDir({ 'package.json': '{}' }, (d) => assert.equal(suggestTestCommand(d), null)));
test('suggestTestCommand: pyproject.toml', () =>
  withDir({ 'pyproject.toml': '' }, (d) => assert.equal(suggestTestCommand(d), 'pytest')));
test('suggestTestCommand: go.mod', () =>
  withDir({ 'go.mod': 'module x' }, (d) => assert.equal(suggestTestCommand(d), 'go test ./...')));
test('suggestTestCommand: Cargo.toml', () =>
  withDir({ 'Cargo.toml': '' }, (d) => assert.equal(suggestTestCommand(d), 'cargo test')));
test('suggestTestCommand: .sln', () =>
  withDir({ 'x.sln': '' }, (d) => assert.equal(suggestTestCommand(d), 'dotnet test')));
test('suggestTestCommand: empty dir', () =>
  withDir({}, (d) => assert.equal(suggestTestCommand(d), null)));
