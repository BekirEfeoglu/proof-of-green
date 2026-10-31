# proof-of-green: tests run through MCP tools (v0.2)

Date: 2026-10-31
Status: draft, awaiting review
Builds on: `2026-10-31-proof-of-green-design.md` (v0.1)

## Problem

v0.1 counts only shell commands (Claude Code's Bash and PowerShell tools, Codex's Bash) as test runs. Some agents run tests through an MCP tool instead, for example a tool that syncs the project to a Linux server and runs a command there. The gate never sees those runs, so in such a setup it blocks once on every turn that changes code, even when the tests ran and passed.

Evidence from a real session with such a tool (`mcp__uzak_sunucu__sunucu_komut_calistir`, argument `komut` holding the shell command):

| Call | Result as Claude Code records it | Meaning |
|---|---|---|
| Command ran (exit 0 or 1) | content `[{type: "text", text: "{\"exit_code\":1,\"duration_sec\":...,\"stdout\":...,\"stderr\":...}"}]`, `is_error` false | The MCP call succeeds even when the remote test fails. Only `exit_code` inside the JSON text says pass or fail. |
| Tool error (server unreachable) | plain text, `is_error` true | No test ran. |
| A sync tool (`sunucu_projeyi_esitle`) | same JSON shape with `exit_code` | Not a test. Must not count. |

So the gate must be told which tools run tests and where the result is, and must read the result from the response body. `PostToolUseFailure` does not fire for a failed remote test.

## Goal

A user can declare an MCP tool as a test runner once, in a user-level config, and from then on a passing run through that tool satisfies the gate and a failing one blocks, in Claude Code and in Codex, with the same masking rules as shell commands.

## Non-goals

- Built-in knowledge of specific MCP servers.
- Matching tool names by regular expression.
- Checking that a remote copy of the code is up to date before the remote test (the gate cannot know; see Known limits).
- Reading results from free text with patterns like "exit code N".

## Configuration

Two optional files:

- User config: `~/.proof-of-green.json`, applies to every project.
- Project config: `.proof-of-green.json`, found as in v0.1 (walk up to the git root; with no git root, only the working directory).

New key `testTools`:

```json
{
  "testTools": [
    { "tool": "mcp__uzak_sunucu__sunucu_komut_calistir", "commandArg": "komut", "exitCodeField": "exit_code" }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `tool` | yes | Exact tool name as the agent reports it (`mcp__<server>__<tool>` in both agents). |
| `commandArg` | yes | Key in the tool input whose string value is the shell command. |
| `exitCodeField` | no, default `exit_code` | Dotted path to the exit code inside the JSON response, e.g. `result.code`. |

An entry with a missing or wrong-typed field is skipped. A broken user config file is ignored like a broken project file; nothing throws.

Merging user and project config:

| Key | Rule |
|---|---|
| `enabled` | Project value wins over user value; default true. |
| `testCommands`, `include`, `exclude` | Concatenated, user first. |
| `testTools` | Concatenated; a project entry with the same `tool` replaces the user entry. |
| `PROOF_OF_GREEN=off` | Still disables everything. |

## Reading a result

`readToolExitCode(response, field)` returns `pass`, `fail` or `unknown`:

1. Take the response text: if it is an array, the `text` of its first `{type: "text"}` block; if a string, the string itself; if an object, use it directly without parsing.
2. Parse the text as JSON. Failure gives `unknown`.
3. Follow the dotted path. Missing gives `unknown`.
4. An integer, or a string matching `^-?\d+$`, is the exit code: 0 is `pass`, anything else `fail`. Any other value gives `unknown`.

## Data flow

Claude Code:

- `hooks/hooks.json`: the `PostToolUse` matcher becomes `Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|mcp__.*`, the `PostToolUseFailure` matcher `Bash|PowerShell|mcp__.*`.
- `post-tool` for a tool listed in `testTools`: append a command record with `command = tool_input[commandArg]`, `via = tool name`, `isTest = isTestCommand(command, testPatterns)`, `result = readToolExitCode(tool_response, exitCodeField)`. A non-string command is skipped.
- `post-tool-failure` for a listed tool: append the record with `isTest: false`, because no test ran.
- MCP tools not listed are ignored.

Codex:

- `post-tool` for a listed tool: the same record, reading `tool_response` (a string) directly. No rollout lookup is needed for these records.
- `install codex` writes the PostToolUse matcher `apply_patch|Bash|mcp__.*`. When `hooks.json` already has a group whose handler is our post-tool command (a v0.1 install), the installer sets that group's matcher to the new value instead of adding a second group, and reports the event as updated. Because the hook definition changes, Codex resets trust for it once; `doctor` already reports untrusted hooks.

Policy is unchanged: the latest test record after the last code edit decides. An `unknown` latest result allows with the existing systemMessage.

Suggested command in the block reason: when the latest test record has `via`, the suggestion reads `` `npm test` (through mcp__uzak_sunucu__sunucu_komut_calistir) `` so the agent reruns it the same way.

## Edge cases

| Case | Behavior |
|---|---|
| `komut: "npm test \|\| true"` | Not a test (existing masking rules). |
| Response not JSON, or field missing | `unknown`: allow with a note. |
| Tool error (`is_error`) | Not a test run: "no test command ran". |
| Sync tool or any unlisted MCP tool | Ignored. |
| Remote copy stale (test ran before syncing the edit) | Not detected; documented as a known limit. |
| Same `tool` in user and project config | Project entry wins. |

## Testing

`node:test`, no dependencies.

- Config: merge rules, project override per `tool`, invalid entries skipped, broken user file ignored, `PROOF_OF_GREEN=off`.
- `readToolExitCode`: array, string and object responses; dotted path; `"0"`; non-JSON; missing field; non-integer.
- Claude adapter: listed tool pass and fail, masked command, `post-tool-failure`, unlisted MCP tool, suggestion naming the tool.
- Codex adapter: the same cases, without a rollout file.
- End to end: synthetic session using the real response shape above: edit, MCP test fails, stop blocks; MCP test passes, stop allows.
- Packaging: matchers include `mcp__.*`; `install codex` writes the new matcher and updates an existing v0.1 install without duplicating entries.

## Documentation and release

- README: new section "Tests that run through MCP tools" with the user-config example; known limits: remove "MCP test tools are not seen", add "the gate cannot tell whether a remote copy of the code is current".
- Fix the v0.1 spec where it is out of date: string-form hook commands, and the first-test separator rule.
- Version 0.2.0 in `package.json` and `.claude-plugin/plugin.json`.

## Open questions

None.
