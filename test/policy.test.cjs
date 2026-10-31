'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../core/policy.cjs');

const ON = { enabled: true, stopHookActive: false, suggestedCommand: null };
const edit = (seq, p = 'src/a.js') => ({ seq, turn: '1', kind: 'edit', path: p });
const cmd = (seq, command, isTest, result) => ({ seq, turn: '1', kind: 'command', command, isTest, result });
const passT = (seq) => cmd(seq, 'npm test', true, 'pass');
const failTest = (seq) => cmd(seq, 'npm test', true, 'fail');

test('disabled allows', () => {
  assert.deepEqual(decide([edit(1)], { ...ON, enabled: false }), { action: 'allow' });
});

test('stopHookActive allows', () => {
  assert.deepEqual(decide([edit(1)], { ...ON, stopHookActive: true }), { action: 'allow' });
});

test('no edit allows', () => {
  assert.deepEqual(decide([failTest(1)], ON), { action: 'allow' });
  assert.deepEqual(decide([], ON), { action: 'allow' });
});

test('edit then passing test allows', () => {
  assert.deepEqual(decide([edit(1), passT(2)], ON), { action: 'allow' });
});

test('passing test then edit blocks as missing', () => {
  const r = decide([passT(1), edit(2, 'src/foo.js')], ON);
  assert.equal(r.action, 'block');
  assert.match(r.reason, /no test command ran/);
  assert.match(r.reason, /foo\.js/);
});

test('edit then failing test blocks as failed', () => {
  const r = decide([edit(1), failTest(2)], ON);
  assert.equal(r.action, 'block');
  assert.match(r.reason, /failed/);
});

test('edit, failing test, passing test allows', () => {
  assert.deepEqual(decide([edit(1), failTest(2), passT(3)], ON), { action: 'allow' });
});

test('non-test commands are ignored', () => {
  assert.deepEqual(decide([edit(1), passT(2), cmd(3, 'ls', false, 'pass')], ON), { action: 'allow' });
  const r = decide([edit(1), failTest(2), cmd(3, 'ls', false, 'pass')], ON);
  assert.equal(r.action, 'block');
});

test('latest test unknown allows with systemMessage', () => {
  const r = decide([edit(1), cmd(2, 'npm test', true, 'unknown')], ON);
  assert.equal(r.action, 'allow');
  assert.equal(
    r.systemMessage,
    'proof-of-green: the result of the last test command could not be verified, so the stop was allowed.',
  );
});

test('seven edited files list five and (+2 more)', () => {
  const edits = Array.from({ length: 7 }, (_, i) => edit(i + 1, `src/f${i + 1}.js`));
  const r = decide(edits, ON);
  assert.match(r.reason, /\(f1\.js, f2\.js, f3\.js, f4\.js, f5\.js \(\+2 more\)\)/);
  assert.doesNotMatch(r.reason, /f6\.js/);
});

test('repeated edits of one path are listed once', () => {
  const r = decide([edit(1, 'a/x.js'), edit(2, 'b/x.js'), edit(3, 'a/x.js')], ON);
  assert.match(r.reason, /\(x\.js\)/);
});

test('exact copy for missing and failed, with suggested command', () => {
  const opts = { ...ON, suggestedCommand: 'npm test' };
  const tail = ' Suggested command: `npm test`. If this project has no tests, or the user asked you not to run them, say so plainly and finish.';
  assert.equal(
    decide([edit(1, 'a.js')], opts).reason,
    'proof-of-green: you changed code (a.js) but no test command ran after the last change. Run the tests and report the result.' + tail,
  );
  assert.equal(
    decide([edit(1, 'a.js'), failTest(2)], opts).reason,
    'proof-of-green: you changed code (a.js) and the last test run after that change failed. Fix the failures and run the tests again, or report the failing tests to the user.' + tail,
  );
});

test('without suggested command the sentence is omitted but the escape hatch stays', () => {
  const r = decide([edit(1)], ON);
  assert.doesNotMatch(r.reason, /Suggested command/);
  assert.match(r.reason, /If this project has no tests, or the user asked you not to run them, say so plainly and finish\.$/);
});

test('reason never mentions the off switch', () => {
  for (const recs of [[edit(1)], [edit(1), failTest(2)]]) {
    assert.doesNotMatch(decide(recs, { ...ON, suggestedCommand: 'npm test' }).reason, /disable|PROOF_OF_GREEN|enabled/i);
  }
});

test('records are sorted by seq defensively', () => {
  assert.deepEqual(decide([passT(2), edit(1)], ON), { action: 'allow' });
});

test('bad input does not throw and allows', () => {
  assert.deepEqual(decide(null, ON), { action: 'allow' });
  assert.deepEqual(decide('x', ON), { action: 'allow' });
  assert.deepEqual(decide([edit(1)]), { action: 'allow' });
  assert.deepEqual(decide([edit(1)], null), { action: 'allow' });
});
