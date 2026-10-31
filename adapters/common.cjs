'use strict';
const { suggestTestCommand } = require('../core/detect.cjs');
const { decide } = require('../core/policy.cjs');

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

function push(ledger, record) {
  ledger.records.push({ seq: ledger.nextSeq, turn: ledger.turn, ...record });
  ledger.nextSeq += 1;
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

function stopResponse(records, ledger, config, payload) {
  const result = stopDecision(records, ledger, config, payload.stop_hook_active === true);
  if (result.action === 'block') return { decision: 'block', reason: result.reason };
  if (result.systemMessage) return { systemMessage: result.systemMessage };
  return {};
}

module.exports = { push, stopResponse, stopDecision };
