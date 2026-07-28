# Run the ActiveFS examples

This index is for contributors and developers working from an ActiveFS source
checkout. Install and build the workspace once, run `hello-source` first, then
open the README for the example you need.

For a public, goal-led overview, use the
[example gallery](../docs/examples/README.md).

## Install and build once

Run these commands from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
```

## Run `hello-source` first

The deterministic mode checks the smallest Source API tree without leaving a
server running:

```console
$ node examples/hello-source/dist/index.js --once

hello-source entries: /README.txt, /bin, /data, /notes
hello-source read: Hello from an ActiveFS Source API tree.
hello-source matches: /notes/source-api.txt:1
```

Continue with the [`hello-source` README](hello-source/README.md) to keep the
server running, connect it as `/repo`, and read its computed status through
ActiveFS.

## Tree authoring examples

| Directory | Purpose |
|---|---|
| [`basic-memory`](basic-memory/README.md) | Minimal in-process list, read, and search. |
| [`fs-tree-basic`](fs-tree-basic/README.md) | Known files, sparse paths, and nested directories. |
| [`fs-tree-dynamic-paths`](fs-tree-dynamic-paths/README.md) | Dynamic path patterns. |
| [`dynamic-users`](dynamic-users/README.md) | Non-enumerable exact paths and opt-in search. |
| [`fs-tree-command-handlers`](fs-tree-command-handlers/README.md) | Optional source command handlers. |
| [`fs-tree-writable`](fs-tree-writable/README.md) | In-memory writes and committed change events. |

## Application-data examples

| Directory | Purpose |
|---|---|
| [`generated-repo-context`](generated-repo-context/README.md) | Generated files computed from current state. |
| [`logs-tree`](logs-tree/README.md) | Log files and source-owned search. |
| [`database-tree`](database-tree/README.md) | Schema, row, and prepared-query files. |
| [`object-storage-tree`](object-storage-tree/README.md) | Prefixes, object metadata, and lazy reads. |
| [`ci-artifacts-tree`](ci-artifacts-tree/README.md) | CI summaries, logs, reports, and artifacts. |

## Source API examples

| Directory | Purpose |
|---|---|
| [`hello-source`](hello-source/README.md) | First editable Source API server and CLI loop. |
| [`remote-tree-server`](remote-tree-server/README.md) | Standalone Source API server. |
| [`remote-tree-client`](remote-tree-client/README.md) | Programmatic Source API client. |
| [`fetch-source-handler`](fetch-source-handler/README.md) | Fetch-compatible and framework-owned routes. |
| [`multi-tree-remote`](multi-tree-remote/README.md) | Several remote trees in one namespace. |
| [`local-bridge-tree`](local-bridge-tree/README.md) | Local folder served and consumed through Source API. |

## MCP examples

| Directory | Purpose |
|---|---|
| [`mcp-demo`](mcp-demo/README.md) | Package-level MCP server over a fixture tree. |
| [`mcp-source-remote`](mcp-source-remote/README.md) | MCP server over a configured Source API remote. |

## Advanced runtime examples

| Directory | Purpose |
|---|---|
| [`server-authoritative-write-demo`](server-authoritative-write-demo/README.md) | Source-committed writes and policy rejection. |
| [`remote-mount-monitor`](remote-mount-monitor/README.md) | Remote request activity and connection monitoring. |
| [`webdav-rclone-mount-demo`](webdav-rclone-mount-demo/README.md) | Mount-adapter preparation without a host mount. |

## Run the example checks

Run the deterministic automated check for every documented example:

```bash
pnpm smoke:examples
```

Run the example test suites:

```bash
pnpm test:examples
```
