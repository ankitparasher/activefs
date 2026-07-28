# ActiveFSTree authoring

`ActiveFSTree<Auth, Meta>` is the in-process contract for mapping source-owned
data to paths, metadata, content, search, mutations, and change events. Most
authors create one with `fsTree(...)` and override only the behavior their
source needs.

An `ActiveFSTree` is not the Source API. Source API is the separate HTTP
protocol that can expose a tree to remote consumers. See
[Source API](source-api.md) and [Source HTTP transport](source-http-transport.md)
for that boundary.

## Authoring entrypoints

These helpers are exported from `@activefs/core`:

```ts
fsTree<Auth = unknown, Meta = unknown>(
  declaration?: ActiveFSTreeDeclaration<Auth, Meta>,
  options?: ActiveFSTreeOptions<Auth, Meta>
): ActiveFSTree<Auth, Meta>

file<Auth = unknown, Meta = unknown>(
  options?: ActiveFSTreeFileDeclarationOptions<Auth, Meta>
): ActiveFSTreeFileDeclaration<Auth, Meta>

file<Auth = unknown, Meta = unknown>(
  options: ActiveFSTreeFileDeclarationOptions<Auth, Meta>,
  extraOptions: ActiveFSTreeFileDeclarationOptions<Auth, Meta>
): ActiveFSTreeFileDeclaration<Auth, Meta>

dir<Auth = unknown, Meta = unknown>(
  childrenOrFactory?: ActiveFSTreeDeclaration<Auth, Meta> |
    ActiveFSTreeDirectoryChildrenFactory<Auth, Meta>,
  options?: ActiveFSTreeDirectoryDeclarationOptions<Auth, Meta>
): ActiveFSTreeDirectoryDeclaration<Auth, Meta>

text<Auth = unknown, Meta = unknown>(
  contentOrFactory: string | ActiveFSTreeContentFactory<Auth, Meta>,
  options?: Omit<ActiveFSTreeFileDeclarationOptions<Auth, Meta>, "content">
): ActiveFSTreeFileDeclaration<Auth, Meta>

bytes<Auth = unknown, Meta = unknown>(
  contentOrFactory: Uint8Array | ArrayBuffer |
    ActiveFSTreeContentFactory<Auth, Meta>,
  options?: Omit<ActiveFSTreeFileDeclarationOptions<Auth, Meta>, "content">
): ActiveFSTreeFileDeclaration<Auth, Meta>

json<Auth = unknown, Meta = unknown>(
  valueOrFactory: unknown |
    ((context: ActiveFSTreeHandlerContext<Auth, Meta>) => MaybePromise<unknown>),
  options?: Omit<
    ActiveFSTreeFileDeclarationOptions<Auth, Meta>,
    "content" | "read"
  >
): ActiveFSTreeFileDeclaration<Auth, Meta>
```

`text`, `bytes`, and `json` can evaluate a factory when the file is read.
`json` serializes the returned value as indented JSON followed by a newline.

## Tree contract

The public interface has these methods:

