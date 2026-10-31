'use strict';
const path = require('node:path');
const { isTestCommand } = require('../core/detect.cjs');
const { isCodeFile } = require('../core/codefiles.cjs');
const { readLedger, writeLedger, currentTurnRecords } = require('../core/ledger.cjs');
const { push, stopResponse } = require('./common.cjs');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

function recordTool(ledger, payload, cwd, config, result) {
  const tool = payload.tool_name;
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  if (result === 'pass' && EDIT_TOOLS.has(tool)) {
    const p = input.file_path || input.notebook_path;
    if (typeof p !== 'string' || !p) return false;
    const abs = path.resolve(cwd, p);
    if (!isCodeFile(abs, { root: config.root, include: config.include, exclude: config.exclude })) return false;
    push(ledger, { kind: 'edit', path: abs });
    return true;
  }
  if (SHELL_TOOLS.has(tool)) {
    if (typeof input.command !== 'string') return false;
    push(ledger, {
      kind: 'command',
      command: input.command,
      // A background run reports success when it starts, not when the tests finish.
      isTest: input.run_in_background !== true && isTestCommand(input.command, config.testPatterns),
      result,
    });
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
  const ledger = readLedger(dir, p.session_id);

  switch (event) {
    case 'user-prompt':
      ledger.turn = String(Number(ledger.turn) + 1);
      writeLedger(dir, p.session_id, ledger);
      return {};
    case 'post-tool':
    case 'post-tool-failure':
      if (recordTool(ledger, p, cwd, config, event === 'post-tool' ? 'pass' : 'fail')) {
        writeLedger(dir, p.session_id, ledger);
      }
      return {};
    case 'stop':
      return stopResponse(currentTurnRecords(ledger), ledger, config, p);
    default:
      return {};
  }
}

module.exports = { handleClaude };
