# MCP reference

Use this reference for MCP command syntax, transports, configuration,
resources, tools, prompts, subscriptions, authentication, and authorization.
For client setup, see the [MCP guide](../guides/mcp.md).

ActiveFS exposes MCP through three entrypoints:

- `activefs mcp`, the integrated CLI command that reads normal ActiveFS state.
- `activefs-mcp`, the standalone binary from `@activefs/mcp`.
- `createMCPAdapter`, the lower-level resource adapter for embedded hosts.

`@activefs/mcp` uses `@modelcontextprotocol/sdk` `1.29.0`. The server's current
protocol version is `2025-11-25`; it accepts the SDK-supported protocol versions.
The implemented transports are stdio and Streamable HTTP. Legacy HTTP+SSE is
not implemented.

## Integrated CLI commands

```bash
activefs mcp [remote] [start|inspect|status|stop|config claude|codex|generic] [options]
```

| Command | Behavior |
|---|---|
| `activefs mcp` | Starts stdio for every configured remote. |
| `activefs mcp <remote> start` | Starts stdio for one remote. `start` is the default action. |
| `activefs mcp <remote> inspect` | Validates configuration and prints a redacted server plan without starting a server. |
| `activefs mcp <remote> status` | Reads and probes recorded managed HTTP runtime state. |
| `activefs mcp <remote> stop` | Stops a recorded managed HTTP process when one exists. |
| `activefs mcp <remote> config claude` | Prints a Claude Desktop stdio JSON snippet. |
| `activefs mcp <remote> config codex` | Prints a Codex `config.toml` stdio snippet. |
| `activefs mcp <remote> config generic` | Prints a generic stdio command descriptor. |

Without `<remote>`, `inspect`, `status`, `stop`, and `config` target all loaded
remotes. These options apply to integrated start or inspect commands:

| Option | Meaning |
|---|---|
| `--state-root <dir>` | ActiveFS state root; defaults to `.activefs` or a discovered parent. |
| `--root <dir>` | Alias for `--state-root`. |
| `--workspace <dir>` | Compatibility alias for `--state-root`. |
| `--config <path>` | Explicit `activefs-mcp.config.json`. |
| `--demo` | Deterministic in-memory MCP fixture. |
| `--transport stdio\|http` | Transport override; the default is stdio. |
| `--http` | Alias for `--transport http`. |

## Standalone CLI options

```bash
activefs-mcp [options]
```

The standalone binary accepts the same state, config, demo, transport, and HTTP
options. It also provides:

| Option | Meaning |
|---|---|
| `--dry-run` | Validates config and prints the redacted server plan. |
| `--print-config-schema` | Prints the draft-7 JSON Schema for the config file. |
| `--version`, `-v` | Prints the package version. |
| `--help`, `-h` | Prints standalone help. |

## Transport details

Stdio writes MCP JSON-RPC frames to stdout and uses the local identity supplied
by the launching process. It does not create a managed runtime record.

Streamable HTTP uses these options:

| Option | Default or behavior |
|---|---|
| `--host <host>` | `127.0.0.1`. Non-loopback binds require `--allow-network-bind`. |
| `--port <port>` | `8765`; `0` requests an ephemeral port. |
| `--endpoint <path>` | `/mcp`; a missing leading slash is added. |
| `--auth bearer\|none` | Bearer by default. `none` is allowed on trusted loopback. |
| `--token env:NAME\|VALUE` | Reads a bearer token from an environment variable or literal value. |
| `--allow-origin <origin>` | Replaces the accepted Origin list; repeatable. |
| `--allow-host <host>` | Replaces the accepted Host-header list; repeatable. |
| `--allow-network-bind` | Permits a non-loopback bind. |
| `--allow-insecure-http` | Permits `--auth none` outside loopback; it does not by itself permit the bind. |

Bearer mode generates a random process-local token when none is configured.
Reusable client configuration should use `--token env:NAME`. Host validation is
always enforced. A literal `--token VALUE` may appear in shell history or
process listings; use it only as a disposable loopback-development token.
Origin validation is enforced when the request has an Origin header.

New Streamable HTTP sessions must begin with an MCP initialize request. Later
`GET`, `POST`, and `DELETE` requests use the issued `Mcp-Session-Id`; other HTTP
methods return `405`.

## State and runtime files

The integrated command loads the same configured remotes and auth providers as
the rest of the CLI. A foreground Streamable HTTP start records each selected
remote in:

```txt
.activefs/remotes/<remote>/runtime/mcp.json
```

`status` reconciles the recorded PID and probes the HTTP URL. A `401` response
still counts as reachable because the protected endpoint responded. `stop`
uses the recorded PID. Stdio lifecycle remains owned by the launching MCP
client and is not represented by this file.

