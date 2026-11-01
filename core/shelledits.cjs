'use strict';

// Finds the files a shell command writes through the common forms: > and >> redirections,
// tee, sed -i, perl -i and PowerShell's Set-Content, Add-Content and Out-File. Anything else
// (scripts, node -e, cp, git checkout) is not seen. Paths that hold a variable are skipped.

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
        const lines = command.slice(i + 1).split('\n');
        let skipped = 0;
        let found = false;
        for (const line of lines) {
          skipped += line.length + 1;
          if (line.replace(/\r$/, '').replace(heredoc.tabs ? /^\t+/ : /^$/, '') === heredoc.delim) { found = true; break; }
        }
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

// Where copying or moving `sources` to `dest` writes. A lone destination may be a directory, which
// only the file system knows after the command ran: the file candidate carries unlessDir and the
// into-the-directory candidate carries ifDir, and the caller keeps the one that applies.
function placed(sources, dest, intoDir) {
  if (dest.dynamic) return [];
  const known = sources.filter((s) => !s.dynamic);
  if (intoDir) return known.map((s) => ({ path: inDir(dest.text, s.text) }));
  return [{ path: dest.text, unlessDir: dest.text }, ...known.map((s) => ({ path: inDir(dest.text, s.text), ifDir: dest.text }))];
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

// Returns { path, ifDir?, unlessDir? } for each file the command writes.
function commandWrites(words) {
  const argv = words.slice();
  while (argv.length && !argv[0].dynamic && /^[A-Za-z_]\w*=/.test(argv[0].text)) argv.shift();
  if (!argv.length || argv[0].dynamic) return [];
  const name = argv[0].text.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
  const args = argv.slice(1);
  if (name === 'cp' || name === 'mv') return copyMoveWrites(args, name === 'mv');
  if (PS_COPY.has(name) || PS_MOVE.has(name)) return psCopyMoveWrites(args, PS_MOVE.has(name));
  let files = [];
  if (name === 'tee') files = args.filter((a) => !a.text.startsWith('-'));
  else if (name === 'sed') files = sedFiles(args);
  else if (name === 'perl') files = perlFiles(args);
  else if (PS_WRITERS.has(name)) files = psPath(args);
  return files.filter((w) => !w.dynamic).map((w) => ({ path: w.text }));
}

// Each write as { path, end, ifDir?, unlessDir? }: end is the offset where the writing command ends
// (its separator, or the command's length), so a caller can tell what runs after the write. ifDir:
// the write happened only if that path is a directory (`cp a.js lib`); unlessDir: only if it is not.
function shellEdits(command) {
  if (typeof command !== 'string' || !command) return [];
  const tokens = tokenize(command);
  const edits = [];
  let pending = [];
  const push = (w) => { if (w.path && !NULL_TARGETS.has(w.path.toLowerCase())) pending.push(w); };
  let words = [];
  const end = (at) => {
    for (const w of commandWrites(words)) push(w);
    for (const w of pending) {
      const old = edits.findIndex((e) => e.path === w.path);
      if (old >= 0) edits.splice(old, 1);
      const e = { path: w.path, end: at };
      if (w.ifDir !== undefined) e.ifDir = w.ifDir;
      if (w.unlessDir !== undefined) e.unlessDir = w.unlessDir;
      edits.push(e);
    }
    words = [];
    pending = [];
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
      // The file read by < is not an argument of the command.
      if (tokens[i + 1] && !tokens[i + 1].op) i++;
    } else if (t.op) end(t.at);
    else words.push(t);
  }
  end(command.length);
  return edits;
}

// The distinct paths a command writes, in order of first write.
function shellEditPaths(command) {
  const paths = [];
  for (const e of shellEdits(command)) if (!paths.includes(e.path)) paths.push(e.path);
  return paths;
}

module.exports = { shellEdits, shellEditPaths };
