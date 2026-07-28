# Add source-owned command handlers

This example shows where a tree can answer semantic search, `grep`, or `rg`
better than generic text traversal.

## Run

From the repository root:

```bash
pnpm --filter @activefs/example-fs-tree-command-handlers build
node examples/fs-tree-command-handlers/dist/index.js
```

## Expected result

The output demonstrates four search cases:

- normal text search finds `/docs/text.txt`;
- image search returns `OCR label: architecture diagram`;
- the `/docs` `rg` handler returns `directory index hit`;
- the image `grep` handler returns `visual label grep hit`.

## Paths

| Tree path | Behavior |
|---|---|
| `/docs/text.txt` | Uses the default text-search behavior |
| `/docs` | Overrides `rg` with a directory index result |
| `/images/diagram.png` | Overrides semantic search and `grep` |

Handlers are optional. When a command handler is absent, ActiveFS uses its
semantic mapping and default behavior.

## Limits

The handlers return deterministic fixture results. This example has no OCR
service, external index, ranking, provider credentials, cross-tree aggregation,
or mounted-shell command passthrough.

## Next

See [Logs tree](../logs-tree/README.md) for a source-owned index over multiple
files.
