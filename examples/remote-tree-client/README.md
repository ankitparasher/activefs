# Consume a remote tree in code

This example connects to the paired Source API server, mounts that remote at
`/remote` inside an ActiveFS instance, then lists, reads, and searches it.

## Run the pair

From the repository root, build and start the server in one terminal:

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

In a second terminal:

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

Stop the server with `Ctrl-C`.

## Expected result

The client prints the selected URL and remote capabilities, lists
`/remote/README.txt`, reads `Hello from a remote ActiveFS tree.`, and prints a
search match from `/remote/notes/source-api.txt`.

## Paths

| Client ActiveFS path | Server tree path |
|---|---|
| `/remote` | `/` |
| `/remote/README.txt` | `/README.txt` |
| `/remote/notes/source-api.txt` | `/notes/source-api.txt` |

`/remote` is an in-process ActiveFS mount prefix, not an OS-visible folder.

## Limits

The paired fixture is read-only and uses loopback HTTP. It does not configure
credentials, TLS, retries, offline behavior, client caching, or WebDAV/rclone.

## Next

See [Local bridge](../local-bridge-tree/README.md) for a server that reads from
an owned local folder instead of an in-memory declaration.
