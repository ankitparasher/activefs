# Core API

`@activefs/core` provides the in-process filesystem runtime, logical client,
shared operation types, path and content helpers, and stable errors.

An `ActiveFSTree` is the runtime's in-process tree contract. It is not the
Source API. Source API is the separate HTTP protocol and transport used to
expose a tree across a process or network boundary. See
[ActiveFSTree authoring](activefs-tree.md) and [Source API](source-api.md) for
those contracts.

## Create a runtime

```ts
export function createActiveFS<Auth = unknown, Meta = unknown>(): ActiveFS<Auth, Meta>;
```

`createActiveFS()` returns an empty runtime. Add trees with
`filesystem.mount(prefix, tree)`. Mount prefixes are normalized, and the most
specific matching prefix handles an operation. Mounting another tree at the
same prefix replaces the previous tree.

The `ActiveFS<Auth, Meta>` runtime exposes these operations. Every operation
except `mount` receives an `ActiveFSContext<Auth, Meta>` first.

| Method | Return type | Behavior |
|---|---|---|
| `mount(prefix, tree)` | `ActiveFS<Auth, Meta>` | Mount or replace a tree at a normalized prefix. |
| `stat(context, path)` | `Promise<ActiveFSStat<Meta> \| null>` | Return tree or virtual-parent metadata; return `null` when absent. |
| `list(context, path)` | `Promise<ActiveFSDirEntry<Meta>[]>` | List a tree directory or a virtual parent assembled from descendant mounts. |
| `read(context, path, options?)` | `Promise<ActiveFSReadResult<Meta>>` | Read all or part of a file. |
| `search(context, path, query)` | `Promise<ActiveFSSearchResult<Meta>>` | Use source search or ActiveFS list/read scanning. |
| `command(context, command, path, input)` | `Promise<ActiveFSCommandResultMap<Meta>[Command]>` | Use an optional command handler or its semantic default. |
| `write(context, path, content, options?)` | `Promise<ActiveFSWriteResult<Meta>>` | Ask the resolved tree to commit file content. |
| `delete(context, path, options?)` | `Promise<ActiveFSDeleteResult<Meta>>` | Remove a file or directory through tree policy. |
| `mkdir(context, path, options?)` | `Promise<ActiveFSMkdirResult<Meta>>` | Create a directory through tree policy. |
| `rmdir(context, path, options?)` | `Promise<ActiveFSDeleteResult<Meta>>` | Remove a directory through the tree's remove operation. |
| `rename(context, fromPath, toPath, options?)` | `Promise<ActiveFSRenameResult<Meta>>` | Rename within one mounted tree; reject cross-tree moves. |
| `copy(context, fromPath, toPath, options?)` | `Promise<ActiveFSCopyResult<Meta>>` | Copy within one mounted tree; reject cross-tree copies. |
| `truncate(context, path, options?)` | `Promise<ActiveFSTruncateResult<Meta>>` | Change a file's length through tree policy. |
| `updateMetadata(context, path, options)` | `Promise<ActiveFSMetadataUpdateResult<Meta>>` | Update times, type, or opaque metadata through `tree.updateInfo`. |
| `watch(context, path, onEvent, options?)` | `Promise<ActiveFSWatchSubscription>` | Subscribe to tree events mapped into mounted paths. |

Paths without a matching tree fail with `NOT_MOUNTED`, except virtual parents
created by descendant mount prefixes. Tree-local paths and returned metadata
are mapped back into the mounted namespace.

Mutation preconditions and idempotency values are forwarded to the tree. Core
does not decide whether a backend write is authorized or committed.

## Logical client

```ts
export function createActiveFSClient<Auth = unknown, Meta = unknown>(
  filesystem: ActiveFS<Auth, Meta>,
  options?: ActiveFSClientOptions<Auth, Meta>
): ActiveFSLogicalClient<Meta>;
```

The logical client is a promise-based, `fs/promises`-like facade over the same
runtime. It does not use an OS mount.

| Methods | Purpose |
|---|---|
| `readdir`, `stat`, `readFile` | List, inspect, and read logical paths. |
| `writeFile`, `mkdir`, `rm`, `rmdir` | Create, update, and remove content through tree policy. |
| `rename`, `copyFile`, `truncate`, `utimes` | Apply same-tree moves/copies and metadata changes. |
| `search`, `watch` | Use semantic search and watch operations. |
| `command` | Invoke a typed command name and input. |
| `ls`, `cat`, `head`, `tail`, `sed`, `grep`, `rg`, `find` | Invoke command-aware helpers or their semantic defaults. |

`client.stat(path)` differs from `filesystem.stat(context, path)`: the client
throws `NOT_FOUND` instead of returning `null` for an absent path.

`ActiveFSClientOptions` accepts either one context or a context factory that is
evaluated for every operation. `onOperation` and `onActivity` receive an
`ActiveFSClientOperationEvent` after success or failure. Hook errors propagate
to the caller.

```ts
export interface ActiveFSClientOptions<Auth = unknown, Meta = unknown> {
  context?: ActiveFSContext<Auth, Meta> |
    (() => MaybePromise<ActiveFSContext<Auth, Meta>>);
  onOperation?: (event: ActiveFSClientOperationEvent<Meta>) => MaybePromise<void>;
  onActivity?: (event: ActiveFSClientOperationEvent<Meta>) => MaybePromise<void>;
}
```