```ts
export interface ActiveFSTree<Auth = unknown, Meta = unknown> {
  name?: string;
  capabilities?: ActiveFSCapabilities;
  set(
    path: string,
    declaration:
      | ActiveFSTreeNodeDeclaration<Auth, Meta>
      | ActiveFSTreeDeclaration<Auth, Meta>
  ): this;
  path(path: string): ActiveFSTreePathHandle<Auth, Meta>;
  info(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath
  ): Promise<ActiveFSTreeInfo<Meta>>;
  list(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath
  ): Promise<ActiveFSTreeListResult<Auth, Meta>>;
  read(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    options?: ActiveFSReadOptions
  ): Promise<ActiveFSTreeReadResult<Meta>>;
  search(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    query: ActiveFSSearchQuery
  ): Promise<ActiveFSTreeSearchResult<Meta>>;
  walk(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    options?: { includeNonEnumerable?: boolean }
  ): Promise<ActiveFSTreeWalkResult<Meta>>;
  write(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    content: string | Uint8Array,
    options?: ActiveFSWriteOptions<Meta>
  ): Promise<ActiveFSTreeMutationResult<Auth, Meta>>;
  remove(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    options?: ActiveFSDeleteOptions
  ): Promise<ActiveFSTreeMutationResult<Auth, Meta>>;
  makeDir(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    options?: ActiveFSMkdirOptions<Meta>
  ): Promise<ActiveFSTreeMutationResult<Auth, Meta>>;
  move(
    ctx: ActiveFSContext<Auth, Meta>,
    fromPath: ActiveFSPath,
    toPath: ActiveFSPath,
    options?: ActiveFSRenameOptions
  ): Promise<ActiveFSTreeMutationResult<Auth, Meta>>;
  copy(
    ctx: ActiveFSContext<Auth, Meta>,
    fromPath: ActiveFSPath,
    toPath: ActiveFSPath,
    options?: ActiveFSCopyOptions
  ): Promise<ActiveFSTreeMutationResult<Auth, Meta>>;
  truncate(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    options?: ActiveFSTruncateOptions
  ): Promise<ActiveFSTreeMutationResult<Auth, Meta>>;
  updateInfo(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    options: ActiveFSMetadataUpdateOptions<Meta>
  ): Promise<ActiveFSTreeMutationResult<Auth, Meta>>;
  watch(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    onEvent: (event: ActiveFSWatchEvent<Meta>) => void,
    options?: ActiveFSWatchOptions
  ): Promise<ActiveFSWatchSubscription>;
  pre(
    operation: ActiveFSTreeOperation,
    hook: ActiveFSTreeHook<Auth, Meta>
  ): this;
  post(
    operation: ActiveFSTreeOperation,
    hook: ActiveFSTreeHook<Auth, Meta>
  ): this;
  on(
    event: ActiveFSTreeChangeEvent,
    handler: ActiveFSTreeChangeHandler<Meta>
  ): this;
  onChange(handler: ActiveFSTreeChangeHandler<Meta>): this;
  command<Command extends ActiveFSTreeCommand>(
    ctx: ActiveFSContext<Auth, Meta>,
    command: Command,
    path: string,
    input: ActiveFSCommandInput<Command>
  ): Promise<ActiveFSTreeCommandResultMap<Meta>[Command]>;
}
```

