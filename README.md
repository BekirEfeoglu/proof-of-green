# proof-of-green

[![CI](https://github.com/BekirEfeoglu/proof-of-green/actions/workflows/ci.yml/badge.svg)](https://github.com/BekirEfeoglu/proof-of-green/actions/workflows/ci.yml)

proof-of-green is a Stop hook for Claude Code and Codex CLI. When the agent tries to end a turn after changing code, the gate checks whether a test command ran after the last change and exited with success. If not, it sends the agent back once to run the tests or to say honestly why it didn't. It reads the commands the agent actually ran and their real exit codes. It never runs tests itself and never believes a line of text the agent wrote about them.

It is one script with no dependencies. The same `gate.cjs` serves both agents.

## Requirements

Node.js 18 or newer on your PATH. The hooks call `node`.

## Install

### Claude Code

This repository is its own plugin marketplace. Inside Claude Code:

```
/plugin marketplace add BekirEfeoglu/proof-of-green
/plugin install proof-of-green@proof-of-green
```

Or from a terminal:

```
claude plugin marketplace add BekirEfeoglu/proof-of-green
claude plugin install proof-of-green@proof-of-green
```

### Codex CLI

The npm package is not published yet, so run the installer straight from GitHub:

```
npx github:BekirEfeoglu/proof-of-green install codex
```

This copies the gate into Codex's state folder and adds two hooks (`PostToolUse` and `Stop`) to `~/.codex/hooks.json`. Codex skips new hooks until you trust them, so open `/hooks` in Codex and trust the proof-of-green entries. Then check the result:

```
npx github:BekirEfeoglu/proof-of-green doctor
```

`doctor` reports whether the Claude Code plugin and the Codex hooks are installed, whether Codex has trusted them, where the ledgers live, and the last logged errors. Add `--json` for machine-readable output.

## How it decides

At each stop, looking only at the current turn:

1. If the gate is disabled, allow the stop.
2. If this stop is already the result of an earlier block (`stop_hook_active`), allow it. The gate blocks at most once.
3. Find the last edit to a code file. If there is none, allow.
4. Look at the test commands that ran after that edit. If the latest one passed, allow.
5. If the latest one has no known result (Codex only, when the session log can't be read), allow and add a note saying the result could not be verified.
6. Otherwise block. The reason lists up to five edited files, says whether the last test run failed or no test ran, suggests a test command when it can detect one (for example `npm test` when `package.json` has a test script), and tells the agent that if the project has no tests or you asked it not to run them, it should say so plainly and finish.

Any error inside the gate allows the stop and is appended to `errors.log` next to the ledgers. The gate should never trap a session.

## What counts as a test

A shell command counts when one of its segments, split on `&&`, `||`, `;`, `|`, `&` and newlines, starts with a built-in test command:

- `npm`, `pnpm`, `yarn` or `bun` with `test` or `run test` (including `test:unit` style scripts), and `npm t`
- `vitest`, `jest`, `mocha` or `playwright test` through `npx`, `bunx`, `pnpm`, `pnpm exec` or `yarn`
- `pytest`, `python -m pytest`, `python -m unittest`, also through `py` or `py -3`
- `go test`, `cargo test`, `cargo nextest`, `dotnet test`, `deno test`
- `mvn`, `./mvnw`, `gradle` or `./gradlew` (or `.\mvnw`, `.\gradlew`) with `test` or `verify`
- `make test`, `make check`
- `rspec`, `phpunit`, `mix test`

A leading `uv run`, `poetry run`, `pipenv run`, `hatch run` or `pdm run` is skipped, so `uv run pytest` counts. `hatch run test` does not, because `test` there is a script name the gate can't see into. On Codex, a `bash -lc "..."`, `sh -c`, `zsh -lc` or `pwsh -Command` wrapper is unwrapped first.

You can add your own patterns in the config file.

The exit code the agent sees has to be the test's. So every command after the first test command must be joined with `&&`. Anything else can hide a failure: `npm test; echo done`, `npm test || echo failed` and `npm test &` don't count, and neither do `npm test; pytest` or `npm test || npm test`, where a later run could cover up an earlier failed one. Commands before the first test don't matter, so `npm run lint; npm test` counts. Two exceptions:

- A pipe is fine while `set -o pipefail` is on. The last `set -o pipefail` or `set +o pipefail` before the pipe decides.
- A PowerShell check at the end, `; if ($?) { ... }` or `; if ($LASTEXITCODE ...) { ... }`, is fine. The `if` block, and any `else` block, may not contain `exit` or assign `LASTEXITCODE`.

A matching command also does not count if its result is masked or faked:

- `|| true`, `|| :`, `|| exit 0` or `; exit 0` anywhere in the command.
- No test segment at all, such as `echo "tests passed"`.
- On Claude Code, a shell call run with `run_in_background`. Its success only means the command started.

An edit counts when the file has a code extension (`.js`, `.ts`, `.py`, `.go`, `.rs`, `.java`, `.cs`, `.rb`, `.php`, `.sql`, `.vue` and a few dozen more; the full list is in `core/codefiles.cjs`). Files under `node_modules`, `.git`, the OS temp folder, `~/.claude` and `~/.codex` never count.

## Configuration

Everything is optional. To change the defaults, put a `.proof-of-green.json` in your project. The gate looks for it from the agent's working directory up to the git root. If there is no git root above the working directory, only a `.proof-of-green.json` in the working directory itself is read.

```json
{
  "enabled": true,
  "testCommands": ["^make verify$", "^\\./scripts/test\\.sh"],
  "include": ["scripts/**/*.sh"],
  "exclude": ["generated/**"]
}
```

- `enabled`: set to `false` to turn the gate off for the project.
- `testCommands`: extra regular expressions, matched against each command segment.
- `include`: globs for extra files that count as code.
- `exclude`: globs for files that never count. Exclusions win over `include`.

Globs are matched against the path relative to the project root. A pattern without a slash, such as `*.gen.ts`, only matches files at the root; use `**/*.gen.ts` for any depth.

Setting `PROOF_OF_GREEN=off` in the environment disables the gate for that process.

## Known limits

- Codex does not put exit codes in its hook payloads. The gate reads them from Codex's session log (the rollout file), whose format is undocumented and may change. If the log can't be read, the stop is allowed with a note that the result could not be verified.
- Claude Code subagent stops are not gated separately. Only the main session's Stop is checked.
- The gate blocks at most once per stop attempt, so an agent that still can't get a green run can finish by reporting that.
- The gate checks that a test command passed, not that the command tests the code you changed. A narrow or irrelevant test command that exits 0 satisfies it.
- Codex hooks are experimental, and untrusted hooks are skipped without a warning. Run `doctor` after installing.
- Claude Code is expected to report a failing shell command through PostToolUseFailure; this has not yet been checked against a live install.

## Not in scope

- Running tests itself.
- LLM-judged checks.
- Enforcing test-first order.
- Agents other than Claude Code and Codex CLI.

## Prior art

| Project | What it does | Gap proof-of-green fills |
|---|---|---|
| nizos/tdd-guard | PreToolUse, LLM judges each write for TDD order | Checks edits, not the end of the turn; model call per write |
| nizos/probity | Policy engine for Claude Code, Codex, Copilot CLI | No "passing test after last edit" rule; rules written in TypeScript |
| claude-hook-gate | Runs commands from `gate.yaml` at Stop | Re-runs tests; needs config and a downloaded binary |
| claude-verify-before-stop | Trusts a "VERIFIED" line the agent writes | The agent can fake it; no exit codes |
| codhc | Re-runs one command at Codex Stop | Re-runs tests; no edit tracking |

## License

MIT
