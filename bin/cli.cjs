#!/usr/bin/env node
'use strict';
const os = require('node:os');
const { installCodex, uninstallCodex } = require('./codex-hooks.cjs');
const { doctor, formatReport } = require('./doctor.cjs');
const { status, formatStatus } = require('./status.cjs');

const TRUST_NOTE =
  'Codex skips new hooks until you trust them: run /hooks in Codex and trust the proof-of-green hooks.';
const USAGE = 'Usage: proof-of-green install codex | uninstall codex | doctor [--json] | status [--json]';

function run(argv, io) {
  const ctx = { homeDir: io.homeDir, env: io.env, platform: io.platform, cwd: io.cwd };
  const [cmd, arg] = argv;
  try {
    if (cmd === 'install' && arg === 'codex') {
      const r = installCodex(ctx);
      io.out(`Hooks file: ${r.hooksFile}`);
      if (r.added.length) io.out(`Added: ${r.added.join(', ')}`);
      if (r.updated.length) io.out(`Updated: ${r.updated.join(', ')}`);
      if (!r.added.length && !r.updated.length) io.out('Codex hooks already installed.');
      io.out(TRUST_NOTE);
      return 0;
    }
    if (cmd === 'uninstall' && arg === 'codex') {
      const r = uninstallCodex(ctx);
      io.out(`Hooks file: ${r.hooksFile}`);
      io.out(r.removed.length ? `Removed hooks: ${r.removed.join(', ')}` : 'Codex hooks were not installed.');
      if (r.appRemoved) io.out(`Removed app: ${r.appDir}`);
      return 0;
    }
    if (cmd === 'doctor') {
      const r = doctor(ctx);
      io.out(argv.includes('--json') ? JSON.stringify(r, null, 2) : formatReport(r));
      return 0;
    }
    if (cmd === 'status') {
      const r = status(ctx);
      const json = argv.includes('--json');
      io.out(json ? JSON.stringify(r || { ledger: null }, null, 2) : formatStatus(r));
      return 0;
    }
  } catch (err) {
    io.err(`proof-of-green: ${err.message}`);
    return 1;
  }
  io.err(USAGE);
  return 1;
}

module.exports = { installCodex, uninstallCodex, doctor, status, run };

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2), {
    out: (s) => console.log(s),
    err: (s) => console.error(s),
    env: process.env,
    homeDir: os.homedir(),
    platform: process.platform,
    cwd: process.cwd(),
  });
}
