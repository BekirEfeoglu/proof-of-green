'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handleClaude } = require('../adapters/claude.cjs');
const { readLedger } = require('../core/ledger.cjs');
const { stopResponse } = require('../adapters/common.cjs');

function setup(t, extraConfig = {}) {
  const base = fs.mkdtempSync(path.join(os.homedir(), '.pog-claude-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, 'proj');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  const dir = path.join(base, 'ledgers');
  const config = { enabled: true, testPatterns: [], include: [], exclude: [], root: project, ...extraConfig };
  const ctx = { dir, config, env: {} };
  const send = (event, payload) =>
    handleClaude(event, { session_id: 's1', cwd: project, ...payload }, ctx);
  return { project, dir, ctx, send, ledger: () => readLedger(dir, 's1') };
}

test('user-prompt increments the turn', (t) => {
  const s = setup(t);
  assert.deepEqual(s.send('user-prompt', {}), {});
  assert.equal(s.ledger().turn, '1');
  s.send('user-prompt', {});
  assert.equal(s.ledger().turn, '2');
});

test('post-tool Edit on a code file appends an edit record with absolute path', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool', { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } });
  const { records } = s.ledger();
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'edit');
  assert.equal(records[0].path, path.join(s.project, 'src', 'a.ts'));
  assert.equal(records[0].seq, 1);
  assert.equal(records[0].turn, '1');
  assert.equal(s.ledger().nextSeq, 2);
});

test('NotebookEdit uses notebook_path; non-code edits are ignored', (t) => {
  const s = setup(t);
  s.send('post-tool', { tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(s.project, 'n.ipynb') } });
  s.send('post-tool', { tool_name: 'Write', tool_input: { file_path: path.join(s.project, 'README.md') } });
  const kinds = s.ledger().records.map((r) => r.path && path.basename(r.path));
  assert.ok(!kinds.includes('README.md'));
});

test('post-tool Bash records a passing test command', (t) => {
  const s = setup(t);
  s.send('post-tool', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
  s.send('post-tool', { tool_name: 'PowerShell', tool_input: { command: 'echo hi' } });
  const [a, b] = s.ledger().records;
  assert.deepEqual([a.kind, a.command, a.isTest, a.result], ['command', 'npm test', true, 'pass']);
  assert.deepEqual([b.isTest, b.result], [false, 'pass']);
  assert.ok(b.seq > a.seq);
});

test('post-tool-failure Bash records a failing command', (t) => {
  const s = setup(t);
  s.send('post-tool-failure', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
  const [r] = s.ledger().records;
  assert.deepEqual([r.kind, r.isTest, r.result], ['command', true, 'fail']);
});

test('non-string command is skipped; unknown tools are ignored', (t) => {
  const s = setup(t);
  s.send('post-tool', { tool_name: 'Bash', tool_input: { command: 42 } });
  s.send('post-tool', { tool_name: 'Read', tool_input: { file_path: 'a.ts' } });
  assert.equal(s.ledger().records.length, 0);
});

test('custom testPatterns from config classify commands', (t) => {
  const s = setup(t, { testPatterns: [/^make check$/] });
  s.send('post-tool', { tool_name: 'Bash', tool_input: { command: 'make check' } });
  assert.equal(s.ledger().records[0].isTest, true);
});

test('stop blocks after an edit with no test, then allows after a passing test', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool', { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } });
  const out = s.send('stop', {});
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /a\.ts/);
  s.send('post-tool', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.deepEqual(s.send('stop', {}), {});
});

test('stop with stop_hook_active true allows', (t) => {
  const s = setup(t);
  s.send('post-tool', { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } });
  assert.deepEqual(s.send('stop', { stop_hook_active: true }), {});
});

test('stop suggests the latest test command from any turn', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool', { tool_name: 'Bash', tool_input: { command: 'npx vitest run' } });
  s.send('user-prompt', {});
  s.send('post-tool', { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } });
  const out = s.send('stop', {});
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /npx vitest run/);
});

test('stop falls back to the suggested command from package.json', (t) => {
  const s = setup(t);
  fs.writeFileSync(path.join(s.project, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
  s.send('post-tool', { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } });
  const out = s.send('stop', {});
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /Suggested command/);
});

test('stop survives a missing project root', (t) => {
  const s = setup(t, { root: path.join(os.tmpdir(), 'pog-does-not-exist-xyz') });
  s.send('post-tool', { tool_name: 'Edit', tool_input: { file_path: path.join(s.project, 'a.ts') } });
  const out = s.send('stop', {});
  assert.equal(out.decision, 'block');
});

