# Serve a tree over Source API

This example wraps a small `fsTree` in the standalone Source API server and
prints the discovery URL that clients must use.

## Run

From the repository root:

```bash
pnpm --filter @activefs/example-remote-tree-server build
PORT=3999 node examples/remote-tree-server/dist/index.js
```

On Windows PowerShell:

```powershell
pnpm --filter @activefs/example-remote-tree-server build
$env:PORT = "3999"
node examples/remote-tree-server/dist/index.js
```

Keep the process running. It prints:

```text
ActiveFS remote tree listening at http://127.0.0.1:3999/_activefs/
```

## Connect a client

In another terminal, run the paired programmatic client:

```bash
pnpm --filter @activefs/example-remote-tree-client build
ACTIVEFS_REMOTE_URL=http://127.0.0.1:3999/_activefs/ \
  node examples/remote-tree-client/dist/index.js
```

On Windows PowerShell:

```powershell
pnpm --filter @activefs/example-remote-tree-client build
$env:ACTIVEFS_REMOTE_URL = "http://127.0.0.1:3999/_activefs/"
node examples/remote-tree-client/dist/index.js
```

Or connect with the workspace CLI from the repository root:

```bash
pnpm exec activefs remote add repo http://127.0.0.1:3999/_activefs/
pnpm exec activefs list /repo
pnpm exec activefs read /repo/README.txt
pnpm exec activefs grep "Source API" /repo
pnpm exec activefs remote remove repo
```

## Paths

| Server tree path | Result |
|---|---|
| `/README.txt` | Root text file |
| `/notes/source-api.txt` | Searchable note |
| `/bin/sample.bin` | Binary fixture |

A CLI remote named `repo` exposes those paths below `/repo`.

## Limits

The server is read-only and process-local. It does not implement credentials,
TLS, persistence, provider revisions, process supervision, or an OS mount.

## Next

Open [Remote tree client](../remote-tree-client/README.md) for the consuming
code and path mapping.