## Configuration file

The config schema has `schemaVersion: 1`. Unspecified groups use these defaults:

| Field | Default or contract |
|---|---|
| `name` | `activefs-mcp` |
| `version` | `0.1.1` |
| `workspace` | Optional ActiveFS state root. |
| `remotes` | Optional explicit Source API remotes; otherwise workspace remotes are loaded. |
| `resources` | Directories included, depth `8`, at most `1000` resources, page size `100`. |
| `tools` | `list`, `stat`, `read`, and `grep` enabled; mutation and export tools disabled. |
| `prompts.enabled` | `true` |
| `subscriptions` | Enabled with `debounceMs: 25`. Advertising still requires a watchable remote. |
| `auth` | `mode: "stdio"`, with network and insecure HTTP overrides disabled. |
| `authorization.default` | `allow` |

The `auth` object accepts `mode`, `tokenEnv`, `token`, `allowedOrigins`,
`allowedHosts`, `allowInsecureHttp`, and `allowNetworkBind`. CLI HTTP options
override their corresponding config values for that process.

An explicit remote accepts:

| Field | Contract |
|---|---|
| `name` | Required; letters, digits, dots, underscores, and dashes, beginning with a letter or digit. |
| `url` | Required Source API discovery URL. |
| `rootPath` | Source-relative root exposed by MCP; defaults to `/`. |
| `title` | Optional display title. |
| `watchable` | Optional explicit watch capability. |
| `allowInsecureHttp` | Permits a non-loopback `http://` Source API URL for this remote. |
| `auth.type` | `none` or `bearer-env`; defaults to `none`. |
| `auth.env` | Environment variable for `bearer-env`. |
| `auth.scheme` | Authorization scheme; defaults to `Bearer`. |

Example:

```json
{
  "schemaVersion": 1,
  "name": "activefs-mcp",
  "workspace": ".activefs",
  "remotes": [
    {
      "name": "docs",
      "url": "http://127.0.0.1:3999/_activefs/",
      "rootPath": "/",
      "title": "Docs",
      "watchable": true
    }
  ],
  "resources": {
    "includeDirectories": true,
    "maxDepth": 8,
    "maxResources": 1000,
    "pageSize": 100
  },
  "tools": {
    "list": true,
    "stat": true,
    "read": true,
    "grep": true,
    "write": false,
    "mkdir": false,
    "rm": false,
    "mv": false,
    "cp": false,
    "export": false
  },
  "prompts": {
    "enabled": true
  },
  "subscriptions": {
    "enabled": true,
    "debounceMs": 25
  },
  "authorization": {
    "default": "allow"
  }
}
```

Explicit remote discovery uses HTTPS by default. Loopback HTTP is accepted for
local development. Set `allowInsecureHttp: true` for an intentional
non-loopback HTTP remote. Workspace remotes reuse their persisted development
override and configured auth provider.

## Resources

Resource URIs use:

```txt
activefs://<remote>/<path>
```

`resources/list` traverses enumerable entries up to `maxDepth` and
`maxResources`. It includes directories when `includeDirectories` is true and
paginates the resulting descriptors by `pageSize` using MCP cursors.

`resources/read` maps the URI back through the remote's configured `rootPath`
and calls ActiveFS `read`. String content is returned as `text`; byte content is
returned as a base64 `blob`. A direct read can address an authorized path that
was not enumerated by `resources/list`.

Resource templates use:

```txt
activefs://<remote>/{path}
```

Templates describe dynamic paths supplied by configuration or an embedded
host. They neither enumerate concrete files nor grant authorization.

## Tools

This table is exhaustive for the current tool set:

| Tool | Default | Inputs and defaults |
|---|---:|---|
| `activefs_list` | on | `remote?`, `path: "/"`, `limit: 100` (`1..1000`), `cursor?`, `includeNonEnumerable: false` |
| `activefs_stat` | on | `remote?` and either `path` or `uri` |
| `activefs_read` | on | `remote?`, either `path` or `uri`, `encoding?: utf8\|base64\|binary`, `offset?`, `length?` |
| `activefs_grep` | on | `query`, `remote?`, `path: "/"`, `caseSensitive: false`, `limit: 100` (`1..1000`), `includeNonEnumerable: false` |
| `activefs_write` | off | `remote?`, either `path` or `uri`, either `text` or base64 `blob`, `mimeType?`, `create: true`, `overwrite: true`, `idempotencyKey?` |
| `activefs_mkdir` | off | `path`, `remote?`, `recursive: true`, `idempotencyKey?` |
| `activefs_rm` | off | `remote?`, either `path` or `uri`, `recursive: false`, `idempotencyKey?` |
| `activefs_mv` | off | `remote?`, either `fromPath` or `fromUri`, required `toPath`, `overwrite: false`, `idempotencyKey?` |
| `activefs_cp` | off | `remote?`, either `fromPath` or `fromUri`, required `toPath`, `overwrite: false`, `recursive: false`, `idempotencyKey?` |
| `activefs_export` | off | `remote?`, `path: "/"`, `maxFiles: 1000` (`1..10000`) |

