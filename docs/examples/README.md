# ActiveFS examples

Choose an example by the tree you want to program or the behavior you need to
understand. Each link goes directly to a runnable example README.

If ActiveFS is new to you, complete the [quickstart](../quickstart.md), then
open the `hello-source` README below.

## Start with a live source

| Goal | Example | What it proves |
|---|---|---|
| Serve the smallest useful tree and read it through ActiveFS | [`hello-source`](../../examples/hello-source/README.md) | A few generated files become a Source API tree under `/repo`. |
| Generate current project or service context on read | [`generated-repo-context`](../../examples/generated-repo-context/README.md) | Files can be computed from current state instead of stored on disk. |

For a source in a new npm project rather than this repository, use
[Build a source server](../guides/build-a-source-server.md).

## Program files and directories

| Goal | Example | What it proves |
|---|---|---|
| Understand the smallest in-process filesystem | [`basic-memory`](../../examples/basic-memory/README.md) | An in-memory tree supports list, read, and search. |
| Declare known files and nested directories | [`fs-tree-basic`](../../examples/fs-tree-basic/README.md) | `fsTree` maps sparse and nested declarations to paths. |
| Resolve a large path space by pattern | [`fs-tree-dynamic-paths`](../../examples/fs-tree-dynamic-paths/README.md) | Concrete paths can resolve without enumerating every value. |
| Read non-enumerable user paths safely | [`dynamic-users`](../../examples/dynamic-users/README.md) | Exact dynamic paths and opt-in search can coexist. |
| Add provider-aware search or command behavior | [`fs-tree-command-handlers`](../../examples/fs-tree-command-handlers/README.md) | A source can answer commands better than a generic scan. |
| Explore simple committed writes and change events | [`fs-tree-writable`](../../examples/fs-tree-writable/README.md) | A tree can own writable paths and report committed changes. |

## Shape application data

| Goal | Example | What it proves |
|---|---|---|
| Browse and search logs by service and date | [`logs-tree`](../../examples/logs-tree/README.md) | Log data becomes a navigable file tree with source-owned search. |
| Inspect schemas, rows, and prepared query results | [`database-tree`](../../examples/database-tree/README.md) | Read-oriented database views can appear as files. |
| Browse objects without reading all object bytes | [`object-storage-tree`](../../examples/object-storage-tree/README.md) | Prefixes, metadata, lazy reads, and ranges map naturally to a tree. |
| Review run summaries, logs, reports, and artifacts | [`ci-artifacts-tree`](../../examples/ci-artifacts-tree/README.md) | CI output can use a predictable run hierarchy. |

## Serve and compose sources

| Goal | Example | What it proves |
|---|---|---|
| Run a standalone Source API server | [`remote-tree-server`](../../examples/remote-tree-server/README.md) | A dynamic tree can be served over HTTP. |
| Consume a Source API from code | [`remote-tree-client`](../../examples/remote-tree-client/README.md) | A remote tree can be placed under a logical ActiveFS prefix. |
| Bind Source API to Fetch or framework routes | [`fetch-source-handler`](../../examples/fetch-source-handler/README.md) | Applications choose their discovery and operation URLs. |
| Combine several source endpoints | [`multi-tree-remote`](../../examples/multi-tree-remote/README.md) | Independent remote trees can share one namespace. |
| Expose a local folder through Source API | [`local-bridge-tree`](../../examples/local-bridge-tree/README.md) | A client can browse local files through a separate source runtime. |

## Give an MCP client access

| Goal | Example | What it proves |
|---|---|---|
| List, read, and search an in-process tree through MCP | [`mcp-demo`](../../examples/mcp-demo/README.md) | A real MCP client can browse the same resources through MCP. |
| Expose a configured Source API remote through MCP | [`mcp-source-remote`](../../examples/mcp-source-remote/README.md) | MCP resources and tools can read the same source-owned tree. |

For the complete user workflow, including client configuration and safety, use
[Use an ActiveFS remote with an agent](agents-and-mcp.md).

## Inspect advanced behavior

| Goal | Example | What it proves |
|---|---|---|
| Verify server-authoritative writes and rejection | [`server-authoritative-write-demo`](../../examples/server-authoritative-write-demo/README.md) | A write is final only after the source commits it. |
| Observe requests reaching remote trees | [`remote-mount-monitor`](../../examples/remote-mount-monitor/README.md) | A source service can report client activity without owning an OS mount. |
| Preview a mounted-folder setup before mounting | [`webdav-rclone-mount-demo`](../../examples/webdav-rclone-mount-demo/README.md) | The remote mapping and local workspace can be checked without starting a host mount. |
