# Technical specification

This reference defines the cross-cutting ActiveFS v1 contract: namespace
routing, source authority, opaque context, remote discovery, mutation
finality, and freshness. Package and protocol pages linked below own their
complete TypeScript types, payload schemas, and command options.

## Scope

ActiveFS is a programmable filesystem for live application data. A source maps
paths to current bytes and metadata. ActiveFS combines one or more sources into
a logical namespace and exposes generic filesystem-shaped operations.

ActiveFS is not a hosted storage service, a provider-specific policy engine, a
shell replacement, or a promise of full POSIX filesystem semantics.

## Terms

| Term | Meaning |
|---|---|
| ActiveFS path | Absolute logical path such as `/repo/status.json`. |
| Namespace root | Root of the logical ActiveFS tree, normally `/`. |
| Tree mount | Association between an ActiveFS path prefix and an `ActiveFSTree`. |
| Remote | Configured Source API discovery URL plus local client settings. |
| Source | Tree or remote service that owns path meaning and current content. |
| State root | Hidden client state, normally `.activefs`. |
| OS mountpoint | Optional host-visible directory such as `./repo`. |

A Source API URL, ActiveFS path, OS path, and MCP URI are different identifiers.
See [Path syntax](../path-syntax.md) for their exact forms.

## Authority and isolation

The source is authoritative for:

- which paths exist and are visible;
- file and directory metadata;
- bytes returned by a read;
- provider-native search and dynamic path resolution;
- revisions and cache-scope hints; and
- final mutation authorization and result.

The client owns local configuration, credential acquisition, local safety
policy, adapter processes, and diagnostic state. Local policy and projected
permission modes can deny an operation early, but they cannot grant access that
the source rejects.

Core forwards `auth` and `meta` as opaque generic values. It does not define
actors, roles, tenants, claims, credentials, or policy documents. A tree can
interpret those values because it owns the provider boundary.

Hosted Source API services derive authoritative context from the HTTP request.
When `resolveContext` is configured, request-body `auth` and `meta` are
untrusted and cannot override the resolved context. Isolation keys used for
sessions or caches must be stable, non-secret, and non-reversible; raw tokens,
cookies, credential headers, and email addresses are not valid cache keys.

## Namespace and path routing

ActiveFS paths are normalized absolute logical paths. A path cannot escape the
namespace through `..`, platform separators, or an adapter-specific encoding.

Multiple trees can be mounted below different prefixes. Core selects the
longest matching prefix, so a tree at `/repo/generated` wins for that subtree
over a tree at `/repo`. Operations that cannot preserve one source's final
authority across two selected trees must fail rather than simulate success.

A configured remote normally appears below `/<remote>`. The remote's discovery
URL is transport configuration, not part of the ActiveFS path.

## Tree operation contract

`ActiveFSTree<Auth, Meta>` is the source-author boundary. Its semantic methods
are:

```text
info, list, read, search, walk,
write, remove, makeDir, move, copy, truncate, updateInfo, watch
```

Trees can also provide command handlers, hooks, declarations, and change
events. Adapters translate their own vocabulary into these operations; they do
not rename the tree contract or add provider meaning to core.

Capabilities are explicit. An adapter must not call an optional capability or
claim its behavior when the selected tree does not expose it. Missing metadata
such as byte size or modification time remains absent rather than being
fabricated.

The operation context can include:

```ts
interface ActiveFSContext<Auth = unknown, Meta = unknown> {
  auth?: Auth;
  meta?: Meta;
  traceId?: string;
  signal?: AbortSignal;
  deadlineMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  maxSearchResults?: number;
}
```

`deadlineMs` is an absolute Unix timestamp in milliseconds. Core scan search
and built-in sources enforce cancellation, deadlines, and search-result limits.
Other limits are advisory unless the selected tree or adapter documents that it
enforces them.

The exact authoring and runtime types are in [ActiveFSTree authoring](activefs-tree.md)
and [Core API](core-api.md).

## Reads and computed files

A read returns the content and metadata supplied by the selected tree. A tree
may load stored bytes, call another provider, or compute the value when the path
is read. ActiveFS preserves byte content and applies range behavior only where
the selected tree and adapter support it.

"Live" means the source remains responsible for the current result. It does
not promise push delivery, a fixed refresh interval, or a point-in-time
snapshot.

## Enumeration, dynamic paths, and search

Enumerability and resolvability are independent:

- `list` returns concrete children that the source chooses to enumerate.
- A dynamic route can resolve a known concrete path without listing every
  possible value.
- Recursive scan and full-tree export cannot discover a non-enumerable path
  unless the caller names it or the source supplies search or snapshot
  discovery.

Direct ActiveFS search reports one of three strategies:

| Strategy | Meaning |
|---|---|
| `source` | A source command or source-native search produced the results. |
| `scan` | ActiveFS recursively listed and read enumerable paths. |
| `mixed` | More than one mounted subtree used different strategies. |

