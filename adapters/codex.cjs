'use strict';
const path = require('node:path');
const { isTestCommand } = require('../core/detect.cjs');
const { isCodeFile } = require('../core/codefiles.cjs');
const { readLedger, writeLedger, currentTurnRecords } = require('../core/ledger.cjs');
const { push, stopResponse } = require('./common.cjs');
const { readCommandResults } = require('./rollout.cjs');

const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/;

function parsePatchPaths(patch) {
  if (typeof patch !== 'string') return [];
  const paths = [];
  for (const line of patch.split(/\r?\n/)) {
    const m = PATCH_HEADER.exec(line);
    const p = m && m[1].trim();
    if (p && !paths.includes(p)) paths.push(p);
  }
  return paths;
}

const commandText = (c) =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.filter((a) => typeof a === 'string').join(' ') : null;
const normalize = (s) => String(s).trim().replace(/\s+/g, ' ');

function recordTool(ledger, payload, cwd, config) {
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  if (payload.tool_name === 'apply_patch') {
    let added = false;
    for (const p of parsePatchPaths(input.command)) {
      const abs = path.resolve(cwd, p);
      if (!isCodeFile(abs, { root: config.root, include: config.include, exclude: config.exclude })) continue;
      push(ledger, { kind: 'edit', path: abs });
      added = true;
    }
    return added;
  }
  if (payload.tool_name === 'Bash') {
    const command = commandText(input.command);
    if (!command) return false;
    const record = { kind: 'command', command, isTest: isTestCommand(command, config.testPatterns), result: 'unknown' };
    if (typeof payload.tool_use_id === 'string') record.id = payload.tool_use_id;
    push(ledger, record);
    return true;
  }
  return false;
}

function textMatches(record, result) {
  const want = normalize(record.command);
  return want === normalize(result.command) || (typeof result.lastArg === 'string' && want === normalize(result.lastArg));
}

// Returns copies of the records with unknown command results filled in from the rollout.
function resolveResults(records, results) {
  const out = records.map((r) => ({ ...r }));
  const pending = out.filter((r) => r.kind === 'command' && r.result === 'unknown' && typeof r.command === 'string');
  const used = new Set();
  const matched = new Map();
  for (const r of pending) {
    if (typeof r.id !== 'string') continue;
    const i = results.findIndex((x, j) => !used.has(j) && x.callId === r.id);
    if (i >= 0) { used.add(i); matched.set(r, results[i]); }
  }
  for (const r of pending) {
    if (matched.has(r)) continue;
    const i = results.findIndex((x, j) =>
      !used.has(j) && (x.turnId === undefined || x.turnId === r.turn) && textMatches(r, x));
    if (i >= 0) { used.add(i); matched.set(r, results[i]); }
  }
  for (const [r, x] of matched) {
    if (Number.isInteger(x.exitCode)) r.result = x.exitCode === 0 ? 'pass' : 'fail';
  }
  return out;
}

function handleCodex(event, payload, ctx) {
  const { dir, config, env } = ctx;
  if (env && env.PROOF_OF_GREEN_TEST_THROW === '1') throw new Error('PROOF_OF_GREEN_TEST_THROW');
  if (!config.enabled) return {};
  const p = payload && typeof payload === 'object' ? payload : {};
  if (typeof p.session_id !== 'string' || !p.session_id) return {};
  if (event !== 'post-tool' && event !== 'stop') return {};
  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd();
  const ledger = readLedger(dir, p.session_id);
  const newTurn = typeof p.turn_id === 'string' && p.turn_id && p.turn_id !== ledger.turn;
  if (newTurn) ledger.turn = p.turn_id;

  if (event === 'post-tool') {
    if (recordTool(ledger, p, cwd, config) || newTurn) writeLedger(dir, p.session_id, ledger);
    return {};
  }
  const records = resolveResults(currentTurnRecords(ledger), readCommandResults(p.transcript_path));
  return stopResponse(records, ledger, config, p);
}

module.exports = { handleCodex, parsePatchPaths };