test('disabled config returns {} and writes nothing', (t) => {
  const s = setup(t, { enabled: false });
  assert.deepEqual(s.send('user-prompt', {}), {});
  assert.deepEqual(s.send('post-tool', { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }), {});
  assert.deepEqual(s.send('stop', {}), {});
  assert.equal(fs.existsSync(s.dir), false);
});

test('missing or non-string session_id returns {} and writes nothing', (t) => {
  const s = setup(t);
  assert.deepEqual(handleClaude('user-prompt', { cwd: s.project }, s.ctx), {});
  assert.deepEqual(handleClaude('user-prompt', { session_id: 5 }, s.ctx), {});
  assert.equal(fs.existsSync(s.dir), false);
});

test('unknown event returns {}', (t) => {
  const s = setup(t);
  assert.deepEqual(s.send('weird', {}), {});
});

test('PROOF_OF_GREEN_TEST_THROW makes the adapter throw', (t) => {
  const s = setup(t);
  assert.throws(() => handleClaude('user-prompt', { session_id: 's1' }, { ...s.ctx, env: { PROOF_OF_GREEN_TEST_THROW: '1' } }));
});

test('a background shell run never counts as a test', (t) => {
  const s = setup(t);
  s.send('post-tool', { tool_name: 'Bash', tool_input: { command: 'npm test', run_in_background: true } });
  s.send('post-tool', { tool_name: 'PowerShell', tool_input: { command: 'npm test', run_in_background: true } });
  assert.deepEqual(s.ledger().records.map((r) => r.isTest), [false, false]);
});

test('stop names the MCP tool that ran the latest test command', () => {
  const project = path.join(os.tmpdir(), 'pog-via-project');
  const records = [
    { seq: 1, turn: '1', kind: 'edit', path: path.join(project, 'src', 'a.ts') },
    { seq: 2, turn: '1', kind: 'command', command: 'npm test', isTest: true, result: 'fail', via: 'mcp__uzak_sunucu__sunucu_komut_calistir' },
  ];
  const out = stopResponse(records, { turn: '1', nextSeq: 3, records }, { enabled: true, root: project }, {});
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /Suggested command: `npm test` \(through mcp__uzak_sunucu__sunucu_komut_calistir\)\./);
});

test('stop keeps the plain suggestion when the latest test ran without an MCP tool', () => {
  const project = path.join(os.tmpdir(), 'pog-via-project');
  const records = [
    { seq: 1, turn: '1', kind: 'edit', path: path.join(project, 'src', 'a.ts') },
    { seq: 2, turn: '1', kind: 'command', command: 'npm test', isTest: true, result: 'fail' },
  ];
  const out = stopResponse(records, { turn: '1', nextSeq: 3, records }, { enabled: true, root: project }, {});
  assert.match(out.reason, /Suggested command: `npm test`\. If this project/);
  assert.doesNotMatch(out.reason, /through/);
});

test('NotebookEdit on a .ipynb records an edit', (t) => {
  const s = setup(t);
  s.send('post-tool', { tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(s.project, 'n.ipynb') } });
  assert.deepEqual(s.ledger().records.map((r) => [r.kind, r.path]), [['edit', path.join(s.project, 'n.ipynb')]]);
});

const MCP = 'mcp__uzak_sunucu__sunucu_komut_calistir';
const mcpConfig = { testTools: [{ tool: MCP, commandArg: 'komut', exitCodeField: 'exit_code' }] };
const mcpResponse = (code) => [{ type: 'text', text: JSON.stringify({ exit_code: code, duration_sec: 1, stdout: code ? 'FAIL' : 'ok', stderr: '' }) }];

test('listed MCP tool with a failing exit code records a failing test via the tool', (t) => {
  const s = setup(t, mcpConfig);
  s.send('post-tool', { tool_name: MCP, tool_input: { komut: 'npm test' }, tool_response: mcpResponse(1) });
  const [r] = s.ledger().records;
  assert.deepEqual([r.kind, r.command, r.via, r.isTest, r.result], ['command', 'npm test', MCP, true, 'fail']);
});

test('listed MCP tool with exit code 0 records a passing test', (t) => {
  const s = setup(t, mcpConfig);
  s.send('post-tool', { tool_name: MCP, tool_input: { komut: 'npm test' }, tool_response: mcpResponse(0) });
  const [r] = s.ledger().records;
  assert.deepEqual([r.isTest, r.result], [true, 'pass']);
});

test('listed MCP tool running a masked command is not a test', (t) => {
  const s = setup(t, mcpConfig);
  s.send('post-tool', { tool_name: MCP, tool_input: { komut: 'npm test || true' }, tool_response: mcpResponse(0) });
  assert.equal(s.ledger().records[0].isTest, false);
});

