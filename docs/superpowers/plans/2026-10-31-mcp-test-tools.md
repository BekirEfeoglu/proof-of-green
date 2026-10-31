# MCP test tools (v0.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user declare MCP tools as test runners so a passing remote run satisfies the gate and a failing one blocks, in Claude Code and Codex.

**Architecture:** A new pure module reads the exit code from an MCP response. Config gains a user-level file and a `testTools` list. Both adapters record listed MCP calls as command records with a `via` field; the policy names the tool in its suggestion; hooks and the Codex installer widen their matchers to `mcp__.*`.

**Tech Stack:** Node.js >= 18, CommonJS, `node:test`, no dependencies.

**Spec:** `docs/superpowers/specs/2026-10-31-mcp-test-tools-design.md` (builds on `2026-10-31-proof-of-green-design.md`)

## Global Constraints

- No dependencies in `package.json`.
- Every hook path fails open; config and response parsing never throw.
- Block output stays `{"decision":"block","reason":...}`; existing reason copy is unchanged except for the `(through <tool>)` suffix defined in Task 3.
- User config file: `~/.proof-of-green.json` (resolved from an injectable `homeDir`, default `os.homedir()`); project file unchanged: `.proof-of-green.json`.
- `testTools` entry: `{ tool: string, commandArg: string, exitCodeField?: string }`, `exitCodeField` default `exit_code`.
- Matchers: Claude `PostToolUse` `Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|mcp__.*`, Claude `PostToolUseFailure` `Bash|PowerShell|mcp__.*`, Codex `PostToolUse` `apply_patch|Bash|mcp__.*`.
- Version `0.2.0` in `package.json` and `.claude-plugin/plugin.json`.
- Tests run locally (user-approved, `CLAUDE_YEREL_TEST=1`): `node --test <file>` while iterating, `npm test` (unpiped) before every commit.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A Codex turn that runs `npm test` both locally (Bash) and through a listed MCP tool: the rollout's shell result must never be assigned to the MCP record. Test in Task 5.
2. A listed tool whose `tool_input` lacks `commandArg` or holds a non-string: no record, no throw. Test in Task 4.
3. A user config that is valid JSON but not an object (`[]`, `"x"`), or has `testTools` as a non-array: defaults, no throw. Test in Task 2.
4. An MCP response whose first text block is not JSON but a later one is: `unknown` (only the first text block is read, per spec). Test in Task 1.
5. A listed tool also matching a shell name is impossible, but an unlisted `mcp__` tool must never create a record even when its response carries `exit_code`. Test in Task 4.

---

### File structure

| Path | Change |
|---|---|
| `core/toolresult.cjs` | New: `readToolExitCode(response, field)` |
| `core/config.cjs` | User config, merge rules, `testTools` |
| `core/policy.cjs`, `adapters/common.cjs` | Suggestion names the tool |
| `adapters/claude.cjs`, `hooks/hooks.json` | Record listed MCP calls; matchers |
| `adapters/codex.cjs`, `bin/cli.cjs` | Record listed MCP calls; installer matcher and v0.1 upgrade |
| `README.md`, v0.1 spec, `package.json`, `.claude-plugin/plugin.json` | Docs and version |

---

### Task 1: Read an exit code from an MCP response

**Files:** Create `core/toolresult.cjs`; Test `test/toolresult.test.cjs`

**Interfaces:**
- Produces: `readToolExitCode(response: unknown, field?: string) => 'pass' | 'fail' | 'unknown'` (field default `'exit_code'`, dotted path).

- [ ] **Step 1: Write the failing tests:**
  - array `[{type:'text', text:'{"exit_code":0}'}]` → `pass`; with 1 → `fail`
  - string `'{"exit_code":2}'` → `fail`
  - object `{ exit_code: 0 }` → `pass` (no parsing)
  - dotted path `result.code` on `{"result":{"code":0}}` → `pass`
  - `"0"` → `pass`, `"-1"` → `fail`, `"0.5"` → `unknown`, `true` → `unknown`, `null` → `unknown`
  - non-JSON text, missing field, empty array, array without a text block → `unknown`
  - array whose first text block is non-JSON and second is JSON → `unknown` (Review Focus 4)
  - `undefined`, `42`, a circular object → `unknown`, never throws
- [ ] **Step 2: Run** `node --test test/toolresult.test.cjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** per spec "Reading a result" steps 1-4.
- [ ] **Step 4: Run** the same. Expected: PASS. Then `npm test`.
- [ ] **Step 5: Commit** `feat(core): read exit codes from MCP tool responses`.

### Task 2: User config and testTools

**Files:** Modify `core/config.cjs`; Test `test/config.test.cjs`

**Interfaces:**
- Changes: `loadConfig(cwd, env = process.env, homeDir = os.homedir())`; return adds `testTools: Array<{ tool, commandArg, exitCodeField }>`.
- Produces: `USER_CONFIG_NAME = '.proof-of-green.json'` read from `homeDir`.

- [ ] **Step 1: Write the failing tests** (temp project dir with `.git`, temp `homeDir`):
  - user file alone: its `testTools`, `testCommands`, `include`, `exclude` apply
  - project `enabled:false` overrides user `enabled:true`; user `enabled:false` with no project value disables
  - lists concatenate user first; a project `testTools` entry with the same `tool` replaces the user entry
  - `exitCodeField` defaults to `exit_code`; entries missing `tool` or `commandArg`, or with non-string values, are skipped
  - user file `[]`, `"x"`, invalid JSON, or `testTools: {}` → defaults, no throw (Review Focus 3)
  - when `homeDir` equals the project root, the file is read once, not merged with itself
  - existing tests keep passing (they call `loadConfig(cwd, env)`; pass an empty temp `homeDir` where the real home could leak in)
- [ ] **Step 2: Run** `node --test test/config.test.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Gate callers (`gate.cjs`) keep calling `loadConfig(cwd, env)`.
- [ ] **Step 4: Run.** Expected: PASS. Then `npm test`.
- [ ] **Step 5: Commit** `feat(config): user-level config and MCP test tools`.

