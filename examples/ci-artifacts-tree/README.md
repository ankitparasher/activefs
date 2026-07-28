# Browse CI artifacts as files

This example turns one deterministic CI run into a file tree with a summary,
logs, reports, a screenshot placeholder, and an artifact. It shows the shape
without calling a CI provider.

## Run

From the repository root:

```bash
pnpm --filter @activefs/example-ci-artifacts-tree build
node examples/ci-artifacts-tree/dist/index.js
```

## Expected result

The command lists the latest-run directories and log files, reads
`# CI Run 418`, and reports a `source` search strategy with coverage matches.

The example mounts its tree at `/ci`.

## Paths

| ActiveFS path | Result |
|---|---|
| `/ci/runs/latest/summary.md` | Human-readable run summary |
| `/ci/runs/latest/logs/build.log` | Build log |
| `/ci/runs/latest/logs/test.log` | Test log |
| `/ci/runs/latest/reports/coverage.md` | Coverage report |
| `/ci/runs/latest/reports/junit.xml` | JUnit-style report |
| `/ci/runs/latest/artifacts/activefs-0.1.1.tgz.sha256` | Fixture artifact checksum |

## Limits

The data is a read-only fixture, not a GitHub Actions, Buildkite, or CircleCI
connector. It does not implement credentials, live job streaming, retention,
artifact upload, or binary screenshots.

## Next

See [Logs tree](../logs-tree/README.md) for tree-owned search that does not read
every log file.
