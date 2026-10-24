# DSH MCP Relay

[English](README.md) | [简体中文](README.zh.md) | [Local deployment](LOCAL-INSTALL.md) | [Tool registration and agent prompts](AGENT-SETUP.md)

DSH MCP Relay exposes a running DeepSeek Harness (DSH) instance to an MCP client such as Codex. It creates or continues ordinary DSH workspace conversations, lets you inspect task status, and returns agent reports through a durable mailbox.

This repository contains the independently maintained fork at `0.7.0-mailbox.1`. It is based on the upstream `Nigheart/dsh-mcp-relay` project, with local changes for ordinary workspace sessions and mailbox reporting. Installing the upstream GitHub package alone does not install these local changes.

## One project, two installed ends

| Component | Files | Installation |
| --- | --- | --- |
| Codex / MCP client end | `bin/dsh-mcp-relay.mjs`, `bin/relay-client.mjs`, `bin/surface*.mjs` | Configure an MCP stdio server using Node.js. |
| DSH host and UI end | `lib/index.js`, `lib/client.js`, `cordis.patch.yml` | Enable this same package in the DSH profile. |
| DSH-local reporting tool | `lib/reporting.js`, `lib/reporting-prompt.js` | Registered by the host for Relay-managed sessions; no separate project or manual tool copy. |

Both ends must use the same checkout/release. This repository contains plugin implementation and generic usage documentation; personal global agent rules, model preferences, credentials, and chat data belong outside it.

## How it works

The DSH plugin mounts an authenticated HTTP relay inside the running DSH Web instance. The MCP stdio process connects to that loopback endpoint. DSH conversations remain ordinary sessions in DSH workspaces, where people can open them and continue through the native composer and model picker.

For a new task, pass the current Codex project’s absolute path as `workspace`. The relay finds or creates the DSH workspace with that path, starts a conversation titled `子代理：<task name>`, and prefixes its first message with that title. To continue the same task, pass its `sessionId`; the conversation keeps its context. Use `mode: "steer"` only for a necessary clarification to an active turn. The default `queue` mode sends input after the active turn.

The relay presents **seven MCP tools**: `dsh_list_sessions`, `dsh_models`, `dsh_delegate`, `dsh_poll`, `dsh_answer`, `dsh_approval`, and `dsh_cancel`. The DSH agent receives a separate `report_to_codex` tool for messages to its coordinator; that is not an eighth Codex MCP tool.

Reports are written to `~/.dsh/dsh-mcp-relay/reports/<session-id-sha256>.json`, separately from native DSH conversation logs. A successful report call confirms durable storage only. It does not mean Codex has read or approved the report, and the agent should continue other authorized work. Reading reports does not delete them. This mailbox is not Codex’s native subagent mailbox and does not automatically wake a Codex conversation that has ended.

## Install and connect

Clone `https://github.com/greatZhaoFD/dsh-mcp-relay` into a directory of your choice (the examples use `D:\plugins\dsh-mcp-relay`). Link that same checkout into the DSH profile as a bundle and preserve its `cordis.patch.yml` dependencies and `sessionMode: workspace`. Enable or reload the plugin in the DSH plugin manager, then reconnect the Codex MCP process so it loads this release’s tools and instructions. Markdown-only updates do not require a runtime reload. See [LOCAL-INSTALL.md](LOCAL-INSTALL.md) for portable installation steps for both ends.

The plugin writes its current loopback URL and authentication token to `~/.dsh/dsh-mcp-relay/connection.json` (or `$DSH_HOME/dsh-mcp-relay/connection.json` when `DSH_HOME` is set). Keep this file private. The recommended MCP configuration points the process to that file, so it follows the current port and token:

Codex (`~/.codex/config.toml`), with paths adjusted for your machine:

```toml
[mcp_servers.dsh]
command = "node"
args = ["D:/plugins/dsh-mcp-relay/bin/dsh-mcp-relay.mjs"]
startup_timeout_sec = 60
tool_timeout_sec = 900

[mcp_servers.dsh.env]
DSH_RELAY_CONNECTION_FILE = "C:/Users/<you>/.dsh/dsh-mcp-relay/connection.json"
```

Replace `<you>` with the Windows account directory that owns the DSH home. The connection file supplies both URL and token. Alternatively, set `DSH_RELAY_URL` and `DSH_RELAY_TOKEN` explicitly; the normal endpoint is `http://127.0.0.1:3080/dsh-relay`, but the active Web profile may use a different port. The relay accepts only a loopback URL from the connection file.

