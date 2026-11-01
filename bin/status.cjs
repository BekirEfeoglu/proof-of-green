'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readLedgerFile } = require('../core/ledger.cjs');
const { loadConfig } = require('../core/config.cjs');
const { stopDecision, parentRecords, withNote } = require('../adapters/common.cjs');
const { allLedgerDirs } = require('./ledger-dirs.cjs');

const CODEX_NOTE = 'Note: Codex results are read from the session log only at Stop, so this verdict may differ.';

function newestLedgerFile(dirs) {
  let best = null;
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/\.jsonl?$/.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { file, mtimeMs: st.mtimeMs };
      } catch { /* vanished */ }
    }
  }
  return best;
}

function status({ homeDir = os.homedir(), env = process.env, platform = process.platform, cwd = process.cwd() } = {}) {
  const config = loadConfig(cwd, env, homeDir);
  if (!config.enabled) return { disabled: true };
  const found = newestLedgerFile(allLedgerDirs({ homeDir, env, platform }));
  if (!found) return null;
  const ledger = readLedgerFile(found.file);
  const { records, note } = parentRecords(ledger);
  const names = [];
  for (const r of records) {
    if (r && r.kind === 'edit') {
      const name = path.basename(String(r.path));
      if (!names.includes(name)) names.push(name);
    }
  }
  const commands = records
    .filter((r) => r && r.kind === 'command')
    .map((r) => ({ command: r.command, isTest: r.isTest === true, result: r.result, via: r.via, ...(r.masked === true ? { masked: true } : {}) }));
  return {
    ledger: found.file,
    modified: new Date(found.mtimeMs).toISOString(),
    turn: ledger.turn,
    edits: names,
    commands,
    decision: withNote(stopDecision(records, ledger, { enabled: config.enabled, root: config.root }, false), note),
    ...(commands.some((c) => c.result === 'unknown' && !c.via) ? { note: CODEX_NOTE } : {}),
  };
}

function formatStatus(r) {
  if (!r) return 'No ledger yet.';
  if (r.disabled) return 'Gate disabled by config';
  const shown = r.edits.slice(0, 10).join(', ');
  const edits = r.edits.length ? (r.edits.length > 10 ? `${shown} (+${r.edits.length - 10} more)` : shown) : 'none';
  const d = r.decision;
  const verdict = d.action === 'block' ? `Would block: ${d.reason}`
    : d.systemMessage ? `Would allow with note: ${d.systemMessage}` : 'Would allow';
  return [
    `Ledger: ${r.ledger}`,
    `Modified: ${r.modified}`,
    `Turn: ${r.turn}`,
    `Edits this turn: ${edits}`,
    r.commands.length ? 'Commands this turn:' : 'Commands this turn: none',
    ...r.commands.map((c) => `  ${c.command} [${c.isTest ? 'test' : c.masked ? 'test, exit code hidden' : 'not a test'}] result=${c.result || 'none'}${c.via ? ` via=${c.via}` : ''}`),
    verdict,
    ...(r.note ? [r.note] : []),
  ].join('\n');
}

module.exports = { status, formatStatus };
