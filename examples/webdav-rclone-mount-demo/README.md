# Preview a mounted-folder setup

Use this example to confirm a remote's name, Source API URL, and local workspace
before starting a real OS mount. It prepares the configuration and cache layout
a real mount would use, then reports status without starting WebDAV, rclone, or
a host mount.

## Preview the setup

From the repository root, choose a disposable workspace directory for the
preview:

```bash
pnpm --filter @activefs/example-webdav-rclone-mount-demo build
node examples/webdav-rclone-mount-demo/dist/index.js \
  /tmp/activefs-demo local http://127.0.0.1:3900/_activefs/
```

The command writes ActiveFS state below `/tmp/activefs-demo`. The example URL
does not need to be reachable because this flow inspects configured state only.

## What to check

The printed JSON includes:

- the `local` remote mapped to the `/local` ActiveFS path;
- `"sourceUrl": "http://127.0.0.1:3900/_activefs/"`;
- the local runtime, cache, filesystem-view, and log paths a mount would use;
- configured status showing that no host mount has started;
- an empty cache showing that the preview did not fetch remote files.

## Inputs and paths

| Value | Role |
|---|---|
| `/tmp/activefs-demo` | Disposable local workspace for the preview |
| `local` | Remote name |
| `http://127.0.0.1:3900/_activefs/` | Recorded Source API URL |
| `/local` | Direct ActiveFS namespace |
| derived VFS path | Prepared filesystem view used by the mount workflow |

## Limits

This preview does not start a Source API server, WebDAV, rclone, FUSE, or a host
mount. It does not read remote files or validate freshness, writes, editor
saves, or OS permissions. Use a disposable root because it creates local state.

## Next

Follow [Mounted folder](../../docs/guides/mounted-folder.md) when you need a
real OS-visible path.