The stdio server requires Node.js 18 or newer. It writes protocol messages to stdout and diagnostics to stderr.

## Delegation workflow

Create a task with an absolute workspace path and keep the returned cursors:

```json
{
  "workspace": "C:/Users/you/Documents/Codex/my-project",
  "taskName": "inspect parser edge cases",
  "instruction": "Review the parser's handling of empty input and malformed headers. Return concrete findings with file paths and line numbers."
}
```

`dsh_delegate` returns an acceptance receipt immediately by default. It includes `sessionId`, `requestId`, `baselineSeq`, and `afterMessageSeq`; acceptance means DSH accepted the request, not that the turn has started or completed. Save both cursors and continue with `dsh_poll`:

```json
{
  "sessionId": "<session-id>",
  "baselineSeq": 12,
  "afterMessageSeq": 0
}
```

Polling waits for a new report, a terminal outcome, or a human wait. It returns messages with `nextMessageSeq` and `hasMoreMessages`. After every response, use its `nextMessageSeq` as the next `afterMessageSeq`, including when continuing after a reconnect. `baselineSeq` tracks DSH turn events; `afterMessageSeq` independently tracks mailbox reports. Keeping both makes reconnects reliable. Pass `afterMessageSeq: 0` to replay stored reports. Reports are returned in pages of at most 20; drain remaining pages even after a terminal outcome. An omitted message cursor reuses the MCP process’s in-memory position, which is lost on reconnect.

The default wait is up to 600 seconds. This is a connection guard, not a task deadline: its expiry does not cancel the DSH task and is not evidence of model failure. Continue polling the same `sessionId` and `baselineSeq`. There are no periodic two-minute heartbeats. The relay checks internally every two seconds; that interval does not create model calls or status messages. `dsh_delegate({wait:true})` is also supported, but the immediate receipt followed by polling is the default workflow.

Do not resubmit just because a task is quiet or a wait window ends. If a status check fails, `unknown` means the task may still be running; retry `dsh_poll` on that session. A `pendingTool` means DSH is still handling a tool call.

## Task status

- `accepted`: DSH accepted the request; retain the receipt cursors.
- `pending`: the accepted turn has not yet been observed as started or completed.
- `running`: the turn is active. A retry phase remains active and may include retry details.
- `waiting`: the turn needs a person. Inspect `waiting.kind` and `waiting.detail`.
- `completed`: DSH explicitly ended the current turn successfully; `output` is its result.
- `failed`: DSH explicitly ended with an error; inspect `error`, `terminationReason`, retry information, and any `partialOutput`.
- `cancelled` or `interrupted`: the turn stopped without success.
- `blocked`: DSH explicitly ended blocked.
- `unknown`: the relay cannot establish a reliable outcome. Check the same session again.

The relay uses live DSH activity and turn-end evidence. Silence, an empty response, or `running: false` alone does not prove success. Errors from a single tool attempt do not necessarily mean the overall DSH turn failed.

## Reports, questions, and approvals

See [AGENT-SETUP.md](AGENT-SETUP.md) for the registration contract, file locations, and copyable English DSH/Codex `AGENTS.md` prompt templates (with Chinese setup explanations). The plugin registers tools; Markdown instructions guide model behavior and do not create tools.

DSH agents can call `report_to_codex` with `kind` set to `progress`, `finding`, `blocker`, `question`, or `reply`, plus a message (up to 4,000 characters). `replyTo` can identify the coordinator message being answered. Useful reports include a meaningful milestone, the start of long work with its handle or artifact path, a material finding, a blocker, a decision request, or a reply. Avoid repetitive status pings. A report does not pause or finish the task.

The tool is registered only for relay-owned conversations and derives the sender from the actual execution context. Newly delegated tasks and the first continuation of an older task receive the collaboration protocol once. DSH does not need access to Codex’s global `AGENTS.md`. A report with `kind: "question"` is a mailbox message, not an intercepted question-tool call; pause only work that actually needs a decision or permission. Final output still uses the ordinary DSH response and explicit turn-end status.

New tasks use takeover by default. An intercepted `user-question` can be answered with `dsh_answer`, using IDs from `waiting.detail`. If takeover is disabled, a question remains in the DSH GUI; only a person there can answer it. Intercepted questions can fall back to the GUI after about three minutes if unanswered.

