'use strict';
const fs = require('node:fs');

// The Codex rollout format is undocumented: every field is treated as optional,
// and lines that are not JSON objects (for example a truncated last line) are skipped.
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const firstString = (...values) => values.find((v) => typeof v === 'string');

function toResult(line) {
  let rec;
  try { rec = JSON.parse(line); } catch { return null; }
  if (!isObj(rec) || rec.type !== 'event_msg' || !isObj(rec.payload)) return null;
  const { payload } = rec;
  if (payload.type !== 'item_completed' || !isObj(payload.item)) return null;
  const { item } = payload;
  if (item.type !== 'CommandExecution') return null;

  const argv = Array.isArray(item.command) ? item.command.filter((a) => typeof a === 'string') : null;
  const command = argv ? argv.join(' ') : typeof item.command === 'string' ? item.command : '';
  const callId = firstString(item.call_id, item.id, payload.call_id);
  if (!command && callId === undefined) return null;

  const result = { command, exitCode: Number.isInteger(item.exit_code) ? item.exit_code : null };
  if (callId !== undefined) result.callId = callId;
  if (typeof payload.turn_id === 'string') result.turnId = payload.turn_id;
  if (argv && argv.length > 0) result.lastArg = argv[argv.length - 1];
  return result;
}

function readCommandResults(rolloutPath) {
  if (typeof rolloutPath !== 'string' || !rolloutPath) return [];
  let text;
  try { text = fs.readFileSync(rolloutPath, 'utf8'); } catch { return []; }
  const results = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const r = toResult(line);
    if (r) results.push(r);
  }
  return results;
}

module.exports = { readCommandResults };
