# Runnable Example Catalog

> Contributor reference for the runnable example checks. If you are learning
> ActiveFS, start with [docs/examples/README.md](examples/README.md) for the
> public learning path and [examples/README.md](../examples/README.md) for the
> source folder index.

The [public example gallery](examples/README.md) groups examples by what a reader
wants to learn. The [source-checkout index](../examples/README.md) groups them
for contributors who are running the repository. Start with `hello-source` in
either index.

This page records the commands checked by `pnpm smoke:examples` and the example
inventory tests.

Run commands in the table from the repository root after `pnpm build`. For
reader-facing setup, use
[Install and build once](../examples/README.md#install-and-build-once).

Run all implemented examples:

```bash
pnpm build
pnpm smoke:examples
```

Run example tests:

```bash
pnpm test:examples
```

## Runnable Examples

| Example | What it shows | Run |
|---|---|---|
| `hello-source` | Tiny Source API source for the first source-authoring loop. | `node examples/hello-source/dist/index.js --once` |
| `fs-tree-basic` | Tree-first declaration with sparse paths, nested directories, and `file`/`text`/`json` helpers. | `node examples/fs-tree-basic/dist/index.js` |
| `fs-tree-dynamic-paths` | Path patterns and `tree.path("/notes/:id")` handlers. | `node examples/fs-tree-dynamic-paths/dist/index.js` |
| `fs-tree-writable` | Writable directory defaults, write hooks, and committed change events. | `node examples/fs-tree-writable/dist/index.js` |
| `fs-tree-command-handlers` | Default text search plus directory/file optional command handlers for search-like operations. | `node examples/fs-tree-command-handlers/dist/index.js` |
| `fetch-source-handler` | Web-standard Request/Response handlers bound to arbitrary Next-style application routes. | `node examples/fetch-source-handler/dist/index.js` |
| `dynamic-users` | An `fsTree` tree with non-enumerable dynamic paths such as `/users/ada.md`. | `node examples/dynamic-users/dist/index.js` |
| `remote-tree-server` and `remote-tree-client` | Source API server/client split over HTTP. | Server: `PORT=3999 node examples/remote-tree-server/dist/index.js`<br>Client: `ACTIVEFS_REMOTE_URL=http://127.0.0.1:3999/_activefs/ node examples/remote-tree-client/dist/index.js` |
| `multi-tree-remote` | Several ActiveFS Source API endpoints composed into one ActiveFS namespace. | `node examples/multi-tree-remote/dist/index.js` |
| `logs-tree` | Service/date log paths with tree-native indexed search and deterministic fixture data. | `node examples/logs-tree/dist/index.js` |
| `database-tree` | Dependency-light schema, row JSON, and generated query result files over an in-memory table fixture. | `node examples/database-tree/dist/index.js` |
| `object-storage-tree` | Buckets/prefixes as directories, object metadata, range reads, lazy object reads, and explicit manual S3 mode outside automated example checks. | `node examples/object-storage-tree/dist/index.js` |
| `ci-artifacts-tree` | CI summaries, logs, reports, screenshots, and artifacts under `/runs/latest`. | `node examples/ci-artifacts-tree/dist/index.js` |
| `local-bridge-tree` | A local fixture folder served by one ActiveFS Source API process and consumed by another ActiveFS filesystem. | `node examples/local-bridge-tree/dist/index.js` |
| `generated-repo-context` | Generated files mounted under `/repo`. | `node examples/generated-repo-context/dist/index.js` |
| `mcp-demo` | Real MCP stdio client/server round trip over the `activefs-mcp` demo fixture. | `node examples/mcp-demo/dist/index.js` |
| `mcp-source-remote` | MCP server backed by a local Source API remote. | `node examples/mcp-source-remote/dist/index.js` |
| `basic-memory` | Minimal in-memory tree with list, read, and source search. | `node examples/basic-memory/dist/index.js` |
| `remote-mount-monitor` | Advanced remote Source API monitor with mounted/unmounted client connection state and file request columns. | `node examples/remote-mount-monitor/dist/index.js` |
| `server-authoritative-write-demo` | Server-final writes, policy rejection, idempotency, and operation status. | `node examples/server-authoritative-write-demo/dist/index.js` |
| `webdav-rclone-mount-demo` | Mounted-folder workspace/config/cache preparation without starting a host mount. | `node examples/webdav-rclone-mount-demo/dist/index.js /tmp/activefs-demo local http://127.0.0.1:3900/_activefs/` |

## Example Principles

- Keep each example concrete and small.
- Do not require external credentials for automated example checks.
- Provide local fixture mode for provider-backed examples.
- Keep output deterministic enough for `pnpm smoke:examples`.
- Document what each example shows and what it does not cover.
