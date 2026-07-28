# Monitor remote tree activity

This example hosts named Source API trees and a web page that displays their
clients and list, stat, read, and search activity. The interactive mode starts
`docs` and `reports` trees.

## Preview monitored activity

From the repository root:

```bash
pnpm --filter @activefs/example-remote-mount-monitor build
node examples/remote-mount-monitor/dist/index.js
```

The command starts a temporary loopback monitor, connects a client to `docs`,
runs file operations, and prints the resulting tree and activity counts before
it exits.

## Run the interactive monitor

```bash
node examples/remote-mount-monitor/dist/index.js --serve --port=3998
```

Open `http://127.0.0.1:3998`. In another terminal at the repository root, check
that rclone and the host's FUSE support are available before creating a mount:

```bash
pnpm exec activefs doctor --mounts
```

Then connect the `docs` tree and mount it:

```bash
pnpm exec activefs remote add docs http://127.0.0.1:3998/trees/docs/source/
pnpm exec activefs mount docs ./mounted-docs
ls ./mounted-docs
cat ./mounted-docs/README.md
```

On Windows PowerShell with WinFsp installed:

```powershell
pnpm exec activefs remote add docs http://127.0.0.1:3998/trees/docs/source/
pnpm exec activefs mount docs .\mounted-docs
Get-ChildItem .\mounted-docs
Get-Content .\mounted-docs\README.md
```

If mount support is unavailable, you can still generate monitor activity by
listing and reading the Source API remote directly:

```bash
pnpm exec activefs list /docs
pnpm exec activefs read /docs/README.md
```

These direct operations do not require rclone or FUSE.

If you created the mount, unmount it before stopping the monitor:

```bash
pnpm exec activefs unmount docs
```

Remove the configured remote after either flow:

```bash
pnpm exec activefs remote remove docs
```

Removing the local remote does not delete the monitor's server-owned tree.

## Paths

| Tree path | Result |
|---|---|
| `/README.md` | Tree summary |
| `/mount.json` | Tree ID, discovery URL, and suggested path |
| `/files/tree.txt` | Plain-text fixture |
| `/files/requests.txt` | Note about monitored requests |

The monitor discovery URL is
`/trees/:treeId/source/`. The monitor web/API and event stream remain separate
at `/`, `/api/*`, and `/events`.

## Limits

Generated trees are read-only. The monitor has no authentication,
multi-user authorization, durable audit store, offline writes, or
provider-specific behavior. Its Server-Sent Events update the monitor page;
they are not a general Source API watch implementation.

## Next

Use [Preview a mounted-folder setup](../webdav-rclone-mount-demo/README.md) to
inspect the local state prepared for a mounted folder.
