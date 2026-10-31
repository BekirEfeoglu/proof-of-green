'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ledgerDir, readLedger, appendRecord, startTurn, currentTurnRecords, logError } = require('../core/ledger.cjs');

const mk = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pog-ledger-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const EMPTY = { turn: '0', nextSeq: 1, records: [], stoppedAgents: new Set() };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const daysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000);

const jsonl = (d, s) => path.join(d, sha(s) + '.jsonl');

test('appended records and turn markers read back with seq and turn', (t) => {
  const d = mk(t);
  appendRecord(d, 's1', { kind: 'edit', path: 'a.js' });
  startTurn(d, 's1', '3');
  appendRecord(d, 's1', { kind: 'edit', path: 'b.js' });
  appendRecord(d, 's1', { kind: 'command', command: 'npm test', isTest: true, result: 'pass', id: 'x' });
  assert.deepEqual(readLedger(d, 's1'), {
    turn: '3',
    nextSeq: 4,
    records: [
      { seq: 1, turn: '0', kind: 'edit', path: 'a.js' },
      { seq: 2, turn: '3', kind: 'edit', path: 'b.js' },
      { seq: 3, turn: '3', kind: 'command', command: 'npm test', isTest: true, result: 'pass', id: 'x' },
    ],
    stoppedAgents: new Set(),
  });
});

test('turn markers alone set the turn', (t) => {
  const d = mk(t);
  startTurn(d, 's1', '1');
  startTurn(d, 's1', 'turn-b');
  assert.deepEqual(readLedger(d, 's1'), { turn: 'turn-b', nextSeq: 1, records: [], stoppedAgents: new Set() });
});

test('a stored seq never overrides the replayed one; a stored string turn is kept', (t) => {
  const d = mk(t);
  startTurn(d, 's1', '2');
  appendRecord(d, 's1', { kind: 'edit', path: 'a.js', seq: 99, turn: '7' });
  appendRecord(d, 's1', { kind: 'edit', path: 'b.js', turn: 7 });
  assert.deepEqual(readLedger(d, 's1').records, [
    { seq: 1, turn: '7', kind: 'edit', path: 'a.js' },
    { seq: 2, turn: '2', kind: 'edit', path: 'b.js' },
  ]);
});

test('a truncated last line and unparsable or unknown lines are skipped', (t) => {
  const d = mk(t);
  appendRecord(d, 's1', { kind: 'edit', path: 'a.js' });
  fs.appendFileSync(jsonl(d, 's1'),
    'garbage\n42\nnull\n[]\n{"kind":"turn"}\n{"kind":"other"}\n{"kind":"turn","turn":"5"}\n{"kind":"edit","pa');
  assert.deepEqual(readLedger(d, 's1'), {
    turn: '5', nextSeq: 2, records: [{ seq: 1, turn: '0', kind: 'edit', path: 'a.js' }], stoppedAgents: new Set(),
  });
});

test('an append after a torn line is still read', (t) => {
  const d = mk(t);
  fs.writeFileSync(jsonl(d, 's1'), '{"kind":"edit","pa');
  appendRecord(d, 's1', { kind: 'edit', path: 'b.js' });
  assert.deepEqual(readLedger(d, 's1').records, [{ seq: 1, turn: '0', kind: 'edit', path: 'b.js' }]);
});

test('CRLF line endings are tolerated', (t) => {
  const d = mk(t);
  fs.writeFileSync(jsonl(d, 's1'), '{"kind":"turn","turn":"1"}\r\n{"kind":"edit","path":"a"}\r\n');
  assert.deepEqual(readLedger(d, 's1'), { turn: '1', nextSeq: 2, records: [{ seq: 1, turn: '1', kind: 'edit', path: 'a' }], stoppedAgents: new Set() });
});

test('a legacy .json ledger is read first and .jsonl lines are applied on top', (t) => {
  const d = mk(t);
  fs.writeFileSync(path.join(d, sha('s1') + '.json'), JSON.stringify({
    turn: '2', nextSeq: 3,
    records: [{ seq: 1, turn: '1', kind: 'edit', path: 'old.js' }, { seq: 2, turn: '2', kind: 'edit', path: 'mid.js' }],
  }));
  appendRecord(d, 's1', { kind: 'command', command: 'npm test', isTest: true, result: 'pass' });
  startTurn(d, 's1', '3');
  appendRecord(d, 's1', { kind: 'edit', path: 'new.js' });
  assert.deepEqual(readLedger(d, 's1'), {
    turn: '3',
    nextSeq: 5,
    records: [
      { seq: 1, turn: '1', kind: 'edit', path: 'old.js' },
      { seq: 2, turn: '2', kind: 'edit', path: 'mid.js' },
      { seq: 3, turn: '2', kind: 'command', command: 'npm test', isTest: true, result: 'pass' },
      { seq: 4, turn: '3', kind: 'edit', path: 'new.js' },
    ],
    stoppedAgents: new Set(),
  });
});

