/**
 * Canonical absolute ActiveFS path string.
 *
 * ActiveFS paths always use `/` separators and are normalized before routing.
 * The runtime never allows `..` traversal to escape above `/`.
 */
export type ActiveFSPath = `/${string}`;

/**
 * File-kind marker returned by filesystem-shaped metadata and listing APIs.
 *
 * Only these values are part of the core contract; adapters must map host or
 * protocol-specific node types into this smaller model before returning them.
 */
export type ActiveFSEntryKind = "file" | "directory";

/**
 * Helper type for callbacks that may complete synchronously or asynchronously.
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Advertises operations a tree, remote, or entry can attempt.
 *
 * Capabilities are descriptive, not authorization grants. A tree or remote remains
 * authoritative for request-specific policy and may still reject an operation
 * based on opaque auth, metadata, revisions, or backend state.
 */
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
  /** Command-aware surfaces supported by this source. */
  commands?: ActiveFSTreeCommand[];
}

/**
 * Opaque request context passed from callers and adapters to tree implementations.
 *
 * Core forwards `auth` and `meta` without parsing, persisting, logging, or
 * authorizing against them. Core scans and built-in sources enforce search
 * cancellation, `deadlineMs`, and `maxSearchResults`; other limit fields are
 * advisory unless a tree or adapter implements them.
 */
export interface ActiveFSContext<Auth = unknown, Meta = unknown> {
  auth?: Auth;
  meta?: Meta;
  traceId?: string;
  signal?: AbortSignal;
  /** Absolute Unix time in milliseconds after which work should stop. */
  deadlineMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  maxSearchResults?: number;
}

/**
 * Directory listing entry returned by a tree, remote, or virtual mount parent.
 *
 * `path` must be an absolute ActiveFS path in the tree namespace before core
 * maps it back to the mounted namespace. `meta` is opaque tree metadata.
 */
export interface ActiveFSDirEntry<Meta = unknown> {
  name: string;
  path: ActiveFSPath;
  kind: ActiveFSEntryKind;
  capabilities?: ActiveFSCapabilities;
  size?: number;
  mtimeMs?: number;
  mimeType?: string;
  enumerable?: boolean;
  meta?: Meta;
}

/**
 * File or directory metadata for a single path.
 *
 * `stat` may include cache validators such as `etag` or `revision`. Core
 * carries those values but does not interpret backend-specific consistency
 * policy.
 */
export interface ActiveFSStat<Meta = unknown> extends ActiveFSDirEntry<Meta> {
  path: ActiveFSPath;
  etag?: string;
  revision?: string;
}

/**
 * Options for reading all or part of a file.
 *
 * Offsets and lengths are byte-oriented for binary-capable trees. A tree
 * may throw release-stable `RANGE_NOT_SATISFIABLE` or `INVALID_REQUEST` errors when
 * the requested range cannot be served.
 */
export interface ActiveFSReadOptions {
  offset?: number;
  length?: number;
  encoding?: "utf8" | "base64" | "binary";
}

/**
 * File content returned by a read operation.
 *
 * `stat` should describe the bytes that were read when the tree can provide a
 * consistent view. Core maps any returned `stat.path` through the mount prefix.
 */
export interface ActiveFSReadResult<Meta = unknown> {
  content: string | Uint8Array;
  stat?: ActiveFSStat<Meta>;
  meta?: Meta;
}

/**
 * Options for server-authoritative file writes.
 *
 * Preconditions such as `baseRevision`, `ifMatch`, and `ifNoneMatch` are
 * forwarded to the tree and are not interpreted by core. Trees should use
 * `idempotencyKey` to deduplicate retries when supported.
 */
export interface ActiveFSWriteOptions<Meta = unknown> {
  create?: boolean;
  overwrite?: boolean;
  contentType?: string;
  baseRevision?: string;
  ifMatch?: string;
  ifNoneMatch?: string;
  idempotencyKey?: string;
  meta?: Meta;
}

/**
 * Result of a server-authoritative file write.
 *
 * The tree decides whether a write created, replaced, or rejected content.
 * Core maps returned stats to the mounted namespace and otherwise preserves
 * tree metadata.
 */
export interface ActiveFSWriteResult<Meta = unknown> {
  stat?: ActiveFSStat<Meta>;
  created?: boolean;
  operationId?: string;
  revision?: string;
  meta?: Meta;
}

/**
 * Options for deleting files or directories.
 */
export interface ActiveFSDeleteOptions {
  recursive?: boolean;
  idempotencyKey?: string;
}

/**
 * Result of deleting a path.
 *
 * The returned path is the tree path before core maps it back to the mounted
 * namespace. Trees may return `deleted: false` for idempotent no-op deletes.
 */
export interface ActiveFSDeleteResult<Meta = unknown> {
  path: ActiveFSPath;
  deleted: boolean;
  operationId?: string;
  revision?: string;
  meta?: Meta;
}

/**
 * Options for creating directories.
 */
export interface ActiveFSMkdirOptions<Meta = unknown> {
  recursive?: boolean;
  idempotencyKey?: string;
  meta?: Meta;
}

/**
 * Result of creating or confirming a directory.
 */
export interface ActiveFSMkdirResult<Meta = unknown> {
  stat?: ActiveFSStat<Meta>;
  created?: boolean;
  operationId?: string;
  revision?: string;
  meta?: Meta;
}

/**
 * Options for renaming a path within one mounted tree.
 */
export interface ActiveFSRenameOptions {
  overwrite?: boolean;
  idempotencyKey?: string;
}

/**
 * Result of a rename within one tree namespace.
 *
 * Core rejects cross-tree renames before calling the tree because there is
 * no portable atomic rename contract across independent backends.
 */
export interface ActiveFSRenameResult<Meta = unknown> {
  from: ActiveFSPath;
  to: ActiveFSPath;
  stat?: ActiveFSStat<Meta>;
  operationId?: string;
  revision?: string;
  meta?: Meta;
}

/**
 * Options for copying a file or tree within one mounted tree.
 */
export interface ActiveFSCopyOptions {
  overwrite?: boolean;
  recursive?: boolean;
  idempotencyKey?: string;
}

/**
 * Result of a copy operation.
 *
 * If a tree lacks native copy but supports read and write, core may emulate a
 * file copy through those operations and return the write result metadata.
 */
export interface ActiveFSCopyResult<Meta = unknown> {
  from: ActiveFSPath;
  to: ActiveFSPath;
  stat?: ActiveFSStat<Meta>;
  operationId?: string;
  revision?: string;
  meta?: Meta;
}

/**
 * Options for truncating a file.
 */
export interface ActiveFSTruncateOptions {
  length?: number;
  idempotencyKey?: string;
}

/**
 * Result of truncating a file.
 */
export interface ActiveFSTruncateResult<Meta = unknown> {
  stat?: ActiveFSStat<Meta>;
  operationId?: string;
  revision?: string;
  meta?: Meta;
}

/**
 * Server-authoritative metadata update request.
 *
 * Time and mode fields are advisory filesystem-shaped metadata. Trees decide
 * which fields are supported and should reject unsupported updates rather than
 * silently claiming success.
 */
export interface ActiveFSMetadataUpdateOptions<Meta = unknown> {
  mtimeMs?: number;
  atimeMs?: number;
  mode?: number;
  idempotencyKey?: string;
  meta?: Meta;
}

/**
 * Result of a metadata update.
 */
export interface ActiveFSMetadataUpdateResult<Meta = unknown> {
  stat?: ActiveFSStat<Meta>;
  operationId?: string;
  revision?: string;
  meta?: Meta;
}

/**
 * Search query for source-provided or ActiveFS tree-scan content search.
 *
 * `includeNonEnumerable` controls whether dynamic or hidden tree paths are
 * traversed by scan search and should also be honored by source-provided
 * search.
 */
export interface ActiveFSSearchQuery {
  pattern: string;
  caseSensitive?: boolean;
  maxResults?: number;
  includeNonEnumerable?: boolean;
}

/**
 * Single content search match in a tree or mounted namespace.
 */
export interface ActiveFSSearchMatch<Meta = unknown> {
  path: ActiveFSPath;
  line?: number;
  column?: number;
  excerpt?: string;
  meta?: Meta;
}

/** Identifies how ActiveFS produced a search result. */
export type ActiveFSSearchStrategy = "source" | "scan" | "mixed";

/** Typed reasons why a search result is not complete. */
export type ActiveFSSearchIncompleteReason =
  | "max-results"
  | "source-incomplete"
  | "unreadable-path"
  | "timeout";

/** Search result returned by a filesystem or source tree. */
export interface ActiveFSSearchResult<Meta = unknown> {
  matches: ActiveFSSearchMatch<Meta>[];
  /** Whether all results visible to the selected strategy were returned. */
  complete: boolean;
  /** Whether the source, ActiveFS scanning, or both produced the result. */
  strategy: ActiveFSSearchStrategy;
  /** Reasons for an incomplete result. Present only when `complete` is false. */
  incompleteReasons?: ActiveFSSearchIncompleteReason[];
}

/** Typed inputs accepted by optional command handlers. */
export interface ActiveFSCommandInputMap {
  ls: { includeNonEnumerable?: boolean };
  stat: Record<string, never>;
  cat: { options?: ActiveFSReadOptions };
  head: { lines?: number; options?: ActiveFSReadOptions };
  tail: { lines?: number; options?: ActiveFSReadOptions };
  sed: {
    pattern: string;
    replacement: string;
    global?: boolean;
    caseSensitive?: boolean;
    options?: ActiveFSReadOptions;
  };
  grep: ActiveFSSearchQuery;
  rg: ActiveFSSearchQuery;
  find: { includeNonEnumerable?: boolean };
}

/** Input for one optional command handler. */
export type ActiveFSCommandInput<Command extends keyof ActiveFSCommandInputMap> =
  ActiveFSCommandInputMap[Command];

/** Results returned by command-aware filesystem interfaces. */
export interface ActiveFSCommandResultMap<Meta = unknown> {
  ls: ActiveFSDirEntry<Meta>[];
  stat: ActiveFSStat<Meta> | null;
  cat: ActiveFSReadResult<Meta>;
  head: ActiveFSReadResult<Meta>;
  tail: ActiveFSReadResult<Meta>;
  sed: ActiveFSReadResult<Meta>;
  grep: ActiveFSSearchResult<Meta>;
  rg: ActiveFSSearchResult<Meta>;
  find: ActiveFSStat<Meta>[];
}

/**
 * Watch event kind emitted by a tree.
 */
export type ActiveFSWatchEventType = "create" | "change" | "delete" | "invalidate";

/**
 * Change notification emitted by tree watch implementations.
 *
 * Events are advisory invalidation signals. Consumers should treat them as a
 * reason to refresh tree state rather than as a complete audit log.
 */
export interface ActiveFSWatchEvent<Meta = unknown> {
  type: ActiveFSWatchEventType;
  path: ActiveFSPath;
  stat?: ActiveFSStat<Meta>;
  meta?: Meta;
}

/**
 * Options for watching tree or mounted paths.
 */
export interface ActiveFSWatchOptions {
  recursive?: boolean;
  includeNonEnumerable?: boolean;
  signal?: AbortSignal;
}

/**
 * Handle returned by a watch operation.
 *
 * `close` releases tree or adapter resources. Implementations should make it
 * safe to call once even when an underlying watch has already ended.
 */
export interface ActiveFSWatchSubscription {
  /** Releases underlying watch resources. */
  close(): MaybePromise<void>;
}

/**
 * Operation names emitted by the logical client hooks.
 */
export type ActiveFSClientOperation =
  | "readdir"
  | "stat"
  | "readFile"
  | "writeFile"
  | "mkdir"
  | "rm"
  | "rmdir"
  | "rename"
  | "copyFile"
  | "truncate"
  | "utimes"
  | "search"
  | "command"
  | "watch";

/**
 * Activity record emitted by `createActiveFSClient` hooks.
 *
 * Hooks receive normalized logical paths after each operation succeeds or
 * fails. Errors are reported as messages and are rethrown to the caller.
 */
export interface ActiveFSClientOperationEvent<Meta = unknown> {
  operation: ActiveFSClientOperation;
  path: ActiveFSPath;
  targetPath?: ActiveFSPath;
  startedAt: string;
  completedAt: string;
  result: "ok" | "error";
  error?: string;
  stat?: ActiveFSStat<Meta>;
}

/**
 * Options for creating a logical fs/promises-like client.
 *
 * The optional context factory is evaluated per operation so adapters can
 * provide fresh credentials or request metadata without core interpreting them.
 */
export interface ActiveFSClientOptions<Auth = unknown, Meta = unknown> {
  context?: ActiveFSContext<Auth, Meta> | (() => MaybePromise<ActiveFSContext<Auth, Meta>>);
  onOperation?: (event: ActiveFSClientOperationEvent<Meta>) => MaybePromise<void>;
  onActivity?: (event: ActiveFSClientOperationEvent<Meta>) => MaybePromise<void>;
}

/**
 * Promise-based logical client over an `ActiveFS` filesystem.
 *
 * Methods normalize input paths, forward opaque context, emit operation hooks,
 * and throw `ActiveFSError` failures from the underlying filesystem.
 */
export interface ActiveFSLogicalClient<Meta = unknown> {
  /** Lists directory entries at a logical path. */
  readdir(path: string): Promise<ActiveFSDirEntry<Meta>[]>;
  /** Returns file or directory metadata, throwing `NOT_FOUND` when absent. */
  stat(path: string): Promise<ActiveFSStat<Meta>>;
  /** Reads file content as text or bytes depending on the tree/read options. */
  readFile(path: string, options?: ActiveFSReadOptions): Promise<string | Uint8Array>;
  /** Writes file content through the resolved tree. */
  writeFile(path: string, content: string | Uint8Array, options?: ActiveFSWriteOptions<Meta>): Promise<ActiveFSWriteResult<Meta>>;
  /** Creates a directory through the resolved tree. */
  mkdir(path: string, options?: ActiveFSMkdirOptions<Meta>): Promise<ActiveFSMkdirResult<Meta>>;
  /** Deletes a file or tree through the resolved tree. */
  rm(path: string, options?: ActiveFSDeleteOptions): Promise<ActiveFSDeleteResult<Meta>>;
  /** Removes a directory through `rmdir` when available or delete fallback. */
  rmdir(path: string, options?: ActiveFSDeleteOptions): Promise<ActiveFSDeleteResult<Meta>>;
  /** Renames within one mounted tree; cross-tree renames are rejected. */
  rename(fromPath: string, toPath: string, options?: ActiveFSRenameOptions): Promise<ActiveFSRenameResult<Meta>>;
  /** Copies within one mounted tree, using tree copy or read/write fallback. */
  copyFile(fromPath: string, toPath: string, options?: ActiveFSCopyOptions): Promise<ActiveFSCopyResult<Meta>>;
  /** Truncates a file to the requested length. */
  truncate(path: string, length?: number): Promise<ActiveFSTruncateResult<Meta>>;
  /** Updates access and modification times through tree metadata support. */
  utimes(path: string, atimeMs: number, mtimeMs: number, options?: Omit<ActiveFSMetadataUpdateOptions<Meta>, "atimeMs" | "mtimeMs">): Promise<ActiveFSMetadataUpdateResult<Meta>>;
  /** Searches below a path using a source handler or ActiveFS scan. */
  search(path: string, query: ActiveFSSearchQuery): Promise<ActiveFSSearchResult<Meta>>;
  /** Runs an optional source command handler or its default semantic mapping. */
  command<Command extends ActiveFSTreeCommand>(
    command: Command,
    path: string,
    input: ActiveFSCommandInput<Command>
  ): Promise<ActiveFSCommandResultMap<Meta>[Command]>;
  /** Lists a path through an optional `ls` handler or semantic listing. */
  ls(path: string, input?: ActiveFSCommandInput<"ls">): Promise<ActiveFSCommandResultMap<Meta>["ls"]>;
  /** Reads a file through an optional `cat` handler or semantic read. */
  cat(path: string, input?: ActiveFSCommandInput<"cat">): Promise<ActiveFSCommandResultMap<Meta>["cat"]>;
  /** Reads the first lines through an optional `head` handler. */
  head(path: string, input?: ActiveFSCommandInput<"head">): Promise<ActiveFSCommandResultMap<Meta>["head"]>;
  /** Reads the last lines through an optional `tail` handler. */
  tail(path: string, input?: ActiveFSCommandInput<"tail">): Promise<ActiveFSCommandResultMap<Meta>["tail"]>;
  /** Returns a literal text replacement through an optional `sed` handler. */
  sed(path: string, input: ActiveFSCommandInput<"sed">): Promise<ActiveFSCommandResultMap<Meta>["sed"]>;
  /** Searches through an optional `grep` handler or semantic search. */
  grep(path: string, input: ActiveFSCommandInput<"grep">): Promise<ActiveFSCommandResultMap<Meta>["grep"]>;
  /** Searches through an optional `rg` handler or semantic search. */
  rg(path: string, input: ActiveFSCommandInput<"rg">): Promise<ActiveFSCommandResultMap<Meta>["rg"]>;
  /** Walks a path through an optional `find` handler or semantic traversal. */
  find(path: string, input?: ActiveFSCommandInput<"find">): Promise<ActiveFSCommandResultMap<Meta>["find"]>;
  /** Subscribes to tree invalidation events for a logical path. */
  watch(path: string, onEvent: (event: ActiveFSWatchEvent<Meta>) => void, options?: ActiveFSWatchOptions): Promise<ActiveFSWatchSubscription>;
}

/**
 * Lightweight runtime event type for mount and invalidation notifications.
 */
export type ActiveFSEvent =
  | { type: "mount"; path: ActiveFSPath }
  | { type: "change"; path: ActiveFSPath }
  | { type: "invalidate"; path: ActiveFSPath };

/**
 * Stable error codes used by core, adapters, and Source API mapping.
 */
export type ActiveFSErrorCode =
  | "NOT_FOUND"
  | "NOT_MOUNTED"
  | "NOT_DIRECTORY"
  | "NOT_FILE"
  | "INVALID_PATH"
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "CONFLICT"
  | "PRECONDITION_FAILED"
  | "TRANSIENT"
  | "UNSUPPORTED"
  | "SOURCE_ERROR";

/**
 * Base operational error for ActiveFS filesystem failures.
 *
 * The `code` field is stable for programmatic handling. Messages are
 * diagnostic and should not expose raw credentials or opaque auth payloads.
 */
export class ActiveFSError extends Error {
  readonly code: ActiveFSErrorCode;
  readonly path?: ActiveFSPath;

