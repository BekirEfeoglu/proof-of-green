# proof-of-green Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A zero-dependency Node.js Stop-hook gate that blocks Claude Code and Codex CLI once when code changed after the last passing test command.

**Architecture:** Hooks call `node gate.cjs <agent> <event>`. Per-agent adapters turn hook payloads into ledger records (edits, commands with pass/fail/unknown); at Stop the policy reads the current turn's records and allows or blocks. Codex exit codes come from the rollout file at Stop because its PostToolUse payload has none.

**Tech Stack:** Node.js >= 18, CommonJS (`.cjs`), `node:test`, no runtime or dev dependencies.

**Spec:** `docs/superpowers/specs/2026-10-31-proof-of-green-design.md`

## Global Constraints

- No dependencies in `package.json` (neither `dependencies` nor `devDependencies`).
- Node floor: `"engines": { "node": ">=18" }`; CI matrix Node 18, 20, 22 on ubuntu-latest, windows-latest, macos-latest.
- License: MIT, copyright "Bekir Efeoğlu".
- Every hook path fails open: any thrown error prints `{}` to stdout, exits 0, and appends to `errors.log` in the ledger directory.
- Block output is exactly `{"decision":"block","reason":"<text>"}`; the reason never mentions how to disable the gate.
- Block at most once: when the payload has `stop_hook_active: true`, always allow.
- Config file name: `.proof-of-green.json`; env switch: `PROOF_OF_GREEN=off`.
- Tests, lint and any heavy command run on the remote server only (user rule): sync with `mcp__uzak_sunucu__sunucu_projeyi_esitle(yerel_klasor="D:\\Proje\\proof-of-green", proje="proof-of-green")`, then `mcp__uzak_sunucu__sunucu_komut_calistir(proje="proof-of-green", komut=<cmd>, ajan="Claude")`. "Run" steps below mean this pair.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Windows paths (`C:\Users\x\.claude\settings.json`, mixed slashes, upper-case drive letters) must be excluded or classified the same as POSIX paths. Test in Task 2.
2. PowerShell-style commands (`npm test; if ($?) { "ok" }`, `npm test 2>&1 | Tee-Object out.txt`) must be judged by the same masking rules: the piped one is masked, the `;`-chained one counts. Test in Task 1.
3. A corrupt or half-written ledger file must read as empty and never throw. Test in Task 3.
4. Empty stdin, non-JSON stdin, or payloads missing `session_id` must produce `{}` and exit 0. Test in Task 5.
5. A Codex rollout with a truncated last line, unknown record types, or no `CommandExecution` items must not throw; results stay `unknown`. Test in Task 6.

---

### File structure

| Path | Responsibility |
|---|---|
| `package.json`, `LICENSE`, `.gitattributes`, `.gitignore` | Package metadata, `bin`, `test` script, LF line endings |
| `gate.cjs` | Entry point: parse argv and stdin, route to adapter, print response, fail open |
| `core/detect.cjs` | Is a shell command a test, is its result masked, suggest a project test command |
| `core/codefiles.cjs` | Is a path a code file, minimal glob matching |
| `core/config.cjs` | Load `.proof-of-green.json` and the env switch |
| `core/ledger.cjs` | Per-session ledger files: location, atomic read/write, turns, pruning |
| `core/policy.cjs` | Stop decision and reason text |
| `adapters/claude.cjs` | Claude Code events to ledger operations and Stop response |
| `adapters/codex.cjs` | Codex events to ledger operations, rollout resolution, Stop response |
| `adapters/rollout.cjs` | Parse Codex rollout JSONL for command exit codes |
| `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json` | Claude Code plugin and marketplace |
| `bin/cli.cjs` | `install codex`, `doctor` |
| `test/*.test.cjs`, `test/fixtures/` | Tests and synthetic payloads |
| `.github/workflows/ci.yml`, `README.md` | CI and user docs |

---

### Task 1: Scaffold and test detection

**Files:**
- Create: `package.json`, `LICENSE`, `.gitattributes` (`* text=auto eol=lf`), `.gitignore` (`node_modules/`), `core/detect.cjs`
- Test: `test/detect.test.cjs`

