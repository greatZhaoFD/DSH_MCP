# Install both ends from one project

本项目同时包含 Codex/MCP 客户端的 stdio 端、DSH Host 插件/UI，以及在 DSH 中注册的 `report_to_codex` 工具。它们使用同一份 checkout，不需要另外安装一份“DSH_MCP”项目。

## Requirements

- Node.js 18+ for the MCP stdio process; development tests use Node.js 24.
- A working DSH installation. The host integration targets DSH `0.2.1-rc.2` internal services; verify compatibility when upgrading DSH.
- VS Code is optional, needed only for the temporary communications viewer. Set `DSH_RELAY_VSCODE` to its executable if automatic discovery fails.

## 1. Get the source

```sh
git clone https://github.com/greatZhaoFD/dsh-mcp-relay.git
cd dsh-mcp-relay
npm test
```

Choose a stable absolute source directory. Windows examples below use `D:/plugins/dsh-mcp-relay`; replace that with your actual path on each computer.

## 2. Enable the DSH host end

Close DSH before editing its profile. In your active profile's `package.json`, merge this dependency without replacing existing entries:

```json
{
  "dependencies": {
    "dsh-mcp-relay": "link:D:/plugins/dsh-mcp-relay"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-mcp-relay"]
    }
  }
}
```

The snippet shows only the entries to merge. Keep all existing profile dependencies and bundles. Use the profile's existing pnpm/runtime to install its dependencies (`pnpm install --ignore-scripts` from the profile directory), then start DSH. Do not overwrite the profile's root `cordis.yml`; this package supplies its own bundle patch.

The bundle patch waits for `webServer`, `sessionController`, `agents`, `llm`, and `workspaceRegistry`. The host end writes a private `connection.json` under `DSH_HOME/dsh-mcp-relay`, or `~/.dsh/dsh-mcp-relay` by default. This is runtime data, not a file to commit.

## 3. Connect the Codex/MCP end

Merge the following into Codex's user configuration, replacing both paths:

```toml
[mcp_servers.dsh]
command = "node"
args = ["D:/plugins/dsh-mcp-relay/bin/dsh-mcp-relay.mjs"]
startup_timeout_sec = 60
tool_timeout_sec = 900

[mcp_servers.dsh.env]
DSH_RELAY_CONNECTION_FILE = "C:/Users/<you>/.dsh/dsh-mcp-relay/connection.json"
```

If Node.js is not on the app's PATH, set `command` to its full executable path. Other MCP clients can run the same Node.js stdio command and environment. Reconnect the MCP process after changing code or its tool definitions. Reload/restart the DSH plugin after changing host code; both running ends must use this release.

## 4. Verify without calling a model

- `npm test` runs offline unit tests and mock HTTP/MCP integration tests; it does not call a model.
- `npm pack --dry-run` lists the distributable files; it does not publish to npm.
- In the MCP client, list tools and confirm the seven tools documented in README. `dsh_models` reads the DSH model catalog; it does not run a model.
- Model execution is a separate live check: delegate a harmless task in an existing project, then inspect status and reports. `report_to_codex` is registered by the DSH host for Relay-managed sessions, not configured as an extra Codex MCP tool.

## Private state and portable customization

Do not commit connection tokens, native session logs, report mailbox files, model preferences, or personal global AGENTS/config files. Agent behavior examples in AGENT-SETUP.md are optional component-specific guidance to merge after review; each computer's personal global design is maintained separately.

See README.md / README.zh.md for the workflow and AGENT-SETUP.md for tool registration and optional agent guidance. The upstream Nigheart MIT copyright is retained in LICENSE.
