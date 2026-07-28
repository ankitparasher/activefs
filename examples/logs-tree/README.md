# Search logs without reading every file

This example presents service and date logs as files while a tree-owned line
index answers search. It proves that search can avoid opening each log object.

## Run

From the repository root:

```bash
pnpm --filter @activefs/example-logs-tree build
node examples/logs-tree/dist/index.js
```

## Expected result

The command lists the API log days, reports `search strategy: source`, and
prints:

```text
log read calls during search: 0
```

It then reads the first line of the selected API log.

## Paths

| ActiveFS path | Result |
|---|---|
| `/logs/services/api/2026-06-26.log` | API log day |
| `/logs/services/api/2026-06-25.log` | Earlier API log day |
| `/logs/services/worker/2026-06-26.log` | Worker log day |

The fixture version is `logs-fixture-2026-06-26-v1`.

## Limits

This is a static, read-only fixture. It does not implement live tailing,
provider credentials, retention, writeback, binary attachments, or an OS
mount.

## Next

See [CI artifacts](../ci-artifacts-tree/README.md) for another provider-shaped
tree with logs, reports, and artifacts.
