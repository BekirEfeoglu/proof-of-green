'use strict';
const { suggestTestCommand } = require('../core/detect.cjs');
const { decide } = require('../core/policy.cjs');
const { currentTurnRecords } = require('../core/ledger.cjs');

function guardedSuggest(root) {
  try { return suggestTestCommand(root) || null; } catch { return null; }
}

function latestTestCommand(ledger) {
  for (let i = ledger.records.length - 1; i >= 0; i--) {
    const r = ledger.records[i];
    if (r && r.kind === 'command' && r.isTest === true && typeof r.command === 'string') {
      return { command: r.command, via: typeof r.via === 'string' && r.via ? r.via : undefined };
    }
  }
  return null;
}

function stopDecision(records, ledger, config, stopHookActive) {
  const latest = latestTestCommand(ledger);
  return decide(records, {
    enabled: config.enabled,
    stopHookActive,
    suggestedCommand: latest ? latest.command : guardedSuggest(config.root),
    suggestedVia: latest ? latest.via : undefined,
  });
}

const runningNote = (agent) =>
  `proof-of-green: subagent ${agent} has not reported a stop yet; its changes will be checked when it stops.`;

// The parent's current turn without the records of subagents that have not stopped yet: they
// are judged at their own SubagentStop. A running subagent with an edit yields a note.
function parentRecords(ledger) {
  const stopped = ledger.stoppedAgents instanceof Set ? ledger.stoppedAgents : new Set();
  const running = (r) => r && typeof r.agent === 'string' && !stopped.has(r.agent);
  const current = currentTurnRecords(ledger);
  const editing = [];
  for (const r of current) if (running(r) && r.kind === 'edit' && !editing.includes(r.agent)) editing.push(r.agent);
  return { records: current.filter((r) => !running(r)), note: editing.map(runningNote).join(' ') };
}

// Appends a note to a decision: to the block reason, else to the systemMessage.
function withNote(result, note) {
  if (!note) return result;
  if (result.action === 'block') return { ...result, reason: `${result.reason} ${note}` };
  return { ...result, systemMessage: result.systemMessage ? `${result.systemMessage} ${note}` : note };
}

function stopResponse(records, ledger, config, payload, note) {
  const result = withNote(stopDecision(records, ledger, config, payload.stop_hook_active === true), note);
  if (result.action === 'block') return { decision: 'block', reason: result.reason };
  if (result.systemMessage) return { systemMessage: result.systemMessage };
  return {};
}

module.exports = { stopResponse, stopDecision, parentRecords, withNote };
