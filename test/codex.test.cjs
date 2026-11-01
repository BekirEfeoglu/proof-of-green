'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handleCodex, parsePatchPaths } = require('../adapters/codex.cjs');
const { readLedger } = require('../core/ledger.cjs');

function setup(t, extraConfig = {}) {
  const base = fs.mkdtempSync(path.join(os.homedir(), '.pog-codex-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, 'proj');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  const dir = path.join(base, 'ledgers');
  const config = { enabled: true, testPatterns: [], include: [], exclude: [], root: project, ...extraConfig };
  const ctx = { dir, config, env: {} };
  const send = (event, payload) =>
    handleCodex(event, { session_id: 's1', cwd: project, turn_id: 'turn-1', ...payload }, ctx);
  const rollout = (items) => {
    const file = path.join(base, 'rollout.jsonl');
    const lines = items.map(({ turnId = 'turn-1', ...item }, i) =>
      JSON.stringify({ ordinal: i, type: 'event_msg', payload: { type: 'item_completed', turn_id: turnId, item: { type: 'CommandExecution', ...item } } }));
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
  };
  return { project, dir, ctx, send, rollout, ledger: () => readLedger(dir, 's1') };
}

const PATCH = [
  '*** Begin Patch',
  '*** Update File: src/a.ts',
  '@@',
  '-old',
  '+new',
  '*** Move to: src/b.ts',
  '*** Add File: README.md',
  '+hello',
  '*** End Patch',
].join('\n');

const patchTool = (patch = PATCH) => ({ tool_name: 'apply_patch', tool_input: { command: patch } });
const bash = (command, id) => ({ tool_name: 'Bash', tool_input: { command }, tool_use_id: id });

test('parsePatchPaths reads add, update, delete and move headers', () => {
  assert.deepEqual(parsePatchPaths(PATCH), ['src/a.ts', 'src/b.ts', 'README.md']);
  assert.deepEqual(parsePatchPaths('*** Delete File: old.py\r\n*** Add File: new.py\r\n'), ['old.py', 'new.py']);
  assert.deepEqual(parsePatchPaths(''), []);
  assert.deepEqual(parsePatchPaths(undefined), []);
});

test('apply_patch appends one edit per code path, resolved against cwd', (t) => {
  const s = setup(t);
  assert.deepEqual(s.send('post-tool', patchTool()), {});
  const { records, turn } = s.ledger();
  assert.equal(turn, 'turn-1');
  assert.deepEqual(records.map((r) => [r.kind, r.path, r.turn]), [
    ['edit', path.join(s.project, 'src', 'a.ts'), 'turn-1'],
    ['edit', path.join(s.project, 'src', 'b.ts'), 'turn-1'],
  ]);
});

test('Bash appends an unknown command keyed by tool_use_id; array commands are joined', (t) => {
  const s = setup(t);
  s.send('post-tool', bash('npm test', 'call-1'));
  s.send('post-tool', bash(['npx', 'jest'], 'call-2'));
  s.send('post-tool', bash(42, 'call-3'));
  const records = s.ledger().records;
  assert.deepEqual(records.map((r) => [r.kind, r.command, r.isTest, r.result, r.id]), [
    ['command', 'npm test', true, 'unknown', 'call-1'],
    ['command', 'npx jest', true, 'unknown', 'call-2'],
  ]);
});

test('a new turn_id starts a new turn; a missing turn_id keeps the current one', (t) => {
  const s = setup(t);
  s.send('post-tool', patchTool());
  s.send('post-tool', { ...bash('npm test', 'c1'), turn_id: 'turn-2' });
  s.send('post-tool', { ...bash('echo hi', 'c2'), turn_id: undefined });
  const { turn, records } = s.ledger();
  assert.equal(turn, 'turn-2');
  assert.deepEqual(records.map((r) => r.turn), ['turn-1', 'turn-1', 'turn-2', 'turn-2']);
});

test('records store their own turn_id, so a lost turn marker cannot move them', (t) => {
  const s = setup(t);
  s.send('post-tool', patchTool());
  s.send('post-tool', { ...bash('npm test', 'c1'), turn_id: 'turn-2' });
  const file = fs.readdirSync(s.dir).find((n) => n.endsWith('.jsonl'));
  const lines = fs.readFileSync(path.join(s.dir, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.filter((l) => l.kind !== 'turn').map((l) => l.turn), ['turn-1', 'turn-1', 'turn-2']);
  // Without the turn marker the turn-2 record still replays into turn-2.
  fs.writeFileSync(path.join(s.dir, file), lines.filter((l) => l.kind !== 'turn').map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.deepEqual(s.ledger().records.map((r) => r.turn), ['turn-1', 'turn-1', 'turn-2']);
});

test('stop with transcript_path null allows with a systemMessage', (t) => {
  const s = setup(t);
  s.send('post-tool', patchTool());
  s.send('post-tool', bash('npm test', 'call-1'));
  const out = s.send('stop', { transcript_path: null });
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /could not be verified/);
});

test('stop blocks when the rollout shows the test failed (matched by call id)', (t) => {
  const s = setup(t);
  s.send('post-tool', patchTool());
  s.send('post-tool', bash('npm test', 'call-1'));
  const file = s.rollout([{ call_id: 'call-1', command: ['bash', '-lc', 'npm test'], exit_code: 1 }]);
  const out = s.send('stop', { transcript_path: file });
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /failed/);
  assert.match(out.reason, /a\.ts/);
});

test('stop allows when the rollout shows the test passed (matched by call id)', (t) => {
  const s = setup(t);
  s.send('post-tool', patchTool());
  s.send('post-tool', bash('npm test', 'call-1'));
  const file = s.rollout([
    { id: 'other', command: 'npm test', exit_code: 1 },
    { id: 'call-1', command: 'something else', exit_code: 0 },
  ]);
  assert.deepEqual(s.send('stop', { transcript_path: file }), {});
});

test('without ids, results pair with commands by text in order', (t) => {
  const s = setup(t);
  s.send('post-tool', patchTool());
  s.send('post-tool', bash('npm  test'));
  s.send('post-tool', bash('npm test'));
  const failLast = s.rollout([
    { command: ['bash', '-lc', 'npm test'], exit_code: 0 },
    { command: 'npm test', exit_code: 1 },
  ]);
  assert.equal(s.send('stop', { transcript_path: failLast }).decision, 'block');
  const passLast = s.rollout([
    { command: ['bash', '-lc', 'npm test'], exit_code: 1 },
    { command: 'npm test', exit_code: 0 },
  ]);
  assert.deepEqual(s.send('stop', { transcript_path: passLast }), {});
});

test('text matching ignores rollout results from another turn', (t) => {
  const s = setup(t);
  s.send('post-tool', patchTool());
  s.send('post-tool', bash('npm test'));
  const file = s.rollout([
    { command: 'npm test', exit_code: 0, turnId: 'turn-0' },
    { command: 'npm test', exit_code: 1 },
  ]);
  assert.equal(s.send('stop', { transcript_path: file }).decision, 'block');
});

test('a non-integer exit_code leaves the result unknown', (t) => {
  const s = setup(t);
  s.send('post-tool', patchTool());
  s.send('post-tool', bash('npm test', 'call-1'));
  const file = s.rollout([{ call_id: 'call-1', command: 'npm test', exit_code: null }]);
  assert.match(s.send('stop', { transcript_path: file }).systemMessage, /could not be verified/);
});

test('stop blocks after an edit with no test and suggests a command', (t) => {
  const s = setup(t);
  fs.writeFileSync(path.join(s.project, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
  s.send('post-tool', patchTool());
  const out = s.send('stop', { transcript_path: null });
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /Suggested command: `npm test`/);
});

test('stop with stop_hook_active true allows', (t) => {
  const s = setup(t);
  s.send('post-tool', patchTool());
  assert.deepEqual(s.send('stop', { stop_hook_active: true }), {});
});

test('disabled config, missing session_id and unknown events return {} and write nothing', (t) => {
  const s = setup(t, { enabled: false });
  assert.deepEqual(s.send('post-tool', patchTool()), {});
  assert.deepEqual(s.send('stop', {}), {});
  const on = { ...s.ctx, config: { ...s.ctx.config, enabled: true } };
  assert.deepEqual(handleCodex('post-tool', { cwd: s.project, ...patchTool() }, on), {});
  assert.deepEqual(handleCodex('user-prompt', { session_id: 's1', cwd: s.project }, on), {});
  assert.equal(fs.existsSync(s.dir), false);
});

test('without turn ids, an earlier turn\'s pass never satisfies the current turn', (t) => {
  const s = setup(t);
  s.send('post-tool', { ...bash('npm test', 'c1'), turn_id: 'turn-1' });
  s.send('post-tool', { ...patchTool(), turn_id: 'turn-2' });
  s.send('post-tool', { ...bash('npm test'), turn_id: 'turn-2' });
  const file = s.rollout([
    { command: ['bash', '-lc', 'npm test'], exit_code: 0, turnId: null },
    { command: ['bash', '-lc', 'npm test'], exit_code: 1, turnId: null },
  ]);
  assert.equal(s.send('stop', { turn_id: 'turn-2', transcript_path: file }).decision, 'block');
});

test('text matching never takes a result whose call id belongs to another ledger record', (t) => {
  const s = setup(t);
  s.send('post-tool', { ...bash('npm test', 'c1'), turn_id: 'turn-1' });
  s.send('post-tool', { ...patchTool(), turn_id: 'turn-2' });
  s.send('post-tool', { ...bash('npm test'), turn_id: 'turn-2' });
  const file = s.rollout([{ call_id: 'c1', command: 'npm test', exit_code: 0, turnId: null }]);
  const out = s.send('stop', { turn_id: 'turn-2', transcript_path: file });
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /could not be verified/);
});

test('a record with an unmatched id does not take another call\'s result by text', (t) => {
  const s = setup(t);
  s.send('post-tool', patchTool());
  s.send('post-tool', bash('npm test', 'x9'));
  const file = s.rollout([{ call_id: 'c7', command: 'npm test', exit_code: 0 }]);
  const out = s.send('stop', { transcript_path: file });
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /could not be verified/);
});

test('without turn ids, fail then pass in the current turn resolves in order and allows', (t) => {
  const s = setup(t);
  s.send('post-tool', patchTool());
  s.send('post-tool', bash('npm test'));
  s.send('post-tool', bash('npm test'));
  const file = s.rollout([
    { command: 'npm test', exit_code: 1, turnId: null },
    { command: 'npm test', exit_code: 0, turnId: null },
  ]);
  assert.deepEqual(s.send('stop', { transcript_path: file }), {});
});

test('a patch with move and delete headers records every code path and stop blocks', (t) => {
  const s = setup(t);
  s.send('post-tool', patchTool('*** Begin Patch\n*** Update File: src/x.py\n*** Move to: src/y.py\n*** Delete File: lib/old.go\n*** End Patch'));
  assert.deepEqual(s.ledger().records.map((r) => path.relative(s.project, r.path)),
    [path.join('src', 'x.py'), path.join('src', 'y.py'), path.join('lib', 'old.go')]);
  const out = s.send('stop', { transcript_path: null });
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /old\.go/);
});