**Interfaces:**
- Produces: `isTestCommand(command: string, extraPatterns?: RegExp[]) => boolean` (true only when a segment is a test and the command is not masked); `isMasked(command: string) => boolean`; `suggestTestCommand(projectDir: string) => string | null`; `BUILTIN_TEST_PATTERNS: RegExp[]`.
- `package.json`: `"name": "proof-of-green"`, `"version": "0.1.0"`, `"license": "MIT"`, `"bin": { "proof-of-green": "bin/cli.cjs" }`, `"scripts": { "test": "node --test test/" }`, `"files": ["gate.cjs", "core/", "adapters/", "bin/", "hooks/", ".claude-plugin/"]`.

- [ ] **Step 1: Write the failing tests** in `test/detect.test.cjs`:

```js
const yes = ['npm test', 'npm run test:unit', 'pnpm test', 'yarn test', 'bun test', 'npx vitest run',
  'npx jest', 'pytest -q', 'python -m pytest tests/', 'python3 -m unittest', 'go test ./...',
  'cargo test', 'cargo nextest run', 'dotnet test', 'mvn test', 'gradle test', './gradlew test',
  'make test', 'make check', 'rspec', 'phpunit', 'mix test', 'cd api && npm test',
  'npm test; if ($?) { "ok" }'];
const no = ['echo "tests passed"', 'npm test || true', 'pytest || :', 'go test ./... ; exit 0',
  'cargo test || exit 0', 'npm test | tail -5', 'npm test 2>&1 | Tee-Object out.txt',
  'ls', 'npm install', 'cat test.py', 'git commit -m "npm test"'];
test('detects test commands', () => { for (const c of yes) assert.equal(isTestCommand(c), true, c); });
test('rejects masked or fake commands', () => { for (const c of no) assert.equal(isTestCommand(c), false, c); });
test('pipefail keeps a piped test', () => assert.equal(isTestCommand('set -o pipefail; npm test | tail -5'), true));
test('extra patterns', () => assert.equal(isTestCommand('make verify', [/^make verify$/]), true));
test('suggestTestCommand', () => {
  // temp dirs: package.json with scripts.test -> 'npm test'; pyproject.toml -> 'pytest';
  // go.mod -> 'go test ./...'; Cargo.toml -> 'cargo test'; x.sln -> 'dotnet test'; empty -> null
});
```

- [ ] **Step 2: Run** `node --test test/detect.test.cjs`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `core/detect.cjs`.** Split on `&&`, `||`, `;`, newlines into segments, strip leading `cd x`/env assignments; match segments against `BUILTIN_TEST_PATTERNS` anchored at segment start. A segment inside quotes is not a segment (strip quoted strings before splitting). `isMasked`: `|| true`, `|| :`, `; exit 0`, `|| exit 0`, or a test segment followed by `|` without `pipefail` earlier in the command.
- [ ] **Step 4: Run** `node --test test/detect.test.cjs`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(detect): recognize test commands and masked results`.

### Task 2: Code files and config

**Files:**
- Create: `core/codefiles.cjs`, `core/config.cjs`
- Test: `test/codefiles.test.cjs`, `test/config.test.cjs`

**Interfaces:**
- Produces: `isCodeFile(filePath: string, opts?: { root?: string, include?: string[], exclude?: string[], homeDir?: string, tmpDir?: string }) => boolean`; `globToRegExp(glob: string) => RegExp` (supports `**`, `*`, `?`); `loadConfig(cwd: string, env?: object) => { enabled: boolean, testPatterns: RegExp[], include: string[], exclude: string[], root: string }`.

- [ ] **Step 1: Write the failing tests.** `isCodeFile`: true for `src/a.ts`, `C:\\proj\\b.PY`, `lib/c.rs`; false for `README.md`, `x.json`, `node_modules/a/index.js`, `.git/hooks/x.js`, `<homeDir>/.claude/hooks/a.cjs`, `<homeDir>/.codex/x.js`, `<tmpDir>/s.py`, `C:\\Users\\x\\.claude\\settings.js` with `homeDir: 'C:\\Users\\x'`; `include: ['scripts/**/*.sh']` makes `scripts/a/b.sh` true; `exclude: ['generated/**']` makes `generated/x.ts` false. `loadConfig`: no file gives `{ enabled: true, testPatterns: [], include: [], exclude: [] }`; file in parent dir up to the dir containing `.git` is found; a file above `.git` root is ignored; invalid JSON gives defaults; `PROOF_OF_GREEN=off` gives `enabled: false`; `testCommands: ["^make verify$"]` becomes a RegExp.
- [ ] **Step 2: Run** `node --test test/codefiles.test.cjs test/config.test.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Normalize every path to forward slashes and lower case before comparing (Review Focus 1). Default extensions: `.js .jsx .mjs .cjs .ts .tsx .mts .cts .py .pyi .go .rs .java .kt .kts .scala .cs .fs .vb .c .cc .cpp .cxx .h .hh .hpp .m .mm .swift .dart .rb .php .ex .exs .lua .sql .vue .svelte .gd`. Config search stops at the first dir containing `.git` or at the filesystem root.
- [ ] **Step 4: Run** the same command. Expected: pass.
- [ ] **Step 5: Commit** `feat(core): code file detection and project config`.

