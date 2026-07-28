# Troubleshooting

Use this page to identify the failing layer. Start with the direct CLI,
then debug export, TUI, MCP, or a mounted OS folder only after direct list and
read work.

## Quick checks

| Symptom | Check |
|---|---|
| `activefs: command not found` | Install the CLI with `npm install -g activefs`, open a new shell, then run `activefs --help`. |
| `Unknown ActiveFS remote` | Run `activefs remote list` in the same workspace or with the same `--state-root`. |
| A source cannot be reached | Keep its server running and run `activefs remote status repo`. |
| TUI reports no sources | Add a remote or run `activefs tui --source example`. |
| Exported files appear one level deeper | Look under `exported-repo/repo/` after exporting `/repo`. |
| A mounted folder looks stale | Compare `activefs read /repo/README.txt`, then run `activefs sync repo refresh /`. |

## `Source API discovery URL is not reachable`

This error comes from the discovery check performed by `activefs remote add`
or `activefs remote status`:

```text
Source API discovery URL is not reachable: ...
```

For the shipped demo, stop any recorded runtime and start it again:

```bash
activefs remote remove repo --force
activefs remote add repo --demo --port 3999
activefs remote status repo
activefs read /repo/README.txt
```

For your own source, keep the server running in one terminal and use the exact
discovery URL it printed:

```bash
activefs remote add repo http://127.0.0.1:3999/_activefs/
activefs remote status repo
```

The URL must return the ActiveFS discovery document. `--no-check` records an
offline endpoint but does not make it reachable.

## `Unknown ActiveFS remote`

The command's remote name is absent from the current state root. List what this
workspace knows:

```bash
activefs remote list
```

Use the listed name. If the remote was added with an explicit state root, pass
that same value:

```bash
activefs remote list --state-root /path/to/state
```

## `No ActiveFS sources are configured`

The TUI requires a configured remote or an explicit source:

```bash
activefs remote list
activefs tui --source example
```

The example source is explicit; the TUI does not silently select it.

## `Unknown ActiveFS MCP remote`

List the ActiveFS remotes before starting or inspecting MCP:

```bash
activefs remote list
activefs mcp repo inspect
```

Use `activefs mcp inspect --demo` only for the deterministic MCP fixture. For a
configured source, the remote name in `activefs mcp <remote> inspect` must match
`activefs remote list`.

## `Refusing ambiguous host-root export of /`

The CLI cannot safely infer whether `/` means the host root or an ActiveFS
namespace. Name the configured ActiveFS path:

```bash
activefs export /repo --to exported-repo
```

The first path is inside ActiveFS. The `--to` value is a local OS directory.

## A mounted folder looks stale

First compare a direct read:

```bash
activefs read /repo/README.txt
```

If the direct read is current, inspect and refresh the mounted adapter:

```bash
activefs mount status repo
activefs sync repo refresh /
```

The `sync` syntax requires the remote name before `refresh`. Mounted folders
also pass through rclone, WebDAV, and host caches; a direct read does not.

If mount prerequisites are missing, check them separately:

```bash
activefs doctor --mounts
```

Direct list, read, grep, export, TUI, and MCP do not require a mounted folder.
Windows users should follow the dedicated [Windows guide](guides/windows.md)
for WinFsp, rclone, PowerShell, and mountpoint checks.

## Verify the path layer

Do not substitute one path form for another:

| Layer | Example | Verify with |
|---|---|---|
| Source API discovery URL | `http://127.0.0.1:3999/_activefs/` | `activefs remote status repo` after saving it |
| Direct ActiveFS path | `/repo/README.txt` | `activefs read /repo/README.txt` |
| Exported OS path | `./exported-repo/repo/README.txt` | `cat ./exported-repo/repo/README.txt` or PowerShell `Get-Content .\exported-repo\repo\README.txt` |
| Mounted OS path | `./repo/README.txt` | `cat ./repo/README.txt` or PowerShell `Get-Content .\repo\README.txt` after mounting |
| MCP URI | `activefs://repo/README.txt` | `activefs mcp repo inspect` for the selected remote |

If direct `list` and `read` work, continue with the guide for the failing access
method instead of changing the source.

## Next

If the problem remains after the checks above, use the [support
routes](../SUPPORT.md) for a public issue, security report, or conduct concern.