test('post-tool-failure for a listed MCP tool is a non-test failure', (t) => {
  const s = setup(t, mcpConfig);
  s.send('post-tool-failure', { tool_name: MCP, tool_input: { komut: 'npm test' } });
  const [r] = s.ledger().records;
  assert.deepEqual([r.via, r.isTest, r.result], [MCP, false, 'fail']);
});

// Live Claude Code 2.1.316: a server that flags a failing command as an error fires
// PostToolUseFailure with the exit code JSON in the error text.
const liveError = (code) =>
  `Error: {\n  "exit_code": ${code},\n  "duration_sec": 0.28,\n  "stdout": "",\n  "stderr": "npm notice run test\\nnpm notice run node test.js\\nFAIL\\n"\n}`;

test('post-tool-failure with a readable exit code in the error is a failing test run', (t) => {
  const s = setup(t, mcpConfig);
  s.send('post-tool-failure', { tool_name: MCP, tool_input: { komut: 'npm test' }, error: liveError(1) });
  const [r] = s.ledger().records;
  assert.deepEqual([r.via, r.isTest, r.result], [MCP, true, 'fail']);
});

test('post-tool-failure reads the exit code from tool_response when error is absent', (t) => {
  const s = setup(t, mcpConfig);
  s.send('post-tool-failure', { tool_name: MCP, tool_input: { komut: 'npm test' }, tool_response: liveError(1).slice(7) });
  const [r] = s.ledger().records;
  assert.deepEqual([r.isTest, r.result], [true, 'fail']);
});

test('post-tool-failure with an unreadable error means no test ran', (t) => {
  const s = setup(t, mcpConfig);
  s.send('post-tool-failure', { tool_name: MCP, tool_input: { komut: 'npm test' }, error: 'MCP error -32000: Errno 22 Invalid argument' });
  const [r] = s.ledger().records;
  assert.deepEqual([r.isTest, r.result], [false, 'fail']);
});

test('post-tool-failure for a masked command is not a test', (t) => {
  const s = setup(t, mcpConfig);
  s.send('post-tool-failure', { tool_name: MCP, tool_input: { komut: 'npm test || true' }, error: liveError(1) });
  const [r] = s.ledger().records;
  assert.deepEqual([r.isTest, r.result], [false, 'fail']);
});

test('unlisted MCP tool is never recorded', (t) => {
  const s = setup(t, mcpConfig);
  s.send('post-tool', { tool_name: 'mcp__x__y', tool_input: { komut: 'npm test' }, tool_response: mcpResponse(0) });
  assert.equal(s.ledger().records.length, 0);
});

test('listed MCP tool without a string command argument is not recorded', (t) => {
  const s = setup(t, mcpConfig);
  s.send('post-tool', { tool_name: MCP, tool_input: {}, tool_response: mcpResponse(0) });
  s.send('post-tool', { tool_name: MCP, tool_input: { komut: 42 }, tool_response: mcpResponse(0) });
  assert.equal(s.ledger().records.length, 0);
});

// ---- editTools: MCP edit tools ----
const EDIT_MCP = 'mcp__dc__write_file';
const editCfg = { editTools: [{ tool: EDIT_MCP, pathArg: 'path' }] };

test('listed MCP edit tool on a code file records an edit that makes stop block', (t) => {
  const s = setup(t, editCfg);
  s.send('user-prompt', {});
  s.send('post-tool', { tool_name: EDIT_MCP, tool_input: { path: 'src/a.ts' } });
  const [r] = s.ledger().records;
  assert.deepEqual([r.kind, r.path, r.via], ['edit', path.join(s.project, 'src', 'a.ts'), EDIT_MCP]);
  assert.equal(s.send('stop', {}).decision, 'block');
});

test('listed MCP edit tool: non-code path, missing or non-string pathArg record nothing', (t) => {
  const s = setup(t, editCfg);
  s.send('post-tool', { tool_name: EDIT_MCP, tool_input: { path: 'README.md' } });
  s.send('post-tool', { tool_name: EDIT_MCP, tool_input: {} });
  s.send('post-tool', { tool_name: EDIT_MCP, tool_input: { path: 42 } });
  s.send('post-tool', { tool_name: EDIT_MCP, tool_input: { path: '' } });
  s.send('post-tool', { tool_name: 'mcp__other__write', tool_input: { path: 'src/a.ts' } });
  assert.deepEqual(s.ledger().records, []);
});

