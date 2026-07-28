# Concepts

ActiveFS gives live application data a programmable filesystem shape. A source
decides which paths exist and computes their contents from its current state
when they are accessed.

```txt
normal filesystem: path -> stored bytes
ActiveFS:          path + current source state -> computed bytes
```

The result is a file tree that agents and tools can browse with familiar file
and directory operations without ActiveFS first copying the data into a new
store.

## A programmable file tree

An ActiveFS source arranges application concepts as files and directories:

```txt
current service state
  -> /services/payments/status.json
  -> /services/payments/runbooks/recovery.md
  -> /deployments/latest/summary.md
```

Reading `/services/payments/status.json` can call current application logic and
return newly computed JSON. Other paths can return stored objects, database
rows, generated context, logs, or any bytes the source can provide safely.

The source-backed tree remains a filesystem-shaped interface: directories can
be listed, files can be inspected and read, and searchable sources can answer
queries. The bytes do not have to exist as files on the source server.

## How consumers use the file tree

A file tree lets a consumer discover data progressively:

```txt
list -> search -> stat when useful -> selective read
```

An agent can start with one narrow directory, search for likely matches, check
metadata when size or type matters, and read only the useful files. This keeps
the search organized and limits how much data the consumer must load.

The same shape also works well for scripts and applications that benefit from
stable names and directory structure. Agents are a strong use case, but they
are not the only one.

## The source stays authoritative

The source owns:

- the underlying data and namespace;
- which paths each caller can see;
- the bytes and metadata returned for a path;
- freshness, search behavior, and cache hints; and
- whether a write is accepted and committed.

ActiveFS routes filesystem-shaped operations and exposes the tree to
consumers. It does not become the database, storage service, permission system,
or synchronization authority.

Identity and request metadata remain opaque to the generic ActiveFS core. The
source interprets that context and enforces its own policy.

## Live reads and freshness

Source-backed data is **live** when ActiveFS reads it from current source state
on demand. That does not mean every consumer is always current.

- Direct reads ask the tree for the path.
- An export is a local copy of bytes read from the live tree.
- A mounted folder can include host and adapter caches.
- Real-time updates require a watch-enabled source and a healthy update
  session.

See [Cache and freshness](guides/cache-and-freshness.md) for the exact trust and
coherence boundaries.

## Sources, remotes, and paths

A source implements an `ActiveFSTree`. Source API carries that tree across an
HTTP boundary. Connecting the Source API URL creates a local remote whose name
becomes the first segment of an ActiveFS path.

```txt
application data -> ActiveFSTree -> Source API -> remote named repo -> /repo
```

The source service and the configured remote are different things. An ActiveFS
path such as `/repo/status.json` is also different from an OS path or an MCP
resource URI. See [Path syntax](path-syntax.md) for the exact forms.

## When a filesystem shape fits

ActiveFS is a good fit when the data has a useful hierarchy, consumers need to
discover it selectively, and a file tree is a natural representation.

Another interface may be better when:

- the whole task is a small set of typed actions;
- transactions, joins, or ad hoc queries are the main requirement;
- semantic retrieval over a large unstructured corpus is the primary need; or
- the consumer requires full POSIX behavior or bidirectional synchronization.

These tools can be combined. A product can expose browsable context through
ActiveFS while keeping typed actions, database queries, or semantic retrieval
for the work they handle better.

## Continue

- [Try the demo](quickstart.md).
- [Recognize a fitting use case](use-cases.md).
- [Build a source server](guides/build-a-source-server.md).
- [Choose an access method](guides/access-surfaces.md).
- [Check current limits](reference/current-limits.md).
