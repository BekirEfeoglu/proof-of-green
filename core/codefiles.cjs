'use strict';
const fs = require('node:fs');
const os = require('node:os');
const posix = require('node:path').posix;

const CODE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.py', '.pyi',
  '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.cs', '.fs', '.vb', '.c', '.cc', '.cpp', '.cxx', '.h', '.hh',
  '.hpp', '.m', '.mm', '.swift', '.dart', '.rb', '.php', '.ex', '.exs', '.lua', '.sql', '.vue', '.svelte', '.gd', '.ipynb']);

const normalize = (p) => String(p).replace(/\\/g, '/').toLowerCase();
// Collapses `.` segments and doubled separators so they cannot dodge prefix checks.
const normalizePath = (p) => posix.normalize(normalize(p));
const withSlash = (p) => (p.endsWith('/') ? p : p + '/');

function globToRegExp(glob) {
  const g = normalize(glob);
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$');
}

const matchesAny = (globs, rel) => (globs || []).some((g) => globToRegExp(g).test(rel));

// Resolved on first use and kept for the process; null when it cannot be resolved.
let realTmp;
function realTmpDir() {
  if (realTmp === undefined) {
    try { realTmp = fs.realpathSync.native(os.tmpdir()); } catch { realTmp = null; }
  }
  return realTmp;
}

// The temp dir, plus its real path (a Windows 8.3 short temp path and its long form differ).
function tmpRoots(tmpDir) {
  const roots = [tmpDir || os.tmpdir(), os.tmpdir()];
  const real = realTmpDir();
  if (real) roots.push(real);
  return roots.map((r) => withSlash(normalizePath(r)));
}

function isCodeFile(filePath, opts = {}) {
  const p = normalizePath(filePath);
  const home = withSlash(normalizePath(opts.homeDir || os.homedir()));
  const tmps = tmpRoots(opts.tmpDir);
  const root = opts.root ? withSlash(normalizePath(opts.root)) : null;
  const rel = root && p.startsWith(root) ? p.slice(root.length) : p;

  if (matchesAny(opts.exclude, rel)) return false;
  if (/(?:^|\/)(?:node_modules|\.git)\//.test(p)) return false;
  if (p.startsWith(home + '.claude/') || p.startsWith(home + '.codex/')) return false;
  if (tmps.some((tmp) => p.startsWith(tmp))) return false;
  if (matchesAny(opts.include, rel)) return true;
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 && CODE_EXTENSIONS.has(base.slice(dot));
}

module.exports = { isCodeFile, globToRegExp, CODE_EXTENSIONS };
