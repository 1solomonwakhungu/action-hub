# Harness Guides

How to connect Action Hub to the harnesses and editors it supports.

## What a harness is

A **harness** is the coding agent or editor that talks to Action Hub. Action Hub
ships a CLI (`ah`) with a `harness` group of commands that installs or updates
the right MCP / extension configuration for each supported harness, so agent
sessions automatically see Action Hub's tools.

Check the current list at any time:

```bash
ah harness list
```

Currently supported: `claude-code`, `claude-desktop`, `cursor`, `codex`,
`opencode`, `pi`, `vscode`. (Zed is not yet wired into the CLI — see the
notes at the end.)

---

## Claude Code

```bash
ah harness claude-code
```

This edits Claude Code's MCP config (`~/.claude.json` project-level `mcpServers`)
so Action Hub appears as an MCP server. Restart any open Claude Code session,
then run `/mcp` inside Claude Code to confirm the Action Hub server is
connected and its tools are listed.

## Claude Desktop

```bash
ah harness claude-desktop
```

Writes the Action Hub MCP server entry into Claude Desktop's
`claude_desktop_config.json`. Quit and reopen Claude Desktop fully (⌘Q, not
just closing the window), then check Settings → Developer → MCP servers.

## Cursor

```bash
ah harness cursor
```

Adds the Action Hub MCP server to Cursor's `mcp.json`
(`~/.cursor/mcp.json` or project `.cursor/mcp.json` depending on scope).
Restart Cursor or reload the window, then open
Cursor Settings → MCP to verify the server is green/enabled.

## Codex

```bash
ah harness codex
```

Configures Action Hub for OpenAI Codex CLI via Codex's MCP config
(`~/.codex/config.toml`). Restart any running Codex session so it picks up the
new server.

## VS Code

```bash
ah harness vscode
```

Installs/updates the Action Hub VS Code extension or writes the MCP server
config, depending on your Action Hub build. Reload the VS Code window
(Developer: Reload Window) afterward and check the extension/MCP panel for
Action Hub.

## OpenCode / Pi

```bash
ah harness opencode
# or
ah harness pi
```

OpenCode and Pi both read MCP-style config from their own provider directories;
the CLI writes the matching entry for each. Restart the running agent session
(a new `pi` or `opencode` process) so it discovers the Action Hub tools.

---

## Verifying the connection

From any harness, ask the agent to run a trivial Action Hub tool. From the CLI
side you can sanity-check registration with:

```bash
ah harness list
```

## Troubleshooting

- **Server not showing up** — the config file may live in a different scope
  (user vs project). Re-run the harness command and check the path it reports.
- **Stale config after moving the repo** — if Action Hub was installed from a
  path that changed, re-run the harness command to rewrite absolute paths.
- **Duplicate entries** — if you previously configured a harness by hand,
  remove the manual entry before re-running the command.

## Zed (not yet supported by `ah harness`)

Zed is not currently in the CLI's harness list, so there is no `ah harness
zed` command. You can still wire Action Hub into Zed manually by adding the
same MCP server entry the other harnesses use to Zed's `settings.json` under
`context_servers`. This is untested/unsupported by the CLI — expect to manage
it by hand until a dedicated harness command ships (see `docs/roadmap.md`).

## Using the shared daemon (recommended for multiple harnesses)

Instead of launching a separate server process per harness, run one hub daemon
and point every harness at the same endpoint:

```bash
action-hub daemon start
```

Then set the command in each harness config to:

```bash
action-hub connect
```

`connect` bridges the harness's stdio to the running daemon, so one hub serves
many harnesses without duplicate processes or duplicated auth.

## Importing your existing MCP servers

If you already have MCP servers configured in Claude Desktop, Cursor, VS Code,
or elsewhere, pull them into Action Hub once:

```bash
action-hub import --write
```

This is a one-time migration; afterwards manage everything through Action Hub.
