# Compose multiple remote trees

This example mounts three Source API clients under stable prefixes in one
process-local ActiveFS namespace.

## Run

From the repository root:

```bash
pnpm --filter @activefs/example-multi-tree-remote build
node examples/multi-tree-remote/dist/index.js
```

## Expected result

The command prints three directories:

```text
directory /docs
directory /logs
directory /metrics
```

Listing the composition root does not contact the configured endpoints. A
request below one prefix is routed to that prefix's Source API client.

## Paths

| ActiveFS prefix | Example Source API URL |
|---|---|
| `/docs` | `http://127.0.0.1:3921/_activefs/` |
| `/logs` | `http://127.0.0.1:4121/_activefs/` |
| `/metrics` | `http://127.0.0.1:4021/_activefs/` |

## Limits

The example URLs are configuration fixtures; the standalone command does not
start those servers. The composition layer adds no discovery, credentials,
cross-tree transaction, search ranking, cache, or write policy.

## Next

Use the [remote server](../remote-tree-server/README.md) and
[remote client](../remote-tree-client/README.md) for a live paired Source API
flow.