  constructor(
    code: ActiveFSErrorCode,
    message: string,
    options: { path?: ActiveFSPath; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "ActiveFSError";
    this.code = code;
    this.path = options.path;
  }
}

/**
 * Error thrown when a required path does not exist.
 */
export class ActiveFSNotFoundError extends ActiveFSError {
  constructor(path: ActiveFSPath, cause?: unknown) {
    super("NOT_FOUND", `Path not found: ${path}`, { path, cause });
  }
}

/**
 * Error thrown when no tree is mounted for a logical path.
 */
export class ActiveFSNotMountedError extends ActiveFSError {
  constructor(path: ActiveFSPath, cause?: unknown) {
    super("NOT_MOUNTED", `No tree is mounted for path: ${path}`, { path, cause });
  }
}

/**
 * Error thrown when a directory operation receives a file path.
 */
export class ActiveFSNotDirectoryError extends ActiveFSError {
  constructor(path: ActiveFSPath, cause?: unknown) {
    super("NOT_DIRECTORY", `Path is not a directory: ${path}`, { path, cause });
  }
}

/**
 * Error thrown when a file operation receives a directory path.
 */
export class ActiveFSNotFileError extends ActiveFSError {
  constructor(path: ActiveFSPath, cause?: unknown) {
    super("NOT_FILE", `Path is not a file: ${path}`, { path, cause });
  }
}

/**
 * Error thrown for invalid ActiveFS path input.
 */
export class ActiveFSInvalidPathError extends ActiveFSError {
  constructor(message = "Invalid ActiveFS path", cause?: unknown) {
    super("INVALID_PATH", message, { cause });
  }
}

/**
 * Wrapper for tree failures that do not already use a stable ActiveFS code.
 */
export class ActiveFSTreeError extends ActiveFSError {
  constructor(path: ActiveFSPath, cause?: unknown) {
    super("SOURCE_ERROR", `Tree operation failed for path: ${path}`, { path, cause });
  }
}

/**
 * Semantic operation names used by `fsTree` handlers and hooks.
 */
export type ActiveFSTreeOperation =
  | "info"
  | "list"
  | "read"
  | "search"
  | "walk"
  | "write"
  | "remove"
  | "move"
  | "copy"
  | "makeDir"
  | "truncate"
  | "updateInfo";

/** Command names accepted by optional tree-side handlers and semantic defaults. */
export type ActiveFSTreeCommand = keyof ActiveFSCommandInputMap;

/**
 * Committed tree change events emitted by `ActiveFSTree`.
 */
export type ActiveFSTreeChangeEvent =
  | "created"
  | "modified"
  | "removed"
  | "moved"
  | "copied"
  | "invalidated";

/**
 * Cache hints carried by tree declarations and result metadata.
 */
export interface ActiveFSTreeCachePolicy {
  ttlMs?: number;
  mode?: "none" | "manual" | "ttl" | "versioned" | "realtime/coherent";
  revision?: string;
}

/**
 * Filesystem-shaped permission hints carried by tree declarations.
 */
export interface ActiveFSTreePermissionHints {
  readable?: boolean;
  writable?: boolean;
  searchable?: boolean;
  deletable?: boolean;
  renamable?: boolean;
  copyable?: boolean;
}

/**
 * Stable metadata shape returned by `fsTree` info handlers.
 */
export type ActiveFSTreeInfo<Meta = unknown> = {
  path?: string;
  name?: string;
  kind?: ActiveFSEntryKind;
  type?: string;
  size?: number;
  mtimeMs?: number;
  etag?: string;
  revision?: string;
  enumerable?: boolean;
  cache?: ActiveFSTreeCachePolicy;
  permissions?: ActiveFSTreePermissionHints;
  meta?: Meta;
  data?: Meta;
} | null;

/**
 * File content accepted by tree declarations and read handlers.
 */
export type ActiveFSTreeContent =
  | string
  | Uint8Array
  | ArrayBuffer;

/**
 * Common handler context passed to `fsTree` handlers and hooks.
 */
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

/** Lazy content factory for `fsTree` file declarations. */
export type ActiveFSTreeContentFactory<Auth = unknown, Meta = unknown> = (
  context: ActiveFSTreeHandlerContext<Auth, Meta>
) => MaybePromise<ActiveFSTreeContent>;

/** Handler that returns metadata for a tree path. */
export type ActiveFSTreeInfoHandler<Auth = unknown, Meta = unknown> = (
  context: ActiveFSTreeHandlerContext<Auth, Meta>
) => MaybePromise<ActiveFSTreeInfo<Meta>>;

/** Result returned by a tree list handler. */
export type ActiveFSTreeListResult<Auth = unknown, Meta = unknown> =
  | Record<string, ActiveFSTreeNodeDeclaration<Auth, Meta> | ActiveFSTreeDeclaration<Auth, Meta>>
  | ActiveFSTreeInfo<Meta>[];

/** Handler that returns children for a directory path. */
export type ActiveFSTreeListHandler<Auth = unknown, Meta = unknown> = (
  context: ActiveFSTreeHandlerContext<Auth, Meta>
) => MaybePromise<ActiveFSTreeListResult<Auth, Meta>>;

/** Result returned by a tree read handler. */
export type ActiveFSTreeReadResult<Meta = unknown> =
  | ActiveFSTreeContent
  | {
      content: ActiveFSTreeContent;
      info?: ActiveFSTreeInfo<Meta>;
      type?: string;
      meta?: Meta;
      data?: Meta;
    };

/** Handler that returns file content for a path. */
export type ActiveFSTreeReadHandler<Auth = unknown, Meta = unknown> = (
  context: ActiveFSTreeHandlerContext<Auth, Meta>
) => MaybePromise<ActiveFSTreeReadResult<Meta>>;

/** Result returned by semantic search or optional source search handlers. */
export type ActiveFSTreeSearchResult<Meta = unknown> = {
  matches: Array<{
    path: string;
    line?: number;
    column?: number;
    excerpt?: string;
    score?: number;
    meta?: Meta;
    data?: Meta;
  }>;
  complete: boolean;
  strategy: ActiveFSSearchStrategy;
  incompleteReasons?: ActiveFSSearchIncompleteReason[];
};

/** Result a tree search handler may return before core fills defaults. */
export type ActiveFSTreeSearchHandlerResult<Meta = unknown> =
  Omit<ActiveFSTreeSearchResult<Meta>, "complete" | "strategy"> & {
    complete?: boolean;
    strategy?: ActiveFSSearchStrategy;
  };

/** Handler that returns search results for a file, directory, or tree. */
export type ActiveFSTreeSearchHandler<Auth = unknown, Meta = unknown> = (
  context: ActiveFSTreeHandlerContext<Auth, Meta>
) => MaybePromise<ActiveFSTreeSearchHandlerResult<Meta>>;

/** Result returned by a tree walk handler. */
export type ActiveFSTreeWalkResult<Meta = unknown> =
  | ActiveFSTreeInfo<Meta>[]
  | AsyncIterable<NonNullable<ActiveFSTreeInfo<Meta>>>;

/** Handler that returns a recursive path walk result. */
export type ActiveFSTreeWalkHandler<Auth = unknown, Meta = unknown> = (
  context: ActiveFSTreeHandlerContext<Auth, Meta>
) => MaybePromise<ActiveFSTreeWalkResult<Meta>>;

/** Result returned by a successful tree mutation handler. */
export type ActiveFSTreeMutationResult<Auth = unknown, Meta = unknown> =
  | void
  | ActiveFSTreeNodeDeclaration<Auth, Meta>
  | {
      created?: string;
      modified?: string;
      removed?: string;
      moved?: { from: string; to: string };
      copied?: { from: string; to: string };
      invalidate?: string | null;
      info?: ActiveFSTreeInfo<Meta>;
      operationId?: string;
      revision?: string;
      meta?: Meta;
      data?: Meta;
    };

/** Handler that accepts or rejects a tree mutation. */
export type ActiveFSTreeMutationHandler<Auth = unknown, Meta = unknown> = (
  context: ActiveFSTreeHandlerContext<Auth, Meta>
) => MaybePromise<ActiveFSTreeMutationResult<Auth, Meta>>;

/** Hook that runs before or after a requested tree operation. */
export type ActiveFSTreeHook<Auth = unknown, Meta = unknown> = (
  context: ActiveFSTreeHandlerContext<Auth, Meta>
) => MaybePromise<void>;

/** Listener invoked for committed tree change events. */
export type ActiveFSTreeChangeHandler<Meta = unknown> = (event: {
  type: ActiveFSTreeChangeEvent;
  path: ActiveFSPath;
  fromPath?: ActiveFSPath;
  toPath?: ActiveFSPath;
  info?: ActiveFSTreeInfo<Meta>;
  revision?: string;
  meta?: Meta;
  data?: Meta;
}) => MaybePromise<void>;

/** Tree-local results returned by optional command handlers. */
export interface ActiveFSTreeCommandResultMap<Meta = unknown> {
  ls: NonNullable<ActiveFSTreeInfo<Meta>>[];
  stat: ActiveFSTreeInfo<Meta>;
  cat: ActiveFSTreeReadResult<Meta>;
  head: ActiveFSTreeReadResult<Meta>;
  tail: ActiveFSTreeReadResult<Meta>;
  sed: ActiveFSTreeReadResult<Meta>;
  grep: ActiveFSTreeSearchResult<Meta>;
  rg: ActiveFSTreeSearchResult<Meta>;
  find: NonNullable<ActiveFSTreeInfo<Meta>>[];
}

/** Handler for an optional source command such as `grep` or `tail`. */
export type ActiveFSTreeCommandHandler<
  Auth = unknown,
  Meta = unknown,
  Command extends ActiveFSTreeCommand = ActiveFSTreeCommand
> = (
  context: ActiveFSTreeHandlerContext<Auth, Meta> & {
    command: Command;
    input: ActiveFSCommandInput<Command>;
  }
) => MaybePromise<ActiveFSTreeCommandResultMap<Meta>[Command]>;

interface ActiveFSTreeHandlerSet<Auth = unknown, Meta = unknown> {
  info?: ActiveFSTreeInfoHandler<Auth, Meta>;
  list?: ActiveFSTreeListHandler<Auth, Meta>;
  read?: ActiveFSTreeReadHandler<Auth, Meta>;
  search?: ActiveFSTreeSearchHandler<Auth, Meta>;
  walk?: ActiveFSTreeWalkHandler<Auth, Meta>;
  write?: ActiveFSTreeMutationHandler<Auth, Meta>;
  remove?: ActiveFSTreeMutationHandler<Auth, Meta>;
  move?: ActiveFSTreeMutationHandler<Auth, Meta>;
  copy?: ActiveFSTreeMutationHandler<Auth, Meta>;
  makeDir?: ActiveFSTreeMutationHandler<Auth, Meta>;
  truncate?: ActiveFSTreeMutationHandler<Auth, Meta>;
  updateInfo?: ActiveFSTreeMutationHandler<Auth, Meta>;
}

interface ActiveFSTreeCommandSet<Auth = unknown, Meta = unknown> {
  ls?: ActiveFSTreeCommandHandler<Auth, Meta, "ls">;
  stat?: ActiveFSTreeCommandHandler<Auth, Meta, "stat">;
  cat?: ActiveFSTreeCommandHandler<Auth, Meta, "cat">;
  head?: ActiveFSTreeCommandHandler<Auth, Meta, "head">;
  tail?: ActiveFSTreeCommandHandler<Auth, Meta, "tail">;
  sed?: ActiveFSTreeCommandHandler<Auth, Meta, "sed">;
  grep?: ActiveFSTreeCommandHandler<Auth, Meta, "grep">;
  rg?: ActiveFSTreeCommandHandler<Auth, Meta, "rg">;
  find?: ActiveFSTreeCommandHandler<Auth, Meta, "find">;
}

interface ActiveFSTreeNodePolicy<Meta = unknown> {
  writable?: boolean;
  deletable?: boolean;
  renamable?: boolean;
  copyable?: boolean;
  cache?: ActiveFSTreeCachePolicy;
  permissions?: ActiveFSTreePermissionHints;
  enumerable?: boolean;
  meta?: Meta;
  data?: Meta;
}

/**
 * Options accepted by `file({...})` declarations.
 */
export interface ActiveFSTreeFileDeclarationOptions<Auth = unknown, Meta = unknown>
  extends ActiveFSTreeHandlerSet<Auth, Meta>,
    ActiveFSTreeCommandSet<Auth, Meta>,
    ActiveFSTreeNodePolicy<Meta> {
  name?: string;
  type?: string;
  content?: ActiveFSTreeContent | ActiveFSTreeContentFactory<Auth, Meta>;
}

/**
 * Options accepted by `dir(children, options)` declarations.
 */
export interface ActiveFSTreeDirectoryDeclarationOptions<Auth = unknown, Meta = unknown>
  extends ActiveFSTreeHandlerSet<Auth, Meta>,
    ActiveFSTreeCommandSet<Auth, Meta>,
    ActiveFSTreeNodePolicy<Meta> {
}

/** Lazy directory children factory for `dir(...)` declarations. */
export type ActiveFSTreeDirectoryChildrenFactory<Auth = unknown, Meta = unknown> = (
  context: ActiveFSTreeHandlerContext<Auth, Meta>
) => MaybePromise<ActiveFSTreeDeclaration<Auth, Meta>>;

/**
 * Nested or sparse tree declaration accepted by `fsTree`.
 */
export interface ActiveFSTreeDeclaration<Auth = unknown, Meta = unknown> {
  [path: string]: ActiveFSTreeNodeDeclaration<Auth, Meta> | ActiveFSTreeDeclaration<Auth, Meta>;
}

/**
 * Public file declaration object returned by `file`, `text`, `bytes`, and `json`.
 */
export interface ActiveFSTreeFileDeclaration<Auth = unknown, Meta = unknown> {
  readonly treeNodeKind: "file";
  /** Sets the file metadata handler. */
  setInfo(handler: ActiveFSTreeInfoHandler<Auth, Meta>): this;
  /** Sets the file read handler. */
  setRead(handler: ActiveFSTreeReadHandler<Auth, Meta>): this;
  /** Sets the file semantic search handler. */
  setSearch(handler: ActiveFSTreeSearchHandler<Auth, Meta>): this;
  /** Sets the file walk handler for custom traversal. */
  setWalk(handler: ActiveFSTreeWalkHandler<Auth, Meta>): this;
  /** Sets the file write handler. */
  setWrite(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this;
  /** Sets the file remove handler. */
  setRemove(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this;
  /** Sets the file truncate handler. */
  setTruncate(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this;
  /** Sets the file metadata update handler. */
  setUpdateInfo(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this;
  /** Sets the file `stat` command handler. */
  setStat(handler: ActiveFSTreeCommandHandler<Auth, Meta, "stat">): this;
  /** Sets the optional file `grep` command handler. */
  setGrep(handler: ActiveFSTreeCommandHandler<Auth, Meta, "grep">): this;
  /** Sets the optional file `rg` command handler. */
  setRg(handler: ActiveFSTreeCommandHandler<Auth, Meta, "rg">): this;
  /** Sets the optional file `cat` command handler. */
  setCat(handler: ActiveFSTreeCommandHandler<Auth, Meta, "cat">): this;
  /** Sets the optional file `head` command handler. */
  setHead(handler: ActiveFSTreeCommandHandler<Auth, Meta, "head">): this;
  /** Sets the optional file `tail` command handler. */
  setTail(handler: ActiveFSTreeCommandHandler<Auth, Meta, "tail">): this;
  /** Sets the optional file `sed` command handler. */
  setSed(handler: ActiveFSTreeCommandHandler<Auth, Meta, "sed">): this;
  /** Registers a pre-operation hook on this file declaration. */
  pre(operation: ActiveFSTreeOperation, hook: ActiveFSTreeHook<Auth, Meta>): this;
  /** Registers a post-operation hook on this file declaration. */
  post(operation: ActiveFSTreeOperation, hook: ActiveFSTreeHook<Auth, Meta>): this;
  /** Registers a committed change listener on this file declaration. */
  on(event: ActiveFSTreeChangeEvent, handler: ActiveFSTreeChangeHandler<Meta>): this;
}

/**
 * Public directory declaration object returned by `dir`.
 */
export interface ActiveFSTreeDirectoryDeclaration<Auth = unknown, Meta = unknown> {
  readonly treeNodeKind: "directory";
  /** Sets the directory metadata handler. */
  setInfo(handler: ActiveFSTreeInfoHandler<Auth, Meta>): this;
  /** Sets the directory list handler. */
  setList(handler: ActiveFSTreeListHandler<Auth, Meta>): this;
  /** Sets the directory read handler when a provider treats it as readable. */
  setRead(handler: ActiveFSTreeReadHandler<Auth, Meta>): this;
  /** Sets the directory semantic search handler. */
  setSearch(handler: ActiveFSTreeSearchHandler<Auth, Meta>): this;
  /** Sets the directory walk handler. */
  setWalk(handler: ActiveFSTreeWalkHandler<Auth, Meta>): this;
  /** Sets the directory write handler for child writes. */
  setWrite(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this;
  /** Sets the directory remove handler. */
  setRemove(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this;
  /** Sets the directory move handler. */
  setMove(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this;
  /** Sets the directory copy handler. */
  setCopy(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this;
  /** Sets the directory creation handler. */
  setMakeDir(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this;
  /** Sets the directory metadata update handler. */
  setUpdateInfo(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this;
  /** Sets the directory `stat` command handler. */
  setStat(handler: ActiveFSTreeCommandHandler<Auth, Meta, "stat">): this;
  /** Sets the optional directory `grep` command handler. */
  setGrep(handler: ActiveFSTreeCommandHandler<Auth, Meta, "grep">): this;
  /** Sets the optional directory `rg` command handler. */
  setRg(handler: ActiveFSTreeCommandHandler<Auth, Meta, "rg">): this;
  /** Sets the optional directory `find` command handler. */
  setFind(handler: ActiveFSTreeCommandHandler<Auth, Meta, "find">): this;
  /** Sets the optional directory `ls` command handler. */
  setLs(handler: ActiveFSTreeCommandHandler<Auth, Meta, "ls">): this;
  /** Registers a pre-operation hook on this directory declaration. */
  pre(operation: ActiveFSTreeOperation, hook: ActiveFSTreeHook<Auth, Meta>): this;
  /** Registers a post-operation hook on this directory declaration. */
  post(operation: ActiveFSTreeOperation, hook: ActiveFSTreeHook<Auth, Meta>): this;
  /** Registers a committed change listener on this directory declaration. */
  on(event: ActiveFSTreeChangeEvent, handler: ActiveFSTreeChangeHandler<Meta>): this;
}

/** Union of public file and directory declarations accepted by `fsTree`. */
export type ActiveFSTreeNodeDeclaration<Auth = unknown, Meta = unknown> =
  | ActiveFSTreeFileDeclaration<Auth, Meta>
  | ActiveFSTreeDirectoryDeclaration<Auth, Meta>;

/**
 * Path handle returned by `tree.path(path)`.
 */
export interface ActiveFSTreePathHandle<Auth = unknown, Meta = unknown> {
  /** Registers this path as a file declaration. */
  file(options?: ActiveFSTreeFileDeclarationOptions<Auth, Meta>): ActiveFSTreeFileDeclaration<Auth, Meta>;
  /** Registers this path as a directory declaration. */
  dir(
    childrenOrFactory?: ActiveFSTreeDeclaration<Auth, Meta> | ActiveFSTreeDirectoryChildrenFactory<Auth, Meta>,
    options?: ActiveFSTreeDirectoryDeclarationOptions<Auth, Meta>
  ): ActiveFSTreeDirectoryDeclaration<Auth, Meta>;
  /** Sets the metadata handler for this path. */
  setInfo(handler: ActiveFSTreeInfoHandler<Auth, Meta>): this;
  /** Sets the list handler for this path. */
  setList(handler: ActiveFSTreeListHandler<Auth, Meta>): this;
  /** Sets the read handler for this path. */
  setRead(handler: ActiveFSTreeReadHandler<Auth, Meta>): this;
  /** Sets the semantic search handler for this path. */
  setSearch(handler: ActiveFSTreeSearchHandler<Auth, Meta>): this;
  /** Sets the walk handler for this path. */
  setWalk(handler: ActiveFSTreeWalkHandler<Auth, Meta>): this;
  /** Sets the write handler for this path. */
  setWrite(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this;
  /** Sets the remove handler for this path. */
  setRemove(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this;
  /** Sets the move handler for this path. */
  setMove(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this;
  /** Sets the copy handler for this path. */
  setCopy(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this;
  /** Sets the make-directory handler for this path. */
  setMakeDir(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this;
  /** Sets the truncate handler for this path. */
  setTruncate(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this;
  /** Sets the metadata update handler for this path. */
  setUpdateInfo(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this;
  /** Sets the `stat` command handler for this path. */
  setStat(handler: ActiveFSTreeCommandHandler<Auth, Meta, "stat">): this;
  /** Sets the optional `grep` command handler for this path. */
  setGrep(handler: ActiveFSTreeCommandHandler<Auth, Meta, "grep">): this;
  /** Sets the optional `rg` command handler for this path. */
  setRg(handler: ActiveFSTreeCommandHandler<Auth, Meta, "rg">): this;
  /** Sets the optional `find` command handler for this path. */
  setFind(handler: ActiveFSTreeCommandHandler<Auth, Meta, "find">): this;
  /** Sets the optional `ls` command handler for this path. */
  setLs(handler: ActiveFSTreeCommandHandler<Auth, Meta, "ls">): this;
  /** Sets the optional `cat` command handler for this path. */
  setCat(handler: ActiveFSTreeCommandHandler<Auth, Meta, "cat">): this;
  /** Sets the optional `head` command handler for this path. */
  setHead(handler: ActiveFSTreeCommandHandler<Auth, Meta, "head">): this;
  /** Sets the optional `tail` command handler for this path. */
  setTail(handler: ActiveFSTreeCommandHandler<Auth, Meta, "tail">): this;
  /** Sets the optional `sed` command handler for this path. */
  setSed(handler: ActiveFSTreeCommandHandler<Auth, Meta, "sed">): this;
  /** Registers a pre-operation hook for this path. */
  pre(operation: ActiveFSTreeOperation, hook: ActiveFSTreeHook<Auth, Meta>): this;
  /** Registers a post-operation hook for this path. */
  post(operation: ActiveFSTreeOperation, hook: ActiveFSTreeHook<Auth, Meta>): this;
  /** Registers a committed change listener for this path. */
  on(event: ActiveFSTreeChangeEvent, handler: ActiveFSTreeChangeHandler<Meta>): this;
}

/**
 * Options accepted by `fsTree`.
 */
export interface ActiveFSTreeOptions<Auth = unknown, Meta = unknown>
  extends ActiveFSTreeHandlerSet<Auth, Meta>,
    ActiveFSTreeCommandSet<Auth, Meta>,
    ActiveFSTreeNodePolicy<Meta> {
  name?: string;
  capabilities?: ActiveFSCapabilities;
}

/**
 * Public tree-first authoring API.
 */
export interface ActiveFSTree<Auth = unknown, Meta = unknown> {
  name?: string;
  capabilities?: ActiveFSCapabilities;
  /** Declares or replaces a path in the live tree. */
  set(path: string, declaration: ActiveFSTreeNodeDeclaration<Auth, Meta> | ActiveFSTreeDeclaration<Auth, Meta>): this;
  /** Returns a chainable handle for configuring a path or path pattern. */
  path(path: string): ActiveFSTreePathHandle<Auth, Meta>;
  /** Returns metadata for a tree path. */
  info(ctx: ActiveFSContext<Auth, Meta>, path: ActiveFSPath): Promise<ActiveFSTreeInfo<Meta>>;
  /** Lists children for a tree directory. */
  list(ctx: ActiveFSContext<Auth, Meta>, path: ActiveFSPath): Promise<ActiveFSTreeListResult<Auth, Meta>>;
  /** Reads file content from the tree. */
  read(ctx: ActiveFSContext<Auth, Meta>, path: ActiveFSPath, options?: ActiveFSReadOptions): Promise<ActiveFSTreeReadResult<Meta>>;
  /** Searches a tree path using semantic search. */
  search(ctx: ActiveFSContext<Auth, Meta>, path: ActiveFSPath, query: ActiveFSSearchQuery): Promise<ActiveFSTreeSearchResult<Meta>>;
  /** Walks a tree path recursively. */
  walk(ctx: ActiveFSContext<Auth, Meta>, path: ActiveFSPath, options?: { includeNonEnumerable?: boolean }): Promise<ActiveFSTreeWalkResult<Meta>>;
  /** Writes file content through tree policy, hooks, and handlers. */
  write(ctx: ActiveFSContext<Auth, Meta>, path: ActiveFSPath, content: string | Uint8Array, options?: ActiveFSWriteOptions<Meta>): Promise<ActiveFSTreeMutationResult<Auth, Meta>>;
  /** Removes a tree path through tree policy, hooks, and handlers. */
  remove(ctx: ActiveFSContext<Auth, Meta>, path: ActiveFSPath, options?: ActiveFSDeleteOptions): Promise<ActiveFSTreeMutationResult<Auth, Meta>>;
  /** Creates a directory through tree policy, hooks, and handlers. */
  makeDir(ctx: ActiveFSContext<Auth, Meta>, path: ActiveFSPath, options?: ActiveFSMkdirOptions<Meta>): Promise<ActiveFSTreeMutationResult<Auth, Meta>>;
  /** Moves a tree path through tree policy, hooks, and handlers. */
  move(ctx: ActiveFSContext<Auth, Meta>, fromPath: ActiveFSPath, toPath: ActiveFSPath, options?: ActiveFSRenameOptions): Promise<ActiveFSTreeMutationResult<Auth, Meta>>;
  /** Copies a tree path through tree policy, hooks, and handlers. */
  copy(ctx: ActiveFSContext<Auth, Meta>, fromPath: ActiveFSPath, toPath: ActiveFSPath, options?: ActiveFSCopyOptions): Promise<ActiveFSTreeMutationResult<Auth, Meta>>;
  /** Truncates a file through tree policy, hooks, and handlers. */
  truncate(ctx: ActiveFSContext<Auth, Meta>, path: ActiveFSPath, options?: ActiveFSTruncateOptions): Promise<ActiveFSTreeMutationResult<Auth, Meta>>;
  /** Updates tree metadata through tree policy, hooks, and handlers. */
  updateInfo(ctx: ActiveFSContext<Auth, Meta>, path: ActiveFSPath, options: ActiveFSMetadataUpdateOptions<Meta>): Promise<ActiveFSTreeMutationResult<Auth, Meta>>;
  /** Subscribes to committed tree events below a path. */
  watch(ctx: ActiveFSContext<Auth, Meta>, path: ActiveFSPath, onEvent: (event: ActiveFSWatchEvent<Meta>) => void, options?: ActiveFSWatchOptions): Promise<ActiveFSWatchSubscription>;
  /** Registers a tree-level pre-operation hook. */
  pre(operation: ActiveFSTreeOperation, hook: ActiveFSTreeHook<Auth, Meta>): this;
  /** Registers a tree-level post-operation hook. */
  post(operation: ActiveFSTreeOperation, hook: ActiveFSTreeHook<Auth, Meta>): this;
  /** Registers a tree-level committed change listener. */
  on(event: ActiveFSTreeChangeEvent, handler: ActiveFSTreeChangeHandler<Meta>): this;
  /** Registers a listener for every committed tree change event. */
  onChange(handler: ActiveFSTreeChangeHandler<Meta>): this;
  /** Runs an optional command handler or its default semantic mapping. */
  command<Command extends ActiveFSTreeCommand>(
    ctx: ActiveFSContext<Auth, Meta>,
    command: Command,
    path: string,
    input: ActiveFSCommandInput<Command>
  ): Promise<ActiveFSTreeCommandResultMap<Meta>[Command]>;
}

/**
 * Executes the canonical semantic mapping for an optional tree command.
 *
 * Source adapters can delegate here when they do not provide a specialized
 * handler, keeping `head`, `tail`, `sed`, search, and traversal behavior
 * consistent across local, generated, and remote trees.
 */
export async function runDefaultActiveFSTreeCommand<
  Auth,
  Meta,
  Command extends ActiveFSTreeCommand
>(
  tree: Pick<ActiveFSTree<Auth, Meta>, "info" | "list" | "read" | "search" | "walk">,
  ctx: ActiveFSContext<Auth, Meta>,
  command: Command,
  path: string,
  input: ActiveFSCommandInput<Command>
): Promise<ActiveFSTreeCommandResultMap<Meta>[Command]> {
  const normalizedPath = normalizeActiveFSPath(path);
  if (command === "ls") {
    const result = await tree.list(ctx, normalizedPath);
    return treeListToCommandInfos(result, normalizedPath) as ActiveFSTreeCommandResultMap<Meta>[Command];
  }
  if (command === "stat") {
    return await tree.info(ctx, normalizedPath) as ActiveFSTreeCommandResultMap<Meta>[Command];
  }
  if (command === "grep" || command === "rg") {
    const query = input as ActiveFSCommandInput<"grep">;
    if (!query.pattern) {
      throw new ActiveFSError("INVALID_REQUEST", `${command} requires pattern`, { path: normalizedPath });
    }
    return await tree.search(ctx, normalizedPath, query) as ActiveFSTreeCommandResultMap<Meta>[Command];
  }
  if (command === "find") {
    const walked = await tree.walk(ctx, normalizedPath, input as ActiveFSCommandInput<"find">);
    const infos = isAsyncIterable<NonNullable<ActiveFSTreeInfo<Meta>>>(walked)
      ? await collectAsyncIterable(walked)
      : walked;
    return infos.filter((info): info is NonNullable<ActiveFSTreeInfo<Meta>> => Boolean(info)) as ActiveFSTreeCommandResultMap<Meta>[Command];
  }
  const readInput = input as ActiveFSCommandInput<"cat">;
  const result = await tree.read(ctx, normalizedPath, readInput.options);
  if (command === "cat") {
    return result as ActiveFSTreeCommandResultMap<Meta>[Command];
  }
  if (command === "head" || command === "tail") {
    const lineInput = input as ActiveFSCommandInput<"head">;
    const lines = validateCommandLineCount(lineInput.lines, command);
    return transformTreeReadText(result, (text) => command === "head"
      ? takeHeadLines(text, lines)
      : takeTailLines(text, lines)) as ActiveFSTreeCommandResultMap<Meta>[Command];
  }
  const sedInput = input as ActiveFSCommandInput<"sed">;
  if (typeof sedInput.pattern !== "string" || sedInput.pattern.length === 0 || typeof sedInput.replacement !== "string") {
    throw new ActiveFSError("INVALID_REQUEST", "sed requires non-empty pattern and string replacement", { path: normalizedPath });
  }
  return transformTreeReadText(result, (text) => replaceCommandText(text, sedInput)) as ActiveFSTreeCommandResultMap<Meta>[Command];
}

/**
 * Creates a file declaration for `fsTree`.
 */
export function file<Auth = unknown, Meta = unknown>(
  options?: ActiveFSTreeFileDeclarationOptions<Auth, Meta>
): ActiveFSTreeFileDeclaration<Auth, Meta>;
/**
 * Creates a file declaration and merges additional declaration options.
 */
export function file<Auth = unknown, Meta = unknown>(
  options: ActiveFSTreeFileDeclarationOptions<Auth, Meta>,
  extraOptions: ActiveFSTreeFileDeclarationOptions<Auth, Meta>
): ActiveFSTreeFileDeclaration<Auth, Meta>;
/**
 * Creates a file declaration.
 */
export function file<Auth = unknown, Meta = unknown>(
  options: ActiveFSTreeFileDeclarationOptions<Auth, Meta> = {},
  extraOptions: ActiveFSTreeFileDeclarationOptions<Auth, Meta> = {}
): ActiveFSTreeFileDeclaration<Auth, Meta> {
  return createFileDeclaration<Auth, Meta>({
    ...options,
    ...extraOptions
  });
}

const activeFSTreeDeclarationSymbol = Symbol("activefs.treeDeclaration");

type InternalTreeNodeDeclaration<Auth, Meta> =
  | ActiveFSTreeFileDeclarationImpl<Auth, Meta>
  | ActiveFSTreeDirectoryDeclarationImpl<Auth, Meta>;

interface ActiveFSTreeRecord<Auth, Meta> {
  path: ActiveFSPath;
  parentPath?: ActiveFSPath;
  declaration: InternalTreeNodeDeclaration<Auth, Meta>;
  pattern?: CompiledTreePattern;
}

interface ResolvedTreeRecord<Auth, Meta> {
  record: ActiveFSTreeRecord<Auth, Meta>;
  path: ActiveFSPath;
  params: Record<string, string>;
  ancestors: ActiveFSTreeRecord<Auth, Meta>[];
  ephemeral?: boolean;
}

interface CompiledTreePattern {
  path: ActiveFSPath;
  names: string[];
  regex: RegExp;
  prefixRegex: RegExp;
  staticParent: ActiveFSPath;
}

type TreeHookMap<Auth, Meta> = Map<ActiveFSTreeOperation, ActiveFSTreeHook<Auth, Meta>[]>;
type TreeListenerMap<Meta> = Map<ActiveFSTreeChangeEvent, ActiveFSTreeChangeHandler<Meta>[]>;

class ActiveFSTreeFileDeclarationImpl<Auth, Meta>
  implements ActiveFSTreeFileDeclaration<Auth, Meta> {
  readonly [activeFSTreeDeclarationSymbol] = true;
  readonly treeNodeKind = "file";
  readonly options: ActiveFSTreeFileDeclarationOptions<Auth, Meta>;
  readonly preHooks: TreeHookMap<Auth, Meta> = new Map();
  readonly postHooks: TreeHookMap<Auth, Meta> = new Map();
  readonly listeners: TreeListenerMap<Meta> = new Map();

  constructor(options: ActiveFSTreeFileDeclarationOptions<Auth, Meta> = {}) {
    this.options = { ...options };
  }

  setInfo(handler: ActiveFSTreeInfoHandler<Auth, Meta>): this {
    this.options.info = handler;
    return this;
  }

  setRead(handler: ActiveFSTreeReadHandler<Auth, Meta>): this {
    this.options.read = handler;
    return this;
  }

  setSearch(handler: ActiveFSTreeSearchHandler<Auth, Meta>): this {
    this.options.search = handler;
    return this;
  }

  setWalk(handler: ActiveFSTreeWalkHandler<Auth, Meta>): this {
    this.options.walk = handler;
    return this;
  }

  setWrite(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this {
    this.options.write = handler;
    return this;
  }

  setRemove(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this {
    this.options.remove = handler;
    return this;
  }

  setTruncate(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this {
    this.options.truncate = handler;
    return this;
  }

  setUpdateInfo(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this {
    this.options.updateInfo = handler;
    return this;
  }

  setStat(handler: ActiveFSTreeCommandHandler<Auth, Meta, "stat">): this {
    this.options.stat = handler;
    return this;
  }

  setGrep(handler: ActiveFSTreeCommandHandler<Auth, Meta, "grep">): this {
    this.options.grep = handler;
    return this;
  }

  setRg(handler: ActiveFSTreeCommandHandler<Auth, Meta, "rg">): this {
    this.options.rg = handler;
    return this;
  }

  setCat(handler: ActiveFSTreeCommandHandler<Auth, Meta, "cat">): this {
    this.options.cat = handler;
    return this;
  }

  setHead(handler: ActiveFSTreeCommandHandler<Auth, Meta, "head">): this {
    this.options.head = handler;
    return this;
  }

  setTail(handler: ActiveFSTreeCommandHandler<Auth, Meta, "tail">): this {
    this.options.tail = handler;
    return this;
  }

  setSed(handler: ActiveFSTreeCommandHandler<Auth, Meta, "sed">): this {
    this.options.sed = handler;
    return this;
  }

  pre(operation: ActiveFSTreeOperation, hook: ActiveFSTreeHook<Auth, Meta>): this {
    addTreeHook(this.preHooks, operation, hook);
    return this;
  }

  post(operation: ActiveFSTreeOperation, hook: ActiveFSTreeHook<Auth, Meta>): this {
    addTreeHook(this.postHooks, operation, hook);
    return this;
  }

  on(event: ActiveFSTreeChangeEvent, handler: ActiveFSTreeChangeHandler<Meta>): this {
    addTreeListener(this.listeners, event, handler);
    return this;
  }
}

class ActiveFSTreeDirectoryDeclarationImpl<Auth, Meta>
  implements ActiveFSTreeDirectoryDeclaration<Auth, Meta> {
  readonly [activeFSTreeDeclarationSymbol] = true;
  readonly treeNodeKind = "directory";
  readonly options: ActiveFSTreeDirectoryDeclarationOptions<Auth, Meta>;
  readonly childrenOrFactory?: ActiveFSTreeDeclaration<Auth, Meta> | ActiveFSTreeDirectoryChildrenFactory<Auth, Meta>;
  readonly preHooks: TreeHookMap<Auth, Meta> = new Map();
  readonly postHooks: TreeHookMap<Auth, Meta> = new Map();
  readonly listeners: TreeListenerMap<Meta> = new Map();

  constructor(
    childrenOrFactory?: ActiveFSTreeDeclaration<Auth, Meta> | ActiveFSTreeDirectoryChildrenFactory<Auth, Meta>,
    options: ActiveFSTreeDirectoryDeclarationOptions<Auth, Meta> = {}
  ) {
    this.childrenOrFactory = childrenOrFactory;
    this.options = { ...options };
  }

  setInfo(handler: ActiveFSTreeInfoHandler<Auth, Meta>): this {
    this.options.info = handler;
    return this;
  }

  setList(handler: ActiveFSTreeListHandler<Auth, Meta>): this {
    this.options.list = handler;
    return this;
  }

  setRead(handler: ActiveFSTreeReadHandler<Auth, Meta>): this {
    this.options.read = handler;
    return this;
  }

  setSearch(handler: ActiveFSTreeSearchHandler<Auth, Meta>): this {
    this.options.search = handler;
    return this;
  }

  setWalk(handler: ActiveFSTreeWalkHandler<Auth, Meta>): this {
    this.options.walk = handler;
    return this;
  }

  setWrite(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this {
    this.options.write = handler;
    return this;
  }

  setRemove(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this {
    this.options.remove = handler;
    return this;
  }

  setMove(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this {
    this.options.move = handler;
    return this;
  }

  setCopy(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this {
    this.options.copy = handler;
    return this;
  }

  setMakeDir(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this {
    this.options.makeDir = handler;
    return this;
  }

  setUpdateInfo(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this {
    this.options.updateInfo = handler;
    return this;
  }

  setStat(handler: ActiveFSTreeCommandHandler<Auth, Meta, "stat">): this {
    this.options.stat = handler;
    return this;
  }

  setGrep(handler: ActiveFSTreeCommandHandler<Auth, Meta, "grep">): this {
    this.options.grep = handler;
    return this;
  }

  setRg(handler: ActiveFSTreeCommandHandler<Auth, Meta, "rg">): this {
    this.options.rg = handler;
    return this;
  }

  setFind(handler: ActiveFSTreeCommandHandler<Auth, Meta, "find">): this {
    this.options.find = handler;
    return this;
  }

  setLs(handler: ActiveFSTreeCommandHandler<Auth, Meta, "ls">): this {
    this.options.ls = handler;
    return this;
  }

  pre(operation: ActiveFSTreeOperation, hook: ActiveFSTreeHook<Auth, Meta>): this {
    addTreeHook(this.preHooks, operation, hook);
    return this;
  }

  post(operation: ActiveFSTreeOperation, hook: ActiveFSTreeHook<Auth, Meta>): this {
    addTreeHook(this.postHooks, operation, hook);
    return this;
  }

  on(event: ActiveFSTreeChangeEvent, handler: ActiveFSTreeChangeHandler<Meta>): this {
    addTreeListener(this.listeners, event, handler);
    return this;
  }
}

class ActiveFSTreePathHandleImpl<Auth, Meta>
  implements ActiveFSTreePathHandle<Auth, Meta> {
  constructor(
    private readonly tree: ActiveFSTreeImpl<Auth, Meta>,
    private readonly targetPath: ActiveFSPath
  ) {}

  file(options: ActiveFSTreeFileDeclarationOptions<Auth, Meta> = {}): ActiveFSTreeFileDeclaration<Auth, Meta> {
    const declaration = createFileDeclaration<Auth, Meta>(options);
    this.tree.set(this.targetPath, declaration);
    return declaration;
  }

  dir(
    childrenOrFactory?: ActiveFSTreeDeclaration<Auth, Meta> | ActiveFSTreeDirectoryChildrenFactory<Auth, Meta>,
    options: ActiveFSTreeDirectoryDeclarationOptions<Auth, Meta> = {}
  ): ActiveFSTreeDirectoryDeclaration<Auth, Meta> {
    const declaration = createDirectoryDeclaration(childrenOrFactory, options);
    this.tree.set(this.targetPath, declaration);
    return declaration;
  }

  setInfo(handler: ActiveFSTreeInfoHandler<Auth, Meta>): this {
    this.ensureFile().setInfo(handler);
    return this;
  }

  setList(handler: ActiveFSTreeListHandler<Auth, Meta>): this {
    this.ensureDirectory().setList(handler);
    return this;
  }

  setRead(handler: ActiveFSTreeReadHandler<Auth, Meta>): this {
    this.ensureFile().setRead(handler);
    return this;
  }

  setSearch(handler: ActiveFSTreeSearchHandler<Auth, Meta>): this {
    this.ensureFile().setSearch(handler);
    return this;
  }

  setWalk(handler: ActiveFSTreeWalkHandler<Auth, Meta>): this {
    this.ensureDirectory().setWalk(handler);
    return this;
  }

  setWrite(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this {
    this.ensureFile().setWrite(handler);
    return this;
  }

  setRemove(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this {
    this.ensureFile().setRemove(handler);
    return this;
  }

  setMove(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this {
    this.ensureDirectory().setMove(handler);
    return this;
  }

  setCopy(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this {
    this.ensureDirectory().setCopy(handler);
    return this;
  }

  setMakeDir(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this {
    this.ensureDirectory().setMakeDir(handler);
    return this;
  }

  setTruncate(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this {
    this.ensureFile().setTruncate(handler);
    return this;
  }

  setUpdateInfo(handler: ActiveFSTreeMutationHandler<Auth, Meta>): this {
    this.ensureFile().setUpdateInfo(handler);
    return this;
  }

  setStat(handler: ActiveFSTreeCommandHandler<Auth, Meta, "stat">): this {
    this.ensureFile().setStat(handler);
    return this;
  }

  setGrep(handler: ActiveFSTreeCommandHandler<Auth, Meta, "grep">): this {
    this.ensureFile().setGrep(handler);
    return this;
  }

  setRg(handler: ActiveFSTreeCommandHandler<Auth, Meta, "rg">): this {
    this.ensureFile().setRg(handler);
    return this;
  }

  setFind(handler: ActiveFSTreeCommandHandler<Auth, Meta, "find">): this {
    this.ensureDirectory().setFind(handler);
    return this;
  }

  setLs(handler: ActiveFSTreeCommandHandler<Auth, Meta, "ls">): this {
    this.ensureDirectory().setLs(handler);
    return this;
  }

  setCat(handler: ActiveFSTreeCommandHandler<Auth, Meta, "cat">): this {
    this.ensureFile().setCat(handler);
    return this;
  }

  setHead(handler: ActiveFSTreeCommandHandler<Auth, Meta, "head">): this {
    this.ensureFile().setHead(handler);
    return this;
  }

  setTail(handler: ActiveFSTreeCommandHandler<Auth, Meta, "tail">): this {
    this.ensureFile().setTail(handler);
    return this;
  }

  setSed(handler: ActiveFSTreeCommandHandler<Auth, Meta, "sed">): this {
    this.ensureFile().setSed(handler);
    return this;
  }

  pre(operation: ActiveFSTreeOperation, hook: ActiveFSTreeHook<Auth, Meta>): this {
    this.ensureFile().pre(operation, hook);
    return this;
  }

  post(operation: ActiveFSTreeOperation, hook: ActiveFSTreeHook<Auth, Meta>): this {
    this.ensureFile().post(operation, hook);
    return this;
  }

  on(event: ActiveFSTreeChangeEvent, handler: ActiveFSTreeChangeHandler<Meta>): this {
    this.ensureFile().on(event, handler);
    return this;
  }

  private ensureFile(): ActiveFSTreeFileDeclarationImpl<Auth, Meta> {
    const existing = this.tree.exactDeclaration(this.targetPath);
    if (existing instanceof ActiveFSTreeFileDeclarationImpl) {
      return existing;
    }
    const declaration = createFileDeclaration<Auth, Meta>();
    this.tree.set(this.targetPath, declaration);
    return declaration as ActiveFSTreeFileDeclarationImpl<Auth, Meta>;
  }

  private ensureDirectory(): ActiveFSTreeDirectoryDeclarationImpl<Auth, Meta> {
    const existing = this.tree.exactDeclaration(this.targetPath);
    if (existing instanceof ActiveFSTreeDirectoryDeclarationImpl) {
      return existing;
    }
    const declaration = createDirectoryDeclaration<Auth, Meta>();
    this.tree.set(this.targetPath, declaration);
    return declaration as ActiveFSTreeDirectoryDeclarationImpl<Auth, Meta>;
  }
}

class ActiveFSTreeImpl<Auth, Meta>
  implements ActiveFSTree<Auth, Meta> {
  name?: string;
  capabilities?: ActiveFSCapabilities;

  private readonly nodesByPath = new Map<ActiveFSPath, ActiveFSTreeRecord<Auth, Meta>>();
  private readonly childrenByDirectoryPath = new Map<ActiveFSPath, Map<string, ActiveFSPath>>();
  private readonly patternRecords: ActiveFSTreeRecord<Auth, Meta>[] = [];
  private readonly metadataByPath = new Map<ActiveFSPath, Partial<NonNullable<ActiveFSTreeInfo<Meta>>>>();
  private readonly preHooks: TreeHookMap<Auth, Meta> = new Map();
  private readonly postHooks: TreeHookMap<Auth, Meta> = new Map();
  private readonly listeners: TreeListenerMap<Meta> = new Map();
  private readonly changeListeners: ActiveFSTreeChangeHandler<Meta>[] = [];
  private readonly watchers = new Set<{
    root: ActiveFSPath;
    options?: ActiveFSWatchOptions;
    onEvent: (event: ActiveFSWatchEvent<Meta>) => void;
  }>();
  private readonly options: ActiveFSTreeOptions<Auth, Meta>;

  constructor(
    declaration: ActiveFSTreeDeclaration<Auth, Meta> = {},
    options: ActiveFSTreeOptions<Auth, Meta> = {}
  ) {
    this.options = { ...options };
    this.name = options.name ?? "fs-tree";
    const root = createDirectoryDeclaration<Auth, Meta>(undefined, options);
    this.registerNode("/", root, { emit: false });
    this.declare("/", declaration, { emit: false });
    this.refreshCapabilities();
  }

  set(path: string, declaration: ActiveFSTreeNodeDeclaration<Auth, Meta> | ActiveFSTreeDeclaration<Auth, Meta>): this {
    const normalizedPath = normalizeActiveFSPath(path);
    if (isTreeNodeDeclaration<Auth, Meta>(declaration)) {
      this.registerNode(normalizedPath, declaration, { emit: true });
    } else {
      this.registerNode(normalizedPath, createDirectoryDeclaration(declaration), { emit: true });
    }
    this.refreshCapabilities();
    return this;
  }

  path(path: string): ActiveFSTreePathHandle<Auth, Meta> {
    return new ActiveFSTreePathHandleImpl(this, normalizeActiveFSPath(path));
  }

  pre(operation: ActiveFSTreeOperation, hook: ActiveFSTreeHook<Auth, Meta>): this {
    addTreeHook(this.preHooks, operation, hook);
    return this;
  }

  post(operation: ActiveFSTreeOperation, hook: ActiveFSTreeHook<Auth, Meta>): this {
    addTreeHook(this.postHooks, operation, hook);
    return this;
  }

  on(event: ActiveFSTreeChangeEvent, handler: ActiveFSTreeChangeHandler<Meta>): this {
    addTreeListener(this.listeners, event, handler);
    return this;
  }

  onChange(handler: ActiveFSTreeChangeHandler<Meta>): this {
    this.changeListeners.push(handler);
    return this;
  }

  async command<Command extends ActiveFSTreeCommand>(
    ctx: ActiveFSContext<Auth, Meta>,
    command: Command,
    path: string,
    input: ActiveFSCommandInput<Command>
  ): Promise<ActiveFSTreeCommandResultMap<Meta>[Command]> {
    const normalizedPath = normalizeActiveFSPath(path);
    const operation = operationForCommand(command);
    const resolved = await this.resolve(normalizedPath, ctx, operation);
    const handler = this.findCommandHandler(command, normalizedPath, resolved);
    const baseContext = this.createContext(ctx, normalizedPath, operation, resolved, {
      command,
      input,
      options: input
    });
    const records = this.hookRecords(normalizedPath, resolved);
    await this.runPreHooks(operation, baseContext, records);
    let result: ActiveFSTreeCommandResultMap<Meta>[Command];
    if (handler) {
      result = await handler.handler({
        ...baseContext,
        params: handler.params,
        command,
        input
      });
    } else {
      result = await this.runSemanticFallback(command, baseContext, input);
    }
    baseContext.result = result;
    await this.runPostHooks(operation, baseContext, records);
    return result;
  }

  async info(ctx: ActiveFSContext<Auth, Meta>, path: ActiveFSPath): Promise<ActiveFSTreeInfo<Meta>> {
    const normalizedPath = normalizeActiveFSPath(path);
    const resolved = await this.resolve(normalizedPath, ctx, "info");
    const records = this.hookRecords(normalizedPath, resolved);
    const context = this.createContext(ctx, normalizedPath, "info", resolved);
    await this.runPreHooks("info", context, records);
    const handler = this.findOperationHandler("info", normalizedPath, resolved);
    const info = handler
      ? await handler.handler({ ...context, params: handler.params }) as ActiveFSTreeInfo<Meta>
      : this.defaultInfo(normalizedPath, resolved);
    context.result = info;
    await this.runPostHooks("info", context, records);
    return info;
  }

  async list(ctx: ActiveFSContext<Auth, Meta>, path: ActiveFSPath): Promise<ActiveFSTreeListResult<Auth, Meta>> {
    const normalizedPath = normalizeActiveFSPath(path);
    const resolved = await this.resolve(normalizedPath, ctx, "list");
    const records = this.hookRecords(normalizedPath, resolved);
    const context = this.createContext(ctx, normalizedPath, "list", resolved);
    await this.runPreHooks("list", context, records);
    const handler = this.findOperationHandler("list", normalizedPath, resolved);
    const result = handler
      ? await handler.handler({ ...context, params: handler.params }) as ActiveFSTreeListResult<Auth, Meta>
      : await this.defaultList(ctx, normalizedPath, resolved);
    context.result = result;
    await this.runPostHooks("list", context, records);
    return Array.isArray(result) ? [...result].sort(compareTreeInfos) : result;
  }

  async read(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    options?: ActiveFSReadOptions
  ): Promise<ActiveFSTreeReadResult<Meta>> {
    const normalizedPath = normalizeActiveFSPath(path);
    const resolved = await this.resolve(normalizedPath, ctx, "read");
    const records = this.hookRecords(normalizedPath, resolved);
    const context = this.createContext(ctx, normalizedPath, "read", resolved, { options });
    await this.runPreHooks("read", context, records);
    const handler = this.findOperationHandler("read", normalizedPath, resolved);
    const result = handler
      ? await handler.handler({ ...context, params: handler.params }) as ActiveFSTreeReadResult<Meta>
      : await this.defaultRead(ctx, normalizedPath, resolved);
    const readResult = this.applyReadOptions(result, options);
    context.result = readResult;
    await this.runPostHooks("read", context, records);
    return readResult;
  }

  async search(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    query: ActiveFSSearchQuery
  ): Promise<ActiveFSTreeSearchResult<Meta>> {
    const normalizedPath = normalizeActiveFSPath(path);
    const resolved = await this.resolve(normalizedPath, ctx, "search");
    const records = this.hookRecords(normalizedPath, resolved);
    const context = this.createContext(ctx, normalizedPath, "search", resolved, { query });
    await this.runPreHooks("search", context, records);
    const handler = this.findOperationHandler("search", normalizedPath, resolved);
    const treeResult = handler
      ? await handler.handler({ ...context, params: handler.params }) as ActiveFSTreeSearchResult<Meta>
      : await this.defaultSearch(ctx, normalizedPath, query);
    const result: ActiveFSTreeSearchResult<Meta> = {
      matches: treeResult.matches.map((match) => ({
        ...match,
        path: normalizeActiveFSPath(match.path)
      })),
      complete: treeResult.complete ?? true,
      strategy: treeResult.strategy ?? (handler ? "source" : "scan"),
      incompleteReasons: treeResult.complete === false
        ? treeResult.incompleteReasons ?? ["source-incomplete"]
        : undefined
    };
    context.result = result;
    await this.runPostHooks("search", context, records);
    return result;
  }

  async walk(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    options: { includeNonEnumerable?: boolean } = {}
  ): Promise<ActiveFSTreeWalkResult<Meta>> {
    const normalizedPath = normalizeActiveFSPath(path);
    const resolved = await this.resolve(normalizedPath, ctx, "walk");
    const records = this.hookRecords(normalizedPath, resolved);
    const context = this.createContext(ctx, normalizedPath, "walk", resolved, { options });
    await this.runPreHooks("walk", context, records);
    const handler = this.findOperationHandler("walk", normalizedPath, resolved);
    const result = handler
      ? await handler.handler({ ...context, params: handler.params }) as ActiveFSTreeWalkResult<Meta>
      : await this.defaultWalk(ctx, normalizedPath, options);
    context.result = result;
    await this.runPostHooks("walk", context, records);
    return result;
  }

  async write(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    content: string | Uint8Array,
    options?: ActiveFSWriteOptions<Meta>
  ): Promise<ActiveFSTreeMutationResult<Auth, Meta>> {
    const normalizedPath = normalizeActiveFSPath(path);
    const resolved = await this.resolve(normalizedPath, ctx, "write");
    const records = this.hookRecords(normalizedPath, resolved, parentActiveFSPath(normalizedPath));
    const context = this.createContext(ctx, normalizedPath, "write", resolved, { content, options });
    await this.runPreHooks("write", context, records);
    const handler = this.findOperationHandler("write", normalizedPath, resolved);
    let descriptor: ActiveFSTreeMutationResult<Auth, Meta>;
    if (handler) {
      descriptor = await (handler.handler as ActiveFSTreeMutationHandler<Auth, Meta>)({ ...context, params: handler.params });
    } else {
      const result = await this.defaultWrite(ctx, normalizedPath, context.content ?? content, options, resolved);
      descriptor = result.created ? { created: normalizedPath } : { modified: normalizedPath };
    }
    context.result = descriptor;
    await this.runPostHooks("write", context, records);
    await this.emitMutationResult("write", normalizedPath, undefined, descriptor);
    return descriptor;
  }

  async delete(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    options?: ActiveFSDeleteOptions
  ): Promise<ActiveFSTreeMutationResult<Auth, Meta>> {
    return this.remove(ctx, path, options);
  }

  async rmdir(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    options?: ActiveFSDeleteOptions
  ): Promise<ActiveFSTreeMutationResult<Auth, Meta>> {
    return this.remove(ctx, path, options);
  }

  async makeDir(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    options?: ActiveFSMkdirOptions<Meta>
  ): Promise<ActiveFSTreeMutationResult<Auth, Meta>> {
    const normalizedPath = normalizeActiveFSPath(path);
    const resolved = await this.resolve(normalizedPath, ctx, "makeDir");
    const records = this.hookRecords(normalizedPath, resolved, parentActiveFSPath(normalizedPath));
    const context = this.createContext(ctx, normalizedPath, "makeDir", resolved, { options });
    await this.runPreHooks("makeDir", context, records);
    const handler = this.findOperationHandler("makeDir", normalizedPath, resolved);
    let descriptor: ActiveFSTreeMutationResult<Auth, Meta>;
    if (handler) {
      descriptor = await (handler.handler as ActiveFSTreeMutationHandler<Auth, Meta>)({ ...context, params: handler.params });
    } else {
      const created = this.defaultMakeDir(normalizedPath, options);
      descriptor = created ? { created: normalizedPath } : { modified: normalizedPath };
    }
    context.result = descriptor;
    await this.runPostHooks("makeDir", context, records);
    await this.emitMutationResult("makeDir", normalizedPath, undefined, descriptor);
    return descriptor;
  }

  async move(
    ctx: ActiveFSContext<Auth, Meta>,
    fromPath: ActiveFSPath,
    toPath: ActiveFSPath,
    options?: ActiveFSRenameOptions
  ): Promise<ActiveFSTreeMutationResult<Auth, Meta>> {
    const normalizedFrom = normalizeActiveFSPath(fromPath);
    const normalizedTo = normalizeActiveFSPath(toPath);
    const resolved = await this.resolve(normalizedFrom, ctx, "move");
    const records = this.hookRecords(normalizedFrom, resolved);
    const context = this.createContext(ctx, normalizedFrom, "move", resolved, { toPath: normalizedTo, options });
    await this.runPreHooks("move", context, records);
    const handler = this.findOperationHandler("move", normalizedFrom, resolved);
    const descriptor: ActiveFSTreeMutationResult<Auth, Meta> = handler
      ? await (handler.handler as ActiveFSTreeMutationHandler<Auth, Meta>)({ ...context, params: handler.params })
      : this.defaultMove(normalizedFrom, normalizedTo, options);
    context.result = descriptor;
    await this.runPostHooks("move", context, records);
    await this.emitMutationResult("move", normalizedFrom, normalizedTo, descriptor);
    return descriptor;
  }

  async copy(
    ctx: ActiveFSContext<Auth, Meta>,
    fromPath: ActiveFSPath,
    toPath: ActiveFSPath,
    options?: ActiveFSCopyOptions
  ): Promise<ActiveFSTreeMutationResult<Auth, Meta>> {
    const normalizedFrom = normalizeActiveFSPath(fromPath);
    const normalizedTo = normalizeActiveFSPath(toPath);
    const resolved = await this.resolve(normalizedFrom, ctx, "copy");
    const records = this.hookRecords(normalizedFrom, resolved);
    const context = this.createContext(ctx, normalizedFrom, "copy", resolved, { toPath: normalizedTo, options });
    await this.runPreHooks("copy", context, records);
    const handler = this.findOperationHandler("copy", normalizedFrom, resolved);
    const descriptor: ActiveFSTreeMutationResult<Auth, Meta> = handler
      ? await (handler.handler as ActiveFSTreeMutationHandler<Auth, Meta>)({ ...context, params: handler.params })
      : this.defaultCopy(normalizedFrom, normalizedTo, options);
    context.result = descriptor;
    await this.runPostHooks("copy", context, records);
    await this.emitMutationResult("copy", normalizedFrom, normalizedTo, descriptor);
    return descriptor;
  }

  async truncate(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    options?: ActiveFSTruncateOptions
  ): Promise<ActiveFSTreeMutationResult<Auth, Meta>> {
    const normalizedPath = normalizeActiveFSPath(path);
    const resolved = await this.resolve(normalizedPath, ctx, "truncate");
    const records = this.hookRecords(normalizedPath, resolved);
    const context = this.createContext(ctx, normalizedPath, "truncate", resolved, { options });
    await this.runPreHooks("truncate", context, records);
    const handler = this.findOperationHandler("truncate", normalizedPath, resolved);
    const descriptor: ActiveFSTreeMutationResult<Auth, Meta> = handler
      ? await (handler.handler as ActiveFSTreeMutationHandler<Auth, Meta>)({ ...context, params: handler.params })
      : await this.defaultTruncate(ctx, normalizedPath, options, resolved);
    context.result = descriptor;
    await this.runPostHooks("truncate", context, records);
    await this.emitMutationResult("truncate", normalizedPath, undefined, descriptor);
    return descriptor;
  }

  async updateInfo(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    options: ActiveFSMetadataUpdateOptions<Meta>
  ): Promise<ActiveFSTreeMutationResult<Auth, Meta>> {
    const normalizedPath = normalizeActiveFSPath(path);
    const resolved = await this.resolve(normalizedPath, ctx, "updateInfo");
    const records = this.hookRecords(normalizedPath, resolved);
    const context = this.createContext(ctx, normalizedPath, "updateInfo", resolved, { options });
    await this.runPreHooks("updateInfo", context, records);
    const handler = this.findOperationHandler("updateInfo", normalizedPath, resolved);
    const descriptor: ActiveFSTreeMutationResult<Auth, Meta> = handler
      ? await (handler.handler as ActiveFSTreeMutationHandler<Auth, Meta>)({ ...context, params: handler.params })
      : this.defaultUpdateInfo(normalizedPath, options, resolved);
    context.result = descriptor;
    await this.runPostHooks("updateInfo", context, records);
    await this.emitMutationResult("updateInfo", normalizedPath, undefined, descriptor);
    return descriptor;
  }

  async watch(
    _ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    onEvent: (event: ActiveFSWatchEvent<Meta>) => void,
    options?: ActiveFSWatchOptions
  ): Promise<ActiveFSWatchSubscription> {
    const watcher = {
      root: normalizeActiveFSPath(path),
      options,
      onEvent
    };
    this.watchers.add(watcher);
    options?.signal?.addEventListener("abort", () => {
      this.watchers.delete(watcher);
    }, { once: true });
    return {
      close: () => {
        this.watchers.delete(watcher);
      }
    };
  }

  exactDeclaration(path: ActiveFSPath): InternalTreeNodeDeclaration<Auth, Meta> | undefined {
    return this.nodesByPath.get(path)?.declaration;
  }

  private declare(
    basePath: ActiveFSPath,
    declaration: ActiveFSTreeDeclaration<Auth, Meta>,
    options: { emit: boolean }
  ): void {
    for (const [name, value] of Object.entries(declaration)) {
      const childPath = name.startsWith("/")
        ? normalizeActiveFSPath(name)
        : joinActiveFSPath(basePath, name);
      if (isTreeNodeDeclaration<Auth, Meta>(value)) {
        this.registerNode(childPath, value, options);
      } else {
        this.registerNode(childPath, createDirectoryDeclaration(value), options);
      }
    }
  }

  private registerNode(
    path: ActiveFSPath,
    declaration: ActiveFSTreeNodeDeclaration<Auth, Meta>,
    options: { emit: boolean }
  ): void {
    const internalDeclaration = declaration as InternalTreeNodeDeclaration<Auth, Meta>;
    const existed = this.nodesByPath.has(path) || this.patternRecords.some((record) => record.path === path);
    const parentPath = path === "/" ? undefined : parentActiveFSPath(path);
    if (pathIncludesPattern(path)) {
      this.ensureStaticParents(patternStaticParent(path));
      const pattern = compileTreePattern(path);
      const record: ActiveFSTreeRecord<Auth, Meta> = {
        path,
        parentPath: pattern.staticParent,
        declaration: internalDeclaration,
        pattern
      };
      const existingIndex = this.patternRecords.findIndex((candidate) => candidate.path === path);
      if (existingIndex >= 0) {
        this.patternRecords.splice(existingIndex, 1, record);
      } else {
        this.patternRecords.push(record);
      }
      this.patternRecords.sort(comparePatternRecords);
      if (options.emit) {
        void this.emitChange({ type: existed ? "modified" : "created", path });
      }
      return;
    }

    this.ensureStaticParents(parentPath);
    this.nodesByPath.set(path, {
      path,
      parentPath,
      declaration: internalDeclaration
    });
    if (parentPath) {
      const children = this.childrenByDirectoryPath.get(parentPath) ?? new Map<string, ActiveFSPath>();
      children.set(basenameActiveFSPath(path), path);
      this.childrenByDirectoryPath.set(parentPath, children);
    }
    if (internalDeclaration instanceof ActiveFSTreeDirectoryDeclarationImpl) {
      this.childrenByDirectoryPath.set(path, this.childrenByDirectoryPath.get(path) ?? new Map());
      if (internalDeclaration.childrenOrFactory && typeof internalDeclaration.childrenOrFactory !== "function") {
        this.declare(path, internalDeclaration.childrenOrFactory, { emit: false });
      }
    }
    if (options.emit) {
      void this.emitChange({ type: existed ? "modified" : "created", path });
    }
  }

  private ensureStaticParents(path: ActiveFSPath | undefined): void {
    if (!path || path === "/") {
      return;
    }
    const missing: ActiveFSPath[] = [];
    let current = path;
    while (current !== "/" && !this.nodesByPath.has(current)) {
      missing.push(current);
      current = parentActiveFSPath(current);
    }
    for (const parent of missing.reverse()) {
      const parentPath = parentActiveFSPath(parent);
      const declaration = createDirectoryDeclaration<Auth, Meta>() as InternalTreeNodeDeclaration<Auth, Meta>;
      this.nodesByPath.set(parent, {
        path: parent,
        parentPath,
        declaration
      });
      const siblings = this.childrenByDirectoryPath.get(parentPath) ?? new Map<string, ActiveFSPath>();
      siblings.set(basenameActiveFSPath(parent), parent);
      this.childrenByDirectoryPath.set(parentPath, siblings);
      this.childrenByDirectoryPath.set(parent, this.childrenByDirectoryPath.get(parent) ?? new Map());
    }
  }

  private refreshCapabilities(): void {
    const mutable = this.hasMutableSurface();
    this.capabilities = {
      stat: true,
      list: true,
      read: true,
      search: true,
      watch: true,
      rangeReadable: true,
      readable: true,
      searchable: true,
      watchable: true,
      create: mutable,
      write: mutable,
      truncate: mutable,
      delete: mutable,
      mkdir: mutable,
      rmdir: mutable,
      rename: mutable,
      copy: mutable,
      updateMetadata: mutable,
      writable: mutable,
      ...this.options.capabilities
    };
  }

  private hasMutableSurface(): boolean {
    if (this.options.writable || hasMutationHandler(this.options)) {
      return true;
    }
    for (const record of [...this.nodesByPath.values(), ...this.patternRecords]) {
      const options = record.declaration.options;
      if (options.writable || hasMutationHandler(options)) {
        return true;
      }
    }
    return false;
  }

  private async resolve(
    path: ActiveFSPath,
    ctx: ActiveFSContext<Auth, Meta>,
    operation: ActiveFSTreeOperation
  ): Promise<ResolvedTreeRecord<Auth, Meta> | undefined> {
    const exact = this.nodesByPath.get(path);
    if (exact) {
      return {
        record: exact,
        path,
        params: {},
        ancestors: this.ancestorRecords(path)
      };
    }

    for (const record of this.patternRecords) {
      const params = matchPattern(record, path);
      if (params) {
        return {
          record,
          path,
          params,
          ancestors: this.ancestorRecords(record.pattern?.staticParent ?? "/")
        };
      }
    }

    for (const record of this.patternRecords.filter((candidate) =>
      candidate.declaration instanceof ActiveFSTreeDirectoryDeclarationImpl
    )) {
      const match = matchPatternPrefix(record, path);
      if (!match || !match.rest) {
        continue;
      }
      const resolved = await this.resolveFromDirectory(record, path, match.rest, ctx, operation, match.params);
      if (resolved) {
        return resolved;
      }
    }

    const exactAncestors = this.ancestorRecords(path).reverse();
    for (const record of exactAncestors) {
      if (!(record.declaration instanceof ActiveFSTreeDirectoryDeclarationImpl)) {
        continue;
      }
      const rest = relativeActiveFSPath(record.path, path);
      if (!rest) {
        continue;
      }
      const resolved = await this.resolveFromDirectory(record, path, rest, ctx, operation, {});
      if (resolved) {
        return resolved;
      }
    }

    return undefined;
  }

  private async resolveFromDirectory(
    directoryRecord: ActiveFSTreeRecord<Auth, Meta>,
    requestedPath: ActiveFSPath,
    rest: string,
    ctx: ActiveFSContext<Auth, Meta>,
    operation: ActiveFSTreeOperation,
    params: Record<string, string>
  ): Promise<ResolvedTreeRecord<Auth, Meta> | undefined> {
    const directory = directoryRecord.declaration;
    if (!(directory instanceof ActiveFSTreeDirectoryDeclarationImpl) || !directory.childrenOrFactory) {
      return undefined;
    }
    const declaration = typeof directory.childrenOrFactory === "function"
      ? await directory.childrenOrFactory(this.createContext(ctx, directoryRecord.path, operation, {
        record: directoryRecord,
        path: directoryRecord.path,
        params,
        ancestors: this.ancestorRecords(directoryRecord.path)
      }))
      : directory.childrenOrFactory;
    const child = resolveDeclarationChild<Auth, Meta>(declaration, rest);
    if (!child) {
      return undefined;
    }
    const ancestors = [
      ...this.ancestorRecords(directoryRecord.path),
      directoryRecord,
      ...child.ancestors.map((ancestor) => ({
        path: joinActiveFSPath(directoryRecord.path, ancestor.relativePath),
        parentPath: parentActiveFSPath(joinActiveFSPath(directoryRecord.path, ancestor.relativePath)),
        declaration: ancestor.declaration
      }))
    ];
    return {
      record: {
        path: requestedPath,
        parentPath: parentActiveFSPath(requestedPath),
        declaration: child.declaration
      },
      path: requestedPath,
      params,
      ancestors,
      ephemeral: true
    };
  }

  private ancestorRecords(path: ActiveFSPath): ActiveFSTreeRecord<Auth, Meta>[] {
    const ancestors: ActiveFSTreeRecord<Auth, Meta>[] = [];
    let current = parentActiveFSPath(path);
    while (true) {
      const record = this.nodesByPath.get(current);
      if (record) {
        ancestors.unshift(record);
      }
      if (current === "/") {
        break;
      }
      current = parentActiveFSPath(current);
    }
    return ancestors;
  }

  private hookRecords(
    path: ActiveFSPath,
    resolved: ResolvedTreeRecord<Auth, Meta> | undefined,
    fallbackAncestor?: ActiveFSPath
  ): ActiveFSTreeRecord<Auth, Meta>[] {
    if (resolved) {
      return [...resolved.ancestors, resolved.record];
    }
    return this.ancestorRecords(fallbackAncestor ?? path);
  }

  private createContext(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    operation: ActiveFSTreeOperation,
    resolved: ResolvedTreeRecord<Auth, Meta> | undefined,
    extra: Partial<ActiveFSTreeHandlerContext<Auth, Meta>> = {}
  ): ActiveFSTreeHandlerContext<Auth, Meta> {
    return {
      ctx,
      path,
      params: resolved?.params ?? {},
      operation,
      ...extra
    };
  }

  private findOperationHandler(
    operation: ActiveFSTreeOperation,
    path: ActiveFSPath,
    resolved: ResolvedTreeRecord<Auth, Meta> | undefined
  ): { handler: ActiveFSTreeInfoHandler<Auth, Meta> | ActiveFSTreeListHandler<Auth, Meta> | ActiveFSTreeReadHandler<Auth, Meta> | ActiveFSTreeSearchHandler<Auth, Meta> | ActiveFSTreeWalkHandler<Auth, Meta> | ActiveFSTreeMutationHandler<Auth, Meta>; params: Record<string, string> } | undefined {
    const key = handlerKeyForOperation(operation);
    if (resolved) {
      const handler = resolved.record.declaration.options[key];
      if (handler) {
        return { handler, params: resolved.params };
      }
    }
    for (const record of this.patternRecords) {
      const params = matchPattern(record, path);
      const handler = params ? record.declaration.options[key] : undefined;
      if (params && handler) {
        return { handler, params };
      }
    }
    for (const record of this.ancestorRecords(path).reverse()) {
      const handler = record.declaration.options[key];
      if (handler) {
        return { handler, params: {} };
      }
    }
    const treeHandler = this.options[key];
    return treeHandler ? { handler: treeHandler, params: {} } : undefined;
  }

  private findCommandHandler<Command extends ActiveFSTreeCommand>(
    command: Command,
    path: ActiveFSPath,
    resolved: ResolvedTreeRecord<Auth, Meta> | undefined
  ): { handler: ActiveFSTreeCommandHandler<Auth, Meta, Command>; params: Record<string, string> } | undefined {
    const commandHandler = (
      options: ActiveFSTreeCommandSet<Auth, Meta>
    ): ActiveFSTreeCommandHandler<Auth, Meta, Command> | undefined =>
      options[command] as ActiveFSTreeCommandHandler<Auth, Meta, Command> | undefined;
    if (resolved) {
      const handler = commandHandler(resolved.record.declaration.options);
      if (handler) {
        return { handler, params: resolved.params };
      }
    }
    for (const record of this.patternRecords) {
      const params = matchPattern(record, path);
      const handler = params ? commandHandler(record.declaration.options) : undefined;
      if (params && handler) {
        return { handler, params };
      }
    }
    for (const record of this.ancestorRecords(path).reverse()) {
      const handler = commandHandler(record.declaration.options);
      if (handler) {
        return { handler, params: {} };
      }
    }
    const treeHandler = commandHandler(this.options);
    return treeHandler ? { handler: treeHandler, params: {} } : undefined;
  }

  private async runSemanticFallback<Command extends ActiveFSTreeCommand>(
    command: Command,
    context: ActiveFSTreeHandlerContext<Auth, Meta>,
    input: ActiveFSCommandInput<Command>
  ): Promise<ActiveFSTreeCommandResultMap<Meta>[Command]> {
    return runDefaultActiveFSTreeCommand(this, context.ctx, command, context.path, input);
  }

  private defaultInfo(path: ActiveFSPath, resolved: ResolvedTreeRecord<Auth, Meta> | undefined): ActiveFSTreeInfo<Meta> {
    if (!resolved) {
      return null;
    }
    const declaration = resolved.record.declaration;
    const options = declaration.options;
    const fileOptions = declaration instanceof ActiveFSTreeFileDeclarationImpl
      ? declaration.options
      : undefined;
    const metadata = this.metadataByPath.get(path);
    const content = fileOptions?.content !== undefined && typeof fileOptions.content !== "function"
      ? toActiveFSContent(fileOptions.content)
      : undefined;
    return {
      path,
      name: fileOptions?.name ?? (path === "/" ? "" : basenameActiveFSPath(path)),
      kind: declaration.treeNodeKind === "file" ? "file" : "directory",
      type: fileOptions?.type,
      size: declaration.treeNodeKind === "file"
        ? metadata?.size ?? (content === undefined ? undefined : activeFSContentByteLength(content))
        : undefined,
      mtimeMs: metadata?.mtimeMs,
      etag: metadata?.etag,
      revision: metadata?.revision ?? options.cache?.revision,
      enumerable: options.enumerable,
      cache: options.cache,
      permissions: {
        readable: true,
        searchable: true,
        writable: options.writable,
        deletable: options.deletable,
        renamable: options.renamable,
        copyable: options.copyable,
        ...options.permissions
      },
      meta: metadata?.meta ?? metadata?.data ?? options.meta ?? options.data,
      data: metadata?.data ?? metadata?.meta ?? options.data ?? options.meta
    };
  }

  private async defaultList(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    resolved: ResolvedTreeRecord<Auth, Meta> | undefined
  ): Promise<ActiveFSTreeListResult<Auth, Meta>> {
    if (!resolved) {
      throw new ActiveFSNotFoundError(path);
    }
    if (!(resolved.record.declaration instanceof ActiveFSTreeDirectoryDeclarationImpl)) {
      throw new ActiveFSNotDirectoryError(path);
    }
    const infos: ActiveFSTreeInfo<Meta>[] = [];
    const exactChildren = this.childrenByDirectoryPath.get(resolved.record.path);
    if (exactChildren) {
      for (const childPath of exactChildren.values()) {
        const info = await this.info(ctx, childPath);
        if (info) {
          infos.push(info);
        }
      }
    }
    const dynamicChildren = await this.dynamicDirectoryChildren(ctx, resolved);
    for (const [name, declaration] of Object.entries(dynamicChildren)) {
      if (isTreeNodeDeclaration<Auth, Meta>(declaration)) {
        infos.push(this.defaultInfo(joinActiveFSPath(path, name), {
          record: {
            path: joinActiveFSPath(path, name),
            parentPath: path,
            declaration: declaration as InternalTreeNodeDeclaration<Auth, Meta>
          },
          path: joinActiveFSPath(path, name),
          params: resolved.params,
          ancestors: [...resolved.ancestors, resolved.record],
          ephemeral: true
        }));
      }
    }
    return infos;
  }

  private async dynamicDirectoryChildren(
    ctx: ActiveFSContext<Auth, Meta>,
    resolved: ResolvedTreeRecord<Auth, Meta>
  ): Promise<ActiveFSTreeDeclaration<Auth, Meta>> {
    const declaration = resolved.record.declaration;
    if (!(declaration instanceof ActiveFSTreeDirectoryDeclarationImpl) || !declaration.childrenOrFactory) {
      return {};
    }
    if (typeof declaration.childrenOrFactory === "function") {
      return declaration.childrenOrFactory(this.createContext(ctx, resolved.path, "list", resolved));
    }
    return resolved.record.pattern || resolved.ephemeral
      ? declaration.childrenOrFactory
      : {};
  }

  private async defaultRead(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    resolved: ResolvedTreeRecord<Auth, Meta> | undefined
  ): Promise<ActiveFSTreeReadResult<Meta>> {
    if (!resolved) {
      throw new ActiveFSNotFoundError(path);
    }
    const declaration = resolved.record.declaration;
    if (!(declaration instanceof ActiveFSTreeFileDeclarationImpl)) {
      throw new ActiveFSNotFileError(path);
    }
    const content = declaration.options.content;
    if (content === undefined) {
      throw new ActiveFSError("UNSUPPORTED", `fsTree file has no read handler or content: ${path}`, { path });
    }
    return typeof content === "function"
      ? content(this.createContext(ctx, path, "read", resolved))
      : content;
  }

  private async defaultSearch(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    query: ActiveFSSearchQuery
  ): Promise<ActiveFSTreeSearchResult<Meta>> {
    const matches: ActiveFSTreeSearchResult<Meta>["matches"] = [];
    const maxResults = searchResultLimit(query, ctx);
    const incompleteReasons = new Set<ActiveFSSearchIncompleteReason>();

    const visit = async (candidate: ActiveFSPath): Promise<void> => {
      assertSearchNotCancelled(ctx);
      if (searchDeadlineReached(ctx)) {
        incompleteReasons.add("timeout");
        return;
      }

      let info: ActiveFSTreeInfo<Meta>;
      try {
        info = await this.info(ctx, candidate);
      } catch (error) {
        if (isUnreadableSearchError(error)) {
          incompleteReasons.add("unreadable-path");
          return;
        }
        throw error;
      }
      if (!info || (info.enumerable === false && !query.includeNonEnumerable)) {
        return;
      }

      if (info.kind === "directory") {
        let entries: NonNullable<ActiveFSTreeInfo<Meta>>[];
        try {
          entries = await this.listResultToInfos(ctx, candidate, await this.list(ctx, candidate));
        } catch (error) {
          if (isUnreadableSearchError(error)) {
            incompleteReasons.add("unreadable-path");
            return;
          }
          throw error;
        }
        for (const entry of entries) {
          if (incompleteReasons.has("max-results") || incompleteReasons.has("timeout")) {
            return;
          }
          if (entry.path && (entry.enumerable !== false || query.includeNonEnumerable)) {
            await visit(normalizeActiveFSPath(entry.path));
          }
        }
        return;
      }

      try {
        const read = await this.read(ctx, candidate, { encoding: "utf8" });
        for (const match of matchTreeContent<Meta>(candidate, treeReadContent(read), query, info)) {
          if (matches.length >= maxResults) {
            incompleteReasons.add("max-results");
            return;
          }
          matches.push(match);
        }
      } catch (error) {
        if (isUnreadableSearchError(error)) {
          incompleteReasons.add("unreadable-path");
          return;
        }
        throw error;
      }
    };

    await visit(path);
    const complete = incompleteReasons.size === 0;
    return {
      matches,
      complete,
      strategy: "scan",
      incompleteReasons: complete ? undefined : [...incompleteReasons]
    };
  }

  private async defaultWalk(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    options: { includeNonEnumerable?: boolean }
  ): Promise<NonNullable<ActiveFSTreeInfo<Meta>>[]> {
    const info = await this.info(ctx, path);
    if (!info) {
      throw new ActiveFSNotFoundError(path);
    }
    const results: NonNullable<ActiveFSTreeInfo<Meta>>[] = [info];
    if (info.kind !== "directory") {
      return results;
    }
    for (const entry of await this.listResultToInfos(ctx, path, await this.list(ctx, path))) {
      if (entry.enumerable === false && !options.includeNonEnumerable) {
        continue;
      }
      if (!entry.path) {
        continue;
      }
      results.push(...await this.defaultWalk(ctx, normalizeActiveFSPath(entry.path), options));
    }
    return results;
  }

  private async defaultWrite(
    _ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    content: string | Uint8Array,
    options: ActiveFSWriteOptions<Meta> | undefined,
    resolved: ResolvedTreeRecord<Auth, Meta> | undefined
  ): Promise<{ created: boolean }> {
    if (resolved) {
      if (!(resolved.record.declaration instanceof ActiveFSTreeFileDeclarationImpl)) {
        throw new ActiveFSNotFileError(path);
      }
      this.assertWritable(path, resolved.record, "write");
      resolved.record.declaration.options.content = content;
      if (options?.contentType) {
        resolved.record.declaration.options.type = options.contentType;
      }
      return { created: false };
    }
    const parentPath = parentActiveFSPath(path);
    const parent = this.nodesByPath.get(parentPath);
    if (!parent || !(parent.declaration instanceof ActiveFSTreeDirectoryDeclarationImpl)) {
      throw new ActiveFSNotDirectoryError(parentPath);
    }
    this.assertWritable(parentPath, parent, "makeDir");
    this.registerNode(path, createFileDeclaration<Auth, Meta>({
      content,
      type: options?.contentType,
      meta: options?.meta,
      data: options?.meta
    }), { emit: false });
    return { created: true };
  }

  async remove(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    options?: ActiveFSDeleteOptions
  ): Promise<ActiveFSTreeMutationResult<Auth, Meta>> {
    const normalizedPath = normalizeActiveFSPath(path);
    const resolved = await this.resolve(normalizedPath, ctx, "remove");
    const records = this.hookRecords(normalizedPath, resolved);
    const context = this.createContext(ctx, normalizedPath, "remove", resolved, { options });
    await this.runPreHooks("remove", context, records);
    const handler = this.findOperationHandler("remove", normalizedPath, resolved);
    const descriptor: ActiveFSTreeMutationResult<Auth, Meta> = handler
      ? await (handler.handler as ActiveFSTreeMutationHandler<Auth, Meta>)({ ...context, params: handler.params })
      : this.defaultRemove(normalizedPath, options, resolved);
    context.result = descriptor;
    await this.runPostHooks("remove", context, records);
    await this.emitMutationResult("remove", normalizedPath, undefined, descriptor);
    return descriptor;
  }

  private defaultRemove(
    path: ActiveFSPath,
    options: ActiveFSDeleteOptions | undefined,
    resolved: ResolvedTreeRecord<Auth, Meta> | undefined
  ): ActiveFSTreeMutationResult<Auth, Meta> {
    if (!resolved || resolved.ephemeral) {
      throw new ActiveFSNotFoundError(path);
    }
    this.assertWritable(path, resolved.record, "remove");
    const children = this.childrenByDirectoryPath.get(path);
    if (children && children.size > 0 && !options?.recursive) {
      throw new ActiveFSError("CONFLICT", `Directory is not empty: ${path}`, { path });
    }
    this.deleteSubtree(path);
    return { removed: path };
  }

  private defaultMakeDir(path: ActiveFSPath, options: ActiveFSMkdirOptions<Meta> | undefined): boolean {
    if (this.nodesByPath.has(path)) {
      return false;
    }
    const parentPath = parentActiveFSPath(path);
    let parent = this.nodesByPath.get(parentPath);
    if (!parent && options?.recursive) {
      this.defaultMakeDir(parentPath, options);
      parent = this.nodesByPath.get(parentPath);
    }
    if (!parent || !(parent.declaration instanceof ActiveFSTreeDirectoryDeclarationImpl)) {
      throw new ActiveFSNotDirectoryError(parentPath);
    }
    this.assertWritable(parentPath, parent, "makeDir");
    this.registerNode(path, createDirectoryDeclaration<Auth, Meta>(undefined, {
      meta: options?.meta,
      data: options?.meta
    }), { emit: false });
    return true;
  }

  private defaultMove(
    fromPath: ActiveFSPath,
    toPath: ActiveFSPath,
    options: ActiveFSRenameOptions | undefined
  ): ActiveFSTreeMutationResult<Auth, Meta> {
    const record = this.nodesByPath.get(fromPath);
    if (!record) {
      throw new ActiveFSNotFoundError(fromPath);
    }
    this.assertWritable(fromPath, record, "move");
    if (this.nodesByPath.has(toPath) && !options?.overwrite) {
      throw new ActiveFSError("CONFLICT", `Path already exists: ${toPath}`, { path: toPath });
    }
    const parent = this.nodesByPath.get(parentActiveFSPath(toPath));
    if (!parent || !(parent.declaration instanceof ActiveFSTreeDirectoryDeclarationImpl)) {
      throw new ActiveFSNotDirectoryError(parentActiveFSPath(toPath));
    }
    this.assertWritable(parent.path, parent, "makeDir");
    const subtree = [...this.nodesByPath.keys()]
      .filter((path) => isActiveFSPathWithin(fromPath, path))
      .sort((left, right) => left.length - right.length);
    for (const oldPath of subtree) {
      const existing = this.nodesByPath.get(oldPath)!;
      const newPath = normalizeActiveFSPath(`${toPath}${oldPath.slice(fromPath.length)}`);
      this.nodesByPath.delete(oldPath);
      this.nodesByPath.set(newPath, {
        ...existing,
        path: newPath,
        parentPath: newPath === "/" ? undefined : parentActiveFSPath(newPath)
      });
      const metadata = this.metadataByPath.get(oldPath);
      if (metadata) {
        this.metadataByPath.delete(oldPath);
        this.metadataByPath.set(newPath, metadata);
      }
    }
    this.rebuildChildrenIndex();
    return { moved: { from: fromPath, to: toPath } };
  }

  private defaultCopy(
    fromPath: ActiveFSPath,
    toPath: ActiveFSPath,
    options: ActiveFSCopyOptions | undefined
  ): ActiveFSTreeMutationResult<Auth, Meta> {
    const record = this.nodesByPath.get(fromPath);
    if (!record) {
      throw new ActiveFSNotFoundError(fromPath);
    }
    this.assertWritable(fromPath, record, "copy");
    if (this.nodesByPath.has(toPath) && !options?.overwrite) {
      throw new ActiveFSError("CONFLICT", `Path already exists: ${toPath}`, { path: toPath });
    }
    const parent = this.nodesByPath.get(parentActiveFSPath(toPath));
    if (!parent || !(parent.declaration instanceof ActiveFSTreeDirectoryDeclarationImpl)) {
      throw new ActiveFSNotDirectoryError(parentActiveFSPath(toPath));
    }
    this.assertWritable(parent.path, parent, "makeDir");
    const subtree = [...this.nodesByPath.values()]
      .filter((candidate) => isActiveFSPathWithin(fromPath, candidate.path))
      .sort((left, right) => left.path.length - right.path.length);
    for (const existing of subtree) {
      const newPath = normalizeActiveFSPath(`${toPath}${existing.path.slice(fromPath.length)}`);
      const clone = cloneTreeDeclaration(existing.declaration);
      this.nodesByPath.set(newPath, {
        path: newPath,
        parentPath: newPath === "/" ? undefined : parentActiveFSPath(newPath),
        declaration: clone
      });
    }
    this.rebuildChildrenIndex();
    return { copied: { from: fromPath, to: toPath } };
  }

  private async defaultTruncate(
    ctx: ActiveFSContext<Auth, Meta>,
    path: ActiveFSPath,
    options: ActiveFSTruncateOptions | undefined,
    resolved: ResolvedTreeRecord<Auth, Meta> | undefined
  ): Promise<ActiveFSTreeMutationResult<Auth, Meta>> {
    if (!resolved || !(resolved.record.declaration instanceof ActiveFSTreeFileDeclarationImpl)) {
      throw new ActiveFSNotFileError(path);
    }
    this.assertWritable(path, resolved.record, "truncate");
    const read = await this.read(ctx, path);
    const content = treeReadContent(read);
    const bytes = activeFSContentToBytes(toActiveFSContent(content));
    const length = Math.max(options?.length ?? 0, 0);
    resolved.record.declaration.options.content = typeof content === "string"
      ? new TextDecoder().decode(bytes.slice(0, length))
      : bytes.slice(0, length);
    return { modified: path };
  }

  private defaultUpdateInfo(
    path: ActiveFSPath,
    options: ActiveFSMetadataUpdateOptions<Meta>,
    resolved: ResolvedTreeRecord<Auth, Meta> | undefined
  ): ActiveFSTreeMutationResult<Auth, Meta> {
    if (!resolved) {
      throw new ActiveFSNotFoundError(path);
    }
    this.assertWritable(path, resolved.record, "updateInfo");
    const previous = this.metadataByPath.get(path) ?? {};
    this.metadataByPath.set(path, {
      ...previous,
      mtimeMs: options.mtimeMs,
      meta: options.meta,
      data: options.meta
    });
    return { modified: path, meta: options.meta, data: options.meta };
  }

  private deleteSubtree(path: ActiveFSPath): void {
    for (const candidate of [...this.nodesByPath.keys()]) {
      if (candidate === "/" || !isActiveFSPathWithin(path, candidate)) {
        continue;
      }
      this.nodesByPath.delete(candidate);
      this.metadataByPath.delete(candidate);
      this.childrenByDirectoryPath.delete(candidate);
    }
    this.rebuildChildrenIndex();
  }

  private rebuildChildrenIndex(): void {
    this.childrenByDirectoryPath.clear();
    for (const record of this.nodesByPath.values()) {
      if (record.declaration instanceof ActiveFSTreeDirectoryDeclarationImpl) {
        this.childrenByDirectoryPath.set(record.path, this.childrenByDirectoryPath.get(record.path) ?? new Map());
      }
    }
    for (const record of this.nodesByPath.values()) {
      if (!record.parentPath) {
        continue;
      }
      const children = this.childrenByDirectoryPath.get(record.parentPath) ?? new Map<string, ActiveFSPath>();
      children.set(basenameActiveFSPath(record.path), record.path);
      this.childrenByDirectoryPath.set(record.parentPath, children);
    }
  }

  private assertWritable(path: ActiveFSPath, record: ActiveFSTreeRecord<Auth, Meta>, operation: "write" | "remove" | "move" | "copy" | "makeDir" | "truncate" | "updateInfo"): void {
    const options = record.declaration.options;
    if (operation === "remove" && options.deletable === false) {
      throw new ActiveFSError("FORBIDDEN", `Path is not deletable: ${path}`, { path });
    }
    if (operation === "move" && options.renamable === false) {
      throw new ActiveFSError("FORBIDDEN", `Path is not renamable: ${path}`, { path });
    }
    if (operation === "copy" && options.copyable === false) {
      throw new ActiveFSError("FORBIDDEN", `Path is not copyable: ${path}`, { path });
    }
    if (options.writable === true || options.deletable === true || options.renamable === true || options.copyable === true) {
      return;
    }
    for (const ancestor of this.ancestorRecords(path).reverse()) {
      const ancestorOptions = ancestor.declaration.options;
      if (operation === "remove" && ancestorOptions.deletable === false) {
        throw new ActiveFSError("FORBIDDEN", `Path is not deletable: ${path}`, { path });
      }
      if (ancestorOptions.writable === true) {
        return;
      }
    }
    if (this.options.writable === true) {
      return;
    }
    throw new ActiveFSError("UNSUPPORTED", `fsTree path is read-only: ${path}`, { path });
  }

  private async listResultToInfos(
    ctx: ActiveFSContext<Auth, Meta>,
    basePath: ActiveFSPath,
    result: ActiveFSTreeListResult<Auth, Meta>
  ): Promise<NonNullable<ActiveFSTreeInfo<Meta>>[]> {
    if (Array.isArray(result)) {
      return result
        .filter((info): info is NonNullable<ActiveFSTreeInfo<Meta>> => Boolean(info));
    }
    const infos: NonNullable<ActiveFSTreeInfo<Meta>>[] = [];
    for (const [name, declaration] of Object.entries(result)) {
      const path = joinActiveFSPath(basePath, name);
      if (isTreeNodeDeclaration<Auth, Meta>(declaration)) {
        const info = this.defaultInfo(path, {
          record: {
            path,
            parentPath: basePath,
            declaration: declaration as InternalTreeNodeDeclaration<Auth, Meta>
          },
          path,
          params: {},
          ancestors: [],
          ephemeral: true
        });
        if (info) {
          infos.push(info);
        }
      } else {
        infos.push({
          path,
          name,
          kind: "directory"
        });
      }
    }
    return infos.sort(compareTreeInfos);
  }

  private applyReadOptions(
    result: ActiveFSTreeReadResult<Meta>,
    options?: ActiveFSReadOptions
  ): ActiveFSTreeReadResult<Meta> {
    if (!options || (options.offset === undefined && options.length === undefined && options.encoding === undefined)) {
      return result;
    }
    const objectResult = isRecordObject(result) && "content" in result
      ? result as { content: ActiveFSTreeContent; info?: ActiveFSTreeInfo<Meta>; type?: string; meta?: Meta; data?: Meta }
      : { content: result as ActiveFSTreeContent };
    const content = sliceActiveFSContent(toActiveFSContent(objectResult.content), options);
    return isRecordObject(result) && "content" in result
      ? { ...objectResult, content }
      : content;
  }

  private async runPreHooks(
    operation: ActiveFSTreeOperation,
    context: ActiveFSTreeHandlerContext<Auth, Meta>,
    records: ActiveFSTreeRecord<Auth, Meta>[]
  ): Promise<void> {
    for (const hook of this.preHooks.get(operation) ?? []) {
      await hook(context);
    }
    for (const record of records) {
      for (const hook of record.declaration.preHooks.get(operation) ?? []) {
        await hook(context);
      }
    }
  }

  private async runPostHooks(
    operation: ActiveFSTreeOperation,
    context: ActiveFSTreeHandlerContext<Auth, Meta>,
    records: ActiveFSTreeRecord<Auth, Meta>[]
  ): Promise<void> {
    for (const record of [...records].reverse()) {
      for (const hook of record.declaration.postHooks.get(operation) ?? []) {
        await hook(context);
      }
    }
    for (const hook of this.postHooks.get(operation) ?? []) {
      await hook(context);
    }
  }

  private async emitMutationResult(
    operation: ActiveFSTreeOperation,
    path: ActiveFSPath,
    toPath: ActiveFSPath | undefined,
    result: ActiveFSTreeMutationResult<Auth, Meta>
  ): Promise<void> {
    if (isTreeNodeDeclaration<Auth, Meta>(result)) {
      this.registerNode(path, result, { emit: false });
      await this.emitChange({ type: "modified", path });
      return;
    }
    if (!isRecordObject(result)) {
      await this.emitChange(defaultChangeForOperation(operation, path, toPath));
      return;
    }
    const meta = mutationData(result);
    if ("invalidate" in result) {
      if (result.invalidate === null) {
        return;
      }
      await this.emitChange({
        type: "invalidated",
        path: normalizeActiveFSPath(result.invalidate ?? path),
        revision: result.revision,
        meta,
        data: meta
      });
      return;
    }
    if (result.created) {
      await this.emitChange({ type: "created", path: normalizeActiveFSPath(result.created), info: result.info, revision: result.revision, meta, data: meta });
    }
    if (result.modified) {
      await this.emitChange({ type: "modified", path: normalizeActiveFSPath(result.modified), info: result.info, revision: result.revision, meta, data: meta });
    }
    if (result.removed) {
      await this.emitChange({ type: "removed", path: normalizeActiveFSPath(result.removed), revision: result.revision, meta, data: meta });
    }
    if (result.moved) {
      await this.emitChange({
        type: "moved",
        path: normalizeActiveFSPath(result.moved.to),
        fromPath: normalizeActiveFSPath(result.moved.from),
        toPath: normalizeActiveFSPath(result.moved.to),
        info: result.info,
        revision: result.revision,
        meta,
        data: meta
      });
    }
    if (result.copied) {
      await this.emitChange({
        type: "copied",
        path: normalizeActiveFSPath(result.copied.to),
        fromPath: normalizeActiveFSPath(result.copied.from),
        toPath: normalizeActiveFSPath(result.copied.to),
        info: result.info,
        revision: result.revision,
        meta,
        data: meta
      });
    }
  }

  private async emitChange(event: Parameters<ActiveFSTreeChangeHandler<Meta>>[0]): Promise<void> {
    for (const handler of this.listeners.get(event.type) ?? []) {
      await handler(event);
    }
    for (const handler of this.changeListeners) {
      await handler(event);
    }
    for (const record of this.recordsForChange(event.path)) {
      for (const handler of record.declaration.listeners.get(event.type) ?? []) {
        await handler(event);
      }
    }
    const watchEvent = treeChangeToWatchEvent(event);
    for (const watcher of this.watchers) {
      if (matchesActiveFSWatchRoot(watcher.root, watchEvent.path, watcher.options)) {
        watcher.onEvent(watchEvent);
      }
    }
  }

  private recordsForChange(path: ActiveFSPath): ActiveFSTreeRecord<Auth, Meta>[] {
    const records: ActiveFSTreeRecord<Auth, Meta>[] = [];
    const exact = this.nodesByPath.get(path);
    if (exact) {
      records.push(exact);
    }
    for (const record of this.patternRecords) {
      if (matchPattern(record, path)) {
        records.push(record);
      }
    }
    return records;
  }
}

/**
 * Creates a live tree-first ActiveFS tree.
 */
export function fsTree<Auth = unknown, Meta = unknown>(
  declaration: ActiveFSTreeDeclaration<Auth, Meta> = {},
  options: ActiveFSTreeOptions<Auth, Meta> = {}
): ActiveFSTree<Auth, Meta> {
  return new ActiveFSTreeImpl(declaration, options);
}

/**
 * Creates a directory declaration for `fsTree`.
 */
export function dir<Auth = unknown, Meta = unknown>(
  childrenOrFactory?: ActiveFSTreeDeclaration<Auth, Meta> | ActiveFSTreeDirectoryChildrenFactory<Auth, Meta>,
  options: ActiveFSTreeDirectoryDeclarationOptions<Auth, Meta> = {}
): ActiveFSTreeDirectoryDeclaration<Auth, Meta> {
  return createDirectoryDeclaration(childrenOrFactory, options);
}

/**
 * Creates a text file declaration for `fsTree`.
 */
export function text<Auth = unknown, Meta = unknown>(
  contentOrFactory: string | ActiveFSTreeContentFactory<Auth, Meta>,
  options: Omit<ActiveFSTreeFileDeclarationOptions<Auth, Meta>, "content"> = {}
): ActiveFSTreeFileDeclaration<Auth, Meta> {
  return createFileDeclaration({
    type: "text/plain",
    ...options,
    content: contentOrFactory
  });
}

/**
 * Creates a byte file declaration for `fsTree`.
 */
export function bytes<Auth = unknown, Meta = unknown>(
  contentOrFactory: Uint8Array | ArrayBuffer | ActiveFSTreeContentFactory<Auth, Meta>,
  options: Omit<ActiveFSTreeFileDeclarationOptions<Auth, Meta>, "content"> = {}
): ActiveFSTreeFileDeclaration<Auth, Meta> {
  return createFileDeclaration({
    type: "application/octet-stream",
    ...options,
    content: contentOrFactory
  });
}

/**
 * Creates a JSON file declaration for `fsTree`.
 */
export function json<Auth = unknown, Meta = unknown>(
  valueOrFactory: unknown | ((context: ActiveFSTreeHandlerContext<Auth, Meta>) => MaybePromise<unknown>),
  options: Omit<ActiveFSTreeFileDeclarationOptions<Auth, Meta>, "content" | "read"> = {}
): ActiveFSTreeFileDeclaration<Auth, Meta> {
  return createFileDeclaration({
    type: "application/json",
    ...options,
    read: async (context) => {
      const value = typeof valueOrFactory === "function"
        ? await (valueOrFactory as (context: ActiveFSTreeHandlerContext<Auth, Meta>) => MaybePromise<unknown>)(context)
        : valueOrFactory;
      return `${JSON.stringify(value, null, 2)}\n`;
    }
  });
}

function createFileDeclaration<Auth = unknown, Meta = unknown>(
  options: ActiveFSTreeFileDeclarationOptions<Auth, Meta> = {}
): ActiveFSTreeFileDeclaration<Auth, Meta> {
  return new ActiveFSTreeFileDeclarationImpl(options);
}

function createDirectoryDeclaration<Auth = unknown, Meta = unknown>(
  childrenOrFactory?: ActiveFSTreeDeclaration<Auth, Meta> | ActiveFSTreeDirectoryChildrenFactory<Auth, Meta>,
  options: ActiveFSTreeDirectoryDeclarationOptions<Auth, Meta> = {}
): ActiveFSTreeDirectoryDeclaration<Auth, Meta> {
  return new ActiveFSTreeDirectoryDeclarationImpl(childrenOrFactory, options);
}

function isTreeDeclarationOptions(value: unknown): value is ActiveFSTreeFileDeclarationOptions {
  return isRecordObject(value) && !(value instanceof Uint8Array) && !(value instanceof ArrayBuffer);
}

function isTreeNodeDeclaration<Auth, Meta>(
  value: unknown
): value is ActiveFSTreeNodeDeclaration<Auth, Meta> {
  return isRecordObject(value) && value[activeFSTreeDeclarationSymbol as keyof typeof value] === true;
}

function addTreeHook<Auth, Meta>(
  hooks: TreeHookMap<Auth, Meta>,
  operation: ActiveFSTreeOperation,
  hook: ActiveFSTreeHook<Auth, Meta>
): void {
  const existing = hooks.get(operation) ?? [];
  existing.push(hook);
  hooks.set(operation, existing);
}

function addTreeListener<Meta>(
  listeners: TreeListenerMap<Meta>,
  event: ActiveFSTreeChangeEvent,
  handler: ActiveFSTreeChangeHandler<Meta>
): void {
  const existing = listeners.get(event) ?? [];
  existing.push(handler);
  listeners.set(event, existing);
}

function handlerKeyForOperation(operation: ActiveFSTreeOperation): keyof ActiveFSTreeHandlerSet {
  if (operation === "info") {
    return "info";
  }
  if (operation === "makeDir") {
    return "makeDir";
  }
  if (operation === "updateInfo") {
    return "updateInfo";
  }
  return operation;
}

function operationForCommand(command: ActiveFSTreeCommand): ActiveFSTreeOperation {
  if (command === "ls") {
    return "list";
  }
  if (command === "stat") {
    return "info";
  }
  if (command === "grep" || command === "rg") {
    return "search";
  }
  if (command === "find") {
    return "walk";
  }
  return "read";
}

function hasMutationHandler<Auth, Meta>(options: ActiveFSTreeHandlerSet<Auth, Meta>): boolean {
  return Boolean(
    options.write ||
    options.remove ||
    options.move ||
    options.copy ||
    options.makeDir ||
    options.truncate ||
    options.updateInfo
  );
}

function basenameActiveFSPath(path: ActiveFSPath): string {
  if (path === "/") {
    return "";
  }
  return path.slice(path.lastIndexOf("/") + 1);
}

function relativeActiveFSPath(root: ActiveFSPath, path: ActiveFSPath): string | undefined {
  if (root === path) {
    return "";
  }
  if (!isActiveFSPathWithin(root, path)) {
    return undefined;
  }
  return root === "/" ? path.slice(1) : path.slice(root.length + 1);
}

function pathIncludesPattern(path: ActiveFSPath): boolean {
  return path.split("/").some((segment) => /:([A-Za-z0-9_]+)/.test(segment));
}

function patternStaticParent(path: ActiveFSPath): ActiveFSPath {
  const segments = path.split("/").filter(Boolean);
  const staticSegments: string[] = [];
  for (const segment of segments) {
    if (/:([A-Za-z0-9_]+)/.test(segment)) {
      break;
    }
    staticSegments.push(segment);
  }
  return staticSegments.length === 0 ? "/" : normalizeActiveFSPath(`/${staticSegments.join("/")}`);
}

function compileTreePattern(path: ActiveFSPath): CompiledTreePattern {
  const names: string[] = [];
  const source = path.split("/").filter(Boolean).map((segment) => {
    return compileTreePatternSegment(segment, names);
  }).join("/");
  return {
    path,
    names,
    regex: new RegExp(`^/${source}$`),
    prefixRegex: new RegExp(`^/${source}(?:/(.*))?$`),
    staticParent: patternStaticParent(path)
  };
}

function compileTreePatternSegment(segment: string, names: string[]): string {
  const matcher = /:([A-Za-z0-9_]+)/g;
  let cursor = 0;
  let compiled = "";
  for (const match of segment.matchAll(matcher)) {
    compiled += escapeRegExp(segment.slice(cursor, match.index));
    names.push(match[1]!);
    compiled += "([^/]+)";
    cursor = match.index + match[0].length;
  }
  compiled += escapeRegExp(segment.slice(cursor));
  return compiled;
}

function matchPattern<Auth, Meta>(
  record: ActiveFSTreeRecord<Auth, Meta>,
  path: ActiveFSPath
): Record<string, string> | undefined {
  if (!record.pattern) {
    return undefined;
  }
  const match = record.pattern.regex.exec(path);
  if (!match) {
    return undefined;
  }
  return Object.fromEntries(record.pattern.names.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? "")]));
}

function matchPatternPrefix<Auth, Meta>(
  record: ActiveFSTreeRecord<Auth, Meta>,
  path: ActiveFSPath
): { params: Record<string, string>; rest?: string } | undefined {
  if (!record.pattern) {
    return undefined;
  }
  const match = record.pattern.prefixRegex.exec(path);
  if (!match) {
    return undefined;
  }
  return {
    params: Object.fromEntries(record.pattern.names.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? "")])),
    rest: match[record.pattern.names.length + 1]
  };
}

function comparePatternRecords<Auth, Meta>(
  left: ActiveFSTreeRecord<Auth, Meta>,
  right: ActiveFSTreeRecord<Auth, Meta>
): number {
  return right.path.length - left.path.length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveDeclarationChild<Auth, Meta>(
  declaration: ActiveFSTreeDeclaration<Auth, Meta>,
  relativePath: string
): { declaration: InternalTreeNodeDeclaration<Auth, Meta>; ancestors: Array<{ relativePath: string; declaration: InternalTreeNodeDeclaration<Auth, Meta> }> } | undefined {
  const segments = relativePath.split("/").filter(Boolean);
  let current: ActiveFSTreeDeclaration<Auth, Meta> | ActiveFSTreeNodeDeclaration<Auth, Meta> | undefined = declaration;
  const ancestors: Array<{ relativePath: string; declaration: InternalTreeNodeDeclaration<Auth, Meta> }> = [];
  const prefix: string[] = [];
  for (const segment of segments) {
    if (!current || isTreeNodeDeclaration<Auth, Meta>(current)) {
      return undefined;
    }
    const value: ActiveFSTreeNodeDeclaration<Auth, Meta> | ActiveFSTreeDeclaration<Auth, Meta> | undefined = current[segment];
    prefix.push(segment);
    if (!value) {
      return undefined;
    }
    if (isTreeNodeDeclaration<Auth, Meta>(value)) {
      if (segment !== segments.at(-1) && value instanceof ActiveFSTreeDirectoryDeclarationImpl && value.childrenOrFactory && typeof value.childrenOrFactory !== "function") {
        ancestors.push({ relativePath: prefix.join("/"), declaration: value as InternalTreeNodeDeclaration<Auth, Meta> });
        current = value.childrenOrFactory;
        continue;
      }
      if (segment === segments.at(-1)) {
        return { declaration: value as InternalTreeNodeDeclaration<Auth, Meta>, ancestors };
      }
      return undefined;
    }
    const directoryDeclaration = createDirectoryDeclaration(value) as InternalTreeNodeDeclaration<Auth, Meta>;
    if (segment === segments.at(-1)) {
      return { declaration: directoryDeclaration, ancestors };
    }
    ancestors.push({ relativePath: prefix.join("/"), declaration: directoryDeclaration });
    current = value;
  }
  return undefined;
}

function toActiveFSContent(content: ActiveFSTreeContent): string | Uint8Array {
  if (typeof content === "string" || content instanceof Uint8Array) {
    return content;
  }
  return new Uint8Array(content);
}

function treeInfoToStat<Meta>(info: NonNullable<ActiveFSTreeInfo<Meta>>, fallbackPath: ActiveFSPath): ActiveFSStat<Meta> {
  const path = normalizeActiveFSPath(info.path ?? fallbackPath);
  return {
    path,
    name: info.name ?? (path === "/" ? "" : basenameActiveFSPath(path)),
    kind: info.kind ?? "file",
    mimeType: info.type,
    size: info.size,
    mtimeMs: info.mtimeMs,
    etag: info.etag,
    revision: info.revision,
    enumerable: info.enumerable,
    capabilities: capabilitiesFromTreeInfo(info),
    meta: treeInfoMeta(info)
  };
}

function treeInfoToDirEntry<Meta>(
  info: NonNullable<ActiveFSTreeInfo<Meta>>,
  fallbackPath: ActiveFSPath
): ActiveFSDirEntry<Meta> {
  const stat = treeInfoToStat(info, fallbackPath);
  return {
    name: stat.name,
    path: stat.path,
    kind: stat.kind,
    capabilities: stat.capabilities,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mimeType: stat.mimeType,
    enumerable: stat.enumerable,
    meta: stat.meta
  };
}

function capabilitiesFromTreeInfo<Meta>(info: NonNullable<ActiveFSTreeInfo<Meta>>): ActiveFSCapabilities {
  const permissions = info.permissions ?? {};
  return {
    stat: true,
    list: info.kind === "directory",
    read: info.kind === "file",
    search: permissions.searchable ?? true,
    write: permissions.writable,
    create: permissions.writable,
    delete: permissions.deletable,
    rename: permissions.renamable,
    copy: permissions.copyable,
    readable: permissions.readable ?? true,
    writable: permissions.writable,
    searchable: permissions.searchable ?? true
  };
}

function treeInfoMeta<Meta>(info: NonNullable<ActiveFSTreeInfo<Meta>>): Meta | undefined {
  return (info.meta as Meta | undefined) ?? (info.data as Meta | undefined);
}

function treeInfoData<Meta>(info: NonNullable<ActiveFSTreeInfo<Meta>>): Meta | undefined {
  return (info.data as Meta | undefined) ?? (info.meta as Meta | undefined);
}

function treeEventMeta<Meta>(event: { meta?: Meta; data?: Meta }): Meta | undefined {
  return (event.meta as Meta | undefined) ?? (event.data as Meta | undefined);
}

function treeSearchMatchMeta<Meta>(match: { meta?: Meta; data?: Meta }): Meta | undefined {
  return (match.meta as Meta | undefined) ?? (match.data as Meta | undefined);
}

function defaultChangeForOperation<Meta>(
  operation: ActiveFSTreeOperation,
  path: ActiveFSPath,
  toPath: ActiveFSPath | undefined
): Parameters<ActiveFSTreeChangeHandler<Meta>>[0] {
  if (operation === "remove") {
    return { type: "removed", path };
  }
  if (operation === "move") {
    return { type: "moved", path: toPath ?? path, fromPath: path, toPath };
  }
  if (operation === "copy") {
    return { type: "copied", path: toPath ?? path, fromPath: path, toPath };
  }
  if (operation === "makeDir") {
    return { type: "created", path };
  }
  return { type: "modified", path };
}

function treeChangeToWatchEvent<Meta>(
  event: Parameters<ActiveFSTreeChangeHandler<Meta>>[0]
): ActiveFSWatchEvent<Meta> {
  const type: ActiveFSWatchEvent<Meta>["type"] =
    event.type === "created" || event.type === "copied"
      ? "create"
      : event.type === "removed"
        ? "delete"
        : event.type === "invalidated"
          ? "invalidate"
          : "change";
  return {
    type,
    path: event.path,
    stat: event.info ? treeInfoToStat(event.info, event.path) : undefined,
    meta: treeEventMeta(event)
  };
}

function mutationRevision<Auth, Meta>(result: ActiveFSTreeMutationResult<Auth, Meta>): string | undefined {
  return isRecordObject(result) && typeof result.revision === "string" ? result.revision : undefined;
}

function mutationData<Auth, Meta>(result: ActiveFSTreeMutationResult<Auth, Meta>): Meta | undefined {
  return isRecordObject(result)
    ? (result.meta as Meta | undefined) ?? (result.data as Meta | undefined)
    : undefined;
}

function mutationCreated<Auth, Meta>(
  result: ActiveFSTreeMutationResult<Auth, Meta>,
  expectedPath: ActiveFSPath
): boolean | undefined {
  if (!isRecordObject(result) || !("created" in result)) {
    return undefined;
  }
  return normalizeActiveFSPath(result.created as string) === expectedPath;
}

/** Tree objects accepted by `ActiveFS.mount`. */
export type ActiveFSMountTree<Auth = unknown, Meta = unknown> = ActiveFSTree<Auth, Meta>;

function cloneTreeDeclaration<Auth, Meta>(
  declaration: InternalTreeNodeDeclaration<Auth, Meta>
): InternalTreeNodeDeclaration<Auth, Meta> {
  if (declaration instanceof ActiveFSTreeFileDeclarationImpl) {
    return createFileDeclaration({ ...declaration.options }) as InternalTreeNodeDeclaration<Auth, Meta>;
  }
  return createDirectoryDeclaration(declaration.childrenOrFactory, { ...declaration.options }) as InternalTreeNodeDeclaration<Auth, Meta>;
}

function isRecordObject(value: unknown): value is Record<string | symbol, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function treeListToRuntimeEntries<Auth, Meta>(
  result: ActiveFSTreeListResult<Auth, Meta>,
  basePath: ActiveFSPath
): ActiveFSDirEntry<Meta>[] {
  if (Array.isArray(result)) {
    return result
      .filter((info): info is NonNullable<ActiveFSTreeInfo<Meta>> => Boolean(info))
      .map((info) => treeInfoToDirEntry(info, basePath))
      .sort(compareEntries);
  }
  return Object.entries(result)
    .map(([name, declaration]) => {
      const path = joinActiveFSPath(basePath, name);
      const node = declaration as ActiveFSTreeNodeDeclaration<Auth, Meta> & { treeNodeKind?: "file" | "directory" };
      const info: NonNullable<ActiveFSTreeInfo<Meta>> = {
        path,
        name,
        kind: node.treeNodeKind === "file" ? "file" : "directory"
      };
      return treeInfoToDirEntry(info, path);
    })
    .sort(compareEntries);
}

function treeListToCommandInfos<Auth, Meta>(
  result: ActiveFSTreeListResult<Auth, Meta>,
  basePath: ActiveFSPath
): NonNullable<ActiveFSTreeInfo<Meta>>[] {
  if (Array.isArray(result)) {
    return result.filter((info): info is NonNullable<ActiveFSTreeInfo<Meta>> => Boolean(info));
  }
  return Object.entries(result).map(([name, declaration]) => {
    const node = declaration as ActiveFSTreeNodeDeclaration<Auth, Meta> & { treeNodeKind?: "file" | "directory" };
    return {
      path: joinActiveFSPath(basePath, name),
      name,
      kind: node.treeNodeKind === "file" ? "file" : "directory"
    };
  });
}

function treeSearchToRuntimeSearch<Meta>(result: ActiveFSTreeSearchResult<Meta>): ActiveFSSearchResult<Meta> {
  return {
    matches: result.matches.map((match) => ({
      path: normalizeActiveFSPath(match.path),
      line: match.line,
      column: match.column,
      excerpt: match.excerpt,
      score: match.score,
      meta: treeSearchMatchMeta(match)
    })),
    complete: result.complete,
    strategy: result.strategy,
    incompleteReasons: result.incompleteReasons
  };
}

function treeContentToActiveFSContent(content: ActiveFSTreeContent): string | Uint8Array {
  return content instanceof ArrayBuffer ? new Uint8Array(content) : content;
}

function treeReadInfo<Meta>(result: ActiveFSTreeReadResult<Meta>): ActiveFSTreeInfo<Meta> | undefined {
  return isRecordObject(result) && "info" in result
    ? result.info as ActiveFSTreeInfo<Meta>
    : undefined;
}

function treeReadData<Meta>(result: ActiveFSTreeReadResult<Meta>): Meta | undefined {
  return isRecordObject(result)
    ? (result.meta as Meta | undefined) ?? (result.data as Meta | undefined)
    : undefined;
}

async function treeMutationStat<Auth, Meta>(
  tree: ActiveFSTree<Auth, Meta>,
  context: ActiveFSContext<Auth, Meta>,
  path: ActiveFSPath,
  result: ActiveFSTreeMutationResult<Auth, Meta>
): Promise<ActiveFSStat<Meta> | undefined> {
  if (isRecordObject(result) && isRecordObject(result.info)) {
    return treeInfoToStat(result.info as NonNullable<ActiveFSTreeInfo<Meta>>, path);
  }
  try {
    const info = await tree.info(context, path);
    return info ? treeInfoToStat(info, path) : undefined;
  } catch (error) {
    if (error instanceof ActiveFSError && error.code === "NOT_FOUND") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Mounted ActiveFS filesystem.
 *
 * Methods normalize caller paths, resolve the longest matching mount prefix,
 * map tree-local paths back to logical mounted paths, and throw
 * `ActiveFSError` when no tree or capability can satisfy the operation.
 */
export interface ActiveFS<Auth = unknown, Meta = unknown> {
  /** Mounts or replaces a tree at a normalized prefix and returns the runtime. */
  mount(prefix: string, tree: ActiveFSMountTree<Auth, Meta>): ActiveFS<Auth, Meta>;
  /** Returns metadata, virtual parent metadata, or `null` for absent paths. */
  stat(
    context: ActiveFSContext<Auth, Meta>,
    path: string
  ): Promise<ActiveFSStat<Meta> | null>;
  /** Lists a directory or virtual parent assembled from descendant mounts. */
  list(
    context: ActiveFSContext<Auth, Meta>,
    path: string
  ): Promise<ActiveFSDirEntry<Meta>[]>;
  /** Reads a file from the resolved mounted tree. */
  read(
    context: ActiveFSContext<Auth, Meta>,
    path: string,
    options?: ActiveFSReadOptions
  ): Promise<ActiveFSReadResult<Meta>>;
  /** Searches below a mounted path using a source handler or ActiveFS scan. */
  search(
    context: ActiveFSContext<Auth, Meta>,
    path: string,
    query: ActiveFSSearchQuery
  ): Promise<ActiveFSSearchResult<Meta>>;
  /** Runs a command-aware source handler or its default semantic mapping. */
  command<Command extends ActiveFSTreeCommand>(
    context: ActiveFSContext<Auth, Meta>,
    command: Command,
    path: string,
    input: ActiveFSCommandInput<Command>
  ): Promise<ActiveFSCommandResultMap<Meta>[Command]>;
  /** Writes a file through the resolved tree. */
  write(
    context: ActiveFSContext<Auth, Meta>,
    path: string,
    content: string | Uint8Array,
    options?: ActiveFSWriteOptions<Meta>
  ): Promise<ActiveFSWriteResult<Meta>>;
  /** Deletes a file or directory through the resolved tree. */
  delete(
    context: ActiveFSContext<Auth, Meta>,
    path: string,
    options?: ActiveFSDeleteOptions
  ): Promise<ActiveFSDeleteResult<Meta>>;
  /** Creates a directory through the resolved tree. */
  mkdir(
    context: ActiveFSContext<Auth, Meta>,
    path: string,
    options?: ActiveFSMkdirOptions<Meta>
  ): Promise<ActiveFSMkdirResult<Meta>>;
  /** Removes a directory through the resolved tree. */
  rmdir(
    context: ActiveFSContext<Auth, Meta>,
    path: string,
    options?: ActiveFSDeleteOptions
  ): Promise<ActiveFSDeleteResult<Meta>>;
  /** Renames within one mounted tree and rejects cross-tree moves. */
  rename(
    context: ActiveFSContext<Auth, Meta>,
    fromPath: string,
    toPath: string,
    options?: ActiveFSRenameOptions
  ): Promise<ActiveFSRenameResult<Meta>>;
  /** Copies within one mounted tree, with read/write fallback for files. */
  copy(
    context: ActiveFSContext<Auth, Meta>,
    fromPath: string,
    toPath: string,
    options?: ActiveFSCopyOptions
  ): Promise<ActiveFSCopyResult<Meta>>;
  /** Truncates a file through the resolved tree. */
  truncate(
    context: ActiveFSContext<Auth, Meta>,
    path: string,
    options?: ActiveFSTruncateOptions
  ): Promise<ActiveFSTruncateResult<Meta>>;
  /** Updates metadata through the resolved tree. */
  updateMetadata(
    context: ActiveFSContext<Auth, Meta>,
    path: string,
    options: ActiveFSMetadataUpdateOptions<Meta>
  ): Promise<ActiveFSMetadataUpdateResult<Meta>>;
  /** Subscribes to tree watch events mapped into mounted paths. */
  watch(
    context: ActiveFSContext<Auth, Meta>,
    path: string,
    onEvent: (event: ActiveFSWatchEvent<Meta>) => void,
    options?: ActiveFSWatchOptions
  ): Promise<ActiveFSWatchSubscription>;
}

interface MountedTree<Auth, Meta> {
  prefix: ActiveFSPath;
  tree: ActiveFSTree<Auth, Meta>;
}

interface ResolvedTree<Auth, Meta> {
  mount: MountedTree<Auth, Meta>;
  treePath: ActiveFSPath;
}

/**
 * Creates an empty ActiveFS filesystem.
 *
 * @returns A mutable filesystem that can be populated with `mount`.
 * @remarks The filesystem has no global credentials or cache state. All
 * request-specific auth/meta is supplied per operation.
 */
export function createActiveFS<Auth = unknown, Meta = unknown>(): ActiveFS<Auth, Meta> {
  return new ActiveFSRuntime<Auth, Meta>();
}

/**
 * Creates an fs/promises-like logical client over an ActiveFS filesystem.
 *
 * @param filesystem Filesystem to operate against.
 * @param options Per-operation context and activity hooks.
 * @returns Promise-based client methods that normalize paths and rethrow runtime
 * failures.
 * @remarks Hooks run after success or failure and therefore should avoid
 * throwing unless the caller intentionally wants hook failures to fail the
 * operation.
 */
export function createActiveFSClient<Auth = unknown, Meta = unknown>(
  filesystem: ActiveFS<Auth, Meta>,
  options: ActiveFSClientOptions<Auth, Meta> = {}
): ActiveFSLogicalClient<Meta> {
  const contextForOperation = async (): Promise<ActiveFSContext<Auth, Meta>> => {
    const context = typeof options.context === "function"
      ? await options.context()
      : options.context;
    return { ...(context ?? {}) };
  };

  const emit = async (event: ActiveFSClientOperationEvent<Meta>): Promise<void> => {
    await options.onOperation?.(event);
    await options.onActivity?.(event);
  };

  const run = async <T>(
    operation: ActiveFSClientOperation,
    path: string,
    targetPath: string | undefined,
    action: (context: ActiveFSContext<Auth, Meta>, path: ActiveFSPath, targetPath?: ActiveFSPath) => Promise<T>,
    statFromResult: (result: T) => ActiveFSStat<Meta> | undefined = () => undefined
  ): Promise<T> => {
    const normalizedPath = normalizeActiveFSPath(path);
    const normalizedTarget = targetPath ? normalizeActiveFSPath(targetPath) : undefined;
    const startedAt = new Date().toISOString();
    try {
      const result = await action(await contextForOperation(), normalizedPath, normalizedTarget);
      await emit({
        operation,
        path: normalizedPath,
        targetPath: normalizedTarget,
        startedAt,
        completedAt: new Date().toISOString(),
        result: "ok",
        stat: statFromResult(result)
      });
      return result;
    } catch (error) {
      await emit({
        operation,
        path: normalizedPath,
        targetPath: normalizedTarget,
        startedAt,
        completedAt: new Date().toISOString(),
        result: "error",
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  };

  const runCommand = <Command extends ActiveFSTreeCommand>(
    command: Command,
    path: string,
    input: ActiveFSCommandInput<Command>
  ): Promise<ActiveFSCommandResultMap<Meta>[Command]> =>
    run("command", path, undefined, (context, normalizedPath) =>
      filesystem.command(context, command, normalizedPath, input));

  return {
    readdir: (path) =>
      run("readdir", path, undefined, (context, normalizedPath) =>
        filesystem.list(context, normalizedPath)),
    stat: (path) =>
      run("stat", path, undefined, async (context, normalizedPath) => {
        const stat = await filesystem.stat(context, normalizedPath);
        if (!stat) {
          throw new ActiveFSNotFoundError(normalizedPath);
        }
        return stat;
      }, (stat) => stat),
    readFile: (path, readOptions) =>
      run("readFile", path, undefined, async (context, normalizedPath) => {
        const result = await filesystem.read(context, normalizedPath, readOptions);
        return result.content;
      }),
    writeFile: (path, content, writeOptions) =>
      run("writeFile", path, undefined, (context, normalizedPath) =>
        filesystem.write(context, normalizedPath, content, writeOptions), (result) => result.stat),
    mkdir: (path, mkdirOptions) =>
      run("mkdir", path, undefined, (context, normalizedPath) =>
        filesystem.mkdir(context, normalizedPath, mkdirOptions), (result) => result.stat),
    rm: (path, deleteOptions) =>
      run("rm", path, undefined, (context, normalizedPath) =>
        filesystem.delete(context, normalizedPath, deleteOptions)),
    rmdir: (path, deleteOptions) =>
      run("rmdir", path, undefined, (context, normalizedPath) =>
        filesystem.rmdir(context, normalizedPath, deleteOptions)),
    rename: (fromPath, toPath, renameOptions) =>
      run("rename", fromPath, toPath, (context, normalizedPath, normalizedTarget) =>
        filesystem.rename(context, normalizedPath, normalizedTarget!, renameOptions), (result) => result.stat),
    copyFile: (fromPath, toPath, copyOptions) =>
      run("copyFile", fromPath, toPath, (context, normalizedPath, normalizedTarget) =>
        filesystem.copy(context, normalizedPath, normalizedTarget!, copyOptions), (result) => result.stat),
    truncate: (path, length) =>
      run("truncate", path, undefined, (context, normalizedPath) =>
        filesystem.truncate(context, normalizedPath, { length }), (result) => result.stat),
    utimes: (path, atimeMs, mtimeMs, metadataOptions) =>
      run("utimes", path, undefined, (context, normalizedPath) =>
        filesystem.updateMetadata(context, normalizedPath, { ...metadataOptions, atimeMs, mtimeMs }), (result) => result.stat),
    search: (path, query) =>
      run("search", path, undefined, (context, normalizedPath) =>
        filesystem.search(context, normalizedPath, query)),
    command: (command, path, input) => runCommand(command, path, input),
    ls: (path, input = {}) => runCommand("ls", path, input),
    cat: (path, input = {}) => runCommand("cat", path, input),
    head: (path, input = {}) => runCommand("head", path, input),
    tail: (path, input = {}) => runCommand("tail", path, input),
    sed: (path, input) => runCommand("sed", path, input),
    grep: (path, input) => runCommand("grep", path, input),
    rg: (path, input) => runCommand("rg", path, input),
    find: (path, input = {}) => runCommand("find", path, input),
    watch: (path, onEvent, watchOptions) =>
      run("watch", path, undefined, (context, normalizedPath) =>
        filesystem.watch(context, normalizedPath, onEvent, watchOptions))
  };
}

/**
 * Normalizes arbitrary user input into an absolute ActiveFS path.
 *
 * @param path Path-like string using `/` or `\` separators.
 * @returns Canonical absolute path.
 * @throws `ActiveFSError` with `INVALID_PATH` when `path` is not a string.
 */
export function normalizeActiveFSPath(path: string): ActiveFSPath {
  if (typeof path !== "string") {
    throw new ActiveFSError("INVALID_PATH", "ActiveFS path must be a string");
  }

  const normalizedSeparators = path.replaceAll("\\", "/");
  const absolute = normalizedSeparators.startsWith("/")
    ? normalizedSeparators
    : `/${normalizedSeparators}`;

  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }

  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

/**
 * Joins a parent and child path using ActiveFS normalization rules.
 *
 * @returns A normalized absolute path. Absolute children replace the parent.
 * @throws `ActiveFSError` with `INVALID_PATH` for non-string input passed to
 * normalization.
 */
export function joinActiveFSPath(parent: string, child: string): ActiveFSPath {
  if (child.startsWith("/")) {
    return normalizeActiveFSPath(child);
  }
  return normalizeActiveFSPath(`${normalizeActiveFSPath(parent)}/${child}`);
}

/**
 * Returns the normalized parent path for an ActiveFS path.
 *
 * The root path is its own parent.
 */
export function parentActiveFSPath(path: string): ActiveFSPath {
  const normalizedPath = normalizeActiveFSPath(path);
  if (normalizedPath === "/") {
    return "/";
  }
  const index = normalizedPath.lastIndexOf("/");
  return index <= 0 ? "/" : normalizeActiveFSPath(normalizedPath.slice(0, index));
}

/**
 * Checks whether `path` is equal to or below `root` in the ActiveFS namespace.
 */
export function isActiveFSPathWithin(root: string, path: string): boolean {
  const normalizedRoot = normalizeActiveFSPath(root);
  const normalizedPath = normalizeActiveFSPath(path);
  return normalizedRoot === "/" ||
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`);
}

/**
 * Checks whether a watch event path should be delivered for a watched root.
 */
export function matchesActiveFSWatchRoot(
  root: string,
  path: string,
  options: { recursive?: boolean } = {}
): boolean {
  const normalizedRoot = normalizeActiveFSPath(root);
  const normalizedPath = normalizeActiveFSPath(path);
  if (normalizedPath === normalizedRoot) {
    return true;
  }
  if (options.recursive) {
    return isActiveFSPathWithin(normalizedRoot, normalizedPath);
  }
  return parentActiveFSPath(normalizedPath) === normalizedRoot;
}

/**
 * Converts ActiveFS string or byte content into a defensive byte copy.
 */
export function activeFSContentToBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : copyActiveFSBytes(content);
}

/**
 * Copies ActiveFS byte content so caches and callers do not share mutable arrays.
 */
export function copyActiveFSBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

/**
 * Applies ActiveFS byte-oriented read options to string or byte content.
 */
export function sliceActiveFSContent(
  content: string | Uint8Array,
  options?: ActiveFSReadOptions
): string | Uint8Array {
  if (!options || (options.offset === undefined && options.length === undefined && options.encoding === undefined)) {
    return typeof content === "string" ? content : copyActiveFSBytes(content);
  }
  const offset = Math.max(options.offset ?? 0, 0);
  const end = options.length === undefined ? undefined : offset + Math.max(options.length, 0);
  const sliced = activeFSContentToBytes(content).slice(offset, end);
  if (options.encoding === "base64") {
    return bytesToBase64(sliced);
  }
  if (options.encoding === "binary") {
    return sliced;
  }
  if (options.encoding === "utf8" || typeof content === "string") {
    return new TextDecoder().decode(sliced);
  }
  return sliced;
}

/**
 * Returns the UTF-8 byte length of ActiveFS content.
 */
export function activeFSContentByteLength(content: string | Uint8Array): number {
  return activeFSContentToBytes(content).byteLength;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

class ActiveFSRuntime<Auth, Meta> implements ActiveFS<Auth, Meta> {
  private mounts: MountedTree<Auth, Meta>[] = [];

  mount(prefix: string, tree: ActiveFSMountTree<Auth, Meta>): ActiveFS<Auth, Meta> {
    const normalizedPrefix = normalizeActiveFSPath(prefix);
    this.mounts = this.mounts.filter((mount) => mount.prefix !== normalizedPrefix);
    this.mounts.push({ prefix: normalizedPrefix, tree });
    this.mounts.sort((left, right) => right.prefix.length - left.prefix.length);
    return this;
  }

  async stat(
    context: ActiveFSContext<Auth, Meta>,
    path: string
  ): Promise<ActiveFSStat<Meta> | null> {
    const normalizedPath = normalizeActiveFSPath(path);
    const resolved = this.resolve(normalizedPath);
    if (resolved) {
      const info = await resolved.mount.tree.info(context, resolved.treePath);
      return info ? this.mapStat(resolved.mount.prefix, treeInfoToStat(info, resolved.treePath)) : null;
    }

    if (this.hasMountedDescendants(normalizedPath)) {
      return this.virtualDirectoryStat(normalizedPath);
    }

    return null;
  }

  async list(
    context: ActiveFSContext<Auth, Meta>,
    path: string
  ): Promise<ActiveFSDirEntry<Meta>[]> {
    const normalizedPath = normalizeActiveFSPath(path);
    const resolved = this.resolve(normalizedPath);
    const virtualChildren = this.virtualChildren(normalizedPath);

    if (resolved) {
      const info = await resolved.mount.tree.info(context, resolved.treePath);
      const stat = info ? treeInfoToStat(info, resolved.treePath) : null;
      if (!stat) {
        throw new ActiveFSError("NOT_FOUND", `Path not found: ${normalizedPath}`, {
          path: normalizedPath
        });
      }
      if (stat.kind !== "directory") {
        throw new ActiveFSError("NOT_DIRECTORY", `Path is not a directory: ${normalizedPath}`, {
          path: normalizedPath
        });
      }

      const entries = treeListToRuntimeEntries(
        await resolved.mount.tree.list(context, resolved.treePath),
        resolved.treePath
      );
      return mergeEntriesByName([
        ...entries.map((entry) => this.mapDirEntry(resolved.mount.prefix, entry)),
        ...virtualChildren
      ]);
    }

    if (virtualChildren.length > 0) {
      return virtualChildren;
    }

    throw new ActiveFSError("NOT_MOUNTED", `No tree is mounted for path: ${normalizedPath}`, {
      path: normalizedPath
    });
  }

  async read(
    context: ActiveFSContext<Auth, Meta>,
    path: string,
    options?: ActiveFSReadOptions
  ): Promise<ActiveFSReadResult<Meta>> {
    const normalizedPath = normalizeActiveFSPath(path);
    const resolved = this.resolve(normalizedPath);
    if (!resolved) {
      throw new ActiveFSError("NOT_MOUNTED", `No tree is mounted for path: ${normalizedPath}`, {
        path: normalizedPath
      });
    }

    const info = await resolved.mount.tree.info(context, resolved.treePath);
    const stat = info ? treeInfoToStat(info, resolved.treePath) : null;
    if (!stat) {
      throw new ActiveFSError("NOT_FOUND", `Path not found: ${normalizedPath}`, {
        path: normalizedPath
      });
    }
    if (stat.kind !== "file") {
      throw new ActiveFSError("NOT_FILE", `Path is not a file: ${normalizedPath}`, {
        path: normalizedPath
      });
    }

    const result = await resolved.mount.tree.read(context, resolved.treePath, options);
    const resultInfo = treeReadInfo(result) ?? info;
    return {
      content: treeContentToActiveFSContent(treeReadContent(result)),
      stat: this.mapStat(resolved.mount.prefix, treeInfoToStat(resultInfo ?? info!, resolved.treePath)),
      meta: treeReadData(result) ?? (resultInfo ? treeInfoMeta(resultInfo) : undefined)
    };
  }

  async search(
    context: ActiveFSContext<Auth, Meta>,
    path: string,
    query: ActiveFSSearchQuery
  ): Promise<ActiveFSSearchResult<Meta>> {
    const normalizedPath = normalizeActiveFSPath(path);
    const resolved = this.resolve(normalizedPath);
    if (resolved && !this.hasMountedDescendants(normalizedPath)) {
      try {
        const result = await resolved.mount.tree.search(context, resolved.treePath, query);
        return this.mapSearchResult(resolved.mount.prefix, treeSearchToRuntimeSearch(result));
      } catch (error) {
        if (!isUnsupportedError(error)) {
          throw error;
        }
      }
    }

    return this.scanSearch(context, normalizedPath, query, undefined, resolved ? normalizedPath : undefined);
  }

  async command<Command extends ActiveFSTreeCommand>(
    context: ActiveFSContext<Auth, Meta>,
    command: Command,
    path: string,
    input: ActiveFSCommandInput<Command>
  ): Promise<ActiveFSCommandResultMap<Meta>[Command]> {
    const normalizedPath = normalizeActiveFSPath(path);
    const resolved = this.resolve(normalizedPath);
    if (!resolved) {
      return this.runDefaultCommand(context, command, normalizedPath, input);
    }
    if (this.hasMountedDescendants(normalizedPath)) {
      if (command === "grep" || command === "rg") {
        return await this.scanSearch(
          context,
          normalizedPath,
          input as ActiveFSCommandInput<"grep">,
          command
        ) as ActiveFSCommandResultMap<Meta>[Command];
      }
      if (command === "find") {
        return await this.findMountedNamespace(
          context,
          normalizedPath,
          input as ActiveFSCommandInput<"find">
        ) as ActiveFSCommandResultMap<Meta>[Command];
      }
    }
    let result: ActiveFSTreeCommandResultMap<Meta>[Command];
    try {
      result = await resolved.mount.tree.command(context, command, resolved.treePath, input);
    } catch (error) {
      if (!isUnsupportedError(error)) {
        throw error;
      }
      return this.runDefaultCommand(context, command, normalizedPath, input);
    }

    if (command === "ls") {
      return mergeEntriesByName([
        ...(result as ActiveFSTreeCommandResultMap<Meta>["ls"])
        .map((info) => this.mapDirEntry(resolved.mount.prefix, treeInfoToDirEntry(info, resolved.treePath)))
        .sort(compareEntries),
        ...this.virtualChildren(normalizedPath)
      ]) as ActiveFSCommandResultMap<Meta>[Command];
    }
    if (command === "stat") {
      const info = result as ActiveFSTreeCommandResultMap<Meta>["stat"];
      return (info
        ? this.mapStat(resolved.mount.prefix, treeInfoToStat(info, resolved.treePath))
        : null) as ActiveFSCommandResultMap<Meta>[Command];
    }
    if (command === "grep" || command === "rg") {
      return this.mapSearchResult(
        resolved.mount.prefix,
        treeSearchToRuntimeSearch(result as ActiveFSTreeCommandResultMap<Meta>["grep"])
      ) as ActiveFSCommandResultMap<Meta>[Command];
    }
    if (command === "find") {
      return (result as ActiveFSTreeCommandResultMap<Meta>["find"])
        .map((info) => this.mapStat(resolved.mount.prefix, treeInfoToStat(info, resolved.treePath))) as ActiveFSCommandResultMap<Meta>[Command];
    }
    if (command === "cat" || command === "head" || command === "tail" || command === "sed") {
      const readResult = result as ActiveFSTreeReadResult<Meta>;
      const info = treeReadInfo(readResult) ?? await resolved.mount.tree.info(context, resolved.treePath);
      return {
        content: treeContentToActiveFSContent(treeReadContent(readResult)),
        stat: info ? this.mapStat(resolved.mount.prefix, treeInfoToStat(info, resolved.treePath)) : undefined,
        meta: treeReadData(readResult) ?? (info ? treeInfoMeta(info) : undefined)
      } as ActiveFSCommandResultMap<Meta>[Command];
    }
    throw new ActiveFSError("UNSUPPORTED", `Unsupported ActiveFS command: ${String(command)}`, { path: normalizedPath });
  }

  async write(
    context: ActiveFSContext<Auth, Meta>,
    path: string,
    content: string | Uint8Array,
    options?: ActiveFSWriteOptions<Meta>
  ): Promise<ActiveFSWriteResult<Meta>> {
    const normalizedPath = normalizeActiveFSPath(path);
    const resolved = this.resolve(normalizedPath);
    if (!resolved) {
      throw new ActiveFSError("NOT_MOUNTED", `No tree is mounted for path: ${normalizedPath}`, {
        path: normalizedPath
      });
    }
    const result = await resolved.mount.tree.write(
      context,
      resolved.treePath,
      content,
      options
    );
    return {
      stat: await this.mountedMutationStat(resolved, context, result),
      created: mutationCreated(result, resolved.treePath),
      revision: mutationRevision(result),
      meta: mutationData(result)
    };
  }

  async delete(
    context: ActiveFSContext<Auth, Meta>,
    path: string,
    options?: ActiveFSDeleteOptions
  ): Promise<ActiveFSDeleteResult<Meta>> {
    const normalizedPath = normalizeActiveFSPath(path);
    const resolved = this.requireResolvedTree(normalizedPath, "delete");
    const result = await resolved.mount.tree.remove(context, resolved.treePath, options);
    return {
      path: normalizedPath,
      deleted: true,
      revision: mutationRevision(result),
      meta: mutationData(result)
    };
  }

  async mkdir(
    context: ActiveFSContext<Auth, Meta>,
    path: string,
    options?: ActiveFSMkdirOptions<Meta>
  ): Promise<ActiveFSMkdirResult<Meta>> {
    const normalizedPath = normalizeActiveFSPath(path);
    const resolved = this.requireResolvedTree(normalizedPath, "mkdir");
    const result = await resolved.mount.tree.makeDir(context, resolved.treePath, options);
    return {
      stat: await this.mountedMutationStat(resolved, context, result),
      created: mutationCreated(result, resolved.treePath),
      revision: mutationRevision(result),
      meta: mutationData(result)
    };
  }

  async rmdir(
    context: ActiveFSContext<Auth, Meta>,
    path: string,
    options?: ActiveFSDeleteOptions
  ): Promise<ActiveFSDeleteResult<Meta>> {
    const normalizedPath = normalizeActiveFSPath(path);
    const resolved = this.requireResolvedTree(normalizedPath, "rmdir");
    const result = await resolved.mount.tree.remove(context, resolved.treePath, options);
    return {
      path: normalizedPath,
      deleted: true,
      revision: mutationRevision(result),
      meta: mutationData(result)
    };
  }

  async rename(
    context: ActiveFSContext<Auth, Meta>,
    fromPath: string,
    toPath: string,
    options?: ActiveFSRenameOptions
  ): Promise<ActiveFSRenameResult<Meta>> {
    const tree = this.requireSameTree(fromPath, toPath, "rename");
    const result = await tree.from.mount.tree.move(
      context,
      tree.from.treePath,
      tree.to.treePath,
      options
    );
    const moved = isRecordObject(result) && isRecordObject(result.moved)
      ? result.moved as { from?: string; to?: string }
      : undefined;
    return {
      from: moved?.from ? joinMountedPath(tree.from.mount.prefix, moved.from) : tree.fromPath,
      to: moved?.to ? joinMountedPath(tree.from.mount.prefix, moved.to) : tree.toPath,
      stat: await this.mountedMutationStat(tree.to, context, result),
      revision: mutationRevision(result),
      meta: mutationData(result)
    };
  }

  async copy(
    context: ActiveFSContext<Auth, Meta>,
    fromPath: string,
    toPath: string,
    options?: ActiveFSCopyOptions
  ): Promise<ActiveFSCopyResult<Meta>> {
    const tree = this.requireSameTree(fromPath, toPath, "copy");
    const result = await tree.from.mount.tree.copy(
      context,
      tree.from.treePath,
      tree.to.treePath,
      options
    );
    const copied = isRecordObject(result) && isRecordObject(result.copied)
      ? result.copied as { from?: string; to?: string }
      : undefined;
    return {
      from: copied?.from ? joinMountedPath(tree.from.mount.prefix, copied.from) : tree.fromPath,
      to: copied?.to ? joinMountedPath(tree.from.mount.prefix, copied.to) : tree.toPath,
      stat: await this.mountedMutationStat(tree.to, context, result),
      revision: mutationRevision(result),
      meta: mutationData(result)
    };
  }

  async truncate(
    context: ActiveFSContext<Auth, Meta>,
    path: string,
    options?: ActiveFSTruncateOptions
  ): Promise<ActiveFSTruncateResult<Meta>> {
    const normalizedPath = normalizeActiveFSPath(path);
    const resolved = this.requireResolvedTree(normalizedPath, "truncate");
    const result = await resolved.mount.tree.truncate(context, resolved.treePath, options);
    return {
      stat: await this.mountedMutationStat(resolved, context, result),
      revision: mutationRevision(result),
      meta: mutationData(result)
    };
  }

  async updateMetadata(
    context: ActiveFSContext<Auth, Meta>,
    path: string,
    options: ActiveFSMetadataUpdateOptions<Meta>
  ): Promise<ActiveFSMetadataUpdateResult<Meta>> {
    const normalizedPath = normalizeActiveFSPath(path);
    const resolved = this.requireResolvedTree(normalizedPath, "update metadata");
    const result = await resolved.mount.tree.updateInfo(context, resolved.treePath, options);
    return {
      stat: await this.mountedMutationStat(resolved, context, result),
      revision: mutationRevision(result),
      meta: mutationData(result)
    };
  }

  async watch(
    context: ActiveFSContext<Auth, Meta>,
    path: string,
    onEvent: (event: ActiveFSWatchEvent<Meta>) => void,
    options?: ActiveFSWatchOptions
  ): Promise<ActiveFSWatchSubscription> {
    const normalizedPath = normalizeActiveFSPath(path);
    const subscriptions: ActiveFSWatchSubscription[] = [];
    const resolved = this.resolve(normalizedPath);

    if (resolved) {
      subscriptions.push(await resolved.mount.tree.watch(
        context,
        resolved.treePath,
        (event) => onEvent(this.mapWatchEvent(resolved.mount.prefix, event)),
        options
      ));
    }

    if (!resolved || options?.recursive) {
      const descendantMounts = this.mounts.filter((mount) => {
        if (resolved && mount.prefix === resolved.mount.prefix) {
          return false;
        }
        return normalizedPath === "/"
          ? mount.prefix !== "/"
          : mount.prefix === normalizedPath || mount.prefix.startsWith(`${normalizedPath}/`);
      });
      for (const mount of descendantMounts) {
        subscriptions.push(await mount.tree.watch(
          context,
          "/",
          (event) => onEvent(this.mapWatchEvent(mount.prefix, event)),
          {
            ...options,
            recursive: true
          }
        ));
      }
    }

    if (subscriptions.length === 0) {
      const code = this.hasMountedDescendants(normalizedPath) ? "UNSUPPORTED" : "NOT_MOUNTED";
      throw new ActiveFSError(code, `No watchable tree is mounted for path: ${normalizedPath}`, {
        path: normalizedPath
      });
    }

    return {
      close: async () => {
        await Promise.all(subscriptions.map((subscription) => subscription.close()));
      }
    };
  }

  private resolve(path: ActiveFSPath): ResolvedTree<Auth, Meta> | null {
    for (const mount of this.mounts) {
      if (mount.prefix === "/") {
        return { mount, treePath: path };
      }
      if (path === mount.prefix || path.startsWith(`${mount.prefix}/`)) {
        return {
          mount,
          treePath: path === mount.prefix ? "/" : normalizeActiveFSPath(path.slice(mount.prefix.length))
        };
      }
    }
    return null;
  }

  private requireResolvedTree(
    path: ActiveFSPath,
    operation: string
  ): ResolvedTree<Auth, Meta> {
    const resolved = this.resolve(path);
    if (!resolved) {
      throw new ActiveFSError("NOT_MOUNTED", `No tree is mounted for ${operation}: ${path}`, {
        path
      });
    }
    return resolved;
  }

  private requireSameTree(
    fromPath: string,
    toPath: string,
    operation: string
  ): {
    fromPath: ActiveFSPath;
    toPath: ActiveFSPath;
    from: ResolvedTree<Auth, Meta>;
    to: ResolvedTree<Auth, Meta>;
  } {
    const normalizedFrom = normalizeActiveFSPath(fromPath);
    const normalizedTo = normalizeActiveFSPath(toPath);
    const from = this.requireResolvedTree(normalizedFrom, operation);
    const to = this.requireResolvedTree(normalizedTo, operation);
    if (from.mount !== to.mount) {
      throw new ActiveFSError(
        "UNSUPPORTED",
        `Cannot ${operation} across different mounted trees: ${normalizedFrom} -> ${normalizedTo}`,
        { path: normalizedFrom }
      );
    }
    return { fromPath: normalizedFrom, toPath: normalizedTo, from, to };
  }

  private async scanSearch(
    context: ActiveFSContext<Auth, Meta>,
    rootPath: ActiveFSPath,
    query: ActiveFSSearchQuery,
    command?: "grep" | "rg",
    skippedSourcePath?: ActiveFSPath
  ): Promise<ActiveFSSearchResult<Meta>> {
    const matches: ActiveFSSearchMatch<Meta>[] = [];
    const maxResults = searchResultLimit(query, context);
    const incompleteReasons = new Set<ActiveFSSearchIncompleteReason>();
    const strategies = new Set<ActiveFSSearchStrategy>();

    const visit = async (path: ActiveFSPath): Promise<void> => {
      assertSearchNotCancelled(context);
      if (searchDeadlineReached(context)) {
        incompleteReasons.add("timeout");
        return;
      }

      const resolved = this.resolve(path);
      if (
        resolved &&
        path !== skippedSourcePath &&
        !this.hasMountedDescendants(path)
      ) {
        try {
          const remaining = Math.max(0, maxResults - matches.length);
          const delegatedQuery = Number.isFinite(maxResults)
            ? { ...query, maxResults: remaining + 1 }
            : query;
          const treeResult = command
            ? await resolved.mount.tree.command(context, command, resolved.treePath, delegatedQuery)
            : await resolved.mount.tree.search(context, resolved.treePath, delegatedQuery);
          const result = treeSearchToRuntimeSearch(treeResult);
          addSearchStrategy(strategies, result.strategy);
          for (const match of this.mapSearchResult(resolved.mount.prefix, result).matches) {
            if (matches.length >= maxResults) {
              incompleteReasons.add("max-results");
              return;
            }
            matches.push(match);
          }
          if (!result.complete) {
            for (const reason of result.incompleteReasons ?? ["source-incomplete"] as const) {
              incompleteReasons.add(reason);
            }
          }
          return;
        } catch (error) {
          if (!isUnsupportedError(error)) {
            throw error;
          }
        }
      }

      strategies.add("scan");
      let stat: ActiveFSStat<Meta> | null;
      try {
        stat = await this.stat(context, path);
      } catch (error) {
        if (isUnreadableSearchError(error)) {
          incompleteReasons.add("unreadable-path");
          return;
        }
        throw error;
      }
      if (!stat) {
        return;
      }

      if (stat.kind === "directory") {
        if (stat.enumerable === false && !query.includeNonEnumerable) {
          return;
        }
        let entries: ActiveFSDirEntry<Meta>[];
        try {
          entries = await this.list(context, path);
        } catch (error) {
          if (isUnreadableSearchError(error)) {
            incompleteReasons.add("unreadable-path");
            return;
          }
          throw error;
        }
        for (const entry of entries) {
          if (entry.enumerable === false && !query.includeNonEnumerable) {
            continue;
          }
          await visit(entry.path);
          if (incompleteReasons.has("max-results") || incompleteReasons.has("timeout")) {
            return;
          }
        }
        return;
      }

      try {
        const readResult = await this.read(context, path);
        for (const match of matchContent<Meta>(path, readResult.content, query)) {
          if (matches.length >= maxResults) {
            incompleteReasons.add("max-results");
            return;
          }
          matches.push(match);
        }
      } catch (error) {
        if (isUnreadableSearchError(error)) {
          incompleteReasons.add("unreadable-path");
          return;
        }
        throw error;
      }
    };

    await visit(rootPath);
    const complete = incompleteReasons.size === 0;
    return {
      matches,
      complete,
      strategy: summarizeSearchStrategies(strategies),
      incompleteReasons: complete ? undefined : [...incompleteReasons]
    };
  }

  private async findMountedNamespace(
    context: ActiveFSContext<Auth, Meta>,
    rootPath: ActiveFSPath,
    input: ActiveFSCommandInput<"find">
  ): Promise<ActiveFSCommandResultMap<Meta>["find"]> {
    const entries: ActiveFSStat<Meta>[] = [];

    const visit = async (path: ActiveFSPath): Promise<void> => {
      const resolved = this.resolve(path);
      if (resolved && !this.hasMountedDescendants(path)) {
        try {
          const result = await resolved.mount.tree.command(context, "find", resolved.treePath, input);
          entries.push(...result.map((info) =>
            this.mapStat(resolved.mount.prefix, treeInfoToStat(info, resolved.treePath))
          ));
          return;
        } catch (error) {
          if (!isUnsupportedError(error)) {
            throw error;
          }
        }
      }

      const stat = await this.stat(context, path);
      if (!stat || (stat.enumerable === false && !input.includeNonEnumerable)) {
        return;
      }
      entries.push(stat);
      if (stat.kind === "directory") {
        for (const child of await this.list(context, path)) {
          if (child.enumerable !== false || input.includeNonEnumerable) {
            await visit(child.path);
          }
        }
      }
    };

    await visit(rootPath);
    return entries;
  }

  private async runDefaultCommand<Command extends ActiveFSTreeCommand>(
    context: ActiveFSContext<Auth, Meta>,
    command: Command,
    path: ActiveFSPath,
    input: ActiveFSCommandInput<Command>
  ): Promise<ActiveFSCommandResultMap<Meta>[Command]> {
    if (command === "ls") {
      return await this.list(context, path) as ActiveFSCommandResultMap<Meta>[Command];
    }
    if (command === "stat") {
      return await this.stat(context, path) as ActiveFSCommandResultMap<Meta>[Command];
    }
    if (command === "grep" || command === "rg") {
      return await this.search(context, path, input as ActiveFSCommandInput<"grep">) as ActiveFSCommandResultMap<Meta>[Command];
    }
    if (command === "find") {
      const findInput = input as ActiveFSCommandInput<"find">;
      const entries: ActiveFSStat<Meta>[] = [];
      const visit = async (candidate: ActiveFSPath): Promise<void> => {
        const stat = await this.stat(context, candidate);
        if (!stat || (stat.enumerable === false && !findInput.includeNonEnumerable)) {
          return;
        }
        entries.push(stat);
        if (stat.kind === "directory") {
          for (const child of await this.list(context, candidate)) {
            await visit(child.path);
          }
        }
      };
      await visit(path);
      return entries as ActiveFSCommandResultMap<Meta>[Command];
    }
    const read = await this.read(context, path, (input as ActiveFSCommandInput<"cat">).options);
    if (command === "cat") {
      return read as ActiveFSCommandResultMap<Meta>[Command];
    }
    if (command === "head" || command === "tail") {
      const lineInput = input as ActiveFSCommandInput<"head">;
      const lines = validateCommandLineCount(lineInput.lines, command);
      return transformActiveFSReadText(read, (text) => command === "head"
        ? takeHeadLines(text, lines)
        : takeTailLines(text, lines)) as ActiveFSCommandResultMap<Meta>[Command];
    }
    const sedInput = input as ActiveFSCommandInput<"sed">;
    if (typeof sedInput.pattern !== "string" || sedInput.pattern.length === 0 || typeof sedInput.replacement !== "string") {
      throw new ActiveFSError("INVALID_REQUEST", "sed requires non-empty pattern and string replacement", { path });
    }
    return transformActiveFSReadText(read, (text) => replaceCommandText(text, sedInput)) as ActiveFSCommandResultMap<Meta>[Command];
  }

  private hasMountedDescendants(path: ActiveFSPath): boolean {
    return this.mounts.some((mount) => {
      if (mount.prefix === "/" || mount.prefix === path) {
        return false;
      }
      return path === "/" || mount.prefix.startsWith(`${path}/`);
    });
  }

  private virtualChildren(path: ActiveFSPath): ActiveFSDirEntry<Meta>[] {
    const children = new Map<string, ActiveFSDirEntry<Meta>>();
    for (const mount of this.mounts) {
      if (mount.prefix === "/" || mount.prefix === path) {
        continue;
      }
      if (path !== "/" && !mount.prefix.startsWith(`${path}/`)) {
        continue;
      }

      const rest = path === "/" ? mount.prefix.slice(1) : mount.prefix.slice(path.length + 1);
      if (rest === "") {
        continue;
      }

      const segment = rest.split("/")[0];
      const childPath = joinActiveFSPath(path, segment);
      children.set(segment, {
        name: segment,
        path: childPath,
        kind: "directory",
        capabilities: { stat: true, list: true },
        enumerable: true
      });
    }
    return [...children.values()].sort(compareEntries);
  }

  private virtualDirectoryStat(path: ActiveFSPath): ActiveFSStat<Meta> {
    return {
      name: path === "/" ? "" : basename(path),
      path,
      kind: "directory",
      capabilities: { stat: true, list: true },
      enumerable: true
    };
  }

  private mapDirEntry(prefix: ActiveFSPath, entry: ActiveFSDirEntry<Meta>): ActiveFSDirEntry<Meta> {
    const path = joinMountedPath(prefix, entry.path);
    return {
      ...entry,
      path,
      name: entry.name || basename(path)
    };
  }

  private mapStat(prefix: ActiveFSPath, stat: ActiveFSStat<Meta>): ActiveFSStat<Meta> {
    const path = joinMountedPath(prefix, stat.path);
    return {
      ...stat,
      path,
      name: path === "/" ? "" : stat.name || basename(path)
    };
  }

  private mapSearchResult(
    prefix: ActiveFSPath,
    result: ActiveFSSearchResult<Meta>
  ): ActiveFSSearchResult<Meta> {
    return {
      ...result,
      matches: result.matches.map((match) => ({
        ...match,
        path: joinMountedPath(prefix, match.path)
      }))
    };
  }

  private mapWatchEvent(
    prefix: ActiveFSPath,
    event: ActiveFSWatchEvent<Meta>
  ): ActiveFSWatchEvent<Meta> {
    return {
      ...event,
      path: joinMountedPath(prefix, event.path),
      stat: event.stat ? this.mapStat(prefix, event.stat) : undefined
    };
  }

  private async mountedMutationStat(
    resolved: ResolvedTree<Auth, Meta>,
    context: ActiveFSContext<Auth, Meta>,
    result: ActiveFSTreeMutationResult<Auth, Meta>
  ): Promise<ActiveFSStat<Meta> | undefined> {
    const stat = await treeMutationStat(resolved.mount.tree, context, resolved.treePath, result);
    return stat ? this.mapStat(resolved.mount.prefix, stat) : undefined;
  }
}

function joinMountedPath(prefix: ActiveFSPath, treePath: string): ActiveFSPath {
  const normalizedSourcePath = normalizeActiveFSPath(treePath);
  if (prefix === "/") {
    return normalizedSourcePath;
  }
  if (normalizedSourcePath === "/") {
    return prefix;
  }
  return normalizeActiveFSPath(`${prefix}/${normalizedSourcePath.slice(1)}`);
}

function basename(path: ActiveFSPath): string {
  if (path === "/") {
    return "";
  }
  const parts = path.split("/");
  return parts[parts.length - 1] ?? "";
}

function compareTreeInfos(left: ActiveFSTreeInfo, right: ActiveFSTreeInfo): number {
  const leftName = left?.name ?? (left?.path ? basename(normalizeActiveFSPath(left.path)) : "");
  const rightName = right?.name ?? (right?.path ? basename(normalizeActiveFSPath(right.path)) : "");
  return leftName.localeCompare(rightName);
}

function compareEntries(left: ActiveFSDirEntry, right: ActiveFSDirEntry): number {
  return left.name.localeCompare(right.name);
}

function treeReadContent<Meta>(result: ActiveFSTreeReadResult<Meta>): ActiveFSTreeContent {
  if (isRecordObject(result) && "content" in result) {
    return result.content as ActiveFSTreeContent;
  }
  return result as ActiveFSTreeContent;
}

function transformTreeReadText<Meta>(
  result: ActiveFSTreeReadResult<Meta>,
  transform: (text: string) => string
): ActiveFSTreeReadResult<Meta> {
  const content = treeReadContent(result);
  const transformed = transform(typeof content === "string"
    ? content
    : new TextDecoder().decode(content instanceof ArrayBuffer ? new Uint8Array(content) : content));
  return isRecordObject(result) && "content" in result
    ? { ...result, content: transformed }
    : transformed;
}

function transformActiveFSReadText<Meta>(
  result: ActiveFSReadResult<Meta>,
  transform: (text: string) => string
): ActiveFSReadResult<Meta> {
  return {
    ...result,
    content: transform(typeof result.content === "string"
      ? result.content
      : new TextDecoder().decode(result.content))
  };
}

function validateCommandLineCount(lines: number | undefined, command: "head" | "tail"): number {
  const value = lines ?? 10;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ActiveFSError("INVALID_REQUEST", `${command} lines must be a non-negative integer`);
  }
  return value;
}

function textLinesWithEndings(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function takeHeadLines(text: string, lines: number): string {
  return textLinesWithEndings(text).slice(0, lines).join("");
}

function takeTailLines(text: string, lines: number): string {
  return lines === 0 ? "" : textLinesWithEndings(text).slice(-lines).join("");
}

function replaceCommandText(text: string, input: ActiveFSCommandInput<"sed">): string {
  const flags = `${input.global ? "g" : ""}${input.caseSensitive === false ? "i" : ""}`;
  return text.replace(new RegExp(escapeRegExp(input.pattern), flags), input.replacement);
}

function isAsyncIterable<Value>(value: unknown): value is AsyncIterable<Value> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

async function collectAsyncIterable<Value>(iterable: AsyncIterable<Value>): Promise<Value[]> {
  const values: Value[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

function mergeEntriesByName<Meta>(entries: ActiveFSDirEntry<Meta>[]): ActiveFSDirEntry<Meta>[] {
  const byName = new Map<string, ActiveFSDirEntry<Meta>>();
  for (const entry of entries) {
    byName.set(entry.name, entry);
  }
  return [...byName.values()].sort(compareEntries);
}

function isUnsupportedError(error: unknown): boolean {
  return error instanceof ActiveFSError && error.code === "UNSUPPORTED";
}

function isUnreadableSearchError(error: unknown): boolean {
  return error instanceof ActiveFSError && (
    error.code === "UNAUTHORIZED" ||
    error.code === "FORBIDDEN" ||
    error.code === "NOT_FOUND"
  );
}

function assertSearchNotCancelled(context: ActiveFSContext): void {
  if (context.signal?.aborted) {
    throw context.signal.reason instanceof Error
      ? context.signal.reason
      : new ActiveFSError("TRANSIENT", "Search was cancelled");
  }
}

function searchDeadlineReached(context: ActiveFSContext): boolean {
  return context.deadlineMs !== undefined && Date.now() >= context.deadlineMs;
}

function searchResultLimit(query: ActiveFSSearchQuery, context: ActiveFSContext): number {
  return Math.max(0, query.maxResults ?? context.maxSearchResults ?? Number.POSITIVE_INFINITY);
}

function addSearchStrategy(
  strategies: Set<ActiveFSSearchStrategy>,
  strategy: ActiveFSSearchStrategy
): void {
  if (strategy === "mixed") {
    strategies.add("source");
    strategies.add("scan");
    return;
  }
  strategies.add(strategy);
}

function summarizeSearchStrategies(strategies: Set<ActiveFSSearchStrategy>): ActiveFSSearchStrategy {
  if (strategies.has("source") && strategies.has("scan")) {
    return "mixed";
  }
  if (strategies.has("source")) {
    return "source";
  }
  return "scan";
}

function matchTreeContent<Meta>(
  path: ActiveFSPath,
  content: ActiveFSTreeContent,
  query: ActiveFSSearchQuery,
  info?: ActiveFSTreeInfo<Meta>
): ActiveFSTreeSearchResult<Meta>["matches"] {
  return matchContent<Meta>(path, treeContentToActiveFSContent(content), query).map((match) => ({
    ...match,
    meta: info ? treeInfoMeta(info) : undefined,
    data: info ? treeInfoData(info) : undefined
  }));
}

function matchContent<Meta>(
  path: ActiveFSPath,
  content: string | Uint8Array,
  query: ActiveFSSearchQuery
): ActiveFSSearchMatch<Meta>[] {
  const text = typeof content === "string" ? content : new TextDecoder().decode(content);
  const caseSensitive = query.caseSensitive === true;
  const needle = caseSensitive ? query.pattern : query.pattern.toLowerCase();
  const lines = text.split(/\r?\n/);
  const matches: ActiveFSSearchMatch<Meta>[] = [];

  lines.forEach((line, index) => {
    const haystack = caseSensitive ? line : line.toLowerCase();
    const column = haystack.indexOf(needle);
    if (column >= 0) {
      matches.push({
        path,
        line: index + 1,
        column: column + 1,
        excerpt: line
      });
    }
  });

  return matches;
}