test('shell wrappers are unwrapped before detection, for argv arrays and strings', (t) => {
  const s = setup(t);
  s.send('post-tool', bash(['bash', '-lc', 'npm test'], 'a1'));
  s.send('post-tool', bash(['/bin/zsh', '-lc', 'npm test; echo done'], 'a2'));
  s.send('post-tool', bash('bash -lc "npm test"', 's1'));
  s.send('post-tool', bash("sh -c 'pytest -q || true'", 's2'));
  s.send('post-tool', bash('pwsh -Command "npm test"', 's3'));
  s.send('post-tool', bash('powershell.exe -Command "go test ./..."', 's4'));
  s.send('post-tool', bash('bash -c "echo npm test"', 's5'));
  const records = s.ledger().records;
  assert.deepEqual(records.map((r) => [r.id, r.isTest]), [
    ['a1', true], ['a2', false], ['s1', true], ['s2', false], ['s3', true], ['s4', true], ['s5', false],
  ]);
  assert.equal(records[0].command, 'bash -lc npm test');
});

const MCP = 'mcp__uzak__run';
const listed = { testTools: [{ tool: MCP, commandArg: 'komut', exitCodeField: 'exit_code' }] };
const mcp = (response, komut = 'npm test', tool = MCP) => ({ tool_name: tool, tool_input: { komut }, tool_response: response });
const mcpText = (code) => JSON.stringify({ exit_code: code, stdout: '' });