Every result reports whether it is complete and gives typed incomplete reasons
when it is not. A mounted OS tool sees normal reads through the mount adapter;
it cannot pass the original `grep` or `rg` command identity to a source handler.

## Source API discovery and delivery

`activefs remote add <name> <url>` treats `<url>` as the exact discovery
document. The client sends `GET` to that URL without adding a suffix, removing
a filename, or rewriting its query.

The discovery document must advertise `stat`, `list`, and `read`. Optional
operation URLs must agree with their advertised capabilities. Version 1 fixes
the method and payload contract for every endpoint key; a discovery document
selects URLs, not methods.

Endpoint safety rules are fail-closed:

- relative references resolve against the final allowed discovery response
  URL;
- same-origin absolute HTTPS references are accepted;
- plain HTTP is accepted automatically only for loopback development;
- non-loopback HTTP requires an explicit insecure opt-in;
- fragments, URL-embedded credentials, unsupported schemes, and unapproved
  cross-origin URLs are rejected; and
- credentials are not forwarded to another origin without a separate explicit
  authorization rule.

Clients follow concrete session, acknowledgement, activity, and operation
status links returned by the service. They do not synthesize resource URLs from
route conventions. The complete endpoint map and schemas are in
[Source API](source-api.md); the shipped Node and Fetch bindings are in
[Source HTTP transport](source-http-transport.md).

## Mutations and concurrency

A successful mutation is synchronous and source-final. ActiveFS does not
report optimistic success followed by later rejection.

Network interruption can leave the client unsure whether a remote mutation
committed. Source API mutations use idempotency keys and can return an
`operationId` with a concrete `operationStatusEndpoint` for resolution. ETags,
representation digests, and source revisions protect concurrent updates where
the source advertises them.

Mutation failures use generic filesystem or Source API errors at the logical
boundary. Adapters translate those errors into CLI exits, HTTP status codes, or
protocol errors without hiding the cause.

ActiveFS v1 has no general offline user-mutation queue. Operation journal
records describe in-flight or ambiguous server-final operations; they do not
authorize later offline writes.

## Sessions, freshness, and cache trust

Source API sessions use server-sent events as a control plane. Events can
describe revisions, path invalidation, configuration or policy changes,
revocation, replay gaps, and required resynchronization. File bytes do not flow
over SSE.

Sequence numbers, `Last-Event-ID`, acknowledgements, bounded replay, and digest
checks let a client detect continuity loss. A verification failure, revoked
session, authorization failure, or unrecoverable gap must downgrade or disable
cache trust.

ActiveFS v1 does not claim a general trusted persistent read cache. Direct
reads continue to call the tree or source. A local TTL, polling probe, rclone
cache, or manual refresh can aid performance or diagnosis, but none establishes
coherent freshness by itself. A mounted view that requires healthy Source API
session coherence must report degraded or unavailable state when that
requirement is not met.

Cache entries that can vary by identity or policy require a safe source-owned
isolation scope. Without one, the adapter must avoid shared reuse.

## Local state and recovery

Unified client configuration lives in `.activefs/config.json`. Per-remote
runtime, session, cache, journal, activity, and adapter state stays below the
state root even when the user selects an external OS mountpoint.

Configuration and diagnostic files must not persist raw credentials, unsafe
server-supplied operation URLs, or unredacted opaque context. Credential command
providers require explicit local approval, argument-vector execution, bounded
runtime and output, and redacted logs.

An activity backlog can retain normalized session activity that still needs to
be reported. Like the operation journal, it is recovery and observability state,
not a copy of source data or an offline mutation queue.

## Adapter requirements

An access adapter must:

- normalize and validate consumer input before calling core;
- construct opaque context at its trusted host boundary;
- respect selected-tree capabilities and source authority;
- preserve exact bytes and incomplete-result metadata;
- translate generic errors without turning unsupported behavior into policy
  denial; and
- redact credentials and opaque identity material from logs and output.

Direct CLI operations and the programmatic client use the logical namespace.
Export writes current bytes to a deliberate local copy. MCP and TUI adapt the
same operations. The optional mounted-folder adapter translates WebDAV and
rclone activity for tools that require an OS path; it does not make WebDAV the
remote source protocol.

See [Access adapters](access-adapters.md) for exact capability and error
mapping, and [CLI](cli.md) for command syntax.

## Explicit support boundaries

ActiveFS v1 does not claim:

- a hosted ActiveFS service or bundled provider accounts;
- native OS installers;
- full POSIX modes, locks, links, extended attributes, or atomic editor-save
  fidelity through WebDAV and rclone;
- discovery of every dynamic non-enumerable path;
- coherent persistent reads without a healthy source-owned isolation and
  session contract;
- a general offline write queue; or
- a fake shell or PATH replacement.

Current runtime and host support is listed in
[Supported environments](supported-environments.md). User-visible limitations
are listed in [Current limits](current-limits.md).
