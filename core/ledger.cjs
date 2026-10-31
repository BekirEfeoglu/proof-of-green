'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
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
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch { /* ignore: file vanished or locked */ }
    }
  } catch { /* ignore: pruning is best effort */ }
}

function writeLedger(dir, sessionId, ledger) {
  fs.mkdirSync(dir, { recursive: true });
  const file = fileFor(dir, sessionId);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(ledger));
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw err;
  }
  prune(dir);
}

const currentTurnRecords = (ledger) => ledger.records.filter((r) => r.turn === ledger.turn);

function logError(dir, err) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const text = err && err.stack ? err.stack : String(err);
    fs.appendFileSync(path.join(dir, 'errors.log'), `${new Date().toISOString()} ${text}\n`);
  } catch { /* logging must never throw */ }
}

module.exports = { ledgerDir, readLedger, writeLedger, currentTurnRecords, logError };