test('readLedger never throws, even when the ledger paths are directories', (t) => {
  const d = mk(t);
  fs.mkdirSync(jsonl(d, 's1'));
  fs.mkdirSync(path.join(d, sha('s1') + '.json'));
  assert.deepEqual(readLedger(d, 's1'), EMPTY);
});

test('parallel appends from 20 processes are all kept', async (t) => {
  const d = mk(t);
  const { spawn } = require('node:child_process');
  const lib = JSON.stringify(path.join(__dirname, '..', 'core', 'ledger.cjs'));
  const N = 20;
  const runs = Array.from({ length: N }, (_, i) => new Promise((resolve, reject) => {
    const code = `require(${lib}).appendRecord(${JSON.stringify(d)}, 'par', ` +
      `{ kind: 'command', command: 'c${i}', isTest: true, result: 'pass' })`;
    const child = spawn(process.execPath, ['-e', code], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`child ${i} exited ${c}`))));
  }));
  await Promise.all(runs);
  const { records, nextSeq } = readLedger(d, 'par');
  assert.equal(records.length, N);
  assert.equal(nextSeq, N + 1);
  assert.deepEqual(records.map((r) => r.command).sort(), Array.from({ length: N }, (_, i) => `c${i}`).sort());
  assert.deepEqual(records.map((r) => r.seq), Array.from({ length: N }, (_, i) => i + 1));
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
  assert.deepEqual(readLedger(d, 's1'), { turn: '2', nextSeq: 1, records: [], stoppedAgents: new Set() });
});

test('file name is the SHA-256 hex of the session id plus .jsonl', (t) => {
  const d = mk(t);
  startTurn(d, 'session/../weird id', '1');
  appendRecord(d, 'session/../weird id', { kind: 'edit', path: 'a' });
  assert.deepEqual(fs.readdirSync(d), [sha('session/../weird id') + '.jsonl']);
});

test('appendRecord and startTurn create the directory recursively', (t) => {
  const d = path.join(mk(t), 'a', 'b');
  appendRecord(d, 's', { kind: 'edit', path: 'a' });
  assert.ok(fs.existsSync(jsonl(d, 's')));
  const d2 = path.join(mk(t), 'c', 'd');
  startTurn(d2, 's', '1');
  assert.ok(fs.existsSync(jsonl(d2, 's')));
});

test('each append writes exactly one newline-terminated JSON line', (t) => {
  const d = mk(t);
  startTurn(d, 's', '1');
  appendRecord(d, 's', { kind: 'edit', path: 'a' });
  assert.deepEqual(fs.readFileSync(jsonl(d, 's'), 'utf8').split('\n'),
    ['{"kind":"turn","turn":"1"}', '{"kind":"edit","path":"a"}', '']);
});

test('ledgers older than 7 days are pruned on append, newer are kept', (t) => {
  const d = mk(t);
  const stale = path.join(d, 'stale.json');
  const fresh = path.join(d, 'fresh.json');
  const staleL = path.join(d, 'stale.jsonl');
  const freshL = path.join(d, 'fresh.jsonl');
  const other = path.join(d, 'notes.txt');
  for (const f of [stale, fresh, staleL, freshL, other]) fs.writeFileSync(f, '{}');
  for (const f of [stale, staleL]) fs.utimesSync(f, daysAgo(8), daysAgo(8));
  for (const f of [fresh, freshL]) fs.utimesSync(f, daysAgo(6), daysAgo(6));
  fs.utimesSync(other, daysAgo(30), daysAgo(30));
  appendRecord(d, 's', { kind: 'edit', path: 'a' });
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(staleL), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(freshL), true);
  assert.equal(fs.existsSync(other), true);
});

test('startTurn also prunes old ledgers', (t) => {
  const d = mk(t);
  const staleL = path.join(d, 'stale.jsonl');
  fs.writeFileSync(staleL, '');
  fs.utimesSync(staleL, daysAgo(8), daysAgo(8));
  startTurn(d, 's', '1');
  assert.equal(fs.existsSync(staleL), false);
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
  appendRecord(d, 's', { kind: 'edit', path: 'a' });
  assert.equal(fs.existsSync(log), true);
});

