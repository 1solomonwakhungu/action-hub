# Harness Guides

How to connect Action Hub to the AI harnesses and editors it supports.

Action Hub ships a Model Context Protocol (MCP) server. Every harness below
speaks MCP over stdio, so wiring one up means pointing its MCP configuration at
the bundled server script:

```
<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/copilot-plugin/server/dist/index.js
```

Auto-configuration commands are not shipped yet, so this guide uses manual
config entries — copy the snippet for your harness, substitute the absolute
path, and restart. The supported harnesses: Claude Code, Claude Desktop,
Cursor, VS Code, Codex, OpenCode, Zed, and Windsurf.

Replace `<ABSOLUTE_PATH_TO_ACTION_HUB>` with the absolute path to your checkout
(for example `/Users/me/Projects/action-hub`), and make sure the build exists:

```bash
cd <ABSOLUTE_PATH_TO_ACTION_HUB>
npm install && npm run build
```

## Claude Code

Run:

```bash
claude mcp add action-hub -- node <ABSOLUTE_PATH_TO_ACTION_HUB>/packages/copilot-plugin/server/dist/index.js
```

This writes the server into `~/.claude.json`. Restart Claude Code, then check
that the Action Hub tools appear.

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows) and add:

```json
{
  "mcpServers": {
    "action-hub": {
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/copilot-plugin/server/dist/index.js"]
    }
  }
}
```

Fully quit and reopen Claude Desktop, then check Settings → Developer for the
Action Hub server.

## Cursor

Edit `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project) and add:

```json
{
  "mcpServers": {
    "action-hub": {
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/copilot-plugin/server/dist/index.js"]
    }
  }
}
```

Restart Cursor or reload the window, then check Cursor Settings → MCP.

## VS Code

Edit `.vscode/mcp.json` in the workspace (or use
**MCP: Add Server** in the Command Palette) and add:

```json
{
  "servers": {
    "action-hub": {
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/copilot-plugin/server/dist/index.js"]
    }
  }
}
```

Reload the window, then check the MCP panel for Action Hub.

## Codex

Edit `~/.codex/config.toml` and add:

```toml
[mcp_servers.action-hub]
command = "node"
args = ["<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/copilot-plugin/server/dist/index.js"]
```

Restart any running Codex session so it picks up the new server.

## OpenCode

Edit `opencode.json` (project) or `~/.config/opencode/opencode.json` (global)
and add:

```json
{
  "mcp": {
    "action-hub": {
      "type": "local",
      "command": ["node", "<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/copilot-plugin/server/dist/index.js"],
      "enabled": true
    }
  }
}
```

Note OpenCode takes `command` as a single argv array. Restart the OpenCode
session so it discovers the Action Hub tools.

## Zed

Edit Zed's `settings.json` and add:

```json
{
  "context_servers": {
    "action-hub": {
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/copilot-plugin/server/dist/index.js"]
    }
  }
}
```

Restart Zed, then check the Agent Panel settings for the Action Hub server.

## Windsurf

Edit `~/.codeium/windsurf/mcp_config.json` and add:

```json
{
  "mcpServers": {
    "action-hub": {
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/copilot-plugin/server/dist/index.js"]
    }
  }
}
```

Restart Windsurf or reload the window, then check the MCP servers panel.

## Verifying the setup

From the checkout, run:

```bash
node <ABSOLUTE_PATH_TO_ACTION_HUB>/packages/cli/dist/index.js doctor
```

This reports whether the CLI config, catalog, and discovered servers are
healthy.

## Skills

Action Hub indexes skills the same way it indexes tools. Drop skill folders —
each containing a `SKILL.md` — into:

```
~/.action-hub/skills/
```

(or a directory of your choice exported as `ACTION_HUB_SKILLS_DIR`). The hub
scans that directory and adds every skill it finds to the catalog, so the same
skills appear in every harness connected to the hub — no per-harness installs.

## Using the shared daemon

Running one server process per harness duplicates the catalog and every
activated downstream MCP process. The shared daemon avoids that: one
background hub, many harnesses bridged over stdio.

If the CLI is on your `PATH` (for example, installed via npm):

```bash
action-hub daemon start
```

Then set the command in each harness config to `action-hub connect`:

```json
{
  "command": "action-hub",
  "args": ["connect"]
}
```

If the CLI is *not* on your `PATH`, use the portable form instead — it works in
any harness from any machine with the checkout:

```json
{
  "command": "node",
  "args": [
    "<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/cli/dist/index.js",
    "connect"
  ]
}
```

`connect` bridges the harness's stdio to the running daemon over an
authenticated local socket. Each connection gets its own MCP session; the
catalog, connection pool, and auth are shared process-wide.

## Importing your existing MCP servers

If you already have MCP servers configured in Claude Desktop, Cursor, VS Code,
or elsewhere, pull them into Action Hub once:

```bash
action-hub import --write
```

(or `node <ABSOLUTE_PATH_TO_ACTION_HUB>/packages/cli/dist/index.js import --write`
if the CLI is not on your `PATH`). This writes the discovered servers and
skills into the Action Hub config; afterwards everything is served through the
hub.
