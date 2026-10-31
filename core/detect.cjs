'use strict';
const fs = require('node:fs');
const path = require('node:path');

const BUILTIN_TEST_PATTERNS = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::\S+)?(?:\s|$)/,
  /^npx\s+(?:vitest|jest|mocha)\b/,
  /^(?:python3?\s+-m\s+)?pytest\b/,
  /^python3?\s+-m\s+unittest\b/,
  /^go\s+test\b/,
  /^cargo\s+(?:test|nextest)\b/,
  /^dotnet\s+test\b/,
  /^(?:mvn|\.\/mvnw|gradle|\.\/gradlew)\s+(?:test|verify)\b/,
  /^make\s+(?:test|check)\b/,
  /^(?:rspec|phpunit)\b/,
  /^mix\s+test\b/,
];

const stripQuotes = (s) => s.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
const stripEnv = (s) => s.replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, '');

// Separators: &&, ||, ;, newline, | and a lone & (not part of 2>&1 or &>).
const SEPARATOR = /(&&|\|\||\r?\n|;|\||(?<![<>&])&(?![>&]))/;
// PowerShell's `; if ($?) { ... }` or `; if ($LASTEXITCODE ...) { ... }` tail checks the result, so it may follow a test.
const PS_RESULT_CHECK = /;\s*if\s*\(\s*\$(?:\?|LASTEXITCODE\b[^)]*)\)\s*\{[^{}]*\}\s*$/i;
const PIPEFAIL = /^set\s+-[A-Za-z]*o\s+pipefail\b/;

// Alternating [segment, separator, segment, ...] of the quote-stripped command.
function split(command) {
  const flat = stripQuotes(command).replace(PS_RESULT_CHECK, '').replace(/[\s;]+$/, '');
  return flat.split(SEPARATOR).map((s, i) => (i % 2 ? s.replace('\r', '') : stripEnv(s.trim())));
}

const segments = (command) => split(command).filter((_, i) => i % 2 === 0);
const isTestSegment = (seg, patterns) => patterns.some((p) => p.test(seg));

// True when a forced-success form appears, or when the last test segment's exit code
// is not the command's: anything but && after it (| only under an earlier set -o pipefail).
function masked(command, patterns) {
  const flat = stripQuotes(command);
  if (/\|\|\s*(?:true|:|exit\s+0)(?=\s|;|\)|$)/.test(flat)) return true;
  if (/;\s*exit\s+0(?=\s|;|\)|$)/.test(flat)) return true;
  const parts = split(command);
  let last = -1;
  for (let i = 0; i < parts.length; i += 2) if (isTestSegment(parts[i], patterns)) last = i;
  if (last < 0) return false;
  const pipefail = parts.slice(0, last).some((s, i) => i % 2 === 0 && PIPEFAIL.test(s));
  for (let i = last + 1; i < parts.length; i += 2) {
    if (parts[i] === '&&' || (parts[i] === '|' && pipefail)) continue;
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
