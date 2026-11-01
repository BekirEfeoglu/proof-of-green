'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shellEditPaths, shellEdits, patchPaths } = require('../core/shelledits.cjs');

const cases = (list) => {
  for (const [command, want] of list) assert.deepEqual(shellEditPaths(command), want, command);
};

test('> and >> redirections name the file they write', () => {
  cases([
    ['echo x > a.js', ['a.js']],
    ['echo x >> "src/b.ts"', ['src/b.ts']],
    ['cat a.js>b.js', ['b.js']],
    ['node gen.js 1> out.py', ['out.py']],
    ['node gen.js &> all.log', ['all.log']],
    ["printf '%s' x > 'my file.rb'", ['my file.rb']],
    ['echo a > x.js && echo b > x.js', ['x.js']],
  ]);
});

test('redirections to null devices, descriptors and variables are not edits', () => {
  cases([
    ['npm test 2>&1', []],
    ['npm test > /dev/null 2>&1', []],
    ['cmd 2>/dev/null', []],
    ['Get-Item x 2>$null', []],
    ['dir > NUL', []],
    ['echo x > $f', []],
    ['echo x > "$OUT/a.js"', []],
    ['echo "a > b.js"', []],
    ["node -e 'const f = (a) => a > b.js'", []],
  ]);
});

test('a heredoc body is not read as commands', () => {
  cases([
    ["cat > src/a.js <<'EOF'\nif (a > b) x = 1 > c.js;\nEOF\nnpm test", ['src/a.js']],
    ['cat <<-EOF > b.py\n\tx > y.py\n\tEOF', ['b.py']],
  ]);
});

test('tee writes each file argument', () => {
  cases([
    ['npm test 2>&1 | tee out.log', ['out.log']],
    ['echo x | tee -a a.py b.py', ['a.py', 'b.py']],
  ]);
});

test('sed -i edits its file arguments, not its script', () => {
  cases([
    ["sed -i 's/a/b/' src/x.js", ['src/x.js']],
    ["sed -i.bak -e 's/a/b/' x.js y.js", ['x.js', 'y.js']],
    ["sed -i '' 's/a/b/' x.js", ['x.js']],
    ["sed --in-place -f fix.sed a.go", ['a.go']],
    ["sed -Ei 's/a/b/' a.rs", ['a.rs']],
    ["sed 's/a/b/' x.js", []],
    ["grep -i foo x.js", []],
  ]);
});

test('perl -i edits its file arguments', () => {
  cases([
    ["perl -pi -e 's/a/b/' x.pl lib/y.pm", ['x.pl', 'lib/y.pm']],
    ["perl -i.bak -pe 's/a/b/' a.js", ['a.js']],
    ["perl -pe 's/a/b/' a.js", []],
  ]);
});

test('PowerShell content cmdlets write their path', () => {
  cases([
    ['Set-Content -Path src/a.ts -Value x', ['src/a.ts']],
    ["Set-Content a.ts 'x'", ['a.ts']],
    ['"x" | Out-File -FilePath a.cs -Encoding utf8', ['a.cs']],
    ['Add-Content -LiteralPath C:\\proj\\a.js -Value x', ['C:\\proj\\a.js']],
    ['set-content -Encoding utf8 -Force b.py x', ['b.py']],
    ['Get-Content a.ts', []],
  ]);
});

test('commands in a chain are each checked', () => {
  cases([
    ["sed -i 's/a/b/' a.js; npm test > test.log", ['a.js', 'test.log']],
    ['FOO=1 tee x.js < in.txt', ['x.js']],
  ]);
});

test('non-strings and plain commands yield nothing', () => {
  assert.deepEqual(shellEditPaths(undefined), []);
  assert.deepEqual(shellEditPaths(''), []);
  cases([['npm test', []], ['git status', []], ['if [ $a -gt 3 ]; then echo hi; fi', []]]);
});

test('a dynamic script or option keeps the static file operands', () => {
  cases([
    ['sed -i "$script" src/a.js', ['src/a.js']],
    ["sed -i 's/a/b/' \"$f\" b.js", ['b.js']],
    ['perl -pi -e "$expr" x.pl', ['x.pl']],
    ['tee "$LOG" a.js', ['a.js']],
    ['Set-Content -Path $p -Value x', []],
  ]);
});

