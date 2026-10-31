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

function setupCodex(t) {
  const base = fs.mkdtempSync(path.join(os.homedir(), '.pog-e2e-codex-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, 'proj');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  const state = path.join(base, 'state');
  const run = (event, payload, extraEnv = {}) => {
    const r = spawnSync(process.execPath, [GATE, 'codex', event], {
      input: JSON.stringify({ session_id: 'e2e-codex', cwd: project, turn_id: 'turn-1', ...payload }),
      encoding: 'utf8',
      env: { ...process.env, LOCALAPPDATA: state, XDG_STATE_HOME: state, ...extraEnv },
    });
    return { status: r.status, out: r.stdout.trim() };
  };
  const rollout = (exitCode) => {
    const file = path.join(base, 'rollout.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      type: 'event_msg',
      payload: { type: 'item_completed', turn_id: 'turn-1', item: { type: 'CommandExecution', call_id: 'call-1', command: ['bash', '-lc', 'npm test'], exit_code: exitCode } },
    }) + '\n');
    return file;
  };
  return { run, rollout, state };
}

const codexPatch = { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch' } };
const codexTest = { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'call-1' };

test('codex: patch, failing test in rollout, stop blocks', (t) => {
  const s = setupCodex(t);
  assert.equal(s.run('post-tool', codexPatch).out, '{}');
  assert.equal(s.run('post-tool', codexTest).out, '{}');
  const r = s.run('stop', { transcript_path: s.rollout(1) });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.out).decision, 'block');
});

test('codex: patch, passing test in rollout, stop allows', (t) => {
  const s = setupCodex(t);
  s.run('post-tool', codexPatch);
  s.run('post-tool', codexTest);
  assert.equal(s.run('stop', { transcript_path: s.rollout(0) }).out, '{}');
});

test('codex: missing transcript allows with a systemMessage; other events give {}', (t) => {
  const s = setupCodex(t);
  s.run('post-tool', codexPatch);
  s.run('post-tool', codexTest);
  assert.match(JSON.parse(s.run('stop', { transcript_path: null }).out).systemMessage, /could not be verified/);
  assert.equal(s.run('user-prompt', {}).out, '{}');
});

test('codex: throwing adapter fails open and logs to the codex ledger dir', (t) => {
  const s = setupCodex(t);
  const r = s.run('stop', {}, { PROOF_OF_GREEN_TEST_THROW: '1' });
  assert.deepEqual([r.status, r.out], [0, '{}']);
  const log = fs.readFileSync(path.join(s.state, 'proof-of-green', 'errors.log'), 'utf8');
  assert.match(log, /PROOF_OF_GREEN_TEST_THROW/);
});

test('edit, background npm test that "passes", stop blocks', (t) => {
  const s = setup(t);
  s.run('user-prompt', {});
  s.run('post-tool', edit);
  s.run('post-tool', { tool_name: 'Bash', tool_input: { command: 'npm test', run_in_background: true } });
  assert.equal(JSON.parse(s.run('stop', {}).out).decision, 'block');
});

test('listed MCP test tool: edit, failing run blocks naming the tool, passing run allows', (t) => {
  const s = setup(t);
  const home = fs.mkdtempSync(path.join(os.homedir(), '.pog-e2e-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const MCP = 'mcp__uzak_sunucu__sunucu_komut_calistir';
  fs.writeFileSync(path.join(home, '.proof-of-green.json'), JSON.stringify({ testTools: [{ tool: MCP, commandArg: 'komut' }] }));
  const env = { HOME: home, USERPROFILE: home };
  const response = (code) => [{ type: 'text', text: JSON.stringify({ exit_code: code, duration_sec: 0.05, stdout: code ? 'FAIL' : 'ok', stderr: '' }) }];
  const mcp = (code) => ({ tool_name: MCP, tool_input: { komut: 'npm test' }, tool_response: response(code) });

  s.run('user-prompt', {}, env);
  s.run('post-tool', edit, env);
  s.run('post-tool', mcp(1), env);
  const blocked = JSON.parse(s.run('stop', {}, env).out);
  assert.equal(blocked.decision, 'block');
  assert.ok(blocked.reason.includes(`(through ${MCP})`), blocked.reason);

  s.run('user-prompt', {}, env);
  s.run('post-tool', edit, env);
  s.run('post-tool', mcp(0), env);
  assert.equal(s.run('stop', {}, env).out, '{}');
});
