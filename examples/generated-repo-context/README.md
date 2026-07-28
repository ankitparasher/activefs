# Generate repository context on read

This example exposes generated context under `/repo` even though the files do
not exist on disk. One file is stable fixture context; another reads the
current clock each time.

## Run

From the repository root:

```bash
pnpm --filter @activefs/example-generated-repo-context build
node examples/generated-repo-context/dist/index.js
```

## Expected result

The command prints a `# Repository Context` document and a line shaped like:

```text
Generated timestamp: <current ISO timestamp>
```

## Paths

| ActiveFS path | Result |
|---|---|
| `/repo/context.md` | Generated repository summary |
| `/repo/dynamic/build-info.txt` | Timestamp computed by the read callback |

The clock is injectable so tests can keep the dynamic result deterministic.

## Limits

This fixture does not inspect the current Git checkout. It is read-only and has
no file watcher, incremental refresh, provider revision, or OS mount.

## Next

Run [Hello source](../hello-source/README.md) to serve a computed file through
Source API.
