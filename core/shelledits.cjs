'use strict';

// Finds the files a shell command writes through the common forms: > and >> redirections,
// tee, sed -i, perl -i, PowerShell's Set-Content, Add-Content and Out-File, cp and mv, git
// checkout and restore with paths, and git apply or patch (as the patch file they read). Anything
// else (scripts, node -e, git switch or pull) is not seen. Paths that hold a variable are skipped.

const NULL_TARGETS = new Set(['/dev/null', 'nul', 'nul:']);
const PS_WRITERS = new Set(['set-content', 'add-content', 'out-file']);
const PS_PATH_PARAMS = new Set(['-path', '-filepath', '-literalpath']);
const PS_SWITCHES = new Set(['-force', '-nonewline', '-append', '-noclobber', '-passthru', '-whatif', '-confirm']);

// Words carry { text, dynamic } (dynamic: holds an unquoted or double-quoted $); operators carry { op }.
function tokenize(command) {
  const tokens = [];
  let word = null;
  const flush = () => { if (word) tokens.push(word); word = null; };
  const add = (s, dynamic = false) => {
    word = word || { text: '', dynamic: false };
    word.text += s;
    word.dynamic = word.dynamic || dynamic;
  };
  let heredoc = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\n') {
      flush();
      if (heredoc) {
        // Skip the body; the command ends at the newline after the delimiter line.
        // The body is kept on the heredoc token, so patch and git apply can read it.
        const lines = command.slice(i + 1).split('\n');
        const body = [];
        let skipped = 0;
        let found = false;
        for (const line of lines) {
          skipped += line.length + 1;
          const text = line.replace(/\r$/, '').replace(heredoc.tabs ? /^\t+/ : /^$/, '');
          if (text === heredoc.delim) { found = true; break; }
          body.push(text);
        }
        heredoc.body = body.join('\n');
        i += found ? skipped - 1 : command.length;
        heredoc = null;
        continue;
      }
      tokens.push({ op: ';', at: i });
    } else if (/\s/.test(c)) flush();
    else if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end === -1 ? command.length : end;
      add(command.slice(i + 1, stop));
      i = stop;
    } else if (c === '"') {
      let j = i + 1;
      let s = '';
      let dynamic = false;
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === '\\' && j + 1 < command.length) { s += command[++j]; continue; }
        if (command[j] === '$') dynamic = true;
        s += command[j];
      }
      add(s, dynamic);
      i = j;
    } else if (c === '\\' && /[\s'"$`\\]/.test(command[i + 1] || '')) add(command[++i]);
    else if (c === '$') add(c, true);
    else if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      flush();
      const tabs = command[i + 2] === '-';
      const m = /^\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(command.slice(i + (tabs ? 3 : 2)));
      if (m) {
        heredoc = { delim: m[2], tabs };
        tokens.push({ op: '<<', doc: heredoc });
        i += (tabs ? 3 : 2) + m[0].length - 1;
      } else i += 1;
    } else if (c === '<') {
      flush();
      tokens.push({ op: '<' });
    } else if (c === '>' || (c === '&' && command[i + 1] === '>')) {
      // A bare descriptor number just before > belongs to the operator (2>, 1>>).
      if (c === '>' && word && /^\d$/.test(word.text) && !word.dynamic) word = null;
      flush();
      if (c === '&') i++;
      if (command[i + 1] === '>') i++;
      if (command[i + 1] === '&') {
        // >&2 duplicates a descriptor; it writes no file.
        i++;
        while (/[\d-]/.test(command[i + 1] || '')) i++;
        continue;
      }
      tokens.push({ op: '>' });
    } else if (c === ';' || c === '|' || c === '&') {
      flush();
      tokens.push({ op: ';', at: i });
      if ((c === '|' || c === '&') && command[i + 1] === c) i++;
    } else add(c);
  }
  flush();
  return tokens;
}

