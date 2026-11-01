'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Options before the script name. Only the listed flags take a separate value (`--prefix api`,
// `-w pkg`, `--filter x`); every other flag is a switch (`-r`, `-g`, `--silent`). A value is never
// read as the script name, so `npm --prefix test install` is not a test. The two alternatives
// cannot match the same flag, and a flag name starts with a word character, so long option lists
// do not backtrack exponentially.
const PM_VALUE_FLAG = String.raw`(?:--(?:prefix|workspace|dir|filter|cwd)|-[wCF])`;
const PM_OPTIONS = String.raw`(?:\s+(?:${PM_VALUE_FLAG}(?:=\S+|\s+\S+)|-(?!-?(?:prefix|workspace|dir|filter|cwd|[wCF])(?=[\s=]|$))-?\w[\w-]*(?:=\S+)?))*`;
const YARN_WORKSPACE = String.raw`(?:\s+workspace\s+\S+|\s+workspaces\s+foreach(?:\s+-\S+)*)?`;
// Maven and Gradle flags that take a separate value (`-T 4`, `-pl mod`, `-p sub`).
const JVM_VALUE_FLAG = String.raw`(?:-(?:T|pl|f|p|P|s|rf|b)|--(?:threads|projects|file|project-dir|settings|build-file))`;
const JVM_OPTIONS = String.raw`(?:\s+(?:${JVM_VALUE_FLAG}\s+\S+|-(?!(?:x|T|pl|f|p|P|s|rf|b)(?=\s|$))\S+|clean))*`;
// What runs a JavaScript tool: a package runner (`npx --yes`, `pnpm exec`), the project's
// node_modules/.bin, or nothing, for a tool on PATH.
const JS_LAUNCH = String.raw`(?:(?:npx(?:\s+(?:--yes|-y))*|bunx|bun\s+x|pnpm(?:\s+(?:exec|dlx))?|yarn(?:\s+dlx)?)\s+|(?:\.[\\/])?node_modules[\\/]\.bin[\\/])?`;
// A test task name: `test`, or `test:unit`, `test-e2e`, `test_api`.
const TEST_TASK = String.raw`test(?:[:_-][\w:-]+)?`;

// Forms of a test command that run no tests: skip flags, dry runs, listings, non-test sessions.
const NO_TESTS_RUN = [
  /(?:^|\s)-DskipTests(?:=true)?(?=\s|$)/,
  /(?:^|\s)-Dmaven\.test\.skip(?:=true)?(?=\s|$)/,
  /^(?:gradle|\.[\\/]gradlew)\b.*\s(?:--dry-run|-m|-x\s+\S*[Tt]est\S*)(?=\s|$)/,
  /^tox\b.*\s(?:--notest|-l|-a|--listenvs(?:-all)?|--help|-h|--version)(?=\s|$)/,
  /^nox\b.*\s(?:--list|-l|--help|-h|--version)(?=\s|$)/,
  /^(?:tox|nox)\b.*\s(?:-e|-s|--sessions?)(?:\s+|=)(?!py|tests?\b)/,
  /^ctest\b.*\s(?:-N|--show-only\S*)(?=\s|$)/,
  /^swift\s+test\b.*\s--list-tests(?=\s|$)/,
];

const BUILTIN_TEST_PATTERNS = [
  new RegExp(String.raw`^(?:npm|pnpm|yarn|bun)${PM_OPTIONS}${YARN_WORKSPACE}\s+(?:run\s+)?test(?:[:_-]\S+)?(?:\s|$)`),
  /^npm\s+t(?:\s|$)/,
  new RegExp(String.raw`^${JS_LAUNCH}(?:vitest|jest|mocha|ava|tap|playwright\s+test|cypress\s+run|karma\s+start|ng\s+test)(?=\s|$)`),
  // Monorepo and task runners with a test task: `turbo run test`, `nx run app:test`, `nx run-many -t lint,test`.
  new RegExp(String.raw`^${JS_LAUNCH}turbo(?:\s+run)?\s+${TEST_TASK}(?=\s|$)`),
  new RegExp(String.raw`^${JS_LAUNCH}nx\s+(?:${TEST_TASK}|run\s+\S+:${TEST_TASK})(?=\s|$)`),
  new RegExp(String.raw`^${JS_LAUNCH}nx\s+(?:run-many|affected)\s(?:.*\s)?(?:-t|--targets?)(?:\s+|=)(?:[\w:-]+,)*${TEST_TASK}(?=[\s,]|$)`),
  new RegExp(String.raw`^(?:deno\s+task|mise\s+(?:run|r)|task)\s+${TEST_TASK}(?=\s|$)`),
  /^(?:(?:python3?|py)(?:\s+-\d+(?:\.\d+)?)?\s+-m\s+)?pytest\b/,
  /^(?:python3?|py)(?:\s+-\d+(?:\.\d+)?)?\s+-m\s+unittest\b/,
  /^go\s+test\b/,
  /^cargo\s+(?:test|nextest)\b/,
  /^dotnet\s+test\b/,
  /^deno\s+test\b/,
  /^node\s+--test(?:\s|$)/,
  // Flags and `clean` may come first, and a task path such as `:app:test` or a variant task such as
  // `testDebugUnitTest`; `test-compile` and `testClasses` only compile.
  new RegExp(String.raw`^(?:mvn|gradle|\.[\\/](?:mvnw|gradlew))${JVM_OPTIONS}\s+(?:\S*:)?(?:test(?:\w*Test)?|verify|check)(?=\s|$)`),
  /^make\s+(?:test|check)\b/,
  /^(?:bundle\s+exec\s+)?(?:rspec|phpunit)\b/,
  /^(?:\.[\\/])?vendor[\\/]bin[\\/](?:phpunit|pest)\b/,
  /^pest(?:\s|$)/,
  /^(?:bundle\s+exec\s+)?(?:rake|(?:bin[\\/])?rails)\s+test\b/,
  /^mix\s+test\b/,
  /^(?:swift|flutter|dart|sbt|just)\s+test\b/,
  /^zig\s+build\s+test\b/,
  /^ctest\b/,
  /^php\s+artisan\s+test\b/,
  /^composer\s+(?:run(?:-script)?\s+)?test\b/,
  /^(?:tox|nox)(?:\s|$)/,
  /^uvx\s+pytest\b/,
  /^hatch\s+test\b/,
];

