'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GATE = path.join(__dirname, '..', 'gate.cjs');

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.homedir(), '.pog-e2e-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, 'proj');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  const data = path.join(base, 'data');
  const run = (event, payload, extraEnv = {}, rawInput) => {
    const input = rawInput !== undefined ? rawInput : JSON.stringify({ session_id: 'e2e', cwd: project, ...payload });
    const r = spawnSync(process.execPath, [GATE, 'claude', event], {
      input,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data, ...extraEnv },
    });
    return { status: r.status, out: r.stdout.trim() };
  };
  return { project, data, run };
}

const edit = { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } };
const npmTest = { tool_name: 'Bash', tool_input: { command: 'npm test' } };

test('prompt, edit, stop blocks', (t) => {
  const s = setup(t);
  assert.equal(s.run('user-prompt', {}).out, '{}');
  assert.equal(s.run('post-tool', edit).out, '{}');
  const r = s.run('stop', {});
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.decision, 'block');
  assert.match(parsed.reason, /a\.ts/);
});

test('prompt, edit, passing test, stop allows', (t) => {
  const s = setup(t);
  s.run('user-prompt', {});
  s.run('post-tool', edit);
  s.run('post-tool', npmTest);
  assert.equal(s.run('stop', {}).out, '{}');
});

test('failing test then stop blocks', (t) => {
  const s = setup(t);
  s.run('user-prompt', {});
  s.run('post-tool', edit);
  s.run('post-tool-failure', npmTest);
  assert.equal(JSON.parse(s.run('stop', {}).out).decision, 'block');
});

test('stop with stop_hook_active true allows', (t) => {
  const s = setup(t);
  s.run('user-prompt', {});
  s.run('post-tool', edit);
  assert.equal(s.run('stop', { stop_hook_active: true }).out, '{}');
});

test('empty stdin, invalid JSON, and missing session_id each give {} with exit 0', (t) => {
  const s = setup(t);
  for (const raw of ['', 'not json', '{}']) {
    const r = s.run('stop', {}, {}, raw);
    assert.deepEqual([r.status, r.out], [0, '{}'], `input: ${JSON.stringify(raw)}`);
  }
});

test('unknown agent and unknown event give {}', (t) => {
  const s = setup(t);
  const r = spawnSync(process.execPath, [GATE, 'nobody', 'stop'], { input: '{}', encoding: 'utf8' });
  assert.deepEqual([r.status, r.stdout.trim()], [0, '{}']);
  assert.equal(s.run('bogus', {}).out, '{}');
});

test('throwing adapter fails open and logs to errors.log', (t) => {
  const s = setup(t);
  const r = s.run('user-prompt', {}, { PROOF_OF_GREEN_TEST_THROW: '1' });
  assert.deepEqual([r.status, r.out], [0, '{}']);
  const log = fs.readFileSync(path.join(s.data, 'ledgers', 'errors.log'), 'utf8');
  assert.match(log, /PROOF_OF_GREEN_TEST_THROW|test throw/i);
});

test('PROOF_OF_GREEN=off disables the gate', (t) => {
  const s = setup(t);
  s.run('user-prompt', {}, { PROOF_OF_GREEN: 'off' });
  s.run('post-tool', edit, { PROOF_OF_GREEN: 'off' });
  assert.equal(s.run('stop', {}, { PROOF_OF_GREEN: 'off' }).out, '{}');
});