### Task 3: Suggestion names the tool

**Files:** Modify `core/policy.cjs`, `adapters/common.cjs`; Test `test/policy.test.cjs`, `test/claude.test.cjs`

**Interfaces:**
- `decide(records, { enabled, stopHookActive, suggestedCommand, suggestedVia })`; when `suggestedVia` is a non-empty string the suggestion reads `` Suggested command: `<cmd>` (through <via>). ``; otherwise unchanged.
- `adapters/common.cjs`: `latestTestCommand(ledger)` returns `{ command, via } | null` (via from the record, may be undefined); `stopResponse` passes both.

- [ ] **Step 1: Write the failing tests:** exact reason copy with `suggestedVia`; unchanged copy without it; `stopResponse` uses the latest test record's `via`.
- [ ] **Step 2: Run** `node --test test/policy.test.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Then `npm test`.
- [ ] **Step 5: Commit** `feat(policy): name the MCP tool in the suggested command`.

### Task 4: Claude Code records listed MCP calls

**Files:** Modify `adapters/claude.cjs`, `hooks/hooks.json`; Test `test/claude.test.cjs`, `test/gate.e2e.test.cjs`, `test/packaging.test.cjs`

**Interfaces:**
- Consumes: `readToolExitCode` (Task 1), `config.testTools` (Task 2), `via` (Task 3).
- Record for a listed tool: `{ kind:'command', command, via: tool, isTest: isTestCommand(command, config.testPatterns), result }`; `post-tool` result from `readToolExitCode(payload.tool_response, exitCodeField)`; `post-tool-failure` → `isTest: false`, `result: 'fail'`.

- [ ] **Step 1: Write the failing tests:**
  - listed tool, `komut: 'npm test'`, response `[{type:'text',text:'{"exit_code":1,"duration_sec":1,"stdout":"FAIL","stderr":""}'}]` → fail record; with 0 → pass
  - `komut: 'npm test || true'` → `isTest: false`
  - `post-tool-failure` for the listed tool → `isTest: false`
  - unlisted `mcp__x__y` with an `exit_code` response → no record (Review Focus 5)
  - listed tool with `tool_input` lacking `komut`, or `komut: 42` → no record (Review Focus 2)
  - e2e: config in a temp home (`HOME`/`USERPROFILE` set for the child) with the listed tool; edit, MCP fail, stop → block whose reason contains `(through mcp__uzak_sunucu__sunucu_komut_calistir)`; then MCP pass, new stop → `{}`
  - packaging: matchers equal the Global Constraints values
- [ ] **Step 2: Run** `node --test test/claude.test.cjs test/gate.e2e.test.cjs test/packaging.test.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement** and update `hooks/hooks.json` matchers.
- [ ] **Step 4: Run.** Expected: PASS. Then `npm test`.
- [ ] **Step 5: Commit** `feat(claude): count listed MCP tools as test runs`.

### Task 5: Codex records listed MCP calls; installer upgrade

**Files:** Modify `adapters/codex.cjs`, `bin/cli.cjs`; Test `test/codex.test.cjs`, `test/cli.test.cjs`

**Interfaces:**
- Codex record for a listed tool: same shape as Task 4, result from `readToolExitCode(payload.tool_response, exitCodeField)`; `resolveResults` skips records that have `via`.
- `installCodex` PostToolUse matcher `apply_patch|Bash|mcp__.*`; when a group already holds our post-tool command with a different matcher, set that group's matcher and report the event in a new `updated` array (`{ appDir, hooksFile, added, updated }`); the CLI prints `Updated: <events>` when non-empty.

- [ ] **Step 1: Write the failing tests:**
  - listed tool pass/fail/unknown records; stop blocks on fail without any rollout file
  - same turn: Bash `npm test` (rollout exit 0) and listed MCP `npm test` (response exit 1, latest) → stop blocks; the MCP record keeps `fail` (Review Focus 1)
  - fresh install writes the new matcher; a v0.1 `hooks.json` (matcher `apply_patch|Bash`, same command) is updated in place, one group, `updated: ['PostToolUse']`; a second install changes nothing
- [ ] **Step 2: Run** `node --test test/codex.test.cjs test/cli.test.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Then `npm test`.
- [ ] **Step 5: Commit** `feat(codex): count listed MCP tools and upgrade v0.1 installs`.

### Task 6: Docs and version

**Files:** Modify `README.md`, `docs/superpowers/specs/2026-10-31-proof-of-green-design.md`, `package.json`, `.claude-plugin/plugin.json`

- [ ] **Step 1:** README (use the `humanizer` skill): new section "Tests that run through MCP tools" with the user-config example from the spec and one sentence on what counts; Known limits: remove the MCP line, add "The gate cannot tell whether a remote copy of the code is current when a test runs there."; note that upgrading a Codex install asks you to trust the hooks again.
- [ ] **Step 2:** v0.1 spec: replace the exec-form hook command with the string form; replace the masking list with the first-test separator rule and the narrow PowerShell `if ($?)`/`if ($LASTEXITCODE -eq 0)` exception.
- [ ] **Step 3:** Set `0.2.0` in both manifests.
- [ ] **Step 4: Run** `npm test`. Expected: PASS (packaging test checks the versions match).
- [ ] **Step 5: Commit** `docs: MCP test tools and v0.2.0`.
