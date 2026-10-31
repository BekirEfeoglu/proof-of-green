'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ledgerDir, readLedger, writeLedger, currentTurnRecords, logError } = require('../core/ledger.cjs');

const mk = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pog-ledger-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const EMPTY = { turn: '0', nextSeq: 1, records: [] };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const daysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000);

test('write then read round-trips', (t) => {
  const d = mk(t);
  const ledger = {
    turn: '3',
    nextSeq: 3,
    records: [
      { seq: 1, turn: '3', kind: 'edit', path: 'a.js' },
      { seq: 2, turn: '3', kind: 'command', command: 'npm test', isTest: true, result: 'pass', id: 'x' },
    ],
  };
  writeLedger(d, 's1', ledger);
  assert.deepEqual(readLedger(d, 's1'), ledger);
});

test('missing file reads as the empty ledger', (t) => {
  assert.deepEqual(readLedger(mk(t), 'nope'), EMPTY);
});

test('missing directory reads as the empty ledger', (t) => {
  assert.deepEqual(readLedger(path.join(mk(t), 'absent'), 's'), EMPTY);
});

test('truncated JSON reads as the empty ledger', (t) => {
  const d = mk(t);
  fs.writeFileSync(path.join(d, sha('s1') + '.json'), '{"turn":');
  assert.deepEqual(readLedger(d, 's1'), EMPTY);
});

test('non-object JSON reads as the empty ledger', (t) => {
  const d = mk(t);
  for (const body of ['null', '[]', '42', '"x"']) {
    fs.writeFileSync(path.join(d, sha('s1') + '.json'), body);
    assert.deepEqual(readLedger(d, 's1'), EMPTY);
  }
});

test('missing or wrong-typed fields fall back to defaults', (t) => {
  const d = mk(t);
  fs.writeFileSync(path.join(d, sha('s1') + '.json'), JSON.stringify({ turn: 5, nextSeq: 'x', records: 'no' }));
  assert.deepEqual(readLedger(d, 's1'), EMPTY);
  fs.writeFileSync(path.join(d, sha('s1') + '.json'), JSON.stringify({ turn: '2' }));
  assert.deepEqual(readLedger(d, 's1'), { turn: '2', nextSeq: 1, records: [] });
});

test('file name is the SHA-256 hex of the session id plus .json', (t) => {
  const d = mk(t);
  writeLedger(d, 'session/../weird id', EMPTY);
  assert.deepEqual(fs.readdirSync(d), [sha('session/../weird id') + '.json']);
});

test('writeLedger creates the directory recursively', (t) => {
  const d = path.join(mk(t), 'a', 'b');
  writeLedger(d, 's', EMPTY);
  assert.ok(fs.existsSync(path.join(d, sha('s') + '.json')));
});

test('write leaves no temp files behind', (t) => {
  const d = mk(t);
  writeLedger(d, 's', EMPTY);
  writeLedger(d, 's', { ...EMPTY, turn: '1' });
  assert.equal(fs.readdirSync(d).length, 1);
});

test('files older than 7 days are pruned on write, newer are kept', (t) => {
  const d = mk(t);
  const stale = path.join(d, 'stale.json');
  const fresh = path.join(d, 'fresh.json');
  const other = path.join(d, 'notes.txt');
  for (const f of [stale, fresh, other]) fs.writeFileSync(f, '{}');
  fs.utimesSync(stale, daysAgo(8), daysAgo(8));
  fs.utimesSync(fresh, daysAgo(6), daysAgo(6));
  fs.utimesSync(other, daysAgo(30), daysAgo(30));
  writeLedger(d, 's', EMPTY);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(other), true);
});

test('currentTurnRecords returns only records of the current turn', () => {
  const ledger = {
    turn: '2',
    nextSeq: 4,
    records: [
      { seq: 1, turn: '1', kind: 'edit', path: 'a' },
      { seq: 2, turn: '2', kind: 'edit', path: 'b' },
      { seq: 3, turn: '2', kind: 'command', command: 'x' },
    ],
  };
  assert.deepEqual(currentTurnRecords(ledger).map((r) => r.seq), [2, 3]);
  assert.deepEqual(currentTurnRecords(EMPTY), []);
});

test('ledgerDir for claude uses CLAUDE_PLUGIN_DATA', () => {
  assert.equal(
    ledgerDir('claude', { CLAUDE_PLUGIN_DATA: path.join('x', 'data') }, 'linux', '/home/u'),
    path.join('x', 'data', 'ledgers'),
  );
});

test('ledgerDir for claude falls back to the codex location when unset', () => {
  assert.equal(ledgerDir('claude', {}, 'linux', '/home/u'), path.join('/home/u', '.local', 'state', 'proof-of-green'));
  assert.equal(ledgerDir('claude', { CLAUDE_PLUGIN_DATA: '' }, 'linux', '/home/u'), path.join('/home/u', '.local', 'state', 'proof-of-green'));
});

