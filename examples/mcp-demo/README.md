# Browse an in-process tree through MCP

This example launches the packaged `activefs-mcp` stdio server over a
small in-memory tree. A real MCP client connects and lists, reads, and searches
its resources.

## Run

From the repository root:

```bash
pnpm build
pnpm --filter @activefs/example-mcp-demo build
node examples/mcp-demo/dist/index.js
```

The workspace build is required because the client launches
`packages/mcp/dist/cli.js`.

## Expected result

The printed JSON includes:

- `activefs://demo/hello.md` and `activefs://demo/notes/today.txt` resources;
- the text read from `hello.md`;
- grep match URIs returned by `activefs_grep`;
- the prompt names returned by `prompts/list`.

## Paths

| ActiveFS path | MCP URI |
|---|---|
| `/demo` | `activefs://demo/` |
| `/demo/hello.md` | `activefs://demo/hello.md` |
| `/demo/notes/today.txt` | `activefs://demo/notes/today.txt` |

## Limits

The example uses a local fixture and stdio transport. It does not configure a
Source API remote, public HTTP transport, OAuth, or mutation tools. MCP
diagnostics go to stderr so stdout remains JSON-RPC only.

## Next

Run [MCP over a Source API remote](../mcp-source-remote/README.md) to replace
the process-local fixture with a remote tree.