The source file defines the option and result shapes named in this interface;
the generated [API report](api-report.md#activefscore) inventories those public
declarations.

## Declaration rules

`ActiveFSTreeDeclaration` accepts sparse path keys and nested objects.
Intermediate directories are inferred for sparse paths. A plain nested object
is treated as directory children unless it is a declaration returned by
`file`, `dir`, `text`, `bytes`, or `json`.

```ts
const tree = fsTree({
  "/README.md": text("# Docs\n", { type: "text/markdown" }),
  data: {
    "status.json": json(() => currentStatus())
  }
}, {
  name: "docs"
});
```

`tree.set(path, declaration)` adds or replaces a live declaration after the
tree exists. `tree.path(path)` returns a chainable handle with `file`, `dir`,
semantic handler setters, command handler setters, hooks, and change listeners.

Handlers can be attached at the exact file, closest containing directory, or
tree level. Resolution uses this order:

1. Exact file handler.
2. Closest directory handler.
3. Tree-level handler.
4. Built-in default behavior.

## Handler context

Every authoring handler receives an `ActiveFSTreeHandlerContext<Auth, Meta>`:

```ts
export interface ActiveFSTreeHandlerContext<Auth = unknown, Meta = unknown> {
  ctx: ActiveFSContext<Auth, Meta>;
  path: ActiveFSPath;
  params: Record<string, string>;
  operation: ActiveFSTreeOperation;
  command?: ActiveFSTreeCommand;
  input?: ActiveFSCommandInput<ActiveFSTreeCommand>;
  query?: ActiveFSSearchQuery;
  content?: string | Uint8Array;
  options?:
    | ActiveFSReadOptions
    | ActiveFSWriteOptions<Meta>
    | ActiveFSDeleteOptions
    | ActiveFSMkdirOptions<Meta>
    | ActiveFSRenameOptions
    | ActiveFSCopyOptions
    | ActiveFSTruncateOptions
    | ActiveFSMetadataUpdateOptions<Meta>
    | ActiveFSCommandInput<ActiveFSTreeCommand>
    | Record<string, unknown>;
  toPath?: ActiveFSPath;
  info?: ActiveFSTreeInfo<Meta>;
  result?: unknown;
  data?: unknown;
}
```

`ctx.auth` and `ctx.meta` are opaque to core. A source can interpret them to
enforce its own identity, tenancy, visibility, and policy. `params` contains
values captured by dynamic path patterns.

The concrete `options` value corresponds to the current read, mutation,
metadata, or command operation.

## Read-side operations

| Operation | Authoring behavior |
|---|---|
| `info` | Return file or directory metadata, or `null` when the path is absent. |
| `list` | Return a declaration record or an array of `ActiveFSTreeInfo` children. |
| `read` | Return text, bytes, an `ArrayBuffer`, or a result object with content and metadata. |
| `search` | Return matches plus completeness and strategy; built-in declared trees can scan enumerable readable files. |
| `walk` | Return an info array or an async iterable of info values. |

Metadata can include type, size, modification time, ETag, revision,
enumerability, cache hints, permission hints, and opaque `meta`. `data` remains
accepted as metadata compatibility sugar; new authoring code should prefer
`meta`.

Search results must follow the same source-owned visibility rules as `info` and
`read`. If the source has a provider index, attach a `search` handler. Otherwise
the built-in implementation searches enumerable readable paths.

## Dynamic paths and enumeration

Path patterns use named segments such as:

```txt
/users/:id/profile.md
```

The concrete path `/users/42/profile.md` can resolve through `info` and `read`
without appearing in `list("/users")`. Set `enumerable: false` when listing the
possible values would be too large, expensive, or private.

Scanning cannot discover non-enumerable concrete paths. A source search handler
can return authorized matches when it can search that space safely. Route hints
are metadata, not authorization.

## Mutations and policy

Declared trees are read-only by default. A mutation handler can commit a
request to the source backend. For the built-in in-memory mutations,
`writable: true` marks a node, ancestor, or tree as mutable; explicit
`deletable: false`, `renamable: false`, and `copyable: false` deny those
specific operations.

Mutation handlers can return nothing, a replacement declaration, or an object
with `created`, `modified`, `removed`, `moved`, `copied`, `invalidate`, `info`,
`operationId`, `revision`, `meta`, or `data`. The source remains authoritative
for whether the operation committed.

Expected operational failures should throw `ActiveFSError` with a stable code.
Use `NOT_FOUND` for missing paths, `NOT_FILE` or `NOT_DIRECTORY` for shape
mismatches, `UNAUTHORIZED` or `FORBIDDEN` for policy denial, `UNSUPPORTED` for
unsupported behavior, and `CONFLICT` or `PRECONDITION_FAILED` for write
conditions. Wrap an unexpected tree failure in `ActiveFSTreeError` when it
should carry the stable `SOURCE_ERROR` code. Source API also normalizes
unhandled service failures to `SOURCE_ERROR` at its transport boundary.

## Hooks and committed events

`pre` and `post` hooks wrap requested semantic operations. A successful request
does not itself prove that visible state changed.

Committed events use these names:

```txt
created
modified
removed
moved
copied
invalidated
```

Register one event with `on(event, handler)` or all events with
`onChange(handler)`. Committed events feed `watch` and can represent
server-originated changes as well as client mutations.

## Optional command handlers

Trees can implement source-specific handlers for `ls`, `stat`, `cat`, `head`,
`tail`, `sed`, `grep`, `rg`, and `find`. Handlers follow the same exact-file,
closest-directory, then tree-level precedence as semantic handlers.

Without a command handler, `runDefaultActiveFSTreeCommand` uses these mappings:

| Command | Semantic default |
|---|---|
| `ls` | `list` |
| `stat` | `info` |
| `cat`, `head`, `tail`, `sed` | `read` plus the command transform |
| `grep`, `rg` | `search` |
| `find` | `walk` |

Command-aware clients can preserve the command identity. An OS mount receives
ordinary filesystem operations and cannot know that a caller originally ran
`grep` or another shell command.

## Validate an implementation

At minimum, verify that:

- `info`, `list`, and `read` agree about path existence and kind;
- missing and denied paths use the intended stable error behavior;
- search returns only paths readable for the same opaque context;
- dynamic routes do not become accidentally enumerable;
- generated content changes when its source state changes;
- mutation results reflect committed source state; and
- watch events describe committed visible changes.

Use `runActiveFSTreeConformance` from
`@activefs/testing/conformance` for the shared tree behavior suite. See
[Source API conformance](../contributing/source-api-conformance.md) for the
transport checks.
