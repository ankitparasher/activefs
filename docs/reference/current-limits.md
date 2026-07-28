# Current limits

Use this reference to decide whether ActiveFS fits a workflow before you depend
on it. ActiveFS exposes live application data as programmable files and
directories; it does not replace the source that owns those data.

## Product boundary

- ActiveFS ships npm packages and a CLI. It does not provide a hosted service,
  hosted storage, or a native OS installer.
- Source API services remain authoritative for data, path visibility,
  authentication, authorization, and provider policy.
- ActiveFS has no built-in user directory, identity provider, or hosted OAuth
  authorization server.
- An unavailable source remains unavailable through ActiveFS; local adapters
  do not turn remote data into an independently authoritative store.

## Reads, writes, and local copies

- Direct reads resolve against the current source. A source may compute file
  contents at read time.
- `activefs export` writes a normal local copy and a manifest. It is not an
  atomic point-in-time snapshot unless the source supplies stable snapshot or
  revision semantics.
- Cached reads are coherent only when the configured freshness/session
  contract supports them. A cache does not make an unavailable or stale source
  authoritative.
- Mutations are server-final. ActiveFS reports success after the tree or source
  accepts the operation and does not maintain an offline mutation queue.

## Limits by access method

| Method | Current boundary |
|---|---|
| Direct CLI and APIs | Work without an OS mount, but still depend on source capabilities and policy. |
| TUI | Provides terminal browsing, search, diagnostics, and export; it is not a graphical desktop filesystem. |
| MCP | Supports stdio and Streamable HTTP. ActiveFS does not operate a hosted OAuth server. |
| MCP export | Returns a bounded resource-link manifest for client-side export; it does not write arbitrary host files. |
| Mounted folder | Requires rclone and a platform mount backend. It adapts the source for OS tools but cannot promise every native-filesystem semantic. |

## Mounted-folder limits

- Host mode bits and ownership may be mount-wide or approximate.
- The source remains authoritative for every write, rename, copy, truncate,
  and delete.
- Mounted search tools such as `rg` scan through the mounted path. They cannot
  invoke a source-native search index and may be slower than
  `activefs grep`.
- Mount behavior depends on rclone, macFUSE, FUSE, or WinFsp on the target
  machine. Use export when a tool needs local-disk semantics that the mount
  cannot provide. Windows prerequisites and path behavior are documented in
  [Use ActiveFS on Windows](../guides/windows.md).

## Operational limits

- The shipped Source API service applies bounded request and retention
  defaults documented in [Shared service resource bounds](source-http-transport.md#shared-service-resource-bounds).
- Retained sessions, operation status, idempotency records, and change history
  are process-local and do not survive a service restart.
- Source behavior, data size, network latency, and application policy determine
  throughput and response time. ActiveFS does not provide a universal latency,
  throughput, or availability guarantee.

## API stability

- The Source API wire protocol is version 1.
- npm package versions and Source API protocol versions are separate.
- ActiveFS is pre-1.0, so public TypeScript APIs may change before `1.0.0`.
  User-visible changes belong in the changelog.

For runtime prerequisites and machine checks, see
[Supported environments](supported-environments.md). For failures, see
[Troubleshooting](../troubleshooting.md).
