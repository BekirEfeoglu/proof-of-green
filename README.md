# proof-of-green

[![CI](https://github.com/BekirEfeoglu/proof-of-green/actions/workflows/ci.yml/badge.svg)](https://github.com/BekirEfeoglu/proof-of-green/actions/workflows/ci.yml)

A Stop hook for Claude Code and Codex CLI that keeps the agent from saying "done" when it changed code and no test passed after the change. It reads the commands the agent actually ran and their real exit codes. It never runs tests itself and never trusts text the agent wrote about them. When something is missing it sends the agent back once, so the agent either runs the tests or tells you plainly why it can't.

It is one script with no dependencies. Node.js 18 or newer must be on your PATH, because the hooks call `node`.

## What it looks like

The agent edits `add.js`, runs `npm test`, the test fails, and the agent tries to end its turn. It gets this back instead:

> proof-of-green: you changed code (add.js) and the last test run after that change failed. Fix the failures and run the tests again, or report the failing tests to the user. Suggested command: `npm test`. If this project has no tests, or the user asked you not to run them, say so plainly and finish.

If no test ran at all, the first sentence says "no test command ran after the last change" instead. If a test ran but its exit code was hidden, for example by `npm test | tail` or `npm test; git push`, the reason names that command and says how to run it so the exit code counts. The gate blocks once per stop attempt, so an agent that still can't get a green run can finish by reporting that.

## Quick start

### Claude Code

This repository is its own plugin marketplace. In Claude Code:

```
/plugin marketplace add BekirEfeoglu/proof-of-green
/plugin install proof-of-green@proof-of-green
```

Or from a terminal:

```
claude plugin marketplace add BekirEfeoglu/proof-of-green
claude plugin install proof-of-green@proof-of-green
```

Start a new session afterwards; hooks are loaded when a session starts. To update later, run `claude plugin marketplace update proof-of-green` and then `claude plugin update proof-of-green@proof-of-green`.

### Codex CLI

The npm package is not published yet, so run the installer from GitHub:

```
npx github:BekirEfeoglu/proof-of-green install codex
```

This copies the gate into Codex's state folder and adds two hooks (`PostToolUse` and `Stop`) to `~/.codex/hooks.json`. Codex skips new hooks until you trust them, so open `/hooks` in Codex and trust the proof-of-green entries. Running the installer again after an upgrade changes the `PostToolUse` hook in place, and Codex asks you to trust it again.

### Check the install

```
npx github:BekirEfeoglu/proof-of-green doctor
```

`doctor` reports whether the Claude Code plugin and the Codex hooks are installed, whether Codex trusts them, what it found in your config files, where the ledgers live, and the last logged errors. Add `--json` for machine-readable output.

## How it decides

At each stop, looking only at the current turn:

1. If the gate is disabled, allow.
2. If this stop already follows a block from the gate, allow. It blocks at most once.
3. Find the last edit to a code file. If there is none, allow.
4. Look at the test commands that ran after that edit. If the latest one passed, allow.
5. If the latest one has no known result (only on Codex, when its session log can't be read), allow and add a note that the result could not be verified.
6. Otherwise block, with a reason like the one above.

Any error inside the gate allows the stop and is appended to `errors.log` next to the ledgers. The gate should never trap a session.

## What counts as a test

A shell command counts when it starts a built-in test runner:

- `npm`, `pnpm`, `yarn` or `bun` with `test` or `run test`, `npm t`, and scripts whose name starts with `test` followed by `:`, `-` or `_` (`test:unit`, `test-e2e`)
- `vitest`, `jest`, `mocha` or `playwright test` through `npx`, `bunx`, `pnpm`, `pnpm exec` or `yarn`
- `pytest`, `python -m pytest`, `python -m unittest`, also through `py` or `py -3`
- `node --test`, `go test`, `cargo test`, `cargo nextest`, `dotnet test`, `deno test`
- `mvn`, `./mvnw`, `gradle` or `./gradlew` (or `.\mvnw`, `.\gradlew`) with `test` or `verify`
- `make test`, `make check`, `rspec`, `phpunit`, `mix test`

A leading `uv run`, `poetry run`, `pipenv run`, `hatch run` or `pdm run` is skipped, so `uv run pytest` counts. On Codex, a `bash -lc "..."`, `sh -c`, `zsh -lc` or `pwsh -Command` wrapper is unwrapped first. You can add your own patterns in the config.

The exit code the agent sees has to be the test's own. So every command after the first test command must be joined with `&&`:

| Command | Counts? | Why |
|---|---|---|
| `npm test` | yes | |
| `npm run lint; npm test` | yes | commands before the first test don't matter |
| `npm test && echo ok` | yes | `&&` only runs on success |
| `npm test; echo done` | no | the exit code is `echo`'s |
| `npm test \|\| echo failed` | no | always ends in 0 |
| `npm test; pytest` | no | a passing `pytest` hides a failed `npm test` |
| `npm test \| tail` | no | unless `set -o pipefail` is on |
| `npm test \|\| true` | no | masks the result |
| `echo "tests passed"` | no | not a test |

Two more rules:

- A PowerShell check at the very end is allowed if it is exactly `; if ($?) { ... }` or `; if ($LASTEXITCODE -eq 0) { ... }`, with no `else` and no `exit` or `LASTEXITCODE` assignment inside. Any other check runs a command after a failure, which resets PowerShell's exit code to 0.
- On Claude Code, a shell call made with `run_in_background` never counts. Its success only means the command started.

An edit counts when the file has a code extension (`.js`, `.ts`, `.py`, `.go`, `.rs`, `.java`, `.cs`, `.rb`, `.php`, `.sql`, `.vue` and a few dozen more; the full list is in `core/codefiles.cjs`). Files under `node_modules`, `.git`, the OS temp folder, `~/.claude` and `~/.codex` never count.

Edits made through the shell count too, when the command writes the file with a `>` or `>>` redirection, `tee`, `sed -i`, `perl -i`, or PowerShell's `Set-Content`, `Add-Content` or `Out-File`. They count even if the command failed or ran in the background. Order inside one command matters: in `sed -i ... a.js && npm test` the test runs after the edit, in `npm test && sed -i ... a.js` it doesn't. A target path that holds a variable (`> "$OUT/a.js"`) is skipped, but a variable elsewhere doesn't hide the file: `sed -i "$script" a.js` still counts.

## Configuration

Everything is optional. There are two files, both named `.proof-of-green.json`:

- one in your home folder, used for every project;
- one in the project, looked up from the agent's working directory up to the git root. Without a git root, only the working directory's own file is read.

```json
{
  "enabled": true,
  "testCommands": ["^make verify$", "^\\./scripts/test\\.sh"],
  "include": ["scripts/**/*.sh"],
  "exclude": ["generated/**"]
}
```

- `enabled`: `false` turns the gate off.
- `testCommands`: extra regular expressions, matched against each command segment.
- `include`: globs for extra files that count as code.
- `exclude`: globs for files that never count. Exclusions win over `include`.

Globs are matched against the path relative to the project root. A pattern without a slash, such as `*.gen.ts`, only matches files at the root; use `**/*.gen.ts` for any depth.

When both files exist they are merged. The project's `enabled` wins when it sets one; otherwise a user `false` still turns the gate off. Lists are concatenated, user entries first. Setting `PROOF_OF_GREEN=off` in the environment disables the gate for that process.

### Tests that run through MCP tools

If your agent runs tests through an MCP tool, for example on a remote machine, list the tool under `testTools`:

```json
{
  "testTools": [
    { "tool": "mcp__remote__run_command", "commandArg": "command" }
  ]
}
```

- `tool`: the full tool name. It must start with `mcp__`.
- `commandArg`: the tool argument that holds the command line. That command goes through the same rules as a shell command.
- `exitCodeField`: optional, default `exit_code`. Where the exit code sits in the tool's JSON response. A dotted path such as `result.exit_code` reaches into nested objects.

The response must be JSON that carries the exit code, either as the response itself or as the text of its first text block. An integer or an integer string works; 0 is a pass and anything else a fail. Some tools report a failing command as an error; the gate still reads the exit code from the error text. If it can't read one, the stop is allowed with a note.

### Edits that run through MCP tools

If your agent edits files through an MCP tool instead of Edit or Write, list the tool under `editTools`:

```json
{
  "editTools": [
    { "tool": "mcp__desktop-commander__write_file", "pathArg": "path" }
  ]
}
```

- `tool`: the full tool name. It must start with `mcp__`.
- `pathArg`: the tool argument that holds the file path. A relative path is resolved against the agent's working directory.

Only files that pass the code-file rules count, including your `include` and `exclude` globs. A tool listed under both keys is treated as a test tool. In a merge, a project entry with the same `tool` as a user entry replaces it.

## Subagents

Claude Code only. Each subagent is checked when it stops, using only the edits and test runs it made itself. A subagent that changed code without a passing test afterwards is blocked once, and the suggested command is the last test command it ran.

The main session's stop still looks at every edit in the turn, so changes a subagent left untested also block the main session. A background subagent may still be running when the main session stops; its changes are checked when it stops, and until then the main session gets a note that it has not reported a stop yet.

## Troubleshooting

`proof-of-green status` shows what the gate would do right now, without changing anything:

```
npx github:BekirEfeoglu/proof-of-green status
```

It reads the most recently modified ledger and prints the code files edited this turn, the commands the gate recorded with their result, and a verdict: `Would allow`, `Would allow with note: ...` or `Would block: ...`. Add `--json` for the same data as JSON. With several sessions active it may pick a different one than you mean. On Codex the verdict can differ from the real stop, because status does not read Codex's session log.

To see exactly what the hooks receive, set `PROOF_OF_GREEN_DEBUG=1` in the agent's environment. Each hook call then appends a line to `debug.log` next to `errors.log`: the time, the agent, the event, and the payload cut to 4096 characters. Payloads can contain command output and file paths, so treat the file as sensitive. Both logs are trimmed to their last 32 KB once they pass 64 KB.

The ledger is one append-only JSONL file per session. Ledgers older than 7 days are deleted on the next write.

## Uninstall

Claude Code:

```
claude plugin uninstall proof-of-green@proof-of-green
claude plugin marketplace remove proof-of-green
```

Codex:

```
npx github:BekirEfeoglu/proof-of-green uninstall codex
```

This removes the two proof-of-green entries from `~/.codex/hooks.json` and deletes the copied gate. Your other hooks stay. The ledgers and logs stay in `proof-of-green` inside Codex's state folder (`%LOCALAPPDATA%` on Windows, `$XDG_STATE_HOME` or `~/.local/state` elsewhere); delete that folder too if you want them gone. `doctor` shows where it is.

## Known limits

- Codex does not put exit codes in its hook payloads. The gate reads them from Codex's session log, whose format is undocumented and may change. If it can't be read, the stop is allowed with a note.
- Codex hooks are experimental, and Codex skips untrusted hooks without a warning. Run `doctor` after installing.
- Codex subagents are not checked separately.
- A Claude Code subagent that ends without a `SubagentStop` event (for example, one that was killed) is left out of the main session's check for that turn, and its edits are not checked at all.
- Shell edits are found only in the forms listed above. A script, `node -e`, `python -c`, `cp`, `mv`, `git checkout` or a code generator can change code without the gate seeing an edit.
- The gate checks that a test command passed, not that it tests the code you changed. A narrow test that exits 0 satisfies it.
- When tests run on another machine, the gate can't tell whether that copy of the code is current.
- Every MCP tool call starts the gate briefly, even for tools you didn't list, which adds a little latency.

Out of scope: running tests itself, judging changes with a language model, enforcing test-first order, and agents other than Claude Code and Codex CLI.

## Development

```
npm test
```

The suite uses Node's built-in test runner and needs no install. CI runs it on Ubuntu, Windows and macOS with Node 18, 20 and 22. Design notes are in `docs/superpowers/specs/`.

## Prior art

| Project | What it does | Gap proof-of-green fills |
|---|---|---|
| nizos/tdd-guard | PreToolUse, LLM judges each write for TDD order | Checks edits, not the end of the turn; model call per write |
| nizos/probity | Policy engine for Claude Code, Codex, Copilot CLI | No "passing test after last edit" rule; rules written in TypeScript |
| claude-hook-gate | Runs commands from `gate.yaml` at Stop | Re-runs tests; needs config and a downloaded binary |
| claude-verify-before-stop | Trusts a "VERIFIED" line the agent writes | The agent can fake it; no exit codes |
| codhc | Re-runs one command at Codex Stop | Re-runs tests; no edit tracking |

## Changes

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