test('a listed MCP tool records pass, fail and unknown from its response text', (t) => {
  const s = setup(t, listed);
  s.send('post-tool', mcp(mcpText(0)));
  s.send('post-tool', mcp(mcpText(1)));
  s.send('post-tool', mcp('not json'));
  s.send('post-tool', mcp(mcpText(0), 'echo hi'));
  s.send('post-tool', mcp(mcpText(0), 42));
  s.send('post-tool', mcp(mcpText(0), 'npm test', 'mcp__other__run'));
  assert.deepEqual(s.ledger().records.map(({ kind, command, via, isTest, result }) => ({ kind, command, via, isTest, result })), [
    { kind: 'command', command: 'npm test', via: MCP, isTest: true, result: 'pass' },
    { kind: 'command', command: 'npm test', via: MCP, isTest: true, result: 'fail' },
    { kind: 'command', command: 'npm test', via: MCP, isTest: true, result: 'unknown' },
    { kind: 'command', command: 'echo hi', via: MCP, isTest: false, result: 'pass' },
  ]);
});

test('a listed MCP run decides stop without any rollout file', (t) => {
  const s = setup(t, listed);
  s.send('post-tool', patchTool());
  s.send('post-tool', mcp(mcpText(1)));
  const out = s.send('stop', { transcript_path: null });
  assert.equal(out.decision, 'block');
  assert.ok(out.reason.includes(`(through ${MCP})`), out.reason);
  s.send('post-tool', mcp(mcpText(0)));
  assert.deepEqual(s.send('stop', { transcript_path: null }), {});
});

