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
      tokens.push({ op: ';' });
      if (heredoc) {
        // Skip the body up to the delimiter line.
        const lines = command.slice(i + 1).split('\n');
        let skipped = 0;
        let found = false;
        for (const line of lines) {
          skipped += line.length + 1;
          if (line.replace(/\r$/, '').replace(heredoc.tabs ? /^\t+/ : /^$/, '') === heredoc.delim) { found = true; break; }
        }
        i += found ? skipped - 1 : command.length;
        heredoc = null;
      }
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
      if ((c === '|' || c === '&') && command[i + 1] === c) i++;
      tokens.push({ op: ';' });
    } else add(c);
  }
  flush();
  return tokens;
}

function sedFiles(args) {
  let inPlace = false;
  let scriptGiven = false;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^--in-place(?:=|$)/.test(a) || /^-[A-Za-z]*i/.test(a)) {
      inPlace = true;
      // BSD sed: `-i ''` takes the empty backup suffix as its own argument.
      if (a === '-i' && args[i + 1] === '') i++;
    } else if (a === '-e' || a === '-f' || a === '--expression' || a === '--file') {
      scriptGiven = true;
      i++;
    } else if (/^--(?:expression|file)=/.test(a)) scriptGiven = true;
    else if (!a.startsWith('-')) rest.push(a);
  }
  if (!inPlace) return [];
  return scriptGiven ? rest : rest.slice(1);
}

function perlFiles(args) {
  let inPlace = false;
  let scriptGiven = false;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-[A-Za-z]*i/.test(a)) inPlace = true;
    if (/^-[A-Za-z]*[eE]$/.test(a)) { scriptGiven = true; i++; } else if (!a.startsWith('-')) rest.push(a);
  }
  if (!inPlace) return [];
  return scriptGiven ? rest : rest.slice(1);
}

function psPath(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i].toLowerCase();
    if (PS_PATH_PARAMS.has(a)) return args[i + 1] !== undefined ? [args[i + 1]] : [];
    if (a.startsWith('-')) {
      if (!PS_SWITCHES.has(a)) i++;
      continue;
    }
    return [args[i]];
  }
  return [];
}

function commandWrites(words) {
  const argv = words.filter((w) => !w.dynamic).map((w) => w.text);
  while (argv.length && /^[A-Za-z_]\w*=/.test(argv[0])) argv.shift();
  if (!argv.length) return [];
  const name = argv[0].replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
  const args = argv.slice(1);
  if (name === 'tee') return args.filter((a) => !a.startsWith('-'));
  if (name === 'sed') return sedFiles(args);
  if (name === 'perl') return perlFiles(args);
  if (PS_WRITERS.has(name)) return psPath(args);
  return [];
}

function shellEditPaths(command) {
  if (typeof command !== 'string' || !command) return [];
  const tokens = tokenize(command);
  const paths = [];
  const push = (p) => { if (p && !NULL_TARGETS.has(p.toLowerCase()) && !paths.includes(p)) paths.push(p); };
  let words = [];
  const end = () => { for (const p of commandWrites(words)) push(p); words = []; };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.op === '>') {
      const target = tokens[i + 1];
      if (target && !target.op) {
        i++;
        if (!target.dynamic) push(target.text);
      }
    } else if (t.op === '<') {
      // The file read by < is not an argument of the command.
      if (tokens[i + 1] && !tokens[i + 1].op) i++;
    } else if (t.op) end();
    else words.push(t);
  }
  end();
  return paths;
}

module.exports = { shellEditPaths };