test('shellEdits gives where the writing command ends', () => {
  const cmd = "sed -i 's/a/b/' a.js && npm test";
  assert.deepEqual(shellEdits(cmd), [{ path: 'a.js', end: cmd.indexOf('&&') }]);
  assert.deepEqual(shellEdits('echo x > b.py'), [{ path: 'b.py', end: 13 }]);
  const doc = "cat > a.js <<'EOF'\nnpm test\nEOF\nnpm test";
  assert.equal(doc.slice(shellEdits(doc)[0].end), '\nnpm test');
});

const writes = (command) => shellEdits(command).map(({ end, ...rest }) => rest);

test('cp writes its destination; into a directory it writes dir/<source name>', () => {
  assert.deepEqual(writes('cp a.js b.js'), [{ path: 'b.js', unlessExists: 'b.js/a.js' }, { path: 'b.js/a.js', ifDir: 'b.js' }]);
  assert.deepEqual(writes('cp -r x.js y.ts lib/'), [{ path: 'lib/x.js' }, { path: 'lib/y.ts' }]);
  assert.deepEqual(writes('cp x.js y.ts lib'), [{ path: 'lib/x.js' }, { path: 'lib/y.ts' }]);
  assert.deepEqual(writes('cp -t lib a.js'), [{ path: 'lib/a.js' }]);
  assert.deepEqual(writes('cp --target-directory=lib a.js'), [{ path: 'lib/a.js' }]);
  assert.deepEqual(writes('cp -T a.js b.js'), [{ path: 'b.js' }]);
  assert.deepEqual(writes('cp a.js'), []);
  assert.deepEqual(writes('cp "$SRC" b.js'), [{ path: 'b.js' }]);
  assert.deepEqual(writes('cp a.js "$DEST"'), []);
});

test('mv also removes its sources', () => {
  assert.deepEqual(writes('mv old.js new.js'), [{ path: 'old.js' }, { path: 'new.js', unlessExists: 'new.js/old.js' }, { path: 'new.js/old.js', ifDir: 'new.js' }]);
  assert.deepEqual(writes('mv -f a.py b.py pkg/'), [{ path: 'a.py' }, { path: 'b.py' }, { path: 'pkg/a.py' }, { path: 'pkg/b.py' }]);
});

test('PowerShell Copy-Item and Move-Item write their destination', () => {
  assert.deepEqual(writes('Copy-Item -Path a.ts -Destination b.ts'), [{ path: 'b.ts', unlessExists: 'b.ts/a.ts' }, { path: 'b.ts/a.ts', ifDir: 'b.ts' }]);
  assert.deepEqual(writes('Move-Item a.ts b.ts -Force'), [{ path: 'a.ts' }, { path: 'b.ts', unlessExists: 'b.ts/a.ts' }, { path: 'b.ts/a.ts', ifDir: 'b.ts' }]);
});

test('cp and mv short flag clusters and attached values', () => {
  assert.deepEqual(writes('cp -rt lib a.js'), [{ path: 'lib/a.js' }]);
  assert.deepEqual(writes('cp -tlib a.js'), [{ path: 'lib/a.js' }]);
  assert.deepEqual(writes('mv -fT a.js b.js'), [{ path: 'a.js' }, { path: 'b.js' }]);
  assert.deepEqual(writes('cp -rf a.js b.js'), [{ path: 'b.js', unlessExists: 'b.js/a.js' }, { path: 'b.js/a.js', ifDir: 'b.js' }]);
});

test('PowerShell aliases and abbreviated parameters for copy and move', () => {
  assert.deepEqual(writes('copy a.ts b.ts'), [{ path: 'b.ts', unlessExists: 'b.ts/a.ts' }, { path: 'b.ts/a.ts', ifDir: 'b.ts' }]);
  assert.deepEqual(writes('cpi a.ts -Dest b.ts'), [{ path: 'b.ts', unlessExists: 'b.ts/a.ts' }, { path: 'b.ts/a.ts', ifDir: 'b.ts' }]);
  assert.deepEqual(writes('mi -Pat a.ts -Destination lib/'), [{ path: 'a.ts' }, { path: 'lib/a.ts' }]);
  assert.deepEqual(writes('move a.ts b.ts'), [{ path: 'a.ts' }, { path: 'b.ts', unlessExists: 'b.ts/a.ts' }, { path: 'b.ts/a.ts', ifDir: 'b.ts' }]);
});

