# Mount an ActiveFS remote as a local folder

Use this guide only when a shell command, editor, build tool, or other program
requires an OS-visible path such as `./repo`. Mounting is optional; it adapts an
existing ActiveFS remote for software that expects normal files and directories.

The source still decides which paths are visible, which bytes a read returns,
how fresh those bytes are, and whether a write succeeds.

You do not need rclone, FUSE, macFUSE, or WinFsp for direct commands such as
`activefs list`, `activefs read`, and `activefs grep`. Those commands use the
same syntax on Windows, macOS, and Linux.

## Before you begin

You need a configured remote and these host components:

| Platform | Required mount support |
|---|---|
| macOS | rclone and macFUSE |
| Linux | rclone and FUSE access |
| Windows | rclone and WinFsp |

Check the current machine before attempting a mount:

```bash
activefs doctor --mounts
```

Windows users should complete [Use ActiveFS on Windows](windows.md) first. That
guide covers rclone and WinFsp installation, PowerShell path syntax, mountpoint
requirements, and Windows-specific troubleshooting.

If you need a temporary remote for this guide, start the shipped read-only demo:

```bash
activefs remote add repo --demo --port 3999
activefs remote status repo
```

## Mount and verify the folder

### macOS or Linux shell

Mount the configured remote at `./repo`, then use ordinary filesystem tools
against the mounted path:

```bash
activefs mount repo ./repo
activefs mount status repo
ls ./repo
cat ./repo/README.txt
grep -R Source ./repo
```

### Windows PowerShell with rclone and WinFsp

After completing the [Windows guide](windows.md), mount the same remote at
`.\repo`:

```powershell
activefs mount repo .\repo
activefs mount status repo
```

Then use PowerShell's filesystem commands against the mounted folder:

```powershell
Get-ChildItem .\repo
Get-Content .\repo\README.txt
Get-ChildItem .\repo -Recurse -File | Select-String -Pattern "Source"
```

The Windows guide explains how these cmdlets reach ActiveFS and when to prefer
direct `activefs grep` over a mounted client-side scan.

For the remaining examples in this guide, use `.\repo` on Windows wherever a
macOS/Linux block shows `./repo`.

These commands go through the same mounted adapter. A successful `cat` or
`Get-Content` proves that the OS-visible path can read bytes from the
source-backed tree.

## Unmount when finished

Detach the folder:

```bash
activefs unmount repo
```

ActiveFS removes the visible mountpoint when it is empty. Keep the empty
directory when another tool expects it to remain:

```bash
activefs unmount repo --keep-mountpoint
```

If you created the demo remote for this guide, remove it after unmounting:

```bash
activefs remote remove repo
```

## Choose mount options deliberately

Force a read-only mount when the consuming tool does not need to write:

```bash
activefs mount repo ./repo --read-only
```

Opt into rclone's repeated-read cache only when the tool benefits from it:

```bash
activefs mount repo ./repo --cache
```

The cache option does not make stale data coherent. A source-backed mounted view
needs a healthy watch session before it can claim real-time updates. See
[Cache and freshness](cache-and-freshness.md) before relying on cached mounted
reads.

The one-step form records and mounts a real Source API remote:

```bash
activefs remote add repo https://YOUR_HOST/_activefs/ --mount ./repo
```

Replace `YOUR_HOST` with the host serving the exact Source API discovery URL.

## Understand local WebDAV authentication

The normal `activefs mount` workflow manages the local adapter used by rclone;
you do not need to start its foreground server separately. When testing or
connecting a WebDAV client directly, you can require HTTP Basic authentication:

```bash
activefs server start repo --auth alice:local-only
```

The username and password protect only the local WebDAV adapter. They do not
configure authentication for the upstream Source API remote or for MCP. The
option is optional: without it, `server start` is unauthenticated and binds to
`127.0.0.1:3847` by default. A client that omits configured credentials receives
`401 Unauthorized`.

Command-line passwords may appear in shell history or process listings. Basic
authentication does not encrypt the connection, so do not expose the adapter
over unencrypted non-loopback HTTP.

## Understand mounted search

Mounted `grep`, `rg`, and `find` on macOS/Linux, or `Select-String` and
`Get-ChildItem` on PowerShell, operate like normal filesystem tools: they list
directories and read files through the mount. The mount does not receive the
original search pattern, so it cannot invoke a provider index or a custom
source search handler.

Use ActiveFS search when the source may offer a better search method:

```bash
activefs grep "query" /repo
```

Mounted scanning works only across enumerable, readable files and may be slower
for large trees.

## Keep writes source-authorized

Mounted writes are synchronous. ActiveFS reports success only after the tree or
source accepts the operation. There is no offline mutation queue.

Create, write, move, copy, truncate, and remove behavior depends on both the
tree capability and source policy. Use a read-only mount unless the consuming
tool needs mutation, and do not infer write authority from local mode bits.

The [access adapter reference](../reference/access-adapters.md) defines the
exact WebDAV mapping and supported operation profile.

## Recover a stale or interrupted mount

Start with status and host diagnostics:

```bash
activefs sync repo status
activefs mount status repo --json
activefs doctor --mounts --json
```

If one mounted subtree needs revalidation, request an explicit refresh:

```bash
activefs sync repo refresh /docs --recursive
```

After an interrupted mount or host-level eject, unmount and reconcile inactive
runtime state:

```bash
activefs unmount repo
activefs mount cleanup repo --json
activefs mount repo ./repo
```

Cleanup does not remove the configured remote or delete a non-empty visible
directory. If the retry fails, collect redacted logs before changing source or
tree code:

```bash
activefs logs repo --lines 100
```

## Use export when a mount is the wrong fit

Export a local copy when mount support is unavailable or when a tool needs
local-disk semantics that WebDAV and rclone do not provide:

```bash
activefs export /repo --to exported-repo
```

An export is a local copy of live reads, not a point-in-time snapshot unless
the source provides a stable revision or snapshot capability.

## Exact behavior and limits

- [Access adapter reference](../reference/access-adapters.md)
- [CLI reference](../reference/cli.md)
- [Supported environments](../reference/supported-environments.md)
- [Current limits](../reference/current-limits.md)
