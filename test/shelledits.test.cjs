'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shellEditPaths, shellEdits } = require('../core/shelledits.cjs');

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
  assert.deepEqual(writes('cp a.js b.js'), [{ path: 'b.js' }, { path: 'b.js/a.js', ifDir: 'b.js' }]);
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
  assert.deepEqual(writes('mv old.js new.js'), [{ path: 'old.js' }, { path: 'new.js' }, { path: 'new.js/old.js', ifDir: 'new.js' }]);
  assert.deepEqual(writes('mv -f a.py b.py pkg/'), [{ path: 'a.py' }, { path: 'b.py' }, { path: 'pkg/a.py' }, { path: 'pkg/b.py' }]);
});

test('PowerShell Copy-Item and Move-Item write their destination', () => {
  assert.deepEqual(writes('Copy-Item -Path a.ts -Destination b.ts'), [{ path: 'b.ts' }, { path: 'b.ts/a.ts', ifDir: 'b.ts' }]);
  assert.deepEqual(writes('Move-Item a.ts b.ts -Force'), [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'b.ts/a.ts', ifDir: 'b.ts' }]);
});
