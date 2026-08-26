---
name: action-hub
description: >-
  Find and run capabilities from any connected MCP server or installed skill
  through a single indexed tool. Use when a task needs an integration that is
  not already among the visible tools — GitHub, Linear, Slack, AWS, Jira,
  databases, internal services — or when you are unsure whether a capability
  exists at all. Search first, then load, then execute.
user-invocable: false
---

# Action Hub

Action Hub is a meta-MCP server. It sits in front of every configured MCP
server and installed skill, indexes them, and exposes one tool: `action_hub`.

The catalog may hold tens of thousands of actions. None of their schemas are in
your context. You retrieve what you need, when you need it.

## The loop

Always follow the same three steps. Do not skip ahead.

### 1. Search

```json
{ "operation": "search", "query": "open a pull request" }
```

Returns ranked candidates as `id`, `name`, `serverId`, and a one-line summary.
**Search never returns argument schemas** — that is deliberate, and it is why
the catalog is affordable.

Write the query the way you would describe the task to a colleague. Natural
phrasing ranks better than a guessed tool name, because summaries and
descriptions are indexed alongside names.

Narrow when you already know the source:

```json
{ "operation": "search", "query": "assign issue", "server_id": "linear", "limit": 5 }
```

### 2. Load

```json
{ "operation": "load", "action_id": "github:create_pull_request" }
```

Returns the full description and the verbatim upstream JSON Schema. Read the
schema before constructing arguments. Never guess argument names from the
action name — load is cheap and guessing wastes a round trip.

For an action of kind `skill`, load returns its instructions. Skills are
loaded, never executed.

### 3. Execute

```json
{
  "operation": "execute",
  "action_id": "github:create_pull_request",
  "arguments": { "title": "Fix retry backoff", "base": "main" }
}
```

Arguments are validated against the loaded schema before dispatch, so an
invalid call fails locally and never reaches the downstream server.

## Approval: when execute does not execute

Actions from servers below the auto-approve trust floor are **gated**. The hub
does not run them. Instead the call returns:

```json
{
  "ok": false,
  "status": "approval_required",
  "action_id": "slack:post_message",
  "server": "slack",
  "name": "post_message",
  "trust": "untrusted",
  "reason": "Server \"slack\" is untrusted",
  "arguments_summary": "channel=\"#general\", text=\"Deploy finished\"",
  "approval_token": "…",
  "expires_in_seconds": 300,
  "executed": false
}
```

`executed: false` is literal. Nothing happened downstream.

**Step 1 — ask the user.** Show them the server, the action, and
`arguments_summary`, and ask whether to proceed. State plainly that the server
is untrusted. Do not paraphrase away the risk, and do not decide for them.

**Step 2 — only if they agree**, repeat the *identical* execute call with the
token added:

```json
{
  "operation": "execute",
  "action_id": "slack:post_message",
  "arguments": { "channel": "#general", "text": "Deploy finished" },
  "approval_token": "…"
}
```

The token is:

- **Single-use.** A second execution needs a second approval.
- **Bound to these exact arguments.** Change any value and it is rejected. You
  cannot approve a small call and then send a large one.
- **Bound to this action.** It authorizes nothing else.
- **Short-lived.** It expires in minutes. If it has expired, execute again
  without a token to get a fresh one, and ask the user again.

Approval never overrides a denial. If a server is disabled, an action is
`blocked`, or a tool is on a deny-list, the call fails outright and no token is
issued. Do not look for a workaround — report it to the user.

**Never invent, reuse, guess, or carry over a token, and never send one the
user has not explicitly approved.** Doing so defeats the only thing standing
between an untrusted server and a real side effect.

## Rules

- **Search before you assume.** If a capability might exist, search for it. An
  empty result is a real answer and is cheaper than a wrong assumption.
- **Load before you execute.** Executing an action you have not loaded in this
  conversation is an error waiting to happen.
- **One action per execute call.** Chain them yourself; read each result before
  choosing the next.
- **Prefer a direct tool when one is already visible.** Action Hub is for
  reaching what is *not* already in front of you, not for re-routing tools you
  already have.
- **Re-search after a failure.** A validation error usually means the wrong
  action was chosen, not that the arguments need another guess.
- **Never self-approve.** A gated action needs a human answer, every time.

## Handling results

`execute` returns `{ ok, content, error, duration_ms }`, or an
`approval_required` envelope. On `ok: false`, read the response before retrying:

| Response | What it means | What to do |
| --- | --- | --- |
| `Unknown action` | The id is wrong or stale | Search again |
| `Invalid arguments` | Payload failed schema validation | Re-read the loaded schema |
| `status: approval_required` | Gated; nothing ran | Ask the user, then resend with `approval_token` |
| `Approval rejected: … expired` | Token timed out | Execute without a token, ask again |
| `Approval rejected: … different arguments` | Arguments changed after approval | Ask again for the new arguments |
| `is blocked by policy` | Trust tier is `blocked` | Stop. No token exists for this |
| `excluded by the allow/deny list` | Explicitly denied | Stop. Approval cannot override a deny |
| `Server "x" is disabled` | Turned off in the capability manager | Tell the user |

## Managing servers

Ask the user to open the **Capability Manager** canvas to add servers, inspect
health and authentication, review invocation history, or change trust levels.
Do not attempt to edit the configuration file yourself.
