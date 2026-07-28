# CLI reference

Use this page for exact `activefs` command syntax and behavior. For a runnable
first use, see the [Quickstart](../quickstart.md). For ordinary shell commands
against a mounted folder, see the [Mounted folder guide](../guides/mounted-folder.md).

## Command shape

```bash
activefs <command> [arguments] [options]
```

Commands that load ActiveFS state discover a parent `.activefs/` directory by
default. `--state-root <dir>` selects the state root explicitly. `--root` is an
alias, and `--workspace` is a compatibility alias.

Direct operations read configured remotes from `.activefs/config.json` unless
one or more `--source <spec>` values are supplied. They fail when no source is
available; they never substitute demo data. `--source example` selects the
explicit in-memory fixture. Local and HTTP source specifications use
`local=/path`, `local:/mount=/path`, or `http:/mount=http://host:port/`.

## Command index

| Command group | Purpose |
|---|---|
| `list`, `read`, `stat`, and command-aware aliases | Access ActiveFS paths directly. |
| `tui` | Open the interactive developer/operator interface. |
| `remote` | Add, list, inspect, and remove Source API remotes. |
| `auth` | Configure host-managed credentials for a remote. |
| `status` | Summarize configured remote and local runtime state. |
| `mcp` | Start, inspect, configure, or stop the MCP access adapter. |
| `export` | Copy ActiveFS bytes to host files with a manifest. |
| `server` | Start, inspect, or stop the local WebDAV mount server. |
| `mount`, `unmount`, and `remount` | Manage visible OS folders. |
| `sync` | Inspect or control mounted freshness. |
| `refresh` and `cache` | Run support-level cache and adapter operations. |
| `logs` and `doctor` | Inspect diagnostics and host prerequisites. |

## Direct operations

| Command | Syntax | Output or behavior |
|---|---|---|
| `list` | `activefs list [path] [--state-root <dir>] [--source <spec>]` | Lists direct children; the path defaults to `/`. |
| `ls` | `activefs ls [path] [--include-non-enumerable] [--state-root <dir>] [--source <spec>]` | Invokes the optional `ls` source handler, then the default listing behavior. |
| `stat` | `activefs stat <path> [--state-root <dir>] [--source <spec>]` | Prints entry metadata as JSON. |
| `read` | `activefs read <path> [--state-root <dir>] [--source <spec>]` | Writes file bytes to stdout. |
| `cat` | `activefs cat <path> [--state-root <dir>] [--source <spec>]` | Invokes the optional `cat` source handler, then the default read behavior. |
| `head`, `tail` | `activefs head\|tail <path> [--lines <n>] [--state-root <dir>] [--source <spec>]` | Returns the first or last lines through a command-aware handler. |
| `sed` | `activefs sed <path> <pattern> <replacement> [--global] [--ignore-case] [--state-root <dir>] [--source <spec>]` | Returns a literal text replacement without writing the file. |
| `grep`, `rg` | `activefs grep\|rg <pattern> [path] [--case-sensitive] [--limit <n>] [--include-non-enumerable] [--json] [--state-root <dir>] [--source <spec>]` | Runs source-aware text search; the path defaults to `/`. |
| `find` | `activefs find [path] [--include-non-enumerable] [--state-root <dir>] [--source <spec>]` | Walks entries through the optional source handler; the path defaults to `/`. |

`list` and `read` call semantic operations directly. The aliases `ls`, `stat`,
`cat`, `head`, `tail`, `sed`, `grep`, `rg`, and `find` allow a source to
customize a named workflow; core supplies the default mapping when the source
does not.

### Search result contract

The canonical order is pattern first:

```bash
activefs grep TODO /repo --case-sensitive --limit 20 --json
```

Search invokes an optional source command handler, falls back to semantic
search, and finally scans enumerable files through `list` and `read` when source
search is unavailable. Text and JSON output report `source`, `scan`, or `mixed`,
the `complete` flag, and any `incompleteReasons`.

Mounted `grep -R` reads files through the mounted adapter. It cannot recover the
original command, pattern, or flags, so use direct `activefs grep` when a source
index, OCR, or another command-aware handler matters.

## `activefs tui`

```bash
activefs tui [--state-root <dir>] [--source <spec>] [--export-dir <dir>] [--debug]
```

The TUI loads configured remotes or explicit `--source` values. It fails when
neither is available; `--source example` explicitly selects the built-in
diagnostic fixture. Its browser, search, and export screens call core directly;
WebDAV and rclone state describe the local mount adapter, not the remote Source
API. See the [TUI guide](../guides/tui.md).

## `activefs remote`

```bash
activefs remote add <name> <discovery-url> [options]
activefs remote add <name> --demo [--port <port>] [--mount <path>]
activefs remote list [--state-root <dir>] [--json]
activefs remote status [remote] [--state-root <dir>] [--json]
activefs remote remove <remote> [--force] [--state-root <dir>] [--json]
```

