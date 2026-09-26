# Harness Guides

How to connect Action Hub to the coding agents and editors it supports.

Two ways to run Action Hub against a harness:

- **Shared daemon (recommended)** — start one hub, then point every harness at
  the same connection. One hub serves many harnesses at once. See
  [Shared daemon setup](#shared-daemon-setup).
- **Per-harness config** — add the Action Hub MCP server directly to each
  harness's config file. See the sections below.

In both cases the harness talks to the same MCP server entry point:

```
<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/copilot-plugin/server/dist/index.js
```

Replace `<ABSOLUTE_PATH_TO_ACTION_HUB>` with the absolute path of your Action
Hub checkout (for example `/Users/me/Projects/action-hub`). Absolute paths are
required — harnesses launch MCP servers from their own working directory.

---

## Shared daemon setup

The daemon is a single long-running hub process that many harnesses can share.

```bash
# 1. Start the hub in the background
action-hub daemon start

# 2. Connect each harness to it
action-hub connect
```

After `daemon start`, run `action-hub connect` — that is the command each
harness session uses to join the shared hub. Because one daemon serves many
harnesses, you only configure the connection once per harness and every session
sees the same tools.

---

## Claude Code

Config file: `~/.claude.json` (the project-level `mcpServers` object; the CLI
also manages this via `claude mcp add`).

```json
{
  "mcpServers": {
    "action-hub": {
      "command": "node",
      "args": [
        "<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/copilot-plugin/server/dist/index.js"
      ]
    }
  }
}
```

Restart any open Claude Code session, then run `/mcp` inside Claude Code to
confirm the Action Hub server is connected.

## Claude Desktop

Config file (macOS): `~/Library/Application Support/Claude/claude_desktop_config.json`
(Linux: `~/.config/Claude/claude_desktop_config.json`).

```json
{
  "mcpServers": {
    "action-hub": {
      "command": "node",
      "args": [
        "<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/copilot-plugin/server/dist/index.js"
      ]
    }
  }
}
```

Quit and reopen Claude Desktop fully (⌘Q, not just closing the window), then
check Settings → Developer → MCP servers.

## Cursor

Config file: `~/.cursor/mcp.json` (user scope) or `.cursor/mcp.json`
(project scope).

```json
{
  "mcpServers": {
    "action-hub": {
      "command": "node",
      "args": [
        "<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/copilot-plugin/server/dist/index.js"
      ]
    }
  }
}
```

Restart Cursor or reload the window, then open Cursor Settings → MCP to verify
the server is enabled.

## VS Code

Config file: `.vscode/mcp.json` (project scope) or
`~/Library/Application Support/Code/User/mcp.json` (user scope, macOS).

```json
{
  "servers": {
    "action-hub": {
      "command": "node",
      "args": [
        "<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/copilot-plugin/server/dist/index.js"
      ]
    }
  }
}
```

Reload the VS Code window (Developer: Reload Window) and check the MCP panel
for Action Hub.

## Codex

Config file: `~/.codex/config.toml`.

```toml
[mcp_servers.action-hub]
command = "node"
args = [
  "<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/copilot-plugin/server/dist/index.js"
]
```

Restart any running Codex session so it picks up the new server.

## OpenCode / Pi

OpenCode config file: `~/.config/opencode/opencode.json`.

```json
{
  "mcp": {
    "action-hub": {
      "type": "local",
      "command": [
        "node",
        "<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/copilot-plugin/server/dist/index.js"
      ]
    }
  }
}
```

Pi reads the same style of MCP server config from its provider config
(`~/.config/pi/config.json`); add the equivalent entry with the same
`command`/`args` pair above. Restart the running agent session (a new `pi` or
`opencode` process) so it discovers the Action Hub tools.

## Zed

Config file: `~/.zed/settings.json` (add to the top-level object).

```json
{
  "context_servers": {
    "action-hub": {
      "source": "custom",
      "command": "node",
      "args": [
        "<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/copilot-plugin/server/dist/index.js"
      ]
    }
  }
}
```

Zed applies settings changes immediately; open the context servers panel to
verify the Action Hub server starts.

## Windsurf

Config file (macOS): `~/.codeium/windsurf/mcp_config.json`
(Linux: `~/.codeium/windsurf/mcp_config.json`).

```json
{
  "mcpServers": {
    "action-hub": {
      "command": "node",
      "args": [
        "<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/copilot-plugin/server/dist/index.js"
      ]
    }
  }
}
```

Restart Windsurf or reload the window, then check the MCP servers panel for
Action Hub.

---

## Importing existing MCP servers

If you already use other MCP servers in a harness, you can pull them into
Action Hub once instead of re-adding them everywhere:

```bash
action-hub import --write
```

`import` reads your existing harness configs and copies their MCP server
entries into Action Hub. The `--write` flag persists the result; without it the
import only previews what would be imported.

---

## Verifying the connection

From any harness, ask the agent to run a trivial Action Hub tool. From the CLI
side you can sanity-check registration with:

```bash
action-hub doctor
```

`doctor` validates your configuration and checks connectivity to each
registered server.

## Troubleshooting

- **Server not showing up** — the config file may live in a different scope
  (user vs project). Check the exact path for your harness above.
- **Server fails to start** — run
  `node <ABSOLUTE_PATH_TO_ACTION_HUB>/packages/copilot-plugin/server/dist/index.js`
  by hand to see the error, and confirm the file exists (`npm install &&
  npm run build` in the repo if it doesn't).
- **Stale config after moving the repo** — the snippets use absolute paths, so
  update them after moving or renaming the checkout.
- **Duplicate entries** — remove any older manual entry before adding the
  config above.
