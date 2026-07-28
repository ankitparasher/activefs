# Use cases

Use ActiveFS when live application data can form a useful file tree and a
consumer should be able to discover only what it needs.

The recurring pattern is:

```txt
current data -> useful files and directories -> selective discovery and reads
```

This page helps you recognize that fit. Follow the linked examples and guides
only after one of the shapes matches your problem.

## Quick fit check

ActiveFS is likely a good fit when most of these statements are true:

- The source can arrange data into files and directories with stable,
  meaningful names.
- Consumers benefit from listing before they know the exact item to read.
- File contents can be generated or fetched when the file is read.
- A narrow read is more useful than copying the complete dataset.
- The source can remain authoritative for access, freshness, and writes.

Prefer a typed API, database query, or semantic retrieval system when the work
is primarily actions, transactions, joins, or similarity search rather than
hierarchical discovery.

## Generated project or service context

Turn current build, deployment, or service state into predictable files:

```txt
build and service state
  -> /context/build.json
  -> /context/services/payments.md
  -> /context/deployments/latest.md
  -> an agent reads only the context needed for its task
```

This works well when the content should be generated on demand instead of
committed to a repository. Attach source-owned revision or timestamp metadata
when callers need to reason about freshness.

See the [generated context example](../examples/generated-repo-context/README.md).

## Logs

Give services and time ranges a navigable hierarchy:

```txt
log backend
  -> /logs/services/api/2026-07-21.log
  -> /logs/services/worker/2026-07-21.log
  -> a tool lists a service, searches a range, and reads selected lines
```

The tree structure helps discovery; a source-owned index can still handle search
without ActiveFS reading every log file. Keep retention, visibility, and live
tail behavior with the logging source.

See the [logs example](../examples/logs-tree/README.md).

## Object storage

Map buckets, prefixes, objects, and metadata without downloading object bytes
during discovery:

```txt
object storage
  -> /objects/assets/packages/app-1.0.0.tgz
  -> /objects/assets/packages/app-1.0.0.tgz.meta.json
  -> a tool lists prefixes, checks metadata, then reads one object
```

Listing and metadata checks should stay cheap. Fetch content only when the
consumer reads a file, and preserve provider versions or ETags where available.

See the [object storage example](../examples/object-storage-tree/README.md).

## Database read views

Expose selected schemas, rows, and prepared query results as read-oriented
files:

```txt
database
  -> /db/tables/users/rows/42.json
  -> /db/queries/active-users.md
  -> a tool discovers a table and reads an authorized result
```

This shape is useful for inspection and generated views. Keep transactions,
joins, schema changes, and row-level authorization in the database application.

See the [database example](../examples/database-tree/README.md).

## CI artifacts

Arrange runs, logs, reports, and artifacts in a predictable file tree:

```txt
CI provider
  -> /ci/runs/latest/summary.md
  -> /ci/runs/latest/logs/build.log
  -> /ci/runs/latest/reports/coverage.md
  -> a reviewer reads the failed step and only the relevant report
```

The CI provider remains authoritative for retention and access. ActiveFS gives
review tools a predictable tree for finding the useful result.

See the [CI artifacts example](../examples/ci-artifacts-tree/README.md).

## Agent discovery

Present bounded context as a file tree that an agent can explore before reading
it:

```txt
application-owned context
  -> directories and files with stable names
  -> list -> search -> stat -> selective read
  -> the agent cites the paths it used
```

This can reduce the number of provider-specific tools an agent needs for basic
browsing. Keep task-specific actions as typed tools when that is the clearer or
safer interface, and treat file contents as untrusted data rather than
instructions.

See [Use an ActiveFS remote with an agent](examples/agents-and-mcp.md).

## A useful file tree starts small

Start with one current result that a consumer already needs. Give the file a
clear name, make its freshness and access rules explicit, and add neighboring
files only when they improve discovery.

Avoid mirroring an entire provider merely because the data exists. A small,
purposeful file tree is easier to understand, secure, search, and maintain.

## Continue

- [Build a source server](guides/build-a-source-server.md) for the first custom
  source.
- [Integrate your product](guides/integrate-your-product.md) when the data
  belongs to an existing application.
- [Browse the example gallery](examples/README.md) for more data shapes.
- [Review concepts](concepts.md) for the authority and freshness model.
