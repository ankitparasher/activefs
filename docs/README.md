# ActiveFS documentation

ActiveFS gives live application data a programmable filesystem shape. Use this
page after the demo or your first successful read to choose the task you need
next.

## Recommended path

If ActiveFS is new to you, follow this sequence:

1. [Try the demo](quickstart.md) and browse its tree.
2. [Build one computed file](guides/build-a-source-server.md) from your own
   current data.
3. [Check whether your data fits](use-cases.md).
4. Continue with one task under **Use a tree** or **Build a tree** below.

Consult reference pages only when you need an exact command, API, protocol, or
limit.

## Start

- [Quickstart](quickstart.md): complete the shortest installed-CLI tutorial.
- [Concepts](concepts.md): understand the programmable file tree and source
  authority.
- [Use cases](use-cases.md): recognize useful data shapes and trade-offs.

## Build a tree

- [Build a source server](guides/build-a-source-server.md): program and serve
  your first live file.
- [Integrate your product](guides/integrate-your-product.md): expose one useful
  application-owned data slice.
- [Add dynamic routes](guides/dynamic-routes.md): resolve large or
  non-enumerable path spaces.
- [Test a source](contributing/source-api-conformance.md): validate tree and
  transport behavior.
- [Explore examples](examples/README.md): choose a runnable pattern by goal.

## Use a tree

- [Connect a source](guides/connect-a-source.md): configure an existing Source
  API service.
- [Search](guides/search-and-grep.md): find content through a configured tree.
- [Give an agent access](examples/agents-and-mcp.md): follow a selective
  list/search/stat/read workflow.
- [Configure MCP](guides/mcp.md): connect an MCP-native client.
- [Export local files](guides/export.md): copy current live reads for a
  local-file-only tool.
- [Browse in the TUI](guides/tui.md): inspect a tree interactively.
- [Use ActiveFS on Windows](guides/windows.md): use PowerShell, export, and the
  optional rclone plus WinFsp mount path.
- [Mount a folder](guides/mounted-folder.md): add OS-visible paths only when a
  consumer requires them.
- [Choose an access method](guides/access-surfaces.md): compare direct commands,
  application code, MCP, export, the TUI, and mounting.

## Understand behavior

- [Security and identity](guides/security-and-identity.md): decide where
  credentials and policy belong.
- [Cache and freshness](guides/cache-and-freshness.md): understand when data can
  be trusted as current.
- [Architecture](reference/architecture.md): see how sources, core, and access
  adapters fit together.
- [Troubleshooting](troubleshooting.md): diagnose failures by symptom and layer.

## Reference

- [CLI](reference/cli.md)
- [Path forms](path-syntax.md)
- [ActiveFSTree authoring](reference/activefs-tree.md)
- [Core API](reference/core-api.md)
- [Source API](reference/source-api.md)
- [Source HTTP transport](reference/source-http-transport.md)
- [MCP](reference/mcp.md)
- [Access adapters](reference/access-adapters.md)
- [API reference index](reference/api.md)
- [Generated API inventory](reference/api-report.md)
- [Supported environments](reference/supported-environments.md)
- [Current limits](reference/current-limits.md)
- [Versioning](reference/versioning.md)

## Contribute

- [Contributor guide](contributing/README.md)
- [Testing documentation](contributing/testing.md)
- [Runnable example catalog](examples.md)
- [Repository contribution policy](../CONTRIBUTING.md)