### Task 3: Ledger

**Files:**
- Create: `core/ledger.cjs`
- Test: `test/ledger.test.cjs`

**Interfaces:**
- Produces:
  - `ledgerDir(agent: 'claude' | 'codex', env?: object, platform?: string, homeDir?: string) => string`: Claude `<CLAUDE_PLUGIN_DATA>/ledgers`, falling back to the Codex location when unset; Codex `%LOCALAPPDATA%\proof-of-green` on win32, else `$XDG_STATE_HOME/proof-of-green` or `~/.local/state/proof-of-green`.
  - `readLedger(dir: string, sessionId: string) => { turn: string, nextSeq: number, records: Rec[] }`
  - `writeLedger(dir: string, sessionId: string, ledger) => void` (temp file + rename; prunes files older than 7 days in `dir`)
  - `Rec = { seq: number, turn: string, kind: 'edit' | 'command', path?: string, command?: string, isTest?: boolean, result?: 'pass' | 'fail' | 'unknown', id?: string }`
  - `currentTurnRecords(ledger) => Rec[]`
  - `logError(dir: string, err: Error) => void`

- [ ] **Step 1: Write the failing tests.** Round trip of write and read; missing file gives `{ turn: '0', nextSeq: 1, records: [] }`; a file containing `{"turn":` (truncated) reads as empty (Review Focus 3); file name is the SHA-256 hex of `session_id` plus `.json`; a stale file with mtime 8 days ago is deleted on write, one at 6 days is kept; `ledgerDir` for each platform/env combination.
- [ ] **Step 2: Run** `node --test test/ledger.test.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement** with `fs.writeFileSync(tmp)` then `fs.renameSync`; temp name includes `process.pid` and a random suffix.
- [ ] **Step 4: Run.** Expected: pass.
- [ ] **Step 5: Commit** `feat(ledger): per-session ledger with atomic writes`.

### Task 4: Policy

**Files:**
- Create: `core/policy.cjs`
- Test: `test/policy.test.cjs`

**Interfaces:**
- Consumes: `Rec` (Task 3), `suggestTestCommand` (Task 1).
- Produces: `decide(records: Rec[], opts: { enabled: boolean, stopHookActive: boolean, suggestedCommand: string | null }) => { action: 'allow' } | { action: 'allow', systemMessage: string } | { action: 'block', reason: string }`.

- [ ] **Step 1: Write the failing tests.**
  - disabled, `stopHookActive`, or no edit: allow.
  - edit then passing test: allow.
  - passing test then edit: block; reason contains `no test command ran` and the file name.
  - edit, failing test: block; reason contains `failed`.
  - edit, failing test, passing test: allow.
  - edit, passing test, `ls`: allow (non-test commands are ignored).
  - edit, latest test `unknown`: allow with `systemMessage` containing `could not be verified`.
  - seven edited files: reason lists five and `(+2 more)`.
  - reason includes `suggestedCommand` when given, and the sentence telling the agent that if the project has no tests or the user asked not to run them, it should say so plainly and finish.
  - reason does not match `/disable|PROOF_OF_GREEN|enabled/i`.
- [ ] **Step 2: Run** `node --test test/policy.test.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement `decide`.** Order of checks follows spec "Policy" steps 1-6.
- [ ] **Step 4: Run.** Expected: pass.
- [ ] **Step 5: Commit** `feat(policy): stop decision and block reason`.

### Task 5: Claude Code adapter and entry point