test('a failed MCP run is never overridden by a passing shell run in the rollout', (t) => {
  const s = setup(t, listed);
  s.send('post-tool', patchTool());
  s.send('post-tool', bash('npm test', 'call-1'));
  s.send('post-tool', mcp(mcpText(1)));
  const file = s.rollout([{ call_id: 'call-1', command: 'npm test', exit_code: 0 }]);
  assert.equal(s.send('stop', { transcript_path: file }).decision, 'block');
  assert.equal(s.ledger().records.at(-1).result, 'fail');
});

test('an unknown MCP result never takes a shell result from the rollout by text', (t) => {
  const s = setup(t, listed);
  s.send('post-tool', patchTool());
  s.send('post-tool', mcp('not json'));
  const file = s.rollout([{ command: 'npm test', exit_code: 0 }]);
  const out = s.send('stop', { transcript_path: file });
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /could not be verified/);
});

test('a listed MCP call with a JSON string tool_input records its command', (t) => {
  const s = setup(t, listed);
  s.send('post-tool', { tool_name: MCP, tool_input: '{"komut":"npm test"}', tool_response: mcpText(0) });
  s.send('post-tool', { tool_name: MCP, tool_input: 'not json', tool_response: mcpText(0) });
  s.send('post-tool', { tool_name: MCP, tool_input: '["npm test"]', tool_response: mcpText(0) });
  assert.deepEqual(s.ledger().records.map(({ kind, command, via, isTest, result }) => ({ kind, command, via, isTest, result })), [
    { kind: 'command', command: 'npm test', via: MCP, isTest: true, result: 'pass' },
  ]);
});

