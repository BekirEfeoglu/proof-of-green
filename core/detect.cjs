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

function segments(command) {
  return stripQuotes(command).split(/&&|\|\||;|\r?\n/).map((s) => stripEnv(s.trim()));
}

const isTestSegment = (seg, patterns) => patterns.some((p) => p.test(seg));

function masked(command, patterns) {
  const flat = stripQuotes(command);
  if (/\|\|\s*(?:true|:|exit\s+0)(?=\s|;|\)|$)/.test(flat)) return true;
  if (/;\s*exit\s+0(?=\s|;|\)|$)/.test(flat)) return true;
  if (/pipefail/.test(flat)) return false;
  return segments(command).some((seg) => isTestSegment(seg, patterns) && /(?:^|[^|])\|(?!\|)/.test(seg));
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
