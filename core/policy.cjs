'use strict';
const path = require('node:path');

const MAX_FILES = 5;
const UNVERIFIED =
  'proof-of-green: the result of the last test command could not be verified, so the stop was allowed.';
const ESCAPE = ' If this project has no tests, or the user asked you not to run them, say so plainly and finish.';

function fileList(edits) {
  const names = [];
  for (const e of edits) {
    const name = path.basename(String(e.path));
    if (!names.includes(name)) names.push(name);
  }
  const shown = names.slice(0, MAX_FILES).join(', ');
  return names.length > MAX_FILES ? `${shown} (+${names.length - MAX_FILES} more)` : shown;
}

function decide(records, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  if (o.enabled !== true || o.stopHookActive === true || !Array.isArray(records)) return { action: 'allow' };

  const recs = records
    .filter((r) => r && typeof r === 'object')
    .sort((a, b) => a.seq - b.seq);
  const edits = recs.filter((r) => r.kind === 'edit');
  if (edits.length === 0) return { action: 'allow' };

  const lastEditSeq = edits[edits.length - 1].seq;
  const tests = recs.filter((r) => r.kind === 'command' && r.isTest === true && r.seq > lastEditSeq);
  const last = tests[tests.length - 1];

  if (last && last.result === 'pass') return { action: 'allow' };
  if (last && last.result !== 'fail') return { action: 'allow', systemMessage: UNVERIFIED };

  const files = fileList(edits);
  const head = last
    ? `proof-of-green: you changed code (${files}) and the last test run after that change failed. Fix the failures and run the tests again, or report the failing tests to the user.`
    : `proof-of-green: you changed code (${files}) but no test command ran after the last change. Run the tests and report the result.`;
  const suggest = typeof o.suggestedCommand === 'string' && o.suggestedCommand
    ? ` Suggested command: \`${o.suggestedCommand}\`.`
    : '';
  return { action: 'block', reason: head + suggest + ESCAPE };
}

module.exports = { decide };