## Request context

```ts
export interface ActiveFSContext<Auth = unknown, Meta = unknown> {
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

Core forwards `auth` and `meta` without parsing, persisting, logging, or making
authorization decisions from them. `deadlineMs` is an absolute Unix timestamp
in milliseconds.

Core scans and built-in sources enforce search cancellation, `deadlineMs`, and
`maxSearchResults`. Other limit fields are advisory unless the selected tree or
adapter documents enforcement.

## Entries and capabilities

```ts
export interface ActiveFSDirEntry<Meta = unknown> {
  name: string;
  path: ActiveFSPath;
  kind: "file" | "directory";
  capabilities?: ActiveFSCapabilities;
  size?: number;
  mtimeMs?: number;
  mimeType?: string;
  enumerable?: boolean;
  meta?: Meta;
}

export interface ActiveFSStat<Meta = unknown>
  extends ActiveFSDirEntry<Meta> {
  etag?: string;
  revision?: string;
}
```

`ActiveFSCapabilities` can describe semantic operations, command handlers, and
convenience flags:

```ts
export interface ActiveFSCapabilities {
  stat?: boolean;
  list?: boolean;
  read?: boolean;
  search?: boolean;
  create?: boolean;
  write?: boolean;
  truncate?: boolean;
  delete?: boolean;
  mkdir?: boolean;
  rmdir?: boolean;
  rename?: boolean;
  copy?: boolean;
  updateMetadata?: boolean;
  watch?: boolean;
  readable?: boolean;
  writable?: boolean;
  searchable?: boolean;
  watchable?: boolean;
  rangeReadable?: boolean;
  commands?: ActiveFSTreeCommand[];
}
```

Capabilities are descriptive, not authorization grants. The resolved tree can
still reject a request for the supplied opaque context or current backend
state.

## Search and commands

```ts
export interface ActiveFSSearchQuery {
  pattern: string;
  caseSensitive?: boolean;
  maxResults?: number;
  includeNonEnumerable?: boolean;
}

export interface ActiveFSSearchResult<Meta = unknown> {
  matches: ActiveFSSearchMatch<Meta>[];
  complete: boolean;
  strategy: "source" | "scan" | "mixed";
  incompleteReasons?: ActiveFSSearchIncompleteReason[];
}
```

If a resolved tree provides source search, the runtime uses it. Otherwise the
runtime scans enumerable paths through recursive list and read operations.
`strategy`, `complete`, and `incompleteReasons` describe how the result was
produced and whether it is exhaustive.

Command-aware operations use these semantic defaults when a tree does not
provide a more specific handler:

| Commands | Default operation |
|---|---|
| `ls` | `list` |
| `stat` | `info` |
| `cat`, `head`, `tail`, `sed` | `read` plus the command transform |
| `grep`, `rg` | `search` |
| `find` | `walk` |

## Path helpers

ActiveFS paths use `/` separators and normalize to an absolute path. Empty and
`.` segments are removed, `..` walks toward `/` without escaping it, and a
trailing slash is removed except at the root.

```ts
normalizeActiveFSPath(path: string): ActiveFSPath
joinActiveFSPath(parent: string, child: string): ActiveFSPath
parentActiveFSPath(path: string): ActiveFSPath
isActiveFSPathWithin(root: string, path: string): boolean
matchesActiveFSWatchRoot(
  root: string,
  path: string,
  options?: { recursive?: boolean }
): boolean
```

`matchesActiveFSWatchRoot` matches the watched path or an immediate child by
default. Set `recursive: true` to include deeper descendants.

## Content helpers

```ts
activeFSContentToBytes(content: string | Uint8Array): Uint8Array
copyActiveFSBytes(bytes: Uint8Array): Uint8Array
sliceActiveFSContent(
  content: string | Uint8Array,
  options?: ActiveFSReadOptions
): string | Uint8Array
activeFSContentByteLength(content: string | Uint8Array): number
```

- `activeFSContentToBytes` returns a defensive byte copy.
- `copyActiveFSBytes` copies caller-provided bytes.
- `sliceActiveFSContent` applies byte-oriented offsets, lengths, and the
  `utf8`, `base64`, or `binary` encoding.
- `activeFSContentByteLength` uses UTF-8 byte length for strings.

## Errors

Operational failures use `ActiveFSError` and one of these stable codes:

```txt
NOT_FOUND
NOT_MOUNTED
NOT_DIRECTORY
NOT_FILE
INVALID_PATH
INVALID_REQUEST
UNAUTHORIZED
FORBIDDEN
CONFLICT
PRECONDITION_FAILED
TRANSIENT
UNSUPPORTED
SOURCE_ERROR
```

`ActiveFSNotFoundError`, `ActiveFSNotMountedError`,
`ActiveFSNotDirectoryError`, `ActiveFSNotFileError`, and
`ActiveFSInvalidPathError` provide common typed failures.
`ActiveFSTreeError` maps an unexpected tree failure to `SOURCE_ERROR`.

For the complete declaration and field inventory from the tracked core
entrypoint, use the generated [API report](api-report.md#activefscore).