test('an array tool_input is not a plain object and records nothing', (t) => {
  const s = setup(t, listed);
  const arr = ['npm test'];
  arr.komut = 'npm test';
  s.send('post-tool', { tool_name: MCP, tool_input: arr, tool_response: mcpText(0) });
  assert.equal(s.ledger().records.length, 0);
});

// ---- editTools: MCP edit tools ----
const EDIT_MCP = 'mcp__dc__write_file';
const editCfg = { editTools: [{ tool: EDIT_MCP, pathArg: 'path' }] };

test('listed MCP edit tool on a code file records an edit that makes stop block', (t) => {
  const s = setup(t, editCfg);
  s.send('post-tool', { tool_name: EDIT_MCP, tool_input: { path: 'src/a.ts' } });
  const [r] = s.ledger().records;
  assert.deepEqual([r.kind, r.path, r.via], ['edit', path.join(s.project, 'src', 'a.ts'), EDIT_MCP]);
  assert.equal(s.send('stop', { transcript_path: null }).decision, 'block');
});

test('listed MCP edit tool accepts JSON-string tool_input', (t) => {
  const s = setup(t, editCfg);
  s.send('post-tool', { tool_name: EDIT_MCP, tool_input: JSON.stringify({ path: 'src/a.ts' }) });
  assert.deepEqual(s.ledger().records.map((r) => r.kind), ['edit']);
});

test('listed MCP edit tool: non-code path, missing or non-string pathArg record nothing', (t) => {
  const s = setup(t, editCfg);
  s.send('post-tool', { tool_name: EDIT_MCP, tool_input: { path: 'README.md' } });
  s.send('post-tool', { tool_name: EDIT_MCP, tool_input: {} });
  s.send('post-tool', { tool_name: EDIT_MCP, tool_input: { path: 42 } });
  s.send('post-tool', { tool_name: EDIT_MCP, tool_input: 'not json' });
  s.send('post-tool', { tool_name: 'mcp__other__write', tool_input: { path: 'src/a.ts' } });
  assert.deepEqual(s.ledger().records, []);
});

test('a tool listed in both testTools and editTools is treated as a test tool', (t) => {
  const s = setup(t, { testTools: [{ tool: EDIT_MCP, commandArg: 'path', exitCodeField: 'exit_code' }], ...editCfg });
  s.send('post-tool', { tool_name: EDIT_MCP, tool_input: { path: 'src/a.ts' }, tool_response: mcpText(0) });
  assert.deepEqual(s.ledger().records.map((r) => r.kind), ['command']);
});

test('a Bash command that writes a code file records an edit, also inside a shell wrapper', (t) => {
  const s = setup(t);
  s.send('post-tool', bash(['bash', '-lc', "sed -i 's/a/b/' src/a.js"], 'c1'));
  s.send('post-tool', bash('echo x > src/b.py', 'c2'));
  const edits = s.ledger().records.filter((r) => r.kind === 'edit').map((r) => r.path);
  assert.deepEqual(edits, [path.join(s.project, 'src', 'a.js'), path.join(s.project, 'src', 'b.py')]);
  assert.equal(s.send('stop', { transcript_path: null }).decision, 'block');
});

test('a test that runs before a shell edit in the same Bash call does not cover it', (t) => {
  const s = setup(t);
  s.send('post-tool', bash(['bash', '-lc', "npm test && sed -i 's/a/b/' src/a.js"], 'c1'));
  assert.deepEqual(s.ledger().records.map((r) => r.kind), ['command', 'edit']);
  const rollout = s.rollout([{ call_id: 'c1', command: ['bash', '-lc', "npm test && sed -i 's/a/b/' src/a.js"], exit_code: 0 }]);
  assert.equal(s.send('stop', { transcript_path: rollout }).decision, 'block');
});
