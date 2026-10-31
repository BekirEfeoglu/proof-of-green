# proof-of-green: design

Date: 2026-10-31
Status: draft, awaiting review

## Goal

proof-of-green stops an AI coding agent from ending a turn when it changed code and no test command ran and passed after its last change. It supports Claude Code and OpenAI Codex CLI in the first release. The target users are developers who run these agents and want "done" to mean "tests are green", without re-running the suite themselves.

Success looks like this:

- A user installs it with one command per agent and it works on the next turn, with no config, in a project that uses a common test runner.
- The gate reads what the agent actually ran and the real exit code. It never re-runs tests and never trusts text the agent wrote.
- It blocks at most once per stop attempt, so an agent facing red or missing tests can still finish by reporting that honestly.
- It never locks a session: any internal error allows the stop.

## Non-goals (first release)

- Running tests itself.
- LLM-judged checks.
- Enforcing test-first order (tdd-guard covers that).
- A separate gate for Claude Code subagents at `SubagentStop`.
- Agents other than Claude Code and Codex CLI.

## Prior art and positioning

| Project | What it does | Gap proof-of-green fills |
|---|---|---|
| nizos/tdd-guard | PreToolUse, LLM judges each write for TDD order | Checks edits, not the end of the turn; model call per write |
| nizos/probity | Policy engine for Claude Code, Codex, Copilot CLI | No "passing test after last edit" rule; rules written in TypeScript |
| claude-hook-gate | Runs commands from `gate.yaml` at Stop | Re-runs tests; needs config and a downloaded binary |
| claude-verify-before-stop | Trusts a "VERIFIED" line the agent writes | The agent can fake it; no exit codes |
| codhc | Re-runs one command at Codex Stop | Re-runs tests; no edit tracking |

Differentiators: it checks the real exit code of what the agent ran, it is one zero-dependency Node script for both agents with auto-detection, and a fixture suite proves common cheats do not pass.

## Architecture

One entry point, `node gate.cjs <agent> <event>`, reads the hook payload from stdin and writes the hook response to stdout.

```
hooks (Claude Code plugin / Codex hooks.json)
        |
   gate.cjs <agent> <event>
        |
   adapters/claude.cjs | adapters/codex.cjs   -> normalized records
        |
   core/detect.cjs   (is this shell command a test?)
   core/ledger.cjs   (per-session JSON file, atomic writes)
   core/policy.cjs   (Stop decision)
```

### Adapters

They map each agent's payloads to normalized records and nothing else.

Claude Code:

| Event | Matcher | Record |
|---|---|---|
| `UserPromptSubmit` | | turn start |
| `PostToolUse` | `Edit\|Write\|MultiEdit\|NotebookEdit` | edit, with file path |
| `PostToolUse` | `Bash\|PowerShell` | command, result `pass` |
| `PostToolUseFailure` | `Bash\|PowerShell` | command, result `fail` |
| `Stop` | | evaluate |

The matcher includes `PowerShell` because Windows without Git Bash registers no Bash tool.

Codex CLI:

| Event | Tool | Record |
|---|---|---|
| `PostToolUse` | `apply_patch` | edit, file paths parsed from the patch headers in `tool_input.command` |
| `PostToolUse` | `Bash` | command, result `unknown`, keyed by `tool_use_id` |
| `Stop` | | resolve `unknown` results, then evaluate |

Codex starts a new turn when `turn_id` changes. Its PostToolUse payload has no exit code, so at Stop the adapter reads the rollout file at `transcript_path` and takes `exit_code` from `event_msg` records whose `payload.type` is `item_completed` and whose `payload.item.type` is `CommandExecution`. It matches a record to a ledger entry by call id when present, otherwise by command text and order within the turn. The rollout format is undocumented, so the parser treats every field as optional.

### Ledger

