'use strict';
const path = require('node:path');
const { isTestCommand, suggestTestCommand } = require('../core/detect.cjs');
const { isCodeFile } = require('../core/codefiles.cjs');
const { readLedger, writeLedger, currentTurnRecords } = require('../core/ledger.cjs');
const { decide } = require('../core/policy.cjs');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

function guardedSuggest(root) {
  try { return suggestTestCommand(root) || null; } catch { return null; }
}

function latestTestCommand(ledger) {
  for (let i = ledger.records.length - 1; i >= 0; i--) {
    const r = ledger.records[i];
    if (r && r.kind === 'command' && r.isTest === true && typeof r.command === 'string') return r.command;
  }
  return null;
}

function push(ledger, record) {
  ledger.records.push({ seq: ledger.nextSeq, turn: ledger.turn, ...record });
  ledger.nextSeq += 1;
}

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
      isTest: isTestCommand(input.command, config.testPatterns),
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
    case 'stop': {
      const result = decide(currentTurnRecords(ledger), {
        enabled: config.enabled,
        stopHookActive: p.stop_hook_active === true,
        suggestedCommand: latestTestCommand(ledger) || guardedSuggest(config.root),
      });
      if (result.action === 'block') return { decision: 'block', reason: result.reason };
      if (result.systemMessage) return { systemMessage: result.systemMessage };
      return {};
    }
    default:
      return {};
  }
}

module.exports = { handleClaude };