`remote ls` aliases `remote list`; `remote rm` aliases `remote remove`.

`remote add` accepts:

| Option | Behavior |
|---|---|
| `--no-check` | Records an offline or not-yet-started discovery URL without fetching it. |
| `--allow-insecure-http` | Allows an explicit non-loopback `http://` development endpoint. Non-loopback HTTP otherwise fails closed. |
| `--activity-policy required\|best-effort\|off` | Sets local Source API activity-report handling. |
| `--watchable` / `--no-watchable` | Overrides subscription capability when discovery cannot be checked. |
| `--mount-path <path>` | Sets the remote's ActiveFS namespace path; the default is `/<name>`. |
| `--mount <path>` | Associates and immediately starts a visible mountpoint. |
| `--state-root <dir>` | Selects the ActiveFS state root. |
| `--json` | Prints the recorded remote, endpoint check, and optional mount result as JSON. |

A checked add fetches the exact Source API discovery URL and records safe
capability hints, including `watchable`. A remote is always a Source API
discovery URL; `--protocol` is not part of the public remote contract.

The `--demo` form starts the shipped read-only loopback Source API server and
records its runtime state. Removing that remote stops the recorded demo process
before deleting its config and private local state. Removal refuses an active
mount unless `--force` is present.

`remote list` reads local configuration without probing the network. `remote
status` probes Source API and mount state. Outside loopback, use `https://`
unless the development-only insecure override is explicit.

## `activefs auth`

```bash
activefs auth set <remote> --env <name> [--scheme <scheme>] [--state-root <dir>]
activefs auth set <remote> --token-command '<json-argv>' [--scheme <scheme>] [--state-root <dir>]
activefs auth set <remote> --headers-command '<json-argv>' [--state-root <dir>]
activefs auth set <remote> --cookie-provider '<json-argv>' [--state-root <dir>]
activefs auth set <remote> --static-header <header>:<env-name> [--state-root <dir>]
activefs auth set <remote> --bearer-stdin [--scheme <scheme>] [--state-root <dir>]
activefs auth status <remote> [--state-root <dir>] [--json]
activefs auth clear <remote> [--state-root <dir>]
```

Exactly one provider option is required by `auth set`. Command providers are
JSON argv arrays, not shell strings. A cookie provider prints the Cookie header
value. `--bearer-stdin` stores the token in the remote's private state, not in
`.activefs/config.json`. Status output describes the provider without printing
secrets; `clear` also removes a private stored token.

The CLI has no direct OS-keychain provider. Hosts can wrap platform credential
stores with an argv command or supply a programmatic provider.

## `activefs status`

```bash
activefs status [remote|mountpoint] [--state-root <dir>] [--json]
```

The selector may be a configured remote name or associated mountpoint. Output
summarizes the endpoint, namespace, mountpoint, auth provider type, policy,
adapter capability profile, cache, mount and freshness state, Source API
session, unresolved operation journal, and activity backlog. Status reconciles
known unresolved operations when a server-owned status endpoint is available.

## `activefs mcp`

```bash
activefs mcp [remote] [start|inspect|status|stop|config claude|codex|generic] [options]
```

With no action, `mcp` starts stdio. `inspect` validates configuration and prints
a redacted server plan. `config` prints a stdio client descriptor. `status` and
`stop` operate on managed HTTP runtime records; stdio servers normally belong
to the client process that launched them.

See the [MCP reference](mcp.md) for transports, flags, resources, tools,
subscriptions, and authorization.

## `activefs export`

```bash
activefs export <path> --to <dir> [--tree-revision <revision>] [--state-root <dir>] [--source <spec>]
```

Export writes live ActiveFS bytes to host files and creates
`activefs-export-manifest.json` with source and destination, timestamps,
consistency, per-file `sha-256:<hex>` digests, optional revisions, warnings, and
failures. The default consistency is `live`.

`--tree-revision <revision>` requests a revision-pinned export and fails closed
unless every exported file reports that exact revision. This remains an export;
`snapshot` is reserved for a server snapshot capability.

Normal namespace paths such as `/repo` and explicit selectors such as `repo:/`
are accepted. Export refuses an ambiguous bare host root `/` unless an explicit
state root or source disambiguates it.

## `activefs server`

```bash
activefs server start [remote] [--host <host>] [--port <port>] [--auth <username:password>] [--state-root <dir>] [--source <spec>]
activefs server status [remote] [--state-root <dir>] [--json]
activefs server stop [remote] [--state-root <dir>] [--json]
```

`server start` runs the local WebDAV adapter in the foreground and defaults to
`127.0.0.1:3847`. When a remote is supplied, the CLI records runtime status in
that remote's private state. `status` probes recorded runtimes; `stop` requests
termination of them.