- One JSON file per session, named by a SHA-256 of `session_id`.
- Location: `${CLAUDE_PLUGIN_DATA}/ledgers/` for Claude Code; for Codex, `$XDG_STATE_HOME/proof-of-green/` or `~/.local/state/proof-of-green/` on Linux and macOS, `%LOCALAPPDATA%\proof-of-green\` on Windows.
- Records: `{ seq, turn, kind: "edit" | "command", path | command, isTest, result: "pass" | "fail" | "unknown" }`.
- Writes go to a temp file and are renamed into place so two concurrent hooks cannot corrupt the file. A lost record from a race is acceptable; a corrupt file is not.
- Ledgers older than 7 days are deleted on the next write.

### Test detection

A shell command counts as a test when one of its segments (split on `&&`, `;`, `|`, newlines) matches a built-in pattern or a project pattern:

- Built in: `npm test`, `npm run test*`, `pnpm test`, `yarn test`, `bun test`, `npx vitest`, `npx jest`, `pytest`, `python -m pytest`, `python -m unittest`, `go test`, `cargo test`, `cargo nextest`, `dotnet test`, `mvn test`, `gradle test`, `./gradlew test`, `make test`, `make check`, `rspec`, `phpunit`, `mix test`.
- Project: regular expressions listed in the config file.

A command does not count when its result is masked or faked:

- `|| true`, `|| :`, `; exit 0`, or `|| exit 0` anywhere in the command.
- The test segment piped into another command without `set -o pipefail` (the pipe's exit code is the last command's).
- No test segment at all, for example `echo "tests passed"`.

### Code files

An edit counts when the file has a code extension from a default list (`.js .jsx .mjs .cjs .ts .tsx .py .go .rs .java .kt .cs .fs .c .cc .cpp .h .hpp .swift .rb .php .ex .exs .lua .dart .vue .svelte .sql` and similar) and is not under `node_modules`, `.git`, the OS temp folder, or the agent's own config folder. The config file can add `include` and `exclude` globs.

### Policy

At Stop, within the current turn:

1. If the gate is disabled, allow.
2. If `stop_hook_active` is true, allow (block once only).
3. Find the last edit to a code file. If there is none, allow.
4. Take the commands after that edit that count as tests. If the latest of them passed, allow.
5. If the latest is `unknown` (Codex rollout missing or unreadable), allow and add a `systemMessage` saying the result could not be verified.
6. Otherwise block with a reason that lists up to five edited files, says whether tests failed or never ran, names the detected or configured test command, and tells the agent that if the project has no tests or the user asked not to run them, it should say so plainly and finish.

The block message never mentions how to disable the gate.

Any exception in any step allows the stop and appends the error to `errors.log` next to the ledgers.

## Configuration

Optional file `.proof-of-green.json` at the project root (found by walking up from `cwd` to the git root):

```json
{
  "enabled": true,
  "testCommands": ["^make verify$", "^\\./scripts/test\\.sh"],
  "include": ["scripts/**/*.sh"],
  "exclude": ["generated/**"]
}
```

`PROOF_OF_GREEN=off` in the environment disables the gate for that process.

## Distribution

- Repository `BekirEfeoglu/proof-of-green`, MIT license.
- Claude Code: the repository is also a marketplace. `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and `hooks/hooks.json` at the root. Install with `claude plugin marketplace add BekirEfeoglu/proof-of-green`, then `claude plugin install proof-of-green@proof-of-green`. Hook commands use the exec form `node ${CLAUDE_PLUGIN_ROOT}/gate.cjs claude <event>`.
- Codex: `npx proof-of-green install codex` merges entries into `~/.codex/hooks.json`, keeping the command text byte-identical across releases so Codex trust survives updates, then tells the user to trust the hooks in `/hooks`.
- `npx proof-of-green doctor` reports which hooks are installed, whether Codex has trusted them, the ledger folder, and the last errors.
- The npm package carries only the installer and doctor; hooks run from the installed files with no npm dependency at runtime.

## Testing

- `node:test`, no dependencies.
- Unit tests for detection (including every masking pattern) and the policy.
- Fixture tests per adapter, using synthetic payloads and rollout snippets shaped like the real ones. No real session content goes into the repository.
- End-to-end tests run `gate.cjs` as a child process with stdin payloads and assert on stdout JSON.
- An anti-cheat suite: fake `echo`, `|| true`, piped test without `pipefail`, tests run before the last edit, a red test followed by `ls`.
- CI on GitHub Actions: Ubuntu, Windows and macOS, Node 18, 20 and 22.

## Risks

- Codex rollout format changes. Mitigation: optional-field parser, `unknown` results allow with a visible note, fixtures per known format.
- Codex hooks are marked experimental and Codex skips untrusted hooks silently. Mitigation: `doctor` checks trust.
- Claude Code `PostToolUseFailure` is documented but young; if a version lacks it, failed tests would be missing and the gate would block as "no passing test", which is the safe direction.
- False positives from detection. Mitigation: project patterns and excludes in the config file.

## Open questions

None at this time.