// The parsers below take words ({ text, dynamic }) in their original positions, so a dynamic
// script or option still takes its place; only the file operands they return are filtered.
function sedFiles(args) {
  let inPlace = false;
  let scriptGiven = false;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i].text;
    if (/^--in-place(?:=|$)/.test(a) || /^-[A-Za-z]*i/.test(a)) {
      inPlace = true;
      // BSD sed: `-i ''` takes the empty backup suffix as its own argument.
      if (a === '-i' && args[i + 1] && args[i + 1].text === '' && !args[i + 1].dynamic) i++;
    } else if (a === '-e' || a === '-f' || a === '--expression' || a === '--file') {
      scriptGiven = true;
      i++;
    } else if (/^--(?:expression|file)=/.test(a)) scriptGiven = true;
    else if (!a.startsWith('-')) rest.push(args[i]);
  }
  if (!inPlace) return [];
  return scriptGiven ? rest : rest.slice(1);
}

function perlFiles(args) {
  let inPlace = false;
  let scriptGiven = false;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i].text;
    if (/^-[A-Za-z]*i/.test(a)) inPlace = true;
    if (/^-[A-Za-z]*[eE]$/.test(a)) { scriptGiven = true; i++; } else if (!a.startsWith('-')) rest.push(args[i]);
  }
  if (!inPlace) return [];
  return scriptGiven ? rest : rest.slice(1);
}

function psPath(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i].text.toLowerCase();
    if (PS_PATH_PARAMS.has(a)) return args[i + 1] !== undefined ? [args[i + 1]] : [];
    if (a.startsWith('-')) {
      if (!PS_SWITCHES.has(a)) i++;
      continue;
    }
    return [args[i]];
  }
  return [];
}

const baseName = (p) => p.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '');
const inDir = (dir, src) => `${dir.replace(/[\\/]+$/, '')}/${baseName(src)}`;

// Where copying or moving `sources` to `dest` writes. Whether a lone destination was an existing
// directory only the file system knows after the command ran: the copy is `dest/<source name>`
// when that exists (ifDir), else `dest` itself (unlessExists). The caller keeps what applies.
function placed(sources, dest, intoDir) {
  if (dest.dynamic) return [];
  const known = sources.filter((s) => !s.dynamic);
  if (intoDir) return known.map((s) => ({ path: inDir(dest.text, s.text) }));
  const self = known.length === 1 && sources.length === 1
    ? { path: dest.text, unlessExists: inDir(dest.text, known[0].text) }
    : { path: dest.text };
  return [self, ...known.map((s) => ({ path: inDir(dest.text, s.text), ifDir: dest.text }))];
}

function copyMoveWrites(args, isMove) {
  let target = null;
  let noTarget = false;
  let optionsDone = false;
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i].text;
    if (optionsDone || args[i].dynamic || !a.startsWith('-') || a === '-') operands.push(args[i]);
    else if (a === '--') optionsDone = true;
    else if (a === '-t' || a === '--target-directory') target = args[++i] || null;
    else if (a.startsWith('--target-directory=')) target = { text: a.slice(19), dynamic: false };
    else if (a === '-S' || a === '--suffix') i++;
    else if (a === '-T' || a === '--no-target-directory') noTarget = true;
    else if (/^-[A-Za-z]{2,}$/.test(a)) {
      // A cluster of short flags (`-rt lib`, `-tlib`, `-fT`): t and S take the rest or the next word.
      for (let j = 1; j < a.length; j++) {
        if (a[j] === 'T') noTarget = true;
        else if (a[j] === 't' || a[j] === 'S') {
          const value = a.slice(j + 1) ? { text: a.slice(j + 1), dynamic: false } : args[++i] || null;
          if (a[j] === 't') target = value;
          break;
        }
      }
    }
  }
  let sources = operands;
  let writes;
  if (target) writes = placed(sources, target, true);
  else if (operands.length < 2) return [];
  else {
    const dest = operands[operands.length - 1];
    sources = operands.slice(0, -1);
    if (noTarget) writes = dest.dynamic ? [] : [{ path: dest.text }];
    else writes = placed(sources, dest, sources.length > 1 || /[\\/]$/.test(dest.text));
  }
  const removed = isMove ? sources.filter((s) => !s.dynamic).map((s) => ({ path: s.text })) : [];
  return [...removed, ...writes];
}

