'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const TMP_MAX_AGE_MS = 3600 * 1000;
const APP = 'proof-of-green';

function ledgerDir(agent, env, platform = process.platform, homeDir = os.homedir()) {
  const e = env && typeof env === 'object' ? env : {};
  if (agent === 'claude' && e.CLAUDE_PLUGIN_DATA) return path.join(e.CLAUDE_PLUGIN_DATA, 'ledgers');
  if (platform === 'win32') {
    return path.join(e.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local'), APP);
  }
  return path.join(e.XDG_STATE_HOME || path.join(homeDir, '.local', 'state'), APP);
}

const baseFor = (dir, sessionId) =>
  path.join(dir, crypto.createHash('sha256').update(String(sessionId)).digest('hex'));

// Legacy v0.2 format: one JSON object rewritten on every hook.
function readJsonLedger(file) {
  const empty = { turn: '0', nextSeq: 1, records: [] };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return empty;
    return {
      turn: typeof data.turn === 'string' ? data.turn : empty.turn,
      nextSeq: Number.isInteger(data.nextSeq) ? data.nextSeq : empty.nextSeq,
      records: Array.isArray(data.records) ? data.records : empty.records,
    };
  } catch { return empty; }
}

// Replays <base>.jsonl on top of the legacy <base>.json. Each record gets its seq from its
// position and the turn in effect when it was appended; unparsable or torn lines are skipped.
function readBase(base) {
  const ledger = readJsonLedger(base + '.json');
  let text;
  try { text = fs.readFileSync(base + '.jsonl', 'utf8'); } catch { return ledger; }
  for (const line of text.split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (entry.kind === 'turn') {
      if (typeof entry.turn === 'string') ledger.turn = entry.turn;
    } else if (entry.kind === 'edit' || entry.kind === 'command') {
      ledger.records.push({ ...entry, seq: ledger.nextSeq, turn: ledger.turn });
      ledger.nextSeq += 1;
    }
  }
  return ledger;
}

const readLedger = (dir, sessionId) => readBase(baseFor(dir, sessionId));
// Either file of a session (<hash>.json or <hash>.jsonl) reads the whole merged ledger.
const readLedgerFile = (file) => readBase(file.replace(/\.jsonl?$/, ''));

function prune(dir) {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const maxAge = /\.jsonl?$/.test(name) ? MAX_AGE_MS : name.endsWith('.tmp') ? TMP_MAX_AGE_MS : null;
      if (maxAge === null) continue;
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < now - maxAge) fs.unlinkSync(file);
      } catch { /* ignore: file vanished or locked */ }
    }
  } catch { /* ignore: pruning is best effort */ }
}

// True when the file exists and its last byte is not a newline (a crash tore the last append).
function endsTorn(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 10;
  } catch { return false; } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// One appendFileSync call per line: parallel hooks each add their line instead of
// overwriting each other's read-modify-write. May throw; callers run inside gate's fail-open catch.
function appendLine(dir, sessionId, entry) {
  fs.mkdirSync(dir, { recursive: true });
  const file = baseFor(dir, sessionId) + '.jsonl';
  // Start on a fresh line after a torn append so this record is not glued onto it.
  fs.appendFileSync(file, (endsTorn(file) ? '\n' : '') + JSON.stringify(entry) + '\n');
  prune(dir);
}

const appendRecord = (dir, sessionId, record) => appendLine(dir, sessionId, record);
const startTurn = (dir, sessionId, turnId) => appendLine(dir, sessionId, { kind: 'turn', turn: String(turnId) });

const currentTurnRecords = (ledger) => ledger.records.filter((r) => r.turn === ledger.turn);

const ERROR_LOG_MAX = 64 * 1024;
const ERROR_LOG_KEEP = 32 * 1024;

// Past 64 KB, keep only the last 32 KB, starting at a line boundary.
function trimErrorLog(file) {
  try {
    if (fs.statSync(file).size <= ERROR_LOG_MAX) return;
    const tail = fs.readFileSync(file).subarray(-ERROR_LOG_KEEP);
    const nl = tail.indexOf(10);
    fs.writeFileSync(file, nl === -1 ? Buffer.alloc(0) : tail.subarray(nl + 1));
  } catch { /* a missing or unreadable log is simply appended to */ }
}

function appendCappedLog(dir, name, text) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    trimErrorLog(file);
    fs.appendFileSync(file, `${new Date().toISOString()} ${text}\n`);
  } catch { /* logging must never throw */ }
}

function logError(dir, err) {
  appendCappedLog(dir, 'errors.log', err && err.stack ? err.stack : String(err));
}

const DEBUG_PAYLOAD_MAX = 4096;

function debugLog(dir, agent, event, payload) {
  try {
    appendCappedLog(dir, 'debug.log', `${agent} ${event} ${JSON.stringify(payload).slice(0, DEBUG_PAYLOAD_MAX)}`);
  } catch { /* logging must never throw */ }
}

module.exports = { ledgerDir, readLedger, readLedgerFile, appendRecord, startTurn, currentTurnRecords, logError, debugLog };
