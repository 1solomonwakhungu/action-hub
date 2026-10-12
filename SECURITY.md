# Security policy

## Supported versions

Action Hub has not published a release yet; all workspaces are at `0.1.0` and
the only supported code is the `main` branch. Once a `v*` tag exists, the
latest tagged release and `main` will be supported. Pre-release commits are
not patched retroactively.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub Security Advisories on this repository:
**Security → Advisories → Report a vulnerability**
(<https://github.com/1solomonwakhungu/action-hub/security/advisories/new>).
That creates a private thread with the maintainer where the report, the fix,
and the disclosure timing can be worked out.

Include what you can of:

- the commit or build you tested (`action-hub --version`, or the `git rev-parse HEAD` of your checkout)
- the transport involved (stdio `start`, HTTP `serve`, or the daemon / `connect`)
- a minimal reproduction: config file, downstream server behaviour, and the `action_hub` calls made
- the impact you believe it has

You should get an acknowledgement within a few days. There is no bug bounty.

## What is in scope

Action Hub sits between an AI agent and every MCP server it can reach, so the
security-relevant surface is the set of boundaries it enforces. Reports about
any of the following are in scope:

- **Approval tokens** (`packages/core/src/permissions/approvals.ts`): a way to
  execute a gated action without a valid token, reuse a single-use token,
  replay a token against different arguments, bypass the deny-before-token
  ordering, or obtain a token for a denied action.
- **Permission policy** (`packages/core/src/permissions/policy.ts`): reaching
  a `blocked` server, a disabled server, or a deny-listed tool through any
  path (`execute`, bundles, cached results, skills).
- **Daemon socket authentication** (`packages/plugin/server/src/daemon.ts`,
  `packages/cli/src/commands/daemon.ts`): connecting to the shared daemon
  without presenting its token, reading the token or state files as another
  user, binding the Windows loopback port from another user, or defeating the
  symlink / ownership / mode checks on the runtime directory.
- **HTTP serve bearer token** (`packages/plugin/server/src/http-server.ts`):
  reaching `/mcp` without the token, or any non-loopback bind.
- **Token storage** (`packages/core/src/auth/`): OAuth access or refresh tokens
  written anywhere other than the `0600` credential store, appearing in logs,
  errors, the catalog cache, the diagnostics snapshot, or a tool result;
  rotation or refresh races that leak or revoke a grant; a token sent to a
  host other than the configured one.
- **Secret redaction** (`packages/core/src/redact.ts`, config `${ENV_VAR}`
  expansion): configured secrets or `Authorization` headers echoed back
  through `doctor`, `list`, snapshots, or MCP responses.
- **Argument validation and schema passthrough**: a way for a crafted
  downstream schema or tool description to make the hub mis-validate,
  reinterpret arguments, or inject content past the output-hardening caps
  (`packages/plugin/server/src/output-hardening.ts`).
- **Isolation of spawned processes**: the hub or CLI writing outside the
  user's own config, cache, state, or credential locations, or a test or
  stress script touching real user state despite `test-isolation.mjs`.
- **Supply chain of the standalone binary**: the vendored model or runtime
  under `packages/core/vendor/` differing from the pinned provenance in
  `VENDOR.md`, or `SHA256SUMS.txt` not matching a published artifact.

## What is out of scope

- Vulnerabilities in downstream MCP servers themselves, or in the AI harness
  that hosts Action Hub. Report those upstream; if Action Hub makes an
  upstream problem worse, that part is in scope.
- A model being talked into calling a tool it was allowed to call. The trust
  tiers, deny lists, and approval gate are the controls for that; a report is
  in scope only if those controls can be bypassed.
- Denial of service that requires the attacker to already control the user's
  config file or environment.
- Findings from running the stress suite against a real configuration. The
  suite documents that it must run fully isolated.

## Design notes that may save you a report

- `execute` evaluates deny rules before it reads or mints any approval token,
  so there is no denied-but-approvable state.
- Approval tokens are bound to a SHA-256 of the canonicalized arguments and
  expire after five minutes by default (configurable up to one hour).
- The daemon token is 256 random bits, compared in constant time, stored
  `0600` in a `0700` directory; readers reject symlinks and files owned by
  another user or with group/world bits.
- The catalog cache hashes env and header *keys*, never their values, so no
  secret ends up in an on-disk digest.
- OAuth token-endpoint error bodies are reduced to `error` and
  `error_description` before rendering, then scrubbed of configured secrets.

See `docs/architecture.md` (sections Permissions, Approval, Remote
authentication, Shared daemon transport) for the full reasoning.
