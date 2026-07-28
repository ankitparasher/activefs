# Access adapter reference

Use this technical reference when translating a consumer interface into
ActiveFS operations. For help choosing an interface, see
[Choose how to use an ActiveFS tree](../guides/access-surfaces.md).

An access adapter parses consumer input, builds an `ActiveFSContext<Auth, Meta>`,
calls the shared core, and translates the result or error. It does not define
provider-specific path meaning.

```txt
consumer protocol or UX
        |
        v
access adapter
parse input | build context | call core | format result
        |
        v
ActiveFS core -> ActiveFSTree or Source API client
```

Adapters may know about command flags, TUI panels, WebDAV status codes, MCP
schemas, export manifests, or shell syntax. They must not assign special meaning
to provider-owned paths such as `/tickets/123.txt` or `/logs/build.txt`.

## Translation contract

| Interface | Consumer identifier | Core target | Result translation |
|---|---|---|---|
| Direct CLI and TUI | ActiveFS namespace path such as `/repo/file.md` | The configured tree mounted at that namespace path | Text, JSON, TUI state, or exported bytes |
| WebDAV mount | URL path decoded from the WebDAV request | The same normalized ActiveFS path | WebDAV status, headers, XML, or bytes |
| MCP | `activefs://<remote>/<path>` or a tool `remote` plus `path` | The selected remote's `rootPath` joined to the normalized remote-relative path | MCP resource contents or tool content plus structured content |
| Programmatic client | Normalized ActiveFS path | The client filesystem or Source API tree | Core result types without protocol-specific redefinition |
| Exporter | ActiveFS path or explicit `remote:/path` selector | A bounded tree walk rooted at the selected path | Host files plus `activefs-export-manifest.json` |

Every adapter must:

- Keep `auth` and `meta` opaque while building `ActiveFSContext<Auth, Meta>` at
  the host boundary.
- Normalize remote and path input before calling core.
- Check optional capabilities before invoking them.
- Preserve partial-result, incomplete-search, and stale-cache state when known.
- Preserve the cause while translating errors into the consumer's native error form.
- Avoid logging credentials or raw `auth` values.
- Carry trace IDs into diagnostics when available.

## Capability matrix

| Capability | CLI | TUI | WebDAV mount | MCP | Programmatic client | Exporter |
|---|---:|---:|---:|---:|---:|---:|
| `stat` | yes | yes | yes | yes | yes | yes |
| `list` | yes | yes | yes | yes | yes | yes |
| `read` | yes | yes | yes | yes | yes | yes |
| source-aware `search` | yes | yes | no | yes | yes | optional |
| `write` and mutation | no direct command | no current UI action | policy-gated | optional tools | yes | no |
| export | yes | yes | no | manifest-only optional tool | no | yes |

The MCP export tool returns a bounded manifest of `activefs://` resources. It
does not write host files. Mounted `grep` reads files through WebDAV; it cannot
recover the original shell command or invoke a source-specific search handler.

## Mounted adapter support levels

| Capability or workflow | V1 support level | Mounted-folder behavior |
|---|---|---|
| `ls`, `find`, `stat`, reads, range reads, and `grep -R` by reading | Supported | Uses `PROPFIND`, `GET`, and `HEAD`. Source-aware search remains available through direct adapters such as CLI and MCP. |
| Basic `cp`, new-file `touch`, zero-length truncate, `mkdir`, `rm`, `mv`, and same-remote copy | Supported when capability and policy allow | Uses `PUT`, `MKCOL`, `DELETE`, `MOVE`, and `COPY`. A zero-byte `PUT` on an existing file can use `truncate(length: 0)` when write is unavailable but truncate is allowed. Success is server-final. |
| Existing-file `touch`, nonzero truncate, exact `test -w`, exact per-path modes, rename over an existing path, editor atomic saves, close or fsync validation, and OS file watchers | Not supported in `0.1.x` | Some lower-level primitives exist, but end-to-end behavior through WebDAV, rclone, and the host filesystem is not guaranteed. |
| `LOCK`/`UNLOCK`, full POSIX permission fidelity, `chmod`/`chown`, links, xattrs, offline writes, and shell/PATH command emulation | Unsupported or outside V1 | Return an unsupported response, expose bounded adapter metadata, or use a native adapter or export workflow. |

## WebDAV mount contract

