# Commit in-memory tree writes

This example updates one file, creates another under a writable directory, and
records pre-write, post-write, created, and modified activity.

## Run

From the repository root:

```bash
pnpm --filter @activefs/example-fs-tree-writable build
node examples/fs-tree-writable/dist/index.js
```

## Expected result

The command prints the normalized contents of `/docs/summary.md` and
`/docs/new.md`, followed by an audit line containing both modified and created
events.

## Paths

| Tree path | Behavior |
|---|---|
| `/docs/summary.md` | Existing file changed to `Updated summary` |
| `/docs/new.md` | New file containing `New file` |
| `/docs` | Directory with in-memory `writable: true` behavior |

The pre-write hook adds a trailing newline before the tree commits each write.

## Limits

Writes last only for the lifetime of this process. There is no external store,
authorization, conflict detection, operation-status endpoint, or offline queue.

## Next

Run [Server-authoritative writes](../server-authoritative-write-demo/README.md)
to see committed and rejected writes over Source API.