`activefs_grep` reports `strategy`, `complete`, and optional
`incompleteReasons`. Mutation tools call the authoritative ActiveFS operation;
there is no offline write queue. Move and copy stay within one remote.

`activefs_export` returns a bounded manifest of readable `activefs://` links for
client-side export. It does not write host files. Tool failures return an MCP
tool result with `isError: true`.

## Prompts

The current provider-neutral prompts are:

- `activefs_browse_remote`
- `activefs_summarize_tree`
- `activefs_investigate_path`
- `activefs_search_then_read`

Each accepts optional `remote`, `path`, and `query` arguments; `path` defaults
to `/`. `prompts.enabled: false` removes the prompts capability and handlers.

## Subscriptions

The server advertises resource subscriptions only when subscriptions are
enabled and at least one selected remote has `watchable: true`. It then handles
`resources/subscribe` and `resources/unsubscribe` and emits:

- `notifications/resources/updated`
- `notifications/resources/list_changed`

Each subscription uses recursive ActiveFS `watch`. Notifications are debounced
by `subscriptions.debounceMs`. A non-watchable remote or unauthorized path
fails closed.

Workspace discovery records `watchable` from a Source API handshake. Offline
configuration may set it explicitly with `activefs remote add --watchable` or
`--no-watchable`. Programmatic hosts should set it only when the backing tree is
known to implement watch.

## Authentication and authorization

Stdio uses a local process identity. Streamable HTTP uses bearer authentication
by default, plus Host validation and Origin validation when an Origin is
present. The MCP identity is mapped into opaque ActiveFS auth context; raw
tokens are not added to resource metadata.

Authorization applies independently of tool enablement. The config policy can
set a default, remote operation decisions, ordered exact or prefix path rules,
tool decisions, and prompt decisions:

```json
{
  "authorization": {
    "default": "deny",
    "remotes": {
      "repo": {
        "read": false,
        "search": false,
        "write": false,
        "subscribe": false,
        "prompts": true,
        "paths": [
          {
            "match": "prefix",
            "path": "/public",
            "read": true,
            "search": true,
            "subscribe": true
          }
        ]
      }
    },
    "tools": {
      "activefs_write": false
    },
    "prompts": {
      "activefs_search_then_read": false
    }
  }
}
```

Path rules are evaluated in array order. The first path match is selected; its
decision wins when it defines the requested operation. If it does not, policy
falls back to the remote decision and then the global default without consulting
later path rules. Tool and prompt maps are deny overrides: `false` blocks the
named item, while `true` does not grant access that the remote or global policy
denies. Config policy and programmatic policy hooks are combined so every policy
must allow the operation. Checks run before resource access, search, tool
execution, prompt expansion, and subscription.

## Source API remote fixture

[examples/mcp-source-remote](../../examples/mcp-source-remote/README.md) is the
reference fixture for a configured Source API remote exposed through MCP. It
covers `resources/list`, `resources/read`, and `tools/call` with
`activefs_grep`. Repository prerequisites are in the
[source-checkout setup](../../examples/README.md#install-and-build-once).

## Embedded adapter

Embedded hosts can use the resource adapter directly:

```js
import { createMCPAdapter } from "@activefs/mcp";

const adapter = createMCPAdapter({
  filesystem,
  remotes: [{ name: "repo", rootPath: "/repo" }],
  resourceTemplates: [
    {
      uriTemplate: "activefs://repo/users/{id}/profile.md",
      name: "User profile",
      mimeType: "text/markdown"
    }
  ]
});

await adapter.listResources();
await adapter.readResource("activefs://repo/context.md");
await adapter.grep({ remote: "repo", path: "/", query: "TODO", limit: 20 });
```

The adapter exposes list, read, template, and grep methods. It is read-oriented
and does not define path semantics; the supplied filesystem and trees do. Hosts
that need the full MCP server, tools, prompts, subscriptions, or protocol
transports should use `createActiveFSMCPServer` or the packaged entrypoints.

## Current non-goals

- Legacy HTTP+SSE transport.
- A public remote OAuth authorization-server flow.
- Host-filesystem writes from the MCP export tool.