const PS_ITEM_SWITCHES = new Set(['-force', '-recurse', '-passthru', '-whatif', '-confirm', '-container']);
const PS_ITEM_PARAMS = ['-path', '-literalpath', '-destination', '-filter', '-include', '-exclude', '-credential',
  '-tosession', '-fromsession', ...PS_ITEM_SWITCHES];
// PowerShell accepts any unambiguous prefix of a parameter name (`-Dest`).
function psParam(a) {
  if (PS_ITEM_PARAMS.includes(a)) return a;
  const hits = a.length > 2 ? PS_ITEM_PARAMS.filter((p) => p.startsWith(a)) : [];
  return hits.length === 1 ? hits[0] : a;
}

function psCopyMoveWrites(args, isMove) {
  let source = null;
  let dest = null;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i].dynamic ? '' : psParam(args[i].text.toLowerCase());
    if (a === '-path' || a === '-literalpath') source = args[++i] || null;
    else if (a === '-destination') dest = args[++i] || null;
    else if (a.startsWith('-')) { if (!PS_ITEM_SWITCHES.has(a)) i++; } else positional.push(args[i]);
  }
  source = source || positional.shift() || null;
  dest = dest || positional.shift() || null;
  if (!source || !dest) return [];
  const removed = isMove && !source.dynamic ? [{ path: source.text }] : [];
  return [...removed, ...placed([source], dest, /[\\/]$/.test(dest.text))];
}

const PS_COPY = new Set(['copy-item', 'cpi', 'copy']);
const PS_MOVE = new Set(['move-item', 'mi', 'move']);

const CHECKOUT_VALUES = new Set(['-b', '-B', '--orphan', '--pathspec-from-file']);

// Without `--` a checkout operand may be a branch or a path; all are returned, and a branch name
// matches no file. With `--` the operand before it is the commit.
function checkoutPaths(args) {
  let dashes = -1;
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i].text;
    if (dashes >= 0 || args[i].dynamic || !a.startsWith('-') || a === '-') operands.push(args[i]);
    else if (a === '--') dashes = operands.length;
    else if (CHECKOUT_VALUES.has(a)) i++;
  }
  return dashes >= 0 ? operands.slice(dashes) : operands;
}

// `git restore --staged` alone changes only the index.
function restorePaths(args) {
  let staged = false;
  let worktree = false;
  let done = false;
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i].text;
    if (done || args[i].dynamic || !a.startsWith('-') || a === '-') operands.push(args[i]);
    else if (a === '--') done = true;
    else if (a === '-s' || a === '--source' || a === '--pathspec-from-file') i++;
    else if (a === '--staged') staged = true;
    else if (a === '--worktree') worktree = true;
    else if (/^-[A-Za-z]+$/.test(a) && a[1] !== 's') {
      if (a.includes('S')) staged = true;
      if (a.includes('W')) worktree = true;
    }
  }
  return staged && !worktree ? [] : operands;
}

const APPLY_REPORTS = new Set(['--check', '--stat', '--numstat', '--summary']);

// git apply reads its paths from the repository root; the caller finds that root.
function applyPatches(args, stdin, at) {
  let strip = 1;
  let reportOnly = false;
  let apply = false;
  const patches = [];
  for (const w of args) {
    const a = w.text;
    const p = /^-p(\d+)$/.exec(a);
    if (w.dynamic || !a.startsWith('-')) patches.push({ ...w, text: at(a) });
    else if (a === '--cached') return [];
    else if (APPLY_REPORTS.has(a)) reportOnly = true;
    else if (a === '--apply') apply = true;
    else if (p) strip = Number(p[1]);
  }
  if (reportOnly && !apply) return [];
  if (!patches.length && stdin && stdin.body !== undefined) return [{ patchText: stdin.body, strip, repoRoot: true }];
  const read = patches.length ? patches : stdin ? [stdin] : [];
  return read.filter((w) => !w.dynamic).map((w) => ({ patch: w.text, strip, repoRoot: true }));
}

