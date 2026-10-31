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
test('a later command cannot mask the test result', () => {
  const masked = ['npm test; echo "exit: $?"', 'npm test || echo failed', 'npm test\necho done', 'npm test; ls',
    'pytest -q; true', 'npm test &', 'set +o pipefail; npm test | tail', 'npm test | tee out.txt; echo set pipefail',
    'npm test && echo ok; ls', 'npm test | tail; set -o pipefail'];
  for (const c of masked) assert.equal(isTestCommand(c), false, c);
});
test('only && after the first test, or a PowerShell $? check, keeps it', () => {
  const kept = ['npm test && echo ok', 'npm test; if ($LASTEXITCODE -eq 0) { "ok" }', 'npm test 2>&1',
    'npm run lint; npm test', 'set -euo pipefail; npm test | tail', 'npm test\n', 'npm test && pytest'];
  for (const c of kept) assert.equal(isTestCommand(c), true, c);
});
test('a later passing command cannot hide an earlier failed test', () => {
  const hidden = ['npm test; pytest', 'npm test || pytest --version', 'npm test; cargo test --help',
    'npm test || npm test', 'npm test\npytest'];
  for (const c of hidden) assert.equal(isTestCommand(c), false, c);
  const kept = ['npm run lint; npm test', 'cd api && npm test', 'npm test && pytest', 'npm test && echo ok',
    'npm test 2>&1', 'npm test; if ($?) { "ok" }', 'set -o pipefail; npm test | tail -5'];
  for (const c of kept) assert.equal(isTestCommand(c), true, c);
});
test('a PowerShell if tail that exits or resets LASTEXITCODE masks the test', () => {
  const masked = ['npm test; if ($LASTEXITCODE -ne 0) { exit 0 }', 'npm test; if ($LASTEXITCODE) { $global:LASTEXITCODE = 0 }',
    'npm test; if ($?) { exit 0 } else { exit 0 }', 'npm test; if (-not $?) { exit 0 }',
    'npm test; if ($LASTEXITCODE -ne 0) { exit 1 }'];
  for (const c of masked) assert.equal(isTestCommand(c), false, c);
  for (const c of ['npm test; if ($?) { "ok" }', 'npm test; if ($LASTEXITCODE -eq 0) { "ok" }'])
    assert.equal(isTestCommand(c), true, c);
});
test('only a success-branch PowerShell check may follow a test', () => {
  const masked = ['npm test; if ($?) {"ok"} else {"bad"}', 'npm test; if ($?) { "ok" } else { Write-Host bad }',
    'npm test; if ($LASTEXITCODE -ne 0) { "failed" }', 'npm test; if ($LASTEXITCODE -ne 0) { Write-Host failed }',
    'npm test; if ($LASTEXITCODE -ne 0) { cmd /c ver }', 'npm test; if ($LASTEXITCODE -ne 0) { $host.SetShouldExit(0) }'];
  for (const c of masked) assert.equal(isTestCommand(c), false, c);
  for (const c of ['npm test; if ($?) { "ok" }', 'npm test; if ($LASTEXITCODE -EQ 0) {"ok"}'])
    assert.equal(isTestCommand(c), true, c);
});
test('pipefail follows the last set before the pipe', () =>
  assert.equal(isTestCommand('set -o pipefail; set +o pipefail; npm test | tail'), false));
test('recognizes common runner wrappers', () => {
  const runners = ['uv run pytest', 'poetry run pytest -q', 'pipenv run pytest', 'hatch run python -m pytest',
    'pdm run python -m unittest', 'py -m pytest', 'py -3 -m pytest', '.\\gradlew test', '.\\mvnw test',
    'pnpm vitest run', 'yarn jest', 'pnpm exec vitest', 'bunx vitest', 'npx playwright test', 'npm t',
    'deno test', 'bun run test'];
  for (const c of runners) assert.equal(isTestCommand(c), true, c);
  for (const c of ['uv run python app.py', 'npm install', 'pnpm build', 'hatch run test', 'npm tag'])
    assert.equal(isTestCommand(c), false, c);
});
test("recognizes Node's built-in test runner", () => {
  for (const c of ['node --test', 'node --test test/', 'node --test test/cli.test.cjs', 'node --test --test-reporter=spec'])
    assert.equal(isTestCommand(c), true, c);
  for (const c of ['node test.js', 'node app.js --test', 'node --test-reporter=spec app.js', 'node --test 2>&1 | Select-String ok'])
    assert.equal(isTestCommand(c), false, c);
});
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

test('test script names with a -, _ or : suffix count; look-alike names do not', () => {
  for (const c of ['npm run test-e2e', 'npm run test_unit', 'pnpm test:ci', 'yarn run test-watch']) {
    assert.equal(isTestCommand(c), true, c);
  }
  for (const c of ['npm run testing', 'npm run attest']) assert.equal(isTestCommand(c), false, c);
});
