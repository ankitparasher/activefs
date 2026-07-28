# @activefs/mcp

Install `@activefs/mcp` when a Node.js application or MCP server should expose
an ActiveFS tree as MCP resources and read-oriented tools. The package also
provides the standalone `activefs-mcp` binary.

The package requires Node.js 22 or newer.

## Install

```bash
npm install @activefs/mcp @activefs/core
```

## Read an ActiveFS resource through MCP

```js
import { createActiveFS, fsTree, text } from "@activefs/core";
import { createMCPAdapter } from "@activefs/mcp";

const tree = fsTree({
  "/README.md": text("# Current docs\n")
});
const activefs = createActiveFS().mount("/docs", tree);

const adapter = createMCPAdapter({
  filesystem: activefs,
  remotes: [{ name: "docs", rootPath: "/docs" }]
});

const result = await adapter.readResource("activefs://docs/README.md");
console.log(result.contents[0]?.text);
```

Output:

```text
# Current docs
```

The adapter maps ActiveFS paths to `activefs://` resource URIs. The backing tree
or source still decides which paths are visible, how fresh their contents are,
and whether a write succeeds.

## Use the standalone server

For an MCP-only process, install the package globally:

```bash
npm install -g @activefs/mcp
activefs-mcp --dry-run --demo
```

Use the main `activefs mcp` command instead when the server should read remotes
from an existing ActiveFS state root.

List, stat, read, and grep tools are enabled by default. Mutation and MCP export
tools are disabled by default. MCP export returns a bounded resource-link
manifest; it does not write arbitrary files on the MCP host.

## Documentation

- [Configure MCP access](https://github.com/ankitparasher/activefs/blob/HEAD/docs/guides/mcp.md)
- [MCP reference](https://github.com/ankitparasher/activefs/blob/HEAD/docs/reference/mcp.md)
- [Security and identity](https://github.com/ankitparasher/activefs/blob/HEAD/docs/guides/security-and-identity.md)
