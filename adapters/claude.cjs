'use strict';
const path = require('node:path');
const { isTestCommand, isMaskedTest } = require('../core/detect.cjs');
const { isCodeFile } = require('../core/codefiles.cjs');
const { readLedger, appendRecord, startTurn } = require('../core/ledger.cjs');
const { readToolExitCode } = require('../core/toolresult.cjs');
const { stopResponse, parentRecords, pushShellCommand } = require('./common.cjs');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// Claude Code adds agent_id to the events of a subagent; the main agent's events have none.
const agentIdOf = (p) => (typeof p.agent_id === 'string' && p.agent_id ? p.agent_id : null);

function recordTool(out, payload, cwd, config, result) {
  const tool = payload.tool_name;
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  if (result === 'pass' && EDIT_TOOLS.has(tool)) {
    const p = input.file_path || input.notebook_path;
    if (typeof p !== 'string' || !p) return false;
    const abs = path.resolve(cwd, p);
    if (!isCodeFile(abs, { root: config.root, include: config.include, exclude: config.exclude })) return false;
    out.push({ kind: 'edit', path: abs });
    return true;
  }
  const listed = Array.isArray(config.testTools) ? config.testTools.find((t) => t.tool === tool) : undefined;
  if (listed) {
    const command = input[listed.commandArg];
    if (typeof command !== 'string') return false;
    if (result === 'fail') {
      // A server may report a failing command as an error. A readable exit code means the
      // command ran; an unreadable error (server unreachable) means no test ran.
      const response = typeof payload.error === 'string' ? payload.error : payload.tool_response;
      const ran = readToolExitCode(response, listed.exitCodeField) === 'fail';
      out.push({ kind: 'command', command, via: tool, isTest: ran && isTestCommand(command, config.testPatterns), result: 'fail' });
      return true;
    }
    out.push({
      kind: 'command',
      command,
      via: tool,
      isTest: isTestCommand(command, config.testPatterns),
      result: readToolExitCode(payload.tool_response, listed.exitCodeField),
    });
    return true;
  }
  // Listed after testTools, so a tool in both lists is a test tool.
  const editTool = result === 'pass' && Array.isArray(config.editTools) ? config.editTools.find((t) => t.tool === tool) : undefined;
  if (editTool) {
    const p = input[editTool.pathArg];
    if (typeof p !== 'string' || !p) return false;
    const abs = path.resolve(cwd, p);
    if (!isCodeFile(abs, { root: config.root, include: config.include, exclude: config.exclude })) return false;
    out.push({ kind: 'edit', path: abs, via: tool });
    return true;
  }
  if (SHELL_TOOLS.has(tool)) {
    if (typeof input.command !== 'string') return false;
    const background = input.run_in_background === true;
    const record = {
      kind: 'command',
      command: input.command,
      // A background run reports success when it starts, not when the tests finish.
      isTest: !background && isTestCommand(input.command, config.testPatterns),
      result,
    };
    if (!background && isMaskedTest(input.command, config.testPatterns)) record.masked = true;
    pushShellCommand(out, input.command, cwd, config, record);
    return true;
  }
  return false;
}

function handleClaude(event, payload, ctx) {
  const { dir, config, env } = ctx;
  if (env && env.PROOF_OF_GREEN_TEST_THROW === '1') throw new Error('PROOF_OF_GREEN_TEST_THROW');
  if (!config.enabled) return {};
  const p = payload && typeof payload === 'object' ? payload : {};
  if (typeof p.session_id !== 'string' || !p.session_id) return {};
  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd();

  switch (event) {
    case 'user-prompt':
      startTurn(dir, p.session_id, String(Number(readLedger(dir, p.session_id).turn) + 1));
      return {};
    case 'post-tool':
    case 'post-tool-failure': {
      const out = [];
      recordTool(out, p, cwd, config, event === 'post-tool' ? 'pass' : 'fail');
      const agent = agentIdOf(p);
      for (const record of out) appendRecord(dir, p.session_id, agent ? { ...record, agent } : record);
      return {};
    }
    case 'stop': {
      const ledger = readLedger(dir, p.session_id);
      const { records, note } = parentRecords(ledger);
      return stopResponse(records, ledger, config, p, note);
    }
    case 'subagent-stop': {
      // Judge the subagent on all of its own records, whatever the parent's turn: a background
      // subagent can outlive the turn that started it. decide() compares its last edit with later tests.
      const agent = agentIdOf(p);
      if (!agent) return {};
      // Marks the subagent as stopped for the parent's Stop, whatever this decision is.
      appendRecord(dir, p.session_id, { kind: 'agent-stop', agent });
      if (p.stop_hook_active === true) return {};
      const ledger = readLedger(dir, p.session_id);
      const own = { ...ledger, records: ledger.records.filter((r) => r.agent === agent) };
      return stopResponse(own.records, own, config, p);
    }
    default:
      return {};
  }
}

module.exports = { handleClaude };