const stripQuotes = (s) => s.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
const stripEnv = (s) => s.replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, '');
// Python project runners wrap the real command: `uv run pytest` is checked as `pytest`.
const stripRunner = (s) => s.replace(/^(?:uv|poetry|pipenv|hatch|pdm)\s+run\s+/, '');

// Separators: &&, ||, ;, newline, | and a lone & (not part of 2>&1 or &>).
const SEPARATOR = /(&&|\|\||\r?\n|;|\||(?<![<>&])&(?![>&]))/;
// A final PowerShell `; if ($?) { ... }` or `; if ($LASTEXITCODE -eq 0) { ... }` runs only on success, so a failure
// keeps its exit code. Any other branch (else, -ne 0) runs a statement on failure and resets the code to 0.
// The body still may not run `exit` or assign LASTEXITCODE.
const PS_RESULT_CHECK = /;\s*if\s*\(\s*\$(?:\?|LASTEXITCODE\s+-eq\s+0)\s*\)\s*\{[^{}]*\}\s*$/i;
const RESETS_EXIT = /\bexit\b|LASTEXITCODE\s*=/i;
const PIPEFAIL = /^set\s+([-+])[A-Za-z]*o\s+pipefail\b/;

// Alternating [segment, separator, segment, ...] of the quote-stripped command.
function split(command) {
  const flat = stripQuotes(command).replace(PS_RESULT_CHECK, (t) => (RESETS_EXIT.test(t) ? t : '')).replace(/[\s;]+$/, '');
  return flat.split(SEPARATOR).map((s, i) => (i % 2 ? s.replace('\r', '') : stripRunner(stripEnv(s.trim()))));
}

const segments = (command) => split(command).filter((_, i) => i % 2 === 0);
const isTestSegment = (seg, patterns) => !NO_TESTS_RUN.some((p) => p.test(seg)) && patterns.some((p) => p.test(seg));

// True when a forced-success form appears, or when the first test segment's exit code
// may not be the command's: anything but && after it (| only while set -o pipefail is on).
function masked(command, patterns) {
  const flat = stripQuotes(command);
  if (/\|\|\s*(?:true|:|exit\s+0)(?=\s|;|\)|$)/.test(flat)) return true;
  if (/;\s*exit\s+0(?=\s|;|\)|$)/.test(flat)) return true;
  const parts = split(command);
  let pipefail = false;
  let seenTest = false;
  for (let i = 0; i < parts.length; i += 2) {
    const set = PIPEFAIL.exec(parts[i]);
    if (set) pipefail = set[1] === '-';
    seenTest = seenTest || isTestSegment(parts[i], patterns);
    const sep = parts[i + 1];
    if (!seenTest || sep === undefined || sep === '&&' || (sep === '|' && pipefail)) continue;
    return true;
  }
  return false;
}

function isMasked(command, extraPatterns = []) {
  return masked(command, [...BUILTIN_TEST_PATTERNS, ...extraPatterns]);
}

function isTestCommand(command, extraPatterns = []) {
  const patterns = [...BUILTIN_TEST_PATTERNS, ...extraPatterns];
  if (!segments(command).some((seg) => isTestSegment(seg, patterns))) return false;
  return !masked(command, patterns);
}

// A test ran, but the command's exit code may not be the test's (`npm test | tail`, `npm test; git push`).
function isMaskedTest(command, extraPatterns = []) {
  const patterns = [...BUILTIN_TEST_PATTERNS, ...extraPatterns];
  return segments(command).some((seg) => isTestSegment(seg, patterns)) && masked(command, patterns);
}

function suggestTestCommand(projectDir) {
  const has = (f) => fs.existsSync(path.join(projectDir, f));
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
      if (pkg && pkg.scripts && pkg.scripts.test) return 'npm test';
    } catch { /* unreadable package.json: fall through */ }
  }
  if (has('pyproject.toml')) return 'pytest';
  if (has('go.mod')) return 'go test ./...';
  if (has('Cargo.toml')) return 'cargo test';
  if (fs.readdirSync(projectDir).some((f) => f.endsWith('.sln'))) return 'dotnet test';
  return null;
}

module.exports = { isTestCommand, isMasked, isMaskedTest, suggestTestCommand, BUILTIN_TEST_PATTERNS };
