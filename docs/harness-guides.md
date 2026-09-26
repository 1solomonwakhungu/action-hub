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

## Automatic setup

As of the `harness` command, most harnesses can be configured for you. The
exact grammar (from `action-hub harness --help`):

```
action-hub harness <target> [export|install]

Targets:
  claude-code      Claude Code
  claude-desktop   Claude Desktop
  cursor           Cursor
  codex            Codex CLI
  opencode         OpenCode
  vscode           VS Code

Modes:
  export          Print the config snippet (default).
  install         Write the snippet into the harness config file.
                  Requires --write as a safety guard.

Options:
  --write         Required for install mode; confirms in-place writes.
  --config <path> Point the harness at a specific Action Hub config file
                  (exported as ACTION_HUB_CONFIG in the snippet).
  --json          (export) Print only the JSON document, no commentary.
```

`export` prints the snippet for you to paste; `install` writes it into the
harness config file and requires `--write`. Before touching a config,
`install` writes a timestamped `.bak` copy of the file (e.g.
`mcp.json.bak-20260926T090000Z`), so the original is always recoverable.

```bash
action-hub harness claude-code                 # print the Claude Code snippet
action-hub harness claude-code install --write
action-hub harness codex install --write --config ~/.config/action-hub/servers.json
```

The supported targets are `claude-code`, `claude-desktop`, `cursor`, `codex`,
`opencode`, and `vscode`. Pi is not supported by the harness command; Zed and
Windsurf are covered by the manual snippets below, which remain the fallback
for every harness. If the CLI is not on your `PATH`, run the same commands via
`node <ABSOLUTE_PATH_TO_ACTION_HUB>/packages/cli/dist/index.js harness ...`.

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

## Migrating your existing MCP servers and skills

If you already have MCP servers and skills configured in Claude Desktop,
Cursor, VS Code, or elsewhere, pull them into Action Hub once. Preview first
(without `--write`) to see what would change:

```bash
action-hub migrate --type all
```

Then write the result:

```bash
action-hub migrate --type all --write
```

(Use `node <ABSOLUTE_PATH_TO_ACTION_HUB>/packages/cli/dist/index.js migrate --type all --write`
if the CLI is not on your `PATH`.) The migration engine discovers MCP servers,
skills, and plugins from your local agent configurations and merges them into
the Action Hub config, preserving entries that are already there.

For a servers-only pass, `action-hub import` previews MCP servers discovered
from your local agent configurations, and `action-hub import --write` writes
them. Since the raw-config fix, `--write` preserves everything already in the
config (existing entries win, unknown top-level settings survive, and the
write is atomic with `0600` permissions; it fails closed on a malformed
config). It does not bring in skills, so use `migrate --type all --write`
when you want servers *and* skills written.