function gitWrites(args, stdin) {
  let base = '';
  let i = 0;
  for (; i < args.length && args[i].text.startsWith('-'); i++) {
    const a = args[i].text;
    if (a === '-C') {
      const dir = args[++i];
      if (!dir || dir.dynamic) return [];
      base = base ? `${base}/${dir.text}` : dir.text;
    } else if (a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') i++;
  }
  if (i >= args.length || args[i].dynamic) return [];
  const at = (p) => (base ? `${base.replace(/[\\/]+$/, '')}/${p}` : p);
  const sub = args[i].text;
  const rest = args.slice(i + 1);
  let paths = [];
  if (sub === 'checkout') paths = checkoutPaths(rest);
  else if (sub === 'restore') paths = restorePaths(rest);
  else if (sub === 'apply') return applyPatches(rest, stdin, at).map((e) => (base ? { ...e, base } : e));
  return paths.filter((w) => !w.dynamic).map((w) => ({ path: at(w.text) }));
}

const PATCH_VALUES = new Set(['-i', '--input', '-d', '--directory', '-o', '--output', '-p', '--strip', '-r',
  '--reject-file', '-B', '--prefix', '-D', '--ifdef', '-F', '--fuzz', '-V', '--version-control', '-z', '--suffix',
  '-Y', '--basename-prefix', '-g', '--get']);
const PATCH_LONG = { '--input': '-i', '--directory': '-d', '--output': '-o', '--strip': '-p' };

// `patch [file [patchfile]]`: a named file or -o output is the file written; otherwise the patch
// (from -i, or stdin) names them. Without -p, patch uses each file's base name. -d moves first.
function patchWrites(args, stdin) {
  const opts = {};
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i].text;
    const long = /^(--[a-z-]+)=(.*)$/.exec(a);
    const short = /^-([idop])(.+)$/.exec(a);
    if (args[i].dynamic || !a.startsWith('-') || a === '-') operands.push(args[i]);
    else if (a === '--dry-run') return [];
    else if (long && PATCH_LONG[long[1]]) opts[PATCH_LONG[long[1]]] = { text: long[2], dynamic: false };
    else if (short) opts[`-${short[1]}`] = { text: short[2], dynamic: false };
    else if (PATCH_VALUES.has(a)) {
      const v = args[++i];
      if (v) opts[PATCH_LONG[a] || a] = v;
    }
  }
  const base = opts['-d'];
  if (base && base.dynamic) return [];
  const at = (p) => (base ? `${base.text.replace(/[\\/]+$/, '')}/${p}` : p);
  const written = opts['-o'] || operands[0];
  if (written) return written.dynamic ? [] : [{ path: at(written.text) }];
  const strip = opts['-p'] && /^\d+$/.test(opts['-p'].text) ? Number(opts['-p'].text) : Infinity;
  const input = opts['-i'] ? { ...opts['-i'], text: at(opts['-i'].text) } : stdin;
  if (!input || input.dynamic) return [];
  const from = input.body !== undefined ? { patchText: input.body } : { patch: input.text };
  return [{ ...from, strip, ...(base ? { base: base.text } : {}) }];
}

// Returns { path, ifDir?, unlessExists? } for each file the command writes, or { patch, strip,
// base?, repoRoot? } for a patch it applies. stdin is the word after <.
function commandWrites(words, stdin) {
  const argv = words.slice();
  while (argv.length && !argv[0].dynamic && /^[A-Za-z_]\w*=/.test(argv[0].text)) argv.shift();
  if (!argv.length || argv[0].dynamic) return [];
  const name = argv[0].text.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
  const args = argv.slice(1);
  if (name === 'cp' || name === 'mv') return copyMoveWrites(args, name === 'mv');
  if (PS_COPY.has(name) || PS_MOVE.has(name)) return psCopyMoveWrites(args, PS_MOVE.has(name));
  if (name === 'git') return gitWrites(args, stdin);
  if (name === 'patch') return patchWrites(args, stdin);
  let files = [];
  if (name === 'tee') files = args.filter((a) => !a.text.startsWith('-'));
  else if (name === 'sed') files = sedFiles(args);
  else if (name === 'perl') files = perlFiles(args);
  else if (PS_WRITERS.has(name)) files = psPath(args);
  return files.filter((w) => !w.dynamic).map((w) => ({ path: w.text }));
}