`--auth <username:password>` is optional. It enables HTTP Basic authentication
for WebDAV clients connecting to this adapter; requests without matching
credentials receive `401 Unauthorized`. It does not configure credentials for
an upstream Source API remote or for an MCP server. Without `--auth`, the
foreground adapter is unauthenticated and remains loopback-bound unless
`--host` changes the binding.

```bash
activefs server start repo --auth alice:local-only
```

The password is passed as a command-line argument and may appear in shell
history or process listings. Basic authentication does not encrypt the
connection, so do not expose this server over unencrypted non-loopback HTTP.

## `activefs mount`, `unmount`, and `remount`

```bash
activefs mount [remote] [mountpoint] [--read-only] [--cache] [--foreground] [--debug] [--state-root <dir>]
activefs mount status [remote] [--state-root <dir>] [--json]
activefs mount cleanup [remote] [--state-root <dir>] [--json]
activefs remount [remote] [--read-only] [--cache] [--foreground] [--debug] [--state-root <dir>]
activefs unmount [remote] [--keep-mountpoint] [--state-root <dir>]
```

`mount` requires one configured remote when more than one exists. Supplying a
mountpoint updates that remote's visible mount association before starting it.
The mount is read-write when tree capability and local policy allow mutation;
`--read-only` forces read-only behavior. rclone VFS caching is `off` by default;
`--cache` selects `full` for that mount.

On Windows, a directory mountpoint may be absent or empty. ActiveFS removes an
empty target immediately before starting rclone because WinFsp creates the
mounted directory. A non-empty target is rejected without deleting its
contents. See [Use ActiveFS on Windows](../guides/windows.md).

`--foreground` keeps rclone attached, and `--debug` enables debug mount logs.
Advanced mount options are `--rclone <path>`,
`--rclone-vfs-cache-mode off|minimal|writes|full`, and
`--mount-ready-timeout-ms <ms>`.

Mount status includes visible mountpoint, runtime state, server and rclone
state, freshness mode, stale reason, and last refresh. Safe cleanup runs during
normal mount lifecycle commands. `mount cleanup` is the explicit recovery
command for inactive stale runtime files; it does not remove remote config or a
non-empty visible mountpoint.

`unmount` targets every configured mount when no remote is supplied. It removes
an empty visible mountpoint by default; `--keep-mountpoint` keeps it.

Source API-backed coherent mounts require healthy session SSE. If the stream is
unavailable, loses an unrecoverable gap, or cannot authenticate, the CLI
disables cache trust and reports the mount unavailable or stale. Polling and
manual refresh do not become a coherence guarantee.

## `activefs sync`

Canonical syntax is remote first:

```bash
activefs sync <remote> status [--state-root <dir>] [--json]
activefs sync <remote> refresh [path] [--recursive] [--state-root <dir>] [--json]
activefs sync <remote> watch [--source-remote <name>] [--state-root <dir>]
```

`activefs sync <remote>` defaults to `status`. Status returns the same mounted
runtime and freshness fields as `activefs mount status`. Refresh invalidates the
mounted path, defaulting to `/`; `--recursive` includes descendants when the
adapter supports it.

`activefs sync <remote> watch` runs Source API session watchers for the selected
mounted remote. Repeat `--source-remote <name>` to limit the configured Source
API remotes; without it, all are watched. A source without healthy session SSE
reports unavailable or no-realtime state. `--poll-interval` is rejected.

## `activefs refresh`

```bash
activefs refresh <remote:/path> [--recursive] [--state-root <dir>] [--json]
```

This support command invalidates a mounted subtree through the active adapter.
A failed adapter refresh marks the mount stale and records the reason. It is not
a substitute for session SSE.

## `activefs cache`

```bash
activefs cache status [remote] [--state-root <dir>] [--json]
activefs cache clear [remote] [--path <path>] [--recursive] [--state-root <dir>] [--json]
activefs cache watch [remote] [--source-remote <name>] [--state-root <dir>]
```

Status reports file and byte counts by cache section. Clear removes local mount
cache entries; with `--path`, it clears stable path-keyed entries and refreshes
the active mounted subtree when present.

Watch consumes Source API session SSE, clears invalidated cache paths, and
refreshes an active mount. It fails or reports no-realtime state when a source
cannot provide healthy session SSE; polling is not supported.

## `activefs logs`

```bash
activefs logs [remote] [--lines <n>] [--state-root <dir>] [--json]
```

Logs returns local WebDAV and rclone mount logs. Without a remote it returns all
configured mount logs.

## `activefs doctor`

```bash
activefs doctor [--mounts] [--state-root <dir>] [--json]
```

Doctor reports host mount prerequisites. `--mounts` adds active mount and
configured remote evidence. JSON also includes the platform checks and any
development-only insecure HTTP remotes.

## Exit behavior

Successful commands exit `0`. The packaged `activefs` executable prints the
error message, prefixes an `ActiveFSError` code when available, and exits `1`
for every command failure. It does not currently assign separate numeric exit
codes by error category.