test('git checkout and git restore write the paths they name', () => {
  cases([
    ['git checkout -- src/a.js', ['src/a.js']],
    ['git checkout HEAD~1 -- a.js b.ts', ['a.js', 'b.ts']],
    ['git checkout main src/a.js', ['main', 'src/a.js']],
    ['git checkout .', ['.']],
    ['git restore src/a.js lib', ['src/a.js', 'lib']],
    ['git restore --source=HEAD~2 a.py', ['a.py']],
    ['git restore -s main --worktree a.py', ['a.py']],
    ['git restore --staged --worktree a.py', ['a.py']],
    ['git restore -SW a.py', ['a.py']],
    ['git -C api checkout -- a.go', ['api/a.go']],
    ['git -c core.autocrlf=false restore a.rs', ['a.rs']],
    ['git.exe restore a.rs', ['a.rs']],
  ]);
});

test('git commands that change only branches or the index are not edits', () => {
  cases([
    ['git checkout -b feature', []],
    ['git checkout -B feature', []],
    ['git checkout --orphan gh-pages', []],
    ['git restore --staged a.py', []],
    ['git restore -S a.py', []],
    ['git switch main', []],
    ['git status', []],
    ['git checkout -- "$FILE"', []],
    ['git log -- a.js', []],
  ]);
});

test('git apply and patch report the patch they read', () => {
  assert.deepEqual(writes('git apply fix.patch'), [{ patch: 'fix.patch', strip: 1, repoRoot: true }]);
  assert.deepEqual(writes('git apply -p2 --3way a.diff b.diff'), [
    { patch: 'a.diff', strip: 2, repoRoot: true }, { patch: 'b.diff', strip: 2, repoRoot: true }]);
  assert.deepEqual(writes('git -C api apply x.patch'), [{ patch: 'api/x.patch', strip: 1, repoRoot: true, base: 'api' }]);
  assert.deepEqual(writes('git apply < fix.patch'), [{ patch: 'fix.patch', strip: 1, repoRoot: true }]);
  assert.deepEqual(writes('patch -p1 < fix.patch'), [{ patch: 'fix.patch', strip: 1 }]);
  assert.deepEqual(writes('patch -p 0 -i fix.patch'), [{ patch: 'fix.patch', strip: 0 }]);
  assert.deepEqual(writes('patch --strip=1 --input=fix.patch'), [{ patch: 'fix.patch', strip: 1 }]);
  assert.deepEqual(writes('patch -d src -i fix.patch'), [{ patch: 'src/fix.patch', strip: Infinity, base: 'src' }]);
  assert.deepEqual(writes('patch a.js fix.diff'), [{ path: 'a.js' }]);
  assert.deepEqual(writes('patch -o out.js a.js < fix.diff'), [{ path: 'out.js' }]);
});

test('git apply and patch forms that write nothing', () => {
  cases([
    ['git apply --check fix.patch', []],
    ['git apply --stat fix.patch', []],
    ['git apply --cached fix.patch', []],
    ['patch --dry-run -p1 < fix.patch', []],
    ['git apply "$P"', []],
  ]);
  assert.deepEqual(writes('git apply --check --apply fix.patch'), [{ patch: 'fix.patch', strip: 1, repoRoot: true }]);
});

test('patchPaths lists the files a unified diff changes', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1 +1 @@',
    '-x',
    '+--- not/a/header.js',
    'diff --git a/old.ts b/new.ts',
    'similarity index 100%',
    'rename from old.ts',
    'rename to new.ts',
    '--- /dev/null',
    '+++ b/lib/new file.py\t2026-11-01 10:00:00',
    '--- a/gone.rb',
    '+++ /dev/null',
  ].join('\n');
  assert.deepEqual(patchPaths(diff, 1), ['src/a.js', 'old.ts', 'new.ts', 'lib/new file.py', 'gone.rb']);
  assert.deepEqual(patchPaths('--- a/x/y.js\n+++ b/x/y.js\n', 2), ['y.js']);
  assert.deepEqual(patchPaths('--- x/y.js\n+++ x/y.js\n', 0), ['x/y.js']);
  assert.deepEqual(patchPaths('--- a/x/y.js\n+++ b/x/y.js\n', Infinity), ['y.js']);
  assert.deepEqual(patchPaths('--- "a/q\\"x.js"\n+++ "b/q\\"x.js"\n', 1), ['q"x.js']);
  assert.deepEqual(patchPaths('', 1), []);
});
