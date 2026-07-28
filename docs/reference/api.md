# API reference index

Use this page to choose the package, published subpath, and reference that owns
the contract you need. Package manifests define what consumers can import.

## Choose a package or subpath

| Need | Import or executable | Start here |
|---|---|---|
| Install and run the user-facing CLI | `activefs` | [CLI reference](cli.md) |
| Compose trees, route paths, or use the logical client | `@activefs/core` | [Core API](core-api.md) |
| Author an `ActiveFSTree` | `@activefs/core` | [ActiveFSTree authoring](activefs-tree.md) |
| Read or write workspace configuration | `@activefs/config` | [Connect a source](../guides/connect-a-source.md) and [security](../guides/security-and-identity.md) |
| Serve or consume Source API from Node.js | `@activefs/source-http` | [Source API](source-api.md) and [HTTP transport](source-http-transport.md) |
| Host Source API in a Fetch-compatible runtime | `@activefs/source-http/fetch` | [Fetch-compatible server](source-http-transport.md#fetch-compatible-server) |
| Expose local trees, cache state, or exports | `@activefs/local` | [Export](../guides/export.md) and [cache and freshness](../guides/cache-and-freshness.md) |
| Build or inspect the WebDAV/rclone adapter | `@activefs/mount` | [Access adapter reference](access-adapters.md) |
| Embed MCP resources, tools, prompts, or transports | `@activefs/mcp` | [MCP reference](mcp.md) |
| Invoke the package MCP CLI entrypoint | `@activefs/mcp/cli` or `activefs-mcp` | [Standalone MCP CLI options](mcp.md#standalone-cli-options) |
| Use test fixtures | `@activefs/testing` | [Testing](../contributing/testing.md) |
| Register the tree conformance suite | `@activefs/testing/conformance` | [Source API conformance](../contributing/source-api-conformance.md) |
| Embed the main CLI and TUI implementation | `@activefs/cli` | [CLI reference](cli.md) and [TUI guide](../guides/tui.md) |

`@activefs/source-http/fetch`, `@activefs/mcp/cli`, and
`@activefs/testing/conformance` are published subpaths declared by their
package manifests. The package root and a subpath can expose different APIs and
runtime dependencies.

## Reference boundaries

- [Core API](core-api.md) defines the mounted runtime, logical client, shared
  operation types, path helpers, content helpers, and errors.
- [ActiveFSTree authoring](activefs-tree.md) defines declarations, handlers,
  dynamic paths, tree policy, hooks, and committed events.
- [Source API](source-api.md) defines the remote protocol contract. An
  `ActiveFSTree` is not itself the HTTP Source API.
- [Source HTTP transport](source-http-transport.md) defines discovery and the
  Node and Fetch-compatible server adapters.
- [MCP reference](mcp.md) defines MCP configuration, transports, resources,
  tools, prompts, subscriptions, and authorization.
- [CLI reference](cli.md) defines command syntax and exit behavior.

## Generated declaration report

[The API report](api-report.md) is generated from the explicit entrypoint list
in `scripts/generate-api-report.mjs`. It currently tracks these entrypoints:

```txt
activefs
@activefs/core
@activefs/config
@activefs/source-http
@activefs/local
@activefs/mount
@activefs/mcp
@activefs/testing
@activefs/testing/conformance
@activefs/cli
```

The report is a declaration inventory for that tracked list, not an exhaustive
inventory of every published package subpath. In particular,
`@activefs/source-http/fetch` and `@activefs/mcp/cli` are published but are not
separate generator entrypoints today. Check the package manifest and the
subpath-specific reference above when those imports matter.

Do not edit `api-report.md` by hand. Run `pnpm api:report` after a tracked
entrypoint changes and `pnpm api:report:check` to verify that the generated file
is current.
