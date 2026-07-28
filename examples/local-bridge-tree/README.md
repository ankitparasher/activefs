# Serve a local folder through Source API

This example lets one process own a local fixture folder while a separate
ActiveFS client consumes only its Source API. The client mounts the remote tree
at `/bridge` inside its own ActiveFS namespace.

## Run

From the repository root:

```bash
pnpm --filter @activefs/example-local-bridge-tree build
node examples/local-bridge-tree/dist/index.js
```

The executable starts a loopback server, runs the client checks, and closes the
server.

## Expected result

The output reports `local-bridge-tree mount: /bridge`, lists the fixture's docs,
reads its README heading, and reports source-owned search results.

## Paths

| Server tree path | Client ActiveFS path |
|---|---|
| `/README.md` | `/bridge/README.md` |
| `/docs/setup.md` | `/bridge/docs/setup.md` |
| `/src/app.ts` | `/bridge/src/app.ts` |

The server normalizes requested paths under
`examples/local-bridge-tree/fixture` before reading them.

## Limits

The bridge is read-only and uses local loopback HTTP. It does not implement
symlink policy, file locks, writes, watch events, client caching, OS mounts, or
multi-machine synchronization.

## Next

Use the paired [remote server](../remote-tree-server/README.md) and
[remote client](../remote-tree-client/README.md) to run the two processes
yourself.
