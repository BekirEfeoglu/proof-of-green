'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isTestCommand, isMasked, isMaskedTest, suggestTestCommand, BUILTIN_TEST_PATTERNS } = require('../core/detect.cjs');

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

test('isMaskedTest is true only when a test ran with its exit code hidden', () => {
  assert.equal(isMaskedTest('npm test | grep pass'), true);
  assert.equal(isMaskedTest('npm test; git push'), true);
  assert.equal(isMaskedTest('npm test || true'), true);
  assert.equal(isMaskedTest('npm test'), false);
  assert.equal(isMaskedTest('npm test && echo ok'), false);
  assert.equal(isMaskedTest('ls | grep x'), false);
  assert.equal(isMaskedTest('make verify | tail', [/^make verify$/]), true);
});

test('workspace and directory options before test still count', () => {
  const yesMore = ['npm --prefix api test', 'npm -w pkg test', 'npm --workspace=pkg run test', 'npm -ws test',
    'npm --silent run test', 'pnpm -C api test', 'pnpm --filter "./pkg/**" test', 'pnpm -r test',
    'pnpm --dir api run test:unit', 'yarn workspace @app/web test', 'yarn workspace web run test',
    'yarn workspaces foreach -A run test', 'yarn --cwd api test', 'bun --cwd api test'];
  for (const c of yesMore) assert.equal(isTestCommand(c), true, c);
  for (const c of ['npm install test', 'npm uninstall -g test', 'pnpm add test', 'npm view test']) {
    assert.equal(isTestCommand(c), false, c);
  }
});

test('more test runners count', () => {
  const runners = ['bundle exec rspec', 'bundle exec rake test', 'rake test', 'rails test', 'bin/rails test',
    'swift test', 'flutter test', 'dart test', 'zig build test', 'ctest --output-on-failure', 'sbt test',
    'php artisan test', 'composer test', 'tox -e py312', 'nox -s tests', 'uvx pytest', 'hatch test',
    'just test', 'gradle clean test', './gradlew :app:test', 'mvn -q verify', './gradlew check'];
  for (const c of runners) assert.equal(isTestCommand(c), true, c);
  for (const c of ['gradle build -x test', 'bundle install', 'swift build', 'flutter run', 'composer install',
    'rake db:migrate', 'just build']) {
    assert.equal(isTestCommand(c), false, c);
  }
});

test('long option lists are classified quickly (no exponential backtracking)', () => {
  const inputs = ['npm ' + '--a=b '.repeat(4000), 'npm ' + '--a-b '.repeat(4000) + 'x',
    'npm ' + '-a b '.repeat(4000) + 'x', './gradlew ' + '-q '.repeat(5000) + 'build',
    'yarn workspaces foreach ' + '-x '.repeat(5000) + 'run tes'];
  for (const s of inputs) {
    const start = Date.now();
    isTestCommand(s);
    assert.ok(Date.now() - start < 500, `${s.slice(0, 20)}... took ${Date.now() - start} ms`);
  }
});

test('a flag value is never read as the script name', () => {
  for (const c of ['npm --prefix test install', 'npm --prefix test run build', 'pnpm --filter test build',
    'npm -w test run build', 'yarn --cwd test build', 'bun --cwd test install', 'npm --prefix test-app ci',
    'npm --silent install test', 'npm -g install test']) {
    assert.equal(isTestCommand(c), false, c);
  }
  for (const c of ['npm --prefix test test', 'pnpm --filter test run test', 'npm -g test']) assert.equal(isTestCommand(c), true, c);
});

test('skip, dry-run and list-only flags do not count as tests', () => {
  for (const c of ['mvn -DskipTests test', 'mvn test -DskipTests', 'mvn -Dmaven.test.skip=true verify',
    'mvn -DskipTests=true test', 'gradle --dry-run test', 'gradle -m check', 'gradle check -x test',
    './gradlew build -x testDebugUnitTest', 'tox --notest', 'tox -l', 'tox --help', 'nox --list', 'nox -s lint',
    'tox -e lint', 'ctest -N', 'swift test --list-tests', 'gradle testClasses', 'mvn test-compile']) {
    assert.equal(isTestCommand(c), false, c);
  }
  for (const c of ['mvn -o -T 4 test', 'mvn -f pom.xml test', 'mvn -pl mod test', 'gradle -p sub test',
    './gradlew :app:testDebugUnitTest', 'mvn -DskipTests=false test', 'tox -e py312', 'nox -s tests', 'tox']) {
    assert.equal(isTestCommand(c), true, c);
  }
});

test('JavaScript and PHP runners count bare, through a launcher or from a local bin folder', () => {
  const runners = ['vitest', 'vitest run', 'jest --ci', 'npx --yes vitest run', 'npx -y jest', 'npx ava', 'npx tap',
    'tap', 'npx cypress run', 'npx karma start --single-run', 'node_modules/.bin/vitest run', './node_modules/.bin/jest',
    'vendor/bin/phpunit', './vendor/bin/pest', 'pest --parallel', 'ng test --watch=false', 'npx ng test'];
  for (const c of runners) assert.equal(isTestCommand(c), true, c);
  for (const c of ['npx cypress open', 'npx karma init', 'vendor/bin/phpstan', 'ng build', 'npx vite build', 'npx tsc']) {
    assert.equal(isTestCommand(c), false, c);
  }
});

test('monorepo and task runners count their test task', () => {
  const runners = ['turbo test', 'turbo run test --filter=web', 'npx turbo run test:unit', 'pnpm turbo test',
    'nx test app', 'npx nx run app:test', 'nx run-many -t test', 'npx nx affected --target=test', 'nx run-many -t lint,test',
    'deno task test', 'mise run test', 'task test'];
  for (const c of runners) assert.equal(isTestCommand(c), true, c);
  for (const c of ['turbo run build', 'nx build app', 'nx run app:build', 'nx run-many -t lint', 'deno task dev',
    'mise run build', 'task build', 'turbo run build --filter=test']) {
    assert.equal(isTestCommand(c), false, c);
  }
});

test('long monorepo runner commands are classified quickly', () => {
  for (const s of ['nx run-many ' + '-x '.repeat(5000) + 'build', 'npx nx affected ' + '--a=b '.repeat(5000) + '-t lint',
    'turbo run ' + 'test:'.repeat(5000) + ' x', 'npx ' + '-y '.repeat(5000) + 'vitest']) {
    const start = Date.now();
    isTestCommand(s);
    assert.ok(Date.now() - start < 500, `${s.slice(0, 20)}... took ${Date.now() - start} ms`);
  }
});