An `approval` wait is already pending in DSH and requires a person in the DSH GUI, or `dsh_cancel` to abandon the active turn. `dsh_approval` configures only future approval requests: `gui` (default), `deny`, or `auto-approve` where the deployment supports it. Changing that setting does not resolve an approval already waiting.

Use the tools only when the user asks or agrees, and keep work within the user’s authorization and the DSH deployment’s sandbox and approval rules. A report or question from an agent does not expand its authority.

## Models

`dsh_models` lists the providers, model IDs, and reasoning efforts registered in the current DSH instance. An explicit `model` (and optional `provider` and `reasoningEffort`) takes priority over the conversation’s current model selection. For a new task without an explicit model, the plugin preference is used when present; otherwise the DSH instance default applies. For a continuation without an explicit model, the existing conversation selection remains in effect. The saved plugin preference only affects newly created tasks. A model choice made through DSH’s native model-selection interface also updates the instance default, so it can affect later sessions that follow that default.

Existing workspace conversations retain native DSH model controls. `dsh_list_sessions` may show the current model as a session hint. An immediate acceptance receipt from the default async `dsh_delegate` does not confirm which model was selected; check the session listing or DSH model controls if needed. `dsh_poll` reports task status and messages, not a model-selection receipt.

## Configuration

The MCP process reads these optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DSH_RELAY_CONNECTION_FILE` | unset | Read the current loopback URL and token from the plugin’s connection file. |
| `DSH_RELAY_URL` | `http://127.0.0.1:3080/dsh-relay` | Relay endpoint when no connection file is configured. |
| `DSH_RELAY_TOKEN` | empty | Authentication token when configured directly. |
| `DSH_RELAY_DEFAULT_WORKSPACE` | process working directory | Fallback for a new task without an explicit workspace; callers should pass the current project path. |
| `DSH_RELAY_POLL_MS` | `2000` | Internal delay between status checks while waiting. |
| `DSH_RELAY_CALL_TIMEOUT_MS` | `30000` | Timeout for an individual HTTP call. |
| `DSH_RELAY_SURFACE` | `lean` | `lean` serves the current surface; `full` serves a frozen legacy 0.6.0 surface for comparison and is discouraged for normal use. |

`DSH_RELAY_TIMEOUT_MS` is not used by this version. Per-call `timeoutMs` on `dsh_poll` or `dsh_delegate` controls the connection wait up to 600,000 ms; it does not change the internal HTTP call timeout or cancel the DSH task.

## Storage and limits

| Default path | Contents |
| --- | --- |
| `~/.dsh/sessions/<encoded-workspace>/<sessionId>/session.v4.jsonl.zstd` | Native DSH inputs, responses, and tool events. |
| `~/.dsh/dsh-mcp-relay/reports/<session-id-sha256>.json` | Durable reports, sequence numbers, message IDs, timestamps, and optional reply IDs. |
| `~/.dsh/dsh-mcp-relay/sessions.json` | Relay task index and legacy session-ID aliases. |
| `~/.dsh/dsh-mcp-relay/preferences.json` | Saved model preference. |
| `~/.dsh/dsh-mcp-relay/connection.json` | Current relay address and private token. |

`DSH_HOME` or a custom state directory can change these locations. Workspace association does not place chat logs in project source files. Reports stay queued until a client reads them, remain stored afterward, and have no automatic deletion policy in this version. There is no whole-project archival feature.

The relay restricts HTTP callers to loopback and authenticates requests itself; do not assume DSH’s `/api` access controls also protect this route. Workspace mode generates a token when none is configured. Keep connection files and conversation data private. A running tool remains `running`, not a human wait. Input delivery does not guarantee an immediate interruption of long reasoning or blocking tool execution. Status reads use a recent session-log page; missing terminal evidence produces `unknown` rather than guessed success. The durable report queue is paged separately.

Internal checks do not call a model. Model execution, processing tool results, and added context still consume resources; tool counts and token counts are not exact subscription-quota measurements. Use `bin/dsh-bench.mjs` for tool-surface or recorded-request inspection, not billing attribution.

## Development

Run the package test suite from the local source directory with `npm test`. The host integration was developed against DSH `0.2.1-rc.2`; test against your installed DSH version when upgrading. Unit and integration tests do not replace checking that the plugin and MCP process are both running the intended local version.

## Origin and license

This local fork originates from [Nigheart/dsh-mcp-relay](https://github.com/Nigheart/dsh-mcp-relay) and retains the upstream MIT license. See [`LICENSE`](LICENSE) for the license text.