test('temp files older than an hour are pruned on append, newer are kept', (t) => {
  const d = mk(t);
  const old = path.join(d, 'stale.json.123.abcd.tmp');
  const fresh = path.join(d, 'fresh.json.456.ef01.tmp');
  fs.writeFileSync(old, '{');
  fs.writeFileSync(fresh, '{');
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(old, twoHoursAgo, twoHoursAgo);
  appendRecord(d, 's1', { kind: 'edit', path: 'a' });
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
  appendRecord(d, 's', { kind: 'edit', path: 'a' });
  assert.equal(fs.existsSync(log), true);
  fs.writeFileSync(log, ('y'.repeat(99) + '\n').repeat(700));
  debugLog(d, 'claude', 'stop', {});
  assert.ok(fs.statSync(log).size < 40 * 1024);
});

test('agent-stop lines take no seq and are not records; they fill stoppedAgents', (t) => {
  const d = mk(t);
  appendRecord(d, 's1', { kind: 'edit', path: 'a.js', agent: 'A' });
  appendRecord(d, 's1', { kind: 'agent-stop', agent: 'A' });
  appendRecord(d, 's1', { kind: 'agent-stop' });
  appendRecord(d, 's1', { kind: 'agent-stop', agent: 7 });
  appendRecord(d, 's1', { kind: 'edit', path: 'b.js' });
  const l = readLedger(d, 's1');
  assert.deepEqual(l.records.map((r) => [r.seq, r.path]), [[1, 'a.js'], [2, 'b.js']]);
  assert.equal(l.nextSeq, 3);
  assert.deepEqual([...l.stoppedAgents], ['A']);
});

test('the first append next to a legacy .json writes its current turn as a marker first', (t) => {
  const d = mk(t);
  const legacy = path.join(d, sha('s1') + '.json');
  fs.writeFileSync(legacy, JSON.stringify({ turn: '4', nextSeq: 1, records: [] }));
  appendRecord(d, 's1', { kind: 'edit', path: 'a.js' });
  appendRecord(d, 's1', { kind: 'edit', path: 'b.js' });
  const lines = fs.readFileSync(jsonl(d, 's1'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.kind), ['turn', 'edit', 'edit']);
  // Once the legacy file is pruned, the .jsonl alone still knows the turn.
  fs.unlinkSync(legacy);
  const l = readLedger(d, 's1');
  assert.equal(l.turn, '4');
  assert.deepEqual(l.records.map((r) => r.turn), ['4', '4']);
});

test('without a legacy .json no turn marker is added', (t) => {
  const d = mk(t);
  appendRecord(d, 's1', { kind: 'edit', path: 'a.js' });
  assert.equal(fs.readFileSync(jsonl(d, 's1'), 'utf8').trim().split('\n').length, 1);
});

function stubAppend(t, codes) {
  const real = fs.appendFileSync;
  let calls = 0;
  fs.appendFileSync = (file, ...rest) => {
    if (String(file).endsWith('.jsonl')) {
      calls += 1;
      const code = codes[calls - 1];
      if (code) throw Object.assign(new Error(code), { code });
    }
    return real(file, ...rest);
  };
  t.after(() => { fs.appendFileSync = real; });
  return () => calls;
}

test('appendRecord retries a busy or locked append up to 3 attempts', (t) => {
  const d = mk(t);
  const calls = stubAppend(t, ['EBUSY', 'EPERM']);
  appendRecord(d, 's1', { kind: 'edit', path: 'a.js' });
  assert.equal(calls(), 3);
  assert.deepEqual(readLedger(d, 's1').records.map((r) => r.path), ['a.js']);
});

test('startTurn rethrows after 3 busy attempts', (t) => {
  const d = mk(t);
  const calls = stubAppend(t, ['EBUSY', 'EBUSY', 'EBUSY', 'EBUSY']);
  assert.throws(() => startTurn(d, 's1', '1'), { code: 'EBUSY' });
  assert.equal(calls(), 3);
});

test('other append errors are not retried', (t) => {
  const d = mk(t);
  const calls = stubAppend(t, ['ENOSPC']);
  assert.throws(() => appendRecord(d, 's1', { kind: 'edit', path: 'a.js' }), { code: 'ENOSPC' });
  assert.equal(calls(), 1);
});