**Files:**
- Create: `adapters/claude.cjs`, `gate.cjs`
- Test: `test/claude.test.cjs`, `test/gate.e2e.test.cjs`, fixtures `test/fixtures/claude/*.json`

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces:
  - `handleClaude(event: string, payload: object, ctx: { dir: string, config, env }) => object` (the stdout JSON; `{}` for allow).
  - Events: `user-prompt` (new turn: `turn = String(Number(turn) + 1)`), `post-tool`, `post-tool-failure`, `stop`.
  - `post-tool` with `tool_name` in `Edit|Write|MultiEdit|NotebookEdit` and a code file (`tool_input.file_path` or `notebook_path`) appends an edit; with `Bash|PowerShell` appends a command with `isTest` and `result: 'pass'`. `post-tool-failure` with `Bash|PowerShell` appends `result: 'fail'`.
  - `gate.cjs`: `main(argv: string[], stdinText: string, env: object) => string`; run as script it reads stdin, prints `main(...)`, exits 0.
  - `stop` passes `suggestedCommand` = the latest test command in the ledger, else `suggestTestCommand(config.root)`; this rule is shared with Task 6.
  - `stop` maps `decide` to `{"decision":"block","reason":...}`, `{"systemMessage":...}`, or `{}`.

- [ ] **Step 1: Write the failing tests.** Unit: each event updates the ledger as described; non-code edits are ignored. E2E (spawn `node gate.cjs claude <event>` with a temp `CLAUDE_PLUGIN_DATA`): a session of prompt, Edit `src/a.ts`, stop gives a block; the same plus a passing `npm test` gives `{}`; a second stop with `stop_hook_active: true` gives `{}`; empty stdin, `not json`, and `{}` without `session_id` each give `{}` with exit code 0 (Review Focus 4); an adapter that throws (inject via `PROOF_OF_GREEN_TEST_THROW=1`) gives `{}` and a line in `errors.log`.
- [ ] **Step 2: Run** `node --test test/claude.test.cjs test/gate.e2e.test.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** `gate.cjs` wraps everything in try/catch per Global Constraints.
- [ ] **Step 4: Run.** Expected: pass.
- [ ] **Step 5: Commit** `feat(claude): Claude Code adapter and gate entry point`.

### Task 6: Codex adapter and rollout parser

**Files:**
- Create: `adapters/codex.cjs`, `adapters/rollout.cjs`
- Modify: `gate.cjs` (route `codex`)
- Test: `test/codex.test.cjs`, `test/rollout.test.cjs`, fixtures `test/fixtures/codex/*.jsonl` (synthetic)

**Interfaces:**
- Produces:
  - `parsePatchPaths(patch: string) => string[]`, from lines starting `*** Add File: `, `*** Update File: `, `*** Delete File: `, `*** Move to: `.
  - `readCommandResults(rolloutPath: string | null) => Array<{ callId?: string, command: string, exitCode: number, turnId?: string }>`, reading `event_msg` lines whose `payload.type === 'item_completed'` and `payload.item.type === 'CommandExecution'`; `command` is `item.command` joined with spaces when it is an array.
  - `handleCodex(event: string, payload: object, ctx) => object`; events `post-tool`, `stop`. Turn comes from `payload.turn_id`. `post-tool` with `tool_name === 'apply_patch'` appends one edit per code path from `tool_input.command`; with `Bash` appends a command with `result: 'unknown'` and `id: payload.tool_use_id`. `stop` resolves unknown test results from `readCommandResults(payload.transcript_path)` by `callId === id`, else by matching command text in order within the turn, then calls `decide`.

- [ ] **Step 1: Write the failing tests.** Patch paths from a two-file patch with a move; rollout fixture with two commands (exit 0 and 1); truncated last line, unknown record types, and a file with no `CommandExecution` items return what can be read without throwing (Review Focus 5); `transcript_path: null` leaves results unknown and Stop returns `{"systemMessage": ...}`; resolved failing test blocks; resolved passing test allows; E2E through `node gate.cjs codex stop`.
- [ ] **Step 2: Run** `node --test test/codex.test.cjs test/rollout.test.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Every rollout field is optional; skip lines that fail `JSON.parse`.
- [ ] **Step 4: Run** `npm test` (whole suite). Expected: pass.
- [ ] **Step 5: Commit** `feat(codex): Codex adapter with rollout exit codes`.

### Task 7: Claude Code plugin packaging

**Files:**
- Create: `.claude-plugin/plugin.json` (`name: "proof-of-green"`, `version`, `description`, `license: "MIT"`), `.claude-plugin/marketplace.json` (`name: "proof-of-green"`, `owner: { name: "Bekir Efeoğlu" }`, `plugins: [{ name: "proof-of-green", source: "./" }]`), `hooks/hooks.json`
- Test: `test/packaging.test.cjs`

**Interfaces:**
- `hooks/hooks.json` top-level `"hooks"`: `UserPromptSubmit` to `user-prompt`; `PostToolUse` matcher `Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell` to `post-tool`; `PostToolUseFailure` matcher `Bash|PowerShell` to `post-tool-failure`; `Stop` to `stop`. Each handler `{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/gate.cjs", "claude", "<event>"], "timeout": 10 }`.

- [ ] **Step 1: Write the failing test.** Parse all three JSON files; every handler's event argument is one that `handleClaude` accepts; plugin and marketplace names match `package.json` name; versions of `plugin.json` and `package.json` match.
- [ ] **Step 2: Run** `node --test test/packaging.test.cjs`. Expected: FAIL.
- [ ] **Step 3: Create the files.**
- [ ] **Step 4: Run.** Expected: pass.
- [ ] **Step 5: Manual check (local, user's machine):** `claude plugin marketplace add D:\Proje\proof-of-green`, `claude plugin install proof-of-green@proof-of-green`, then in a scratch repo edit a `.js` file and end the turn; the turn is blocked once. Record the result in the task report.
- [ ] **Step 6: Commit** `feat(plugin): Claude Code plugin and marketplace`.

### Task 8: CLI: install codex and doctor

**Files:**
- Create: `bin/cli.cjs`
- Test: `test/cli.test.cjs`

**Interfaces:**
- Produces:
  - `installCodex({ homeDir, env, platform }) => { appDir: string, hooksFile: string, added: string[] }`. Copies `gate.cjs`, `core/`, `adapters/` to `<codex ledgerDir>/app/` (overwriting), then merges into `<homeDir>/.codex/hooks.json` entries for `PostToolUse` (matcher `apply_patch|Bash`) and `Stop`, command `node "<appDir>/gate.cjs" codex <event>` with forward slashes. Existing entries with the same command are not duplicated; other hooks are kept. Prints that the user must trust the hooks in `/hooks`.
  - `doctor({ homeDir, env, platform, cwd }) => { claude: { installed: boolean }, codex: { installed: boolean, trusted: boolean | 'unknown' }, ledgerDirs: string[], lastErrors: string[] }`; `claude.installed` is true when `<homeDir>/.claude/plugins/installed_plugins.json` lists a key starting with `proof-of-green@` (false when the file is missing); `trusted` is true when `~/.codex/config.toml` has a `[hooks.state.'<hooksFile>:stop:` entry, false when it has none, `'unknown'` when the file is missing.
  - CLI: `proof-of-green install codex`, `proof-of-green doctor` (prints a readable report; `--json` prints the object).

- [ ] **Step 1: Write the failing tests** against a temp `homeDir`: install into an empty home creates both files; running twice adds nothing new; an existing unrelated `Stop` hook survives; the command string is byte-identical across two installs; doctor reports `trusted: false` with a config.toml lacking the entry and `true` with it.
- [ ] **Step 2: Run** `node --test test/cli.test.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Never edit `config.toml`; only read it.
- [ ] **Step 4: Run** `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat(cli): codex installer and doctor`.

### Task 9: README and CI

**Files:**
- Create: `README.md`, `.github/workflows/ci.yml`

- [ ] **Step 1: Write `README.md`** (English; use the `humanizer` skill): one-paragraph pitch, how it decides (the six policy steps), install for Claude Code and Codex, config file example from the spec, what it does not do, comparison table from the spec "Prior art", license. No badges beyond CI.
- [ ] **Step 2: Write `ci.yml`:** on push and pull_request; matrix `os: [ubuntu-latest, windows-latest, macos-latest]`, `node: [18, 20, 22]`; steps `actions/checkout@v4`, `actions/setup-node@v4`, `npm test`.
- [ ] **Step 3: Run** `npm test` on the remote server. Expected: pass. CI itself runs only after the user pushes.
- [ ] **Step 4: Commit** `docs: README and CI workflow`.
