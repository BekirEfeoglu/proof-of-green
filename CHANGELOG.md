# Changelog

## Unreleased

- Shell commands that write a code file now count as edits, on Claude Code and Codex: `>` and `>>` redirections, `tee`, `sed -i`, `perl -i`, and PowerShell's `Set-Content`, `Add-Content` and `Out-File`. Before, an agent could change code with `sed -i` and stop without a test. Other ways of writing files through the shell are listed under Known limits.

## 0.4.0 (2026-11-01)

- `proof-of-green uninstall codex` removes the two Codex hooks that `install codex` added and the copied gate. Other hooks, the ledgers and Codex's `config.toml` are left as they are. Running it again changes nothing.
- The note for a subagent that hasn't stopped yet now says it "has not reported a stop yet" instead of "is still running". A subagent that was killed never reports a stop, so the old wording could be wrong.
- README: rewritten for first-time readers. The Uninstall section uses the new command, and Known limits now covers subagents that end without a `SubagentStop` event.

## 0.3.0 (2026-11-01)

- `proof-of-green status` shows what the gate would do right now: code files edited this turn, the test commands it recorded with their results, and a verdict. `--json` prints the same data as JSON.
- `PROOF_OF_GREEN_DEBUG=1` appends every hook payload, cut to 4096 characters, to `debug.log`.
- `doctor` checks the user and project config files and counts the valid and skipped tool entries.
- Claude Code subagents are checked when they stop, using only their own edits and test runs. A background subagent that is still running is left out of the main session's check, and the main session gets a note about it.
- `editTools` lets an MCP tool that edits files count as an edit.
- The ledger is now an append-only JSONL file, so hooks that run in parallel no longer overwrite each other's records. Ledgers from 0.2 are still read.
- `errors.log` and `debug.log` are cut to their last 32 KB once they pass 64 KB.
- Script names such as `test-e2e` and `test_unit` count as test commands.
- Fixes: MCP error results are detected more strictly, Codex tool input is accepted only as a plain object, code file paths are normalized before matching, and `status` respects a disabled gate.

## 0.2.0 (2026-11-01)

- `testTools` in `.proof-of-green.json` makes an MCP tool count as a test run, for example a tool that runs tests on a remote machine. The command in the tool's arguments goes through the same rules as a shell command, and the exit code is read from the tool's JSON response.
- A user-level `~/.proof-of-green.json` is read for every project and merged with the project's file.
- When the last test ran through an MCP tool, the block reason names that tool.
- A failing MCP command that the tool reports as an error is read as a failed test. An error result never counts as a pass.
- `node --test` counts as a test command.
- Running `install codex` again moves a 0.1 install to the new `PostToolUse` matcher. A matcher you edited by hand is left alone.
- `doctor` finds the Claude Code plugin's ledger folder, and no longer asks you to trust Codex hooks that aren't installed.

## 0.1.0 (2026-10-31)

First release.

- A Stop hook for Claude Code (as a plugin) and Codex CLI (through `install codex`). It blocks the agent's stop once when code changed and no test passed after the last change.
- Test commands are recognized for npm, pnpm, yarn, bun, vitest, jest, mocha, playwright, pytest, go, cargo, dotnet, deno, maven, gradle, make, rspec, phpunit and mix, including through `uv run`, `poetry run` and similar wrappers.
- A command after the first test command must be joined with `&&`, so a later command can't hide a failed test. Shell calls run in the background never count.
- On Codex, exit codes are read from the session log.
- `.proof-of-green.json` can turn the gate off, add test command patterns, and include or exclude files.
- `doctor` reports whether the plugin and the Codex hooks are installed and trusted.
