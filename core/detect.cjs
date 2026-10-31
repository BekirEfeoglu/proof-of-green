'use strict';
const fs = require('node:fs');
const path = require('node:path');

const BUILTIN_TEST_PATTERNS = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::\S+)?(?:\s|$)/,
  /^npm\s+t(?:\s|$)/,
  /^(?:npx|bunx|bun\s+x|pnpm(?:\s+(?:exec|dlx))?|yarn(?:\s+dlx)?)\s+(?:vitest|jest|mocha|playwright\s+test)\b/,
  /^(?:(?:python3?|py)(?:\s+-\d+(?:\.\d+)?)?\s+-m\s+)?pytest\b/,
  /^(?:python3?|py)(?:\s+-\d+(?:\.\d+)?)?\s+-m\s+unittest\b/,
  /^go\s+test\b/,
  /^cargo\s+(?:test|nextest)\b/,
  /^dotnet\s+test\b/,
  /^deno\s+test\b/,
  /^(?:mvn|gradle|\.[\\/](?:mvnw|gradlew))\s+(?:test|verify)\b/,
  /^make\s+(?:test|check)\b/,
  /^(?:rspec|phpunit)\b/,
  /^mix\s+test\b/,
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
const isTestSegment = (seg, patterns) => patterns.some((p) => p.test(seg));

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

module.exports = { isTestCommand, isMasked, suggestTestCommand, BUILTIN_TEST_PATTERNS };