test('ledgerDir for codex on win32 uses LOCALAPPDATA', () => {
  assert.equal(
    ledgerDir('codex', { LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\Users\\u'),
    path.join('C:\\L', 'proof-of-green'),
  );
});

test('ledgerDir for codex on win32 without LOCALAPPDATA uses the home AppData', () => {
  assert.equal(
    ledgerDir('codex', {}, 'win32', 'C:\\Users\\u'),
    path.join('C:\\Users\\u', 'AppData', 'Local', 'proof-of-green'),
  );
});

test('ledgerDir for codex elsewhere uses XDG_STATE_HOME or ~/.local/state', () => {
  assert.equal(ledgerDir('codex', { XDG_STATE_HOME: '/xdg' }, 'linux', '/home/u'), path.join('/xdg', 'proof-of-green'));
  assert.equal(ledgerDir('codex', {}, 'darwin', '/home/u'), path.join('/home/u', '.local', 'state', 'proof-of-green'));
});

test('ledgerDir tolerates a null env', () => {
  assert.equal(ledgerDir('codex', null, 'linux', '/h'), path.join('/h', '.local', 'state', 'proof-of-green'));
});

test('logError appends a timestamped stack line to errors.log', (t) => {
  const d = path.join(mk(t), 'sub');
  logError(d, new Error('boom'));
  logError(d, 'plain');
  const lines = fs.readFileSync(path.join(d, 'errors.log'), 'utf8').split('\n').filter(Boolean);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z .*boom/);
  assert.match(lines[lines.length - 1], /^\d{4}-\d\d-\d\dT[\d:.]+Z plain$/);
});

test('logError never throws, even when the directory is unusable', (t) => {
  const d = mk(t);
  const file = path.join(d, 'file');
  fs.writeFileSync(file, 'x');
  assert.doesNotThrow(() => logError(path.join(file, 'child'), new Error('x')));
  assert.doesNotThrow(() => logError(d, null));
});

test('errors.log is never pruned', (t) => {
  const d = mk(t);
  logError(d, new Error('old'));
  const log = path.join(d, 'errors.log');
  fs.utimesSync(log, daysAgo(30), daysAgo(30));
  writeLedger(d, 's', EMPTY);
  assert.equal(fs.existsSync(log), true);
});

test('writeLedger retries a rename that fails with EPERM once', (t) => {
  const d = mk(t);
  const real = fs.renameSync;
  let calls = 0;
  fs.renameSync = (...args) => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    return real(...args);
  };
  t.after(() => { fs.renameSync = real; });
  writeLedger(d, 's1', EMPTY);
  assert.equal(calls, 2);
  assert.deepEqual(readLedger(d, 's1'), EMPTY);
});

test('writeLedger rethrows when the rename keeps failing and leaves no temp file', (t) => {
  const d = mk(t);
  const real = fs.renameSync;
  let calls = 0;
  fs.renameSync = () => { calls++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
  t.after(() => { fs.renameSync = real; });
  assert.throws(() => writeLedger(d, 's1', EMPTY), { code: 'EBUSY' });
  assert.equal(calls, 3);
  assert.deepEqual(fs.readdirSync(d).filter((f) => f.endsWith('.tmp')), []);
});

test('temp files older than an hour are pruned on write, newer are kept', (t) => {
  const d = mk(t);
  const old = path.join(d, 'stale.json.123.abcd.tmp');
  const fresh = path.join(d, 'fresh.json.456.ef01.tmp');
  fs.writeFileSync(old, '{');
  fs.writeFileSync(fresh, '{');
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(old, twoHoursAgo, twoHoursAgo);
  writeLedger(d, 's1', EMPTY);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
});

test('errors.log over 64 KB is cut to its last 32 KB at a line boundary before appending', (t) => {
  const d = mk(t);
  const file = path.join(d, 'errors.log');
  const lines = Array.from({ length: 1000 }, (_, i) => `line-${String(i).padStart(4, '0')} ${'x'.repeat(80)}`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  assert.ok(fs.statSync(file).size > 64 * 1024);
  logError(d, 'fresh');
  const out = fs.readFileSync(file, 'utf8');
  assert.ok(Buffer.byteLength(out) <= 32 * 1024 + 200, `size ${Buffer.byteLength(out)}`);
  const kept = out.split('\n').filter(Boolean);
  assert.match(kept[kept.length - 1], / fresh$/);
  assert.equal(kept[0], lines[lines.length - (kept.length - 1)]);
  assert.match(kept[kept.length - 2], /^line-0999 /);
});

test('errors.log under the limit is left alone', (t) => {
  const d = mk(t);
  logError(d, 'a');
  logError(d, 'b');
  assert.equal(fs.readFileSync(path.join(d, 'errors.log'), 'utf8').split('\n').filter(Boolean).length, 2);
});

test('debug.log is never pruned and is trimmed like errors.log', (t) => {
  const d = mk(t);
  const { debugLog } = require('../core/ledger.cjs');
  debugLog(d, 'claude', 'stop', { a: 1 });
  const log = path.join(d, 'debug.log');
  fs.utimesSync(log, daysAgo(30), daysAgo(30));
  writeLedger(d, 's', EMPTY);
  assert.equal(fs.existsSync(log), true);
  fs.writeFileSync(log, ('y'.repeat(99) + '\n').repeat(700));
  debugLog(d, 'claude', 'stop', {});
  assert.ok(fs.statSync(log).size < 40 * 1024);
});