test('post-tool-failure for a listed MCP edit tool records nothing', (t) => {
  const s = setup(t, editCfg);
  s.send('post-tool-failure', { tool_name: EDIT_MCP, tool_input: { path: 'src/a.ts' } });
  assert.deepEqual(s.ledger().records, []);
});

test('a tool listed in both testTools and editTools is treated as a test tool', (t) => {
  const s = setup(t, { testTools: [{ tool: EDIT_MCP, commandArg: 'path', exitCodeField: 'exit_code' }], ...editCfg });
  s.send('post-tool', { tool_name: EDIT_MCP, tool_input: { path: 'src/a.ts' }, tool_response: mcpResponse(0) });
  assert.deepEqual(s.ledger().records.map((r) => r.kind), ['command']);
});

// ---- subagents (agent_id) ----
const AGENT = 'a745dd613b6b01ba0';
const OTHER = 'b000000000000000b';
const asAgent = (id, payload) => ({ agent_id: id, agent_type: 'general-purpose', ...payload });

test('records from an event with agent_id carry agent; the main agent records do not', (t) => {
  const s = setup(t, { ...mcpConfig, ...editCfg });
  s.send('user-prompt', {});
  s.send('post-tool', asAgent(AGENT, { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }));
  s.send('post-tool', asAgent(AGENT, { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  s.send('post-tool', asAgent(AGENT, { tool_name: MCP, tool_input: { komut: 'npm test' }, tool_response: mcpResponse(0) }));
  s.send('post-tool', asAgent(AGENT, { tool_name: EDIT_MCP, tool_input: { path: 'src/b.ts' } }));
  s.send('post-tool-failure', asAgent(AGENT, { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  s.send('post-tool', { tool_name: 'Edit', tool_input: { file_path: 'src/c.ts' } });
  s.send('post-tool', { agent_id: '', tool_name: 'Edit', tool_input: { file_path: 'src/d.ts' } });
  s.send('post-tool', { agent_id: 7, tool_name: 'Edit', tool_input: { file_path: 'src/e.ts' } });
  assert.deepEqual(s.ledger().records.map((r) => r.agent), [AGENT, AGENT, AGENT, AGENT, AGENT, undefined, undefined, undefined]);
});

test('subagent-stop blocks when its own edit has no passing test', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool', asAgent(AGENT, { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }));
  const out = s.send('subagent-stop', asAgent(AGENT, {}));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /a\.ts/);
});

test('subagent-stop allows after its own passing test', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool', asAgent(AGENT, { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }));
  s.send('post-tool', asAgent(AGENT, { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  assert.deepEqual(s.send('subagent-stop', asAgent(AGENT, {})), {});
});

test('subagent-stop blocks after its own failing test', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool', asAgent(AGENT, { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }));
  s.send('post-tool-failure', asAgent(AGENT, { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  assert.equal(s.send('subagent-stop', asAgent(AGENT, {})).decision, 'block');
});

test('subagent-stop ignores edits by the parent and by other agents', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool', { tool_name: 'Edit', tool_input: { file_path: 'src/parent.ts' } });
  s.send('post-tool', asAgent(OTHER, { tool_name: 'Edit', tool_input: { file_path: 'src/other.ts' } }));
  assert.deepEqual(s.send('subagent-stop', asAgent(AGENT, {})), {});
});

test('subagent-stop does not count tests run by the parent or other agents', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool', asAgent(AGENT, { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }));
  s.send('post-tool', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
  s.send('post-tool', asAgent(OTHER, { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  const out = s.send('subagent-stop', asAgent(AGENT, {}));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /a\.ts/);
  assert.doesNotMatch(out.reason, /parent|other/);
});

test('subagent-stop of a background agent still sees its edits from an earlier parent turn', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool', asAgent(AGENT, { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }));
  s.send('user-prompt', {});
  const out = s.send('subagent-stop', asAgent(AGENT, {}));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /a\.ts/);
});

test('subagent-stop allows when its test in a later parent turn follows its edit', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool', asAgent(AGENT, { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }));
  s.send('user-prompt', {});
  s.send('post-tool', asAgent(AGENT, { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  assert.deepEqual(s.send('subagent-stop', asAgent(AGENT, {})), {});
});

test('subagent-stop with stop_hook_active true allows', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool', asAgent(AGENT, { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }));
  assert.deepEqual(s.send('subagent-stop', asAgent(AGENT, { stop_hook_active: true })), {});
});

test('subagent-stop without a non-empty string agent_id allows', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool', { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } });
  assert.deepEqual(s.send('subagent-stop', {}), {});
  assert.deepEqual(s.send('subagent-stop', { agent_id: '' }), {});
  assert.deepEqual(s.send('subagent-stop', { agent_id: 7 }), {});
});

test('subagent-stop suggests the latest test command from its own records', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool', asAgent(AGENT, { tool_name: 'Bash', tool_input: { command: 'npx vitest run' } }));
  s.send('post-tool', asAgent(AGENT, { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }));
  s.send('post-tool', { tool_name: 'Bash', tool_input: { command: 'npx jest' } });
  const out = s.send('subagent-stop', asAgent(AGENT, {}));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /npx vitest run/);
  assert.doesNotMatch(out.reason, /npx jest/);
});

test('parent stop still blocks on an untested edit of a stopped subagent', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool', asAgent(AGENT, { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }));
  assert.equal(s.send('subagent-stop', asAgent(AGENT, {})).decision, 'block');
  const out = s.send('stop', {});
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /a\.ts/);
  assert.doesNotMatch(out.reason, /still running/);
});

const runningNote = (id) => `proof-of-green: subagent ${id} has not reported a stop yet; its changes will be checked when it stops.`;

test('subagent-stop records an agent-stop line whether it blocks or allows', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool', asAgent(AGENT, { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }));
  s.send('subagent-stop', asAgent(AGENT, {}));
  s.send('subagent-stop', asAgent(OTHER, {}));
  const l = s.ledger();
  assert.deepEqual([...l.stoppedAgents].sort(), [AGENT, OTHER].sort());
  assert.equal(l.records.length, 1);
});

test('parent stop allows with a note while a background subagent with edits is still running', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool', asAgent(AGENT, { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }));
  assert.deepEqual(s.send('stop', {}), { systemMessage: runningNote(AGENT) });
});

test('parent stop blocks on that subagent edit once the subagent has stopped', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool', asAgent(AGENT, { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }));
  s.send('stop', {});
  s.send('subagent-stop', asAgent(AGENT, { stop_hook_active: true }));
  const out = s.send('stop', {});
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /a\.ts/);
});

