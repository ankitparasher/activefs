# Verify server-authoritative writes

This example proves that a Source API write is final only after the server
commits or rejects it and exposes the resulting operation status.

## Run

From the repository root:

```bash
pnpm --filter @activefs/example-server-authoritative-write-demo build
node examples/server-authoritative-write-demo/dist/index.js
```

The executable starts and closes its own loopback server.

## Expected result

The printed JSON reports:

- `"serverFinal": true`;
- `"writablePath": "/uploads/accepted.txt"`;
- `"readonlyRejected": true`;
- operation IDs for the succeeded and failed writes;
- `"offlineQueue": false`.

## Paths

| Source path | Behavior |
|---|---|
| `/uploads/accepted.txt` | Created and committed by the server |
| `/README.md` | Existing file whose write is rejected with `FORBIDDEN` |

The successful client call uses an idempotency key, then fetches operation
status. The rejected error also carries an operation reference whose status is
`failed`.

## Limits

The server and operation map are in memory. The example has no provider
transaction, conflict resolution, multi-client synchronization, durable
operation store, mounted-editor flow, or offline write queue.

## Next

Read the [Source API reference](../../docs/reference/source-api.md) for mutation
and operation-status contracts.
