# Read a Source API remote through MCP

This example starts a loopback Source API server, mounts it in an ActiveFS MCP
server, and uses an MCP client to list, read, and grep remote resources.

## Run

From the repository root:

```bash
pnpm build
pnpm --filter @activefs/example-mcp-source-remote build
node examples/mcp-source-remote/dist/index.js
```

The executable owns the temporary server and closes it after printing the
result.

## Expected result

The printed JSON includes the loopback source URL,
`activefs://remote/README.md`, `activefs://remote/docs/guide.md`, the README
text, and a grep match URI.

## Paths

| Source tree path | MCP URI |
|---|---|
| `/` | `activefs://remote/` |
| `/README.md` | `activefs://remote/README.md` |
| `/docs/guide.md` | `activefs://remote/docs/guide.md` |

To apply the pattern to a separately running source, start the
[remote tree server](../remote-tree-server/README.md) in another terminal and
keep it running on port `3999`. The command above has already closed its own
temporary server, so its URL cannot be reused. From the repository root,
configure and inspect the running source with the workspace CLI:

```bash
pnpm exec activefs remote add remote http://127.0.0.1:3999/_activefs/
pnpm exec activefs mcp remote inspect
pnpm exec activefs remote remove remote
```

## Limits

The example uses loopback Source API HTTP and an in-memory MCP transport. It
does not cover a public HTTP MCP endpoint, OAuth, persistent remote state, or
write tools.

## Next

Follow the [MCP guide](../../docs/guides/mcp.md) to generate client
configuration and choose a transport.
