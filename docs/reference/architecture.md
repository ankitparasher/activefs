# Architecture

Use this explanation to understand how ActiveFS turns live application state
into files and directories. It describes where meaning, authority, routing, and
access belong; the exact TypeScript and wire contracts live in the linked
reference pages.

## The model

An ordinary filesystem resolves a path to stored bytes. An ActiveFS source can
resolve the same path from current application state:

```text
path + opaque request context + current source state -> bytes and metadata
```

That gives existing filesystem-shaped workflows a programmable file tree:

```text
application or provider data
        |
        v
ActiveFSTree or remote Source API service
        |
        v
ActiveFS namespace (file tree) and operation engine
        |
        v
direct commands, application code, or an optional access adapter
```

The core product is a programmable filesystem view of current data. The
ActiveFS namespace presents that view as a file tree, and paths identify items
inside it. HTTP, MCP, TUI, export, and an OS mount are ways to use the file tree;
none of them decides what a source path means.

## Responsibility boundaries

| Boundary | Owns | Does not own |
|---|---|---|
| Source or `ActiveFSTree` | Path meaning, current bytes, metadata, provider search, visibility, and final mutation decisions | Consumer protocols or another source's paths |
| ActiveFS core | Path normalization, longest-prefix routing, generic operations, capability checks, scan fallback, and generic errors | Identity, tenant logic, provider policy, or rendered business content |
| Source API transport | Discovery, request and response encoding, endpoint safety, and remote operation delivery | WebDAV behavior or local credential selection by a remote service |
| Access adapter | Consumer input, opaque context construction, core calls, and result formatting | Provider-specific path semantics or final authorization |

Core deliberately treats `auth` and `meta` as opaque. A source can interpret
them because it owns its provider rules. Core and generic adapters cannot turn
them into fixed user, agent, role, tenant, or policy types.

## Local and remote trees

An in-process tree and a remote source join the same logical namespace.

```text
in-process read
caller -> ActiveFS core -> ActiveFSTree

remote read
caller -> ActiveFS core -> Source API client -> source service -> ActiveFSTree
```

For a remote, the configured URL is the exact discovery document. The document
advertises the operation URLs; ActiveFS does not infer a route prefix. A hosted
application can therefore bind discovery and operations to its own routes.

The Source API is the remote tree protocol. WebDAV is a separate, local access
adapter used only when a consumer needs an OS-visible folder. A source server
does not need to implement WebDAV.

## How a read becomes current bytes

Consider a source that exposes `/status.json` from current service state:

1. A caller asks ActiveFS to read `/service/status.json`.
2. The access boundary normalizes the input and builds an
   `ActiveFSContext<Auth, Meta>`.
3. Core selects the most specific tree mounted below `/service`.
4. The tree checks source-owned visibility and resolves `/status.json`.
5. Its read callback loads or computes the current value.
6. The result returns through the same boundary as bytes and metadata.

This is why a file can be live without being copied into a second store first.
ActiveFS does not imply that every source pushes updates continuously; it means
the source controls what a read returns now.

## Enumeration and search

Resolvable and enumerable paths are different. A tree can resolve a known path
such as `/users/42/profile.json` without listing every possible user below
`/users`.

Direct ActiveFS search uses the strongest available strategy:

```text
source command or source search
        |
        v
recursive ActiveFS list/read scan when the tree is enumerable and readable
```

A result says whether it came from the source, a scan, or both, and whether it
is complete. A scan cannot discover non-enumerable concrete paths. OS tools run
against a mounted folder by reading files, so a command such as `rg` cannot
carry its original search intent through WebDAV to a source handler.

## Writes stay source-authoritative

Adapters may apply local safety policy before attempting a mutation, but the
tree or remote service makes the final decision. A local permission projection
can help an OS tool display a mode; it is not proof that the next write will be
accepted.

Successful mutations are synchronous and source-final. When a network failure
makes the outcome ambiguous, the Source API returns an operation identifier and
a concrete status URL rather than inventing optimistic success. ActiveFS keeps
recovery records for ambiguous operations, not a general offline user-write
queue.

## Freshness and cache trust

Direct reads call the selected tree or remote service. Cache layers may improve
performance only when they preserve source isolation and can state their trust
level honestly.

Source API sessions use server-sent events for control information such as
invalidations, revisions, revocation, replay gaps, and resynchronization. File
bytes do not travel over the session stream. Polling and a local cache TTL are
diagnostic or performance mechanisms, not proof of coherent freshness.

If a mounted view depends on coherent session state and that state becomes
unhealthy, ActiveFS must stop trusting cached reads and surface the degraded or
unavailable state. It must not silently present stale data as current.

## Access does not change authority

The direct CLI and programmatic client call the logical namespace without an OS
mount. Export writes a deliberate local copy. TUI and MCP adapt the same
operations for interactive and agent clients. The optional mounted-folder path
adds WebDAV, rclone, and a host mount backend for tools that require a normal OS
path.

Those interfaces can have different capability limits, but all route back to
the same source-owned data and authorization boundary.

## Failure boundaries

The architecture makes incomplete behavior visible:

- A non-enumerable path is not discoverable by recursive scan or full-tree
  export unless the source provides another discovery mechanism.
- Missing size or timestamp information stays absent instead of being
  invented.
- Search falls back to list/read only when the tree can enumerate and read the
  relevant paths.
- Cross-source operations fail when they cannot preserve source-final mutation
  semantics.
- Mount, cache, session, and provider failures remain distinct so operators can
  identify the failing layer.
- Credentials and raw opaque context must not leak into cache keys, logs,
  manifests, or public errors.

## Exact contracts

- [Technical specification](technical-specification.md): normative
  cross-cutting behavior and authority rules.
- [ActiveFSTree authoring](activefs-tree.md): source-author contract.
- [Core API](core-api.md): logical filesystem operations and helpers.
- [Source API](source-api.md): language-neutral remote protocol.
- [Source HTTP transport](source-http-transport.md): shipped Node and Fetch
  bindings.
- [Access adapters](access-adapters.md): adapter capabilities and error mapping.