`@activefs/mount` combines the WebDAV adapter, rclone configuration, mount
lifecycle, status, freshness hooks, cleanup, and evidence helpers.

| WebDAV method | ActiveFS behavior |
|---|---|
| `OPTIONS` | Advertises supported WebDAV methods. |
| `PROPFIND` | Calls `stat` and `list`. |
| `GET` and `HEAD` | Call `stat` and `read`. A single `Range: bytes=...` request returns `206` or `416`. |
| `PUT` | Calls `write`. A zero-byte `PUT` on an existing file can call `truncate(length: 0)` when write is unavailable and truncate is allowed. |
| `MKCOL` | Calls `mkdir`. |
| `DELETE` | Calls file deletion or recursive directory removal. |
| `MOVE` | Calls `rename`. |
| `COPY` | Calls `copy`. |

Unknown WebDAV methods return `501`. V1 does not implement `LOCK`, `UNLOCK`,
`PROPPATCH`, `PATCH`, or `POST` as mounted-folder operations. A tree-level
`UNSUPPORTED` error during a recognized operation maps to `405`.

`PROPFIND` properties and tree metadata are not final write authorization. The
adapter enforces local policy before mutation, then the tree or Source API
server makes the authoritative decision. Without writable policy, mutations
fail closed.

POSIX modes shown by `ls -l`, `stat`, and `test -w` are semantic projections.
The authoritative operation can still fail because of tree capability, policy,
or server state.

## rclone mount defaults

For a remote named `repo` mounted at `./repo`, the generated core arguments are:

```bash
rclone mount repo: ./repo \
  --config .activefs/remotes/repo/runtime/rclone.conf \
  --vfs-cache-mode off \
  --dir-cache-time 10m \
  --cache-dir .activefs/remotes/repo/cache/rclone \
  --log-file .activefs/remotes/repo/runtime/rclone.log \
  --log-level INFO \
  --rc \
  --rc-addr 127.0.0.1:<allocated-port> \
  --rc-user activefs-rc \
  --rc-pass <private-generated-password>
```

Debug mode changes the log level to `DEBUG`. macOS and root execution can add
platform-specific volume, UID, GID, or allow-root flags.

Adapter rules:

- Add `--read-only` only when the user requests it or the adapter capability
  profile requires it.
- Keep rclone VFS cache mode `off` by default; the public `--cache` flag selects
  `full` for that mount.
- Keep cache directories remote-specific.
- Use rclone RC refresh internally to invalidate mounted subtrees when possible.

The support option `--rclone-vfs-cache-mode` accepts `off`, `minimal`, `writes`,
or `full`. `--mount-ready-timeout-ms <ms>` extends the readiness wait for slow
FUSE or rclone startup.

## Real-time updates and freshness

Source API-backed mounts require healthy session SSE before claiming a coherent
mounted view. If the stream is unavailable, loses an unrecoverable gap, cannot
authenticate, or is rejected by policy, the adapter must disable cache trust
and report the view unavailable or return a filesystem-style connection error.

Direct WebDAV reads still route to the tree or Source API server while the mount
is available. rclone cache TTLs, manual refresh, and polling are support
mechanisms, not a Source API freshness contract.

## Error mapping

The packaged CLI prints an `ActiveFSError` code when present and exits `1` for
all command failures. MCP tool failures return `isError: true`; resource,
prompt, and subscription failures use MCP protocol errors.

| Core code | CLI | WebDAV | MCP |
|---|---|---:|---|
| `NOT_FOUND` | coded stderr, exit `1` | `404` | resource or tool error |
| `NOT_MOUNTED` | coded stderr, exit `1` | `404` | resource or tool error |
| `NOT_DIRECTORY`, `NOT_FILE` | coded stderr, exit `1` | `405` | resource or tool error |
| `INVALID_PATH`, `INVALID_REQUEST` | coded stderr, exit `1` | `400` | invalid resource, cursor, or tool input |
| `UNAUTHORIZED` | coded stderr, exit `1` | `401` | authentication error |
| `FORBIDDEN` | coded stderr, exit `1` | `403` | authorization error |
| `UNSUPPORTED` | coded stderr, exit `1` | `405` | disabled or unsupported tool/operation |
| `SOURCE_ERROR` | coded stderr, exit `1` | `502` | source error |
| Other errors | stderr, exit `1` | `500` | protocol or tool error |
