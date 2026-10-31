'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const TMP_MAX_AGE_MS = 3600 * 1000;
const RENAME_ATTEMPTS = 3;
const APP = 'proof-of-green';

function ledgerDir(agent, env, platform = process.platform, homeDir = os.homedir()) {
  const e = env && typeof env === 'object' ? env : {};
  if (agent === 'claude' && e.CLAUDE_PLUGIN_DATA) return path.join(e.CLAUDE_PLUGIN_DATA, 'ledgers');
  if (platform === 'win32') {
    return path.join(e.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local'), APP);
  }
  return path.join(e.XDG_STATE_HOME || path.join(homeDir, '.local', 'state'), APP);
}

const fileFor = (dir, sessionId) =>
  path.join(dir, crypto.createHash('sha256').update(String(sessionId)).digest('hex') + '.json');

function readLedger(dir, sessionId) {
  const empty = { turn: '0', nextSeq: 1, records: [] };
  try {
    const data = JSON.parse(fs.readFileSync(fileFor(dir, sessionId), 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return empty;
    return {
      turn: typeof data.turn === 'string' ? data.turn : empty.turn,
      nextSeq: Number.isInteger(data.nextSeq) ? data.nextSeq : empty.nextSeq,
      records: Array.isArray(data.records) ? data.records : empty.records,
    };
  } catch { return empty; }
}

function prune(dir) {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const maxAge = name.endsWith('.json') ? MAX_AGE_MS : name.endsWith('.tmp') ? TMP_MAX_AGE_MS : null;
      if (maxAge === null) continue;
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < now - maxAge) fs.unlinkSync(file);
      } catch { /* ignore: file vanished or locked */ }
    }
  } catch { /* ignore: pruning is best effort */ }
}

// Windows can briefly lock the target (antivirus, a concurrent reader): retry before giving up.
function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try { return fs.renameSync(from, to); } catch (err) {
      if (attempt >= RENAME_ATTEMPTS || (err.code !== 'EPERM' && err.code !== 'EBUSY')) throw err;
    }
  }
}

function writeLedger(dir, sessionId, ledger) {
  fs.mkdirSync(dir, { recursive: true });
  const file = fileFor(dir, sessionId);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(ledger));
    renameWithRetry(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw err;
  }
  prune(dir);
}

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

function logError(dir, err) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const text = err && err.stack ? err.stack : String(err);
    const file = path.join(dir, 'errors.log');
    trimErrorLog(file);
    fs.appendFileSync(file,`${new Date().toISOString()} ${text}\n`);
  } catch { /* logging must never throw */ }
}

module.exports = { ledgerDir, readLedger, writeLedger, currentTurnRecords, logError };