// Each write as { path, end, ifDir?, unlessExists? }: end is the offset where the writing command ends
// (its separator, or the command's length), so a caller can tell what runs after the write. ifDir:
// the write happened only if that path is a directory (`cp a.js lib`); unlessExists: only if that path does not exist.
function shellEdits(command) {
  if (typeof command !== 'string' || !command) return [];
  const tokens = tokenize(command);
  const edits = [];
  let pending = [];
  const push = (w) => { if (w.patch || w.patchText !== undefined || (w.path && !NULL_TARGETS.has(w.path.toLowerCase()))) pending.push(w); };
  let words = [];
  let stdin = null;
  const end = (at) => {
    for (const w of commandWrites(words, stdin)) push(w);
    for (const w of pending) {
      const old = w.path === undefined ? -1 : edits.findIndex((e) => e.path === w.path);
      if (old >= 0) edits.splice(old, 1);
      edits.push({ ...w, end: at });
    }
    words = [];
    pending = [];
    stdin = null;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.op === '>') {
      const target = tokens[i + 1];
      if (target && !target.op) {
        i++;
        if (!target.dynamic) push({ path: target.text });
      }
    } else if (t.op === '<') {
      // The file read by < is not an argument of the command; patch and git apply read it as the diff.
      if (tokens[i + 1] && !tokens[i + 1].op) stdin = tokens[++i];
    } else if (t.op === '<<') stdin = t.doc;
    else if (t.op) end(t.at);
    else words.push(t);
  }
  end(command.length);
  return edits;
}

// The distinct paths a command writes, in order of first write. Patches are left out: their files
// are known only from the patch.
function shellEditPaths(command) {
  const paths = [];
  for (const e of shellEdits(command)) if (e.path !== undefined && !paths.includes(e.path)) paths.push(e.path);
  return paths;
}

// git quotes a path with special characters as a C string; \ooo escapes are UTF-8 bytes.
function unquote(s) {
  if (!s.startsWith('"')) return s;
  const bytes = [];
  for (let i = 1; i < s.length && s[i] !== '"'; i++) {
    if (s[i] !== '\\') { bytes.push(...Buffer.from(s[i])); continue; }
    const oct = /^[0-7]{3}/.exec(s.slice(i + 1));
    if (oct) { bytes.push(parseInt(oct[0], 8)); i += 3; continue; }
    const c = s[++i] || '';
    bytes.push(...Buffer.from({ n: '\n', t: '\t' }[c] || c));
  }
  return Buffer.from(bytes).toString('utf8');
}

// The files a unified or git diff changes, from its ---/+++ header pairs (not /dev/null) with
// `strip` leading parts removed (Infinity keeps the base name), and git's rename and copy lines.
// A --- line counts only when a +++ line follows, so a removed line that starts with -- is not a header.
function patchPaths(text, strip) {
  const out = [];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  const header = (line) => {
    const p = unquote(line.slice(4).replace(/\t.*$/, ''));
    if (p === '/dev/null') return null;
    const parts = p.split('/').filter(Boolean);
    if (strip === Infinity) return parts[parts.length - 1] || null;
    return parts.length > strip ? parts.slice(strip).join('/') : null;
  };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const git = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
    if (git) add(unquote(git[1]));
    else if (line.startsWith('--- ') && (lines[i + 1] || '').startsWith('+++ ')) {
      add(header(line));
      add(header(lines[++i]));
    }
  }
  return out;
}

module.exports = { shellEdits, shellEditPaths, patchPaths };
