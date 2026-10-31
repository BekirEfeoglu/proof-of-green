'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readCommandResults } = require('../adapters/rollout.cjs');

const fixture = (name) => path.join(__dirname, 'fixtures', 'codex', name);

test('reads CommandExecution results with exit codes, call ids and turn ids', () => {
  const results = readCommandResults(fixture('rollout-basic.jsonl'));
  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((r) => [r.callId, r.command, r.exitCode, r.turnId]),
    [
      ['call-1', 'bash -lc npm test', 0, 'turn-1'],
      ['call-2', 'npx jest', 1, 'turn-1'],
    ],
  );
  assert.equal(results[0].lastArg, 'npm test');
});

test('takes item.id as the call id and skips a truncated last line', () => {
  const results = readCommandResults(fixture('rollout-truncated.jsonl'));
  assert.equal(results.length, 1);
  assert.equal(results[0].callId, 'call-9');
  assert.equal(results[0].command, 'powershell.exe -Command npm test');
  assert.equal(results[0].exitCode, 0);
});

test('a file without CommandExecution items gives an empty list', () => {
  assert.deepEqual(readCommandResults(fixture('rollout-unrelated.jsonl')), []);
});

test('null, non-string and missing paths give an empty list', () => {
  assert.deepEqual(readCommandResults(null), []);
  assert.deepEqual(readCommandResults(42), []);
  assert.deepEqual(readCommandResults(fixture('does-not-exist.jsonl')), []);
});