test('parent stop counts a foreground subagent that stopped before it', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool', asAgent(AGENT, { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }));
  s.send('post-tool', asAgent(AGENT, { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  assert.deepEqual(s.send('subagent-stop', asAgent(AGENT, {})), {});
  s.send('post-tool', { tool_name: 'Edit', tool_input: { file_path: 'src/p.ts' } });
  s.send('post-tool', asAgent(OTHER, { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  s.send('subagent-stop', asAgent(OTHER, {}));
  assert.deepEqual(s.send('stop', {}), {});
});

test('a running subagent test does not satisfy the parent; the block reason carries the note', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool', { tool_name: 'Edit', tool_input: { file_path: 'src/p.ts' } });
  s.send('post-tool', asAgent(AGENT, { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }));
  s.send('post-tool', asAgent(AGENT, { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  const out = s.send('stop', {});
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /p\.ts/);
  assert.doesNotMatch(out.reason, /a\.ts/);
  assert.ok(out.reason.endsWith(' ' + runningNote(AGENT)));
});

test('a running subagent without edits gives no note', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool', asAgent(AGENT, { tool_name: 'Bash', tool_input: { command: 'ls' } }));
  assert.deepEqual(s.send('stop', {}), {});
});

test('a shell command that writes a code file records an edit before the command', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool', { tool_name: 'Bash', tool_input: { command: "sed -i 's/a/b/' src/a.js && echo x > notes.txt" } });
  const records = s.ledger().records;
  assert.deepEqual(records.map((r) => r.kind), ['edit', 'command']);
  assert.equal(records[0].path, path.join(s.project, 'src', 'a.js'));
});

test('a shell edit without a later test blocks the stop', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool', { tool_name: 'PowerShell', tool_input: { command: 'Set-Content -Path src/a.ts -Value x' } });
  const out = s.send('stop', {});
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /a\.ts/);
});

test('a shell edit and a passing test in one command allow the stop', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool', { tool_name: 'Bash', tool_input: { command: "sed -i 's/a/b/' src/a.js && npm test" } });
  assert.deepEqual(s.send('stop', {}), {});
});

test('a failed or background shell command still records its edit', (t) => {
  const s = setup(t);
  s.send('user-prompt', {});
  s.send('post-tool-failure', { tool_name: 'Bash', tool_input: { command: 'node gen.js > src/a.py' } });
  s.send('post-tool', { tool_name: 'Bash', tool_input: { command: 'node gen.js > src/b.py', run_in_background: true } });
  assert.deepEqual(s.ledger().records.filter((r) => r.kind === 'edit').map((r) => path.basename(r.path)), ['a.py', 'b.py']);
});
