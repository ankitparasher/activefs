# Understand cache and freshness

Use this explanation to decide whether a read is current, whether cached data
can be trusted, and what to inspect when a mounted folder looks stale.

ActiveFS uses **live** to mean that source-backed data is read on demand. It
uses **real-time updates** only when a watch-enabled source has a healthy
session delivering those updates. An export or disconnected cache is not
automatically current.

## Check freshness first

For a configured remote named `repo`, start with:

```bash
activefs remote status repo
activefs sync repo status
activefs cache status repo
```

These checks answer different questions:

- `remote status` confirms the configured source and its advertised support.
- `sync status` reports session and mounted-view freshness when available.
- `cache status` reports local cache state without exposing credentials.

If another tool is reading through a mounted folder, also check:

```bash
activefs mount status repo
```

## Direct reads remain the conservative default

Direct ActiveFS reads ask the tree for data. The source can compute the file
from current application state at read time, and it remains authoritative for
the bytes and metadata returned.

A **coherence signal** is evidence that cached data still matches the source.
Without that evidence, use these cache rules:

- do not treat persistent cached reads as current without a coherence signal;
- do not claim real-time updates without a healthy watch session;
- stop trusting cached content after an unrecoverable event gap, auth failure,
  digest failure, or required resync; and
- prefer an unavailable error over silently serving bytes known to be stale.

An export is a local copy of live reads. Call it a snapshot only when the source
provides a stable revision or snapshot capability.

## Watch sessions can keep caches consistent

A watch-enabled Source API can open a session and deliver ordered invalidation
or change events. This ordered session is the coherence signal. While the
session is healthy, ActiveFS can invalidate local state and refresh affected
mounted subtrees.

If the session disconnects cleanly and can replay the missing events, the client
can recover. If continuity cannot be proved, cached content becomes untrusted
until an authoritative resync completes. Polling can detect changes, but it is
not a substitute for an ordered coherence session.

The [Source API reference](../reference/source-api.md) defines session behavior.
The [HTTP transport reference](../reference/source-http-transport.md) defines
event streaming, authentication, replay, and integrity checks.

## Context-sensitive data needs cache isolation

Results can vary by identity, tenant, policy, feature flag, or request metadata.
A shared cache may reuse those results only when the tree or host supplies a
safe opaque scope that keeps contexts isolated.

Never put raw tokens, cookies, JWTs, email addresses, or policy documents in a
cache key. If no safe opaque scope exists, avoid shared persistent caching for
that data.

Exact tree cache hints belong in the
[ActiveFSTree reference](../reference/activefs-tree.md). Exact local and mount
cache types are listed in the [generated API report](../reference/api-report.md).

## Mounted folders add cache layers

A mounted read can pass through the provider, ActiveFS, WebDAV, rclone, and the
operating system or tool. Each layer can affect what the user observes.

ActiveFS keeps mounted reads uncached by default so file reads ask the source
for current bytes. The `--cache` mount option enables rclone's repeated-read
cache for tools that benefit from it; it does not turn polling or a local TTL
into a source coherence guarantee.

When a session event invalidates a path, ActiveFS clears the corresponding local
state and asks the active mount adapter to refresh that subtree. If refresh
fails, status should expose the stale or unavailable condition.

For exact mount cache modes, status fields, and adapter guarantees, use the
[access adapter reference](../reference/access-adapters.md) and
[CLI reference](../reference/cli.md).

## Refresh or clear local state deliberately

Normal mounted use should rely on server-backed reads and automatic
invalidation. If a mounted subtree still looks stale, inspect it before forcing
a refresh:

```bash
activefs sync repo status
activefs mount status repo
```

Refresh one subtree when you have a reason to revalidate it:

```bash
activefs sync repo refresh /docs --recursive
```

Clear local cache material only when diagnosis or recovery requires it:

```bash
activefs cache clear repo
activefs cache clear repo --path /docs --recursive
```

Manual refresh and cache clearing are recovery actions. They do not create a
real-time guarantee and should not hide a broken or unauthenticated watch
session.

## Interpret an untrusted state conservatively

If status reports an untrusted, resyncing, disconnected, or stale state:

1. Treat the source as authoritative.
2. Do not rely on persistent cached reads as current.
3. Check Source API authentication and session continuity.
4. Re-establish the session or perform an authoritative resync.
5. Confirm healthy status before making a coherence claim.

If only one user sees incorrect search results, check cache isolation before
clearing everything. Search results must never be shared across identities
without a safe opaque scope.

## Exact commands and contracts

- [CLI reference](../reference/cli.md): `sync`, `cache`, mount status, and exact
  command forms.
- [Source API reference](../reference/source-api.md): sessions, changes, and
  freshness capabilities.
- [Access adapter reference](../reference/access-adapters.md): mounted-cache and
  rclone behavior.
- [Current limits](../reference/current-limits.md): current freshness and mount
  claims.
